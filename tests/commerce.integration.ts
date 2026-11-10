import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProviderError, SqlPaymentStore, payloadHash, type PaymentCommand, type PaymentOperation, type ProviderAdapter, type ProviderReceipt, type ProviderResource } from "@fracture/paypal-core";
import { PaypalClient } from "paypal";
import { VaultAdapter } from "../packages/commerce/vault";
import { type WalletConsent, type FinancialAuthority, type RepairClaim } from "../packages/commerce/contracts";
import { createSession, createQuote, getRevision, commitEdit, type Session } from "../src/server/repository";
import { closeDatabase, database } from "../src/server/db";
import { initializeCommerce, paymentDatabase } from "../src/server/commerce-db";
import { acceptCheckout, authorizePayment, captureCheckout, createCommerceEngine, enableRepairPolicy, loadOrder, refundCheckout, reserveRepair, revokeRepairPolicy, syncOperation } from "../src/server/commerce";
import { beginWalletSetup, completeWalletSetup, createWalletConsent, loadWallet, revokeWallet } from "../src/server/wallets";
import { seal, unseal } from "../src/server/secrets";

class FixtureProvider implements ProviderAdapter {
  readonly source = "sample" as const; calls: PaymentCommand[] = []; unknown = false; instantCapture = false;
  resources = new Map<string, ProviderResource>();
  resource(kind: ProviderResource["kind"], id: string, status: string, command: PaymentCommand, parentId: string | null = null): ProviderResource {
    return { kind, id, status, money: kind === "order" ? null : command.action.money, parentId, customId: command.action.kind === "create_order" ? command.action.customId : null, observedAt: new Date().toISOString(), source: "sample", links: kind === "order" && status !== "COMPLETED" ? [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, method: "GET" }] : [] };
  }
  async execute(command: PaymentCommand): Promise<ProviderReceipt> {
    const claimed = (await database().query("SELECT status,document FROM paycore_operations WHERE tenant_id=$1 AND project_id='worldkit' AND id=$2", [command.scope.tenantId, command.operationId])).rows[0];
    assert.equal(claimed.status, "dispatching"); assert.equal(JSON.parse(claimed.document).worldkitOperation, true);
    this.calls.push(command); if (this.unknown) throw new ProviderError("timeout", "Sample lost response", "unknown", 502);
    const action = command.action; let resources: ProviderResource[];
    if (action.kind === "create_order") { const id = `ORDER-${randomUUID()}`; resources = [this.resource("order", id, this.instantCapture ? "COMPLETED" : "CREATED", command)]; if (this.instantCapture) resources.push(this.resource("capture", `CAPTURE-${randomUUID()}`, "COMPLETED", command, id)); }
    else if (action.kind === "capture_order") resources = [this.resource("order", action.orderId, "COMPLETED", command), this.resource("capture", `CAPTURE-${randomUUID()}`, "COMPLETED", command, action.orderId)];
    else if (action.kind === "refund_capture") resources = [this.resource("refund", `REFUND-${randomUUID()}`, "COMPLETED", command, action.captureId)];
    else throw new Error("Unexpected fixture action");
    resources.forEach(r => this.resources.set(r.id, r));
    return { id: randomUUID(), operationId: command.operationId, providerRequestId: command.providerRequestId, transport: "local_fixture", source: "sample", status: 201, observedAt: new Date().toISOString(), resources, debugId: null, bodyHash: payloadHash(command.action), reconciled: false };
  }
  async read(kind: ProviderResource["kind"], id: string) { const resource = this.resources.get(id); return resource?.kind === kind ? [{ ...resource, observedAt: new Date().toISOString() }] : []; }
  async reconcile(_operation: PaymentOperation) { return null; }
}
let store: SqlPaymentStore;
before(async () => { await initializeCommerce(); store = new SqlPaymentStore(paymentDatabase); await store.initialize(); });
after(async () => { await closeDatabase(); });
async function fixture(saveWallet = false) {
  const { session } = await createSession(); const revision = await getRevision(session.id); const quote = await createQuote(session.id, revision); const provider = new FixtureProvider(); const engine = Promise.resolve(createCommerceEngine(provider, store));
  const order = await acceptCheckout(session, quote.id, quote.quoteHash, saveWallet, "http://localhost:4106", engine);
  return { session, revision, quote, provider, engine, order };
}
async function policyFixture() {
  const f = await fixture(); const paid = await captureCheckout(f.session, f.order.id, f.engine);
  const consent = await createWalletConsent(f.session, "http://localhost:4106", "separate_setup");
  const wallet: WalletConsent = { ...consent, state: "active", tokenId: `private-fixture-token-${randomUUID()}`, customerId: "private-fixture-customer", payerId: "private-fixture-payer", verifiedAt: new Date().toISOString() };
  await database().query("UPDATE wk_wallet_consents SET payload=$1 WHERE id=$2", [seal(f.session.id, wallet), wallet.id]);
  const policy = await enableRepairPolicy(f.session, paid.id, wallet.id, wallet.digest);
  return { ...f, paid, wallet, policy };
}
const proposal = (f: Awaited<ReturnType<typeof policyFixture>>, minor: number, businessKey: string) => ({ scenarioId: "fixture-repair", title: "Fixture setup revision", detail: "Sample policy race", minor, businessKey, revision: f.revision });

test("double-clicking an accepted quote produces one durable order and one provider write", async () => {
  const { session } = await createSession(); const quote = await createQuote(session.id, await getRevision(session.id)); const provider = new FixtureProvider(); const engine = Promise.resolve(createCommerceEngine(provider, store));
  const result = await Promise.all([acceptCheckout(session, quote.id, quote.quoteHash, false, "http://localhost:4106", engine), acceptCheckout(session, quote.id, quote.quoteHash, false, "http://localhost:4106", engine)]);
  assert.equal(result[0]!.id, result[1]!.id); assert.equal(provider.calls.length, 1);
});
test("stale graph, foreign quote and altered amount cannot enter the payment provider", async () => {
  const f = await fixture(); const outsider = await createSession(); await assert.rejects(loadOrder(outsider.session.id, f.order.id), /does not belong/);
  await assert.rejects(acceptCheckout(outsider.session, f.quote.id, f.quote.quoteHash, false, "http://localhost:4106", f.engine), /does not match/);
  const authority = unseal<FinancialAuthority>(f.session.id, (await database().query("SELECT payload FROM wk_financial_authorities WHERE order_id=$1", [f.order.id])).rows[0].payload);
  const tampered = structuredClone(authority.command); tampered.action.money.minor++; tampered.payloadHash = payloadHash(tampered.action);
  assert.equal((await authorizePayment(tampered, f.provider)).allowed, false);
  const quote = await createQuote(f.session.id, f.revision);
  await commitEdit(f.session, f.revision.kit.id, f.revision.certificate.graphHash, { kind: "connection", connectionId: "mic2-audio", enabled: false });
  await assert.rejects(acceptCheckout(f.session, quote.id, quote.quoteHash, false, "http://localhost:4106", f.engine), /changed/); assert.equal(f.provider.calls.length, 1);
});
test("capture and compensating refund preserve immutable purchase history and replay safely", async () => {
  const f = await fixture(); const paid = await captureCheckout(f.session, f.order.id, f.engine); assert.equal(paid.state, "paid"); assert.equal(paid.capturedMinor, 1200);
  await captureCheckout(f.session, f.order.id, f.engine); assert.equal(f.provider.calls.filter(c => c.action.kind === "capture_order").length, 1);
  const refunded = await refundCheckout(f.session, f.order.id, f.engine); assert.equal(refunded.state, "refunded"); assert.equal(refunded.graphHash, f.order.graphHash); assert.equal(refunded.refundedMinor, 1200);
  await refundCheckout(f.session, f.order.id, f.engine); assert.equal(f.provider.calls.filter(c => c.action.kind === "refund_capture").length, 1);
});
test("an immediate completed create is never captured a second time", async () => {
  const { session } = await createSession(); const revision = await getRevision(session.id); const quote = await createQuote(session.id, revision); const provider = new FixtureProvider(); provider.instantCapture = true; const engine = Promise.resolve(createCommerceEngine(provider, store));
  const order = await acceptCheckout(session, quote.id, quote.quoteHash, false, "http://localhost:4106", engine); assert.equal(order.state, "paid"); await captureCheckout(session, order.id, engine); assert.equal(provider.calls.length, 1);
});
test("an unknown create remains pending and the same quote never creates another order", async () => {
  const { session } = await createSession(); const quote = await createQuote(session.id, await getRevision(session.id)); const provider = new FixtureProvider(); provider.unknown = true; const engine = Promise.resolve(createCommerceEngine(provider, store));
  const order = await acceptCheckout(session, quote.id, quote.quoteHash, false, "http://localhost:4106", engine); assert.equal(order.state, "payment_pending");
  await acceptCheckout(session, quote.id, quote.quoteHash, false, "http://localhost:4106", engine); assert.equal(provider.calls.length, 1);
});
test("+8 pending consumes authority, +20 escalates, and refund does not replenish the cap", async () => {
  const f = await policyFixture(); const first = await reserveRepair(f.session, f.policy.id, proposal(f, 800, "event-8")); assert.equal(first.claim.state, "reserved");
  const second = await reserveRepair(f.session, f.policy.id, proposal(f, 2000, "event-20")); assert.equal(second.claim.state, "escalated"); assert.equal(second.authority, null);
  await database().query("UPDATE wk_repair_claims SET payload=$1 WHERE id=$2", [{ ...first.claim, state: "refunded" }, first.claim.id]);
  const afterRefund = await reserveRepair(f.session, f.policy.id, proposal(f, 2000, "event-after-refund")); assert.equal(afterRefund.claim.state, "escalated");
});
test("two concurrent +15 proposals cannot both reserve a +25 cumulative allowance", async () => {
  const f = await policyFixture(); const result = await Promise.all([reserveRepair(f.session, f.policy.id, proposal(f, 1500, "race-a")), reserveRepair(f.session, f.policy.id, proposal(f, 1500, "race-b"))]);
  assert.equal(result.filter(r => r.claim.state === "reserved").length, 1); assert.equal(result.filter(r => r.claim.state === "escalated").length, 1);
});
test("revocation after reservation denies dispatch and duplicate repair events retain one claim", async () => {
  const f = await policyFixture(); const one = await reserveRepair(f.session, f.policy.id, proposal(f, 800, "same-event")); const two = await reserveRepair(f.session, f.policy.id, proposal(f, 800, "same-event")); assert.equal(one.claim.id, two.claim.id); assert.equal(two.authority, null);
  await revokeRepairPolicy(f.session, f.policy.id); const calls = f.provider.calls.length;
  await assert.rejects((await f.engine).core.execute(one.authority!.command), /revoked/); assert.equal(f.provider.calls.length, calls);
});
test("saved wallet IDs are encrypted in both domain authority and core SQL documents", async () => {
  const f = await policyFixture(); const prepared = await reserveRepair(f.session, f.policy.id, proposal(f, 800, "encrypted-command")); f.provider.instantCapture = true;
  const operation = await (await f.engine).core.execute(prepared.authority!.command); await syncOperation(f.session, prepared.claim.orderId!, operation);
  const authority = (await database().query("SELECT payload FROM wk_financial_authorities WHERE operation_id=$1", [operation.command.operationId])).rows[0].payload;
  const core = (await database().query("SELECT document FROM paycore_operations WHERE id=$1", [operation.command.operationId])).rows[0].document;
  assert.equal(JSON.stringify(authority).includes(f.wallet.tokenId!), false); assert.equal(core.includes(f.wallet.tokenId!), false);
  assert.equal((await store.get({ tenantId: f.session.id, projectId: "worldkit" }, operation.command.operationId))?.status, "succeeded");
});
test("lost Vault setup dispatch is claimed once, and exchange waits for actual APPROVED state", async () => {
  const { session } = await createSession(); const consent = await createWalletConsent(session, "http://localhost:4106", "separate_setup"); let writes = 0;
  const client = new PaypalClient({ serverOptions: { baseUrl: "https://api-m.sandbox.paypal.com" }, oauth2: { clientId: "fixture", clientSecret: "fixture" }, logging: { level: "off" }, retry: { maxRetries: 0 }, fetch: async request => { const req = request as Request; if (new URL(req.url).pathname === "/v1/oauth2/token") return Response.json({ access_token: "fixture", token_type: "Bearer", expires_in: 3600 }); writes++; throw new TypeError("fixture lost response"); } });
  const adapter = new VaultAdapter(client); const result = await beginWalletSetup(session, consent.id, adapter); assert.equal(result.state, "pending_reconciliation"); await beginWalletSetup(session, consent.id, adapter); assert.equal(writes, 1);
  await assert.rejects(completeWalletSetup(session, consent.id, adapter), /original wallet setup/); assert.equal(writes, 1);
});
test("wallet revocation is durable before the SDK delete request leaves the process", async () => {
  const f = await policyFixture(); let deletes = 0;
  const client = new PaypalClient({ serverOptions: { baseUrl: "https://api-m.sandbox.paypal.com" }, oauth2: { clientId: "fixture", clientSecret: "fixture" }, logging: { level: "off" }, retry: { maxRetries: 0 }, fetch: async request => { const req = request as Request; if (new URL(req.url).pathname === "/v1/oauth2/token") return Response.json({ access_token: "fixture", token_type: "Bearer", expires_in: 3600 }); assert.equal((await loadWallet(f.session.id, f.wallet.id)).state, "revoked"); assert.equal(req.method, "DELETE"); deletes++; return new Response(null, { status: 204 }); } });
  const result = await revokeWallet(f.session, f.wallet.id, new VaultAdapter(client)); assert.equal(result.state, "revoked"); await revokeWallet(f.session, f.wallet.id, new VaultAdapter(client)); assert.equal(deletes, 1);
});
