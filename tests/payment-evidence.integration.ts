import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CommerceOrder } from "../packages/commerce/contracts";
import type { ToolkitReadInput } from "../packages/commerce/toolkit-contracts";
import { hash } from "../packages/compatibility";
import { database, closeDatabase } from "../src/server/db";
import { createSession, createQuote, getRevision, createAccessToken, authenticateAccess, revokeAccessToken, commitEdit } from "../src/server/repository";
import { initializePaymentEvidence, paymentEvidenceDesk, readPaymentEvidence, toolkitAvailability } from "../src/server/payment-evidence";
import { ScopedPayPalToolkit } from "../src/server/paypal-toolkit";
import { requireIsolatedDatabase } from "./support/isolated-database";
import { startSampleRepair, processRepairQueue, proposeKitAmendment, type RepairCatalogRuntime } from "../src/server/living-repair";
import { livingRepairView } from "../src/server/living-repair-view";
import { acceptKitAmendment } from "../src/server/living-repair-payments";
import { loadOrder } from "../src/server/commerce";
import { acceptKitCompensation, compensationDigest, prepareKitCompensation } from "../src/server/living-repair-compensation";
import { sampleCatalog } from "../packages/living-repair/sample";
requireIsolatedDatabase();

before(async () => { assert.equal(process.env.WORLDKIT_DISABLE_PROVIDERS, "true"); await initializePaymentEvidence(); });
after(closeDatabase);
async function fixture() {
  const { session } = await createSession(), bundle = await getRevision(session.id), quote = await createQuote(session.id, bundle), id = randomUUID();
  const order: CommerceOrder = { id, tenantId: session.id, kitId: bundle.kit.kitId, revisionId: bundle.kit.id, graphHash: bundle.certificate.graphHash, quote, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), origin: "http://localhost:4523", state: "refunded", kind: "initial", parentOrderId: null, repairClaimId: null, approval: { id: "synthetic", version: 1, digest: hash("synthetic"), expiresAt: session.expiresAt }, walletConsentId: null, providerOrderId: `ORDER-${id}`, captureId: `CAPTURE-${id}`, approvalUrl: null, capturedMinor: 1200, refundedMinor: 1200, fulfilledAt: null, operationIds: [], error: null, sourceMode: "live_sandbox" };
  await database().query("INSERT INTO wk_commerce_orders(id,tenant_id,quote_id,payload) VALUES($1,$2,$3,$4)", [id, session.id, quote.id, order]);
  for (const resource of [{ kind: "order", id: order.providerOrderId, parentId: null, money: null, customId: id }, { kind: "capture", id: order.captureId, parentId: order.providerOrderId, money: { minor: 1200, currency: "USD" }, customId: null }]) {
    await database().query("INSERT INTO wk_payment_resources(provider_id,tenant_id,order_id,kind,payload) VALUES($1,$2,$3,$4,$5)", [resource.id, session.id, id, resource.kind, { ...resource, source: "live_sandbox", status: "REFUNDED", links: [], observedAt: new Date().toISOString() }]);
  }
  let calls = 0; let onRequest: (method: string) => Promise<void> = async () => {};
  const fetcher: typeof fetch = async (input, init = {}) => {
    calls++; await onRequest(init.method ?? "GET"); const url = new URL(String(input));
    if (url.pathname === "/v1/oauth2/token") return Response.json({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 300 });
    if (url.pathname === "/v1/reporting/transactions") return Response.json({ page: 1, total_items: 0, total_pages: 0 });
    return Response.json({ id: order.providerOrderId, status: "COMPLETED", purchase_units: [{ custom_id: order.id, payments: { captures: [{ id: order.captureId, status: "REFUNDED", amount: { currency_code: "USD", value: (order.capturedMinor / 100).toFixed(2) } }] } }] });
  };
  const reader = new ScopedPayPalToolkit("synthetic-id", "synthetic-secret", "synthetic_transport", fetcher);
  const input: ToolkitReadInput = { requestId: randomUUID(), orderId: id, expectedGraphHash: order.graphHash, operation: "get_order" };
  return { session, order, input, reader, calls: () => calls, hook: (fn: typeof onRequest) => { onRequest = fn; } };
}
async function repairFixture(supplemental = false) {
  const f = await fixture(), run = await startSampleRepair(f.session, "available-alternative", randomUUID());
  for (let i = 0; i < 4; i++) await processRepairQueue(f.session.id, run.id);
  const view = await livingRepairView(f.session, run.id), candidate = view.candidates.find(item => item.technicalState === "satisfied")!;
  const proposal = await proposeKitAmendment(f.session, run.id, candidate.id, candidate.digest);
  const amendment = await acceptKitAmendment(f.session, { amendmentId: proposal.proposal.id, proposalDigest: proposal.proposal.digest, paymentMode: "sample", authority: "buyer", origin: "http://localhost:4523" });
  let compensation = null;
  if (supplemental) {
    const catalog: RepairCatalogRuntime = { mode: "sample", refresh: async productId => { const response = sampleCatalog(productId, "available-alternative", "restore"); response.value.snapshot.offers[0]!.price!.minor = 25800; return response; }, similar: async () => { throw new Error("not used"); }, search: async () => { throw new Error("not used"); } };
    const request = await prepareKitCompensation(f.session, amendment.proposal.id, "undo", { catalog });
    compensation = await acceptKitCompensation(f.session, request.id, request.digest, "http://localhost:4523", { catalog });
    compensation.paymentMode = "live_sandbox"; compensation.digest = compensationDigest(compensation);
    await database().query("UPDATE wk_kit_compensations SET payload=$2 WHERE id=$1", [compensation.id, compensation]);
  }
  Object.assign(f.order, await loadOrder(f.session.id, compensation?.supplementalOrderId ?? amendment.orderId!));
  if (compensation) f.order.quote.quoteHash = compensation.digest;
  f.order.sourceMode = "live_sandbox"; f.order.livingRepair!.paymentMode = "live_sandbox";
  await database().query("UPDATE wk_commerce_orders SET payload=$2 WHERE id=$1", [f.order.id, f.order]);
  await database().query("UPDATE wk_kit_amendments SET payload=jsonb_set(payload,'{paymentMode}','\"live_sandbox\"') WHERE id=$1", [amendment.proposal.id]);
  await database().query("UPDATE wk_kit_repair_claims SET payload=jsonb_set(payload,'{paymentMode}','\"live_sandbox\"') WHERE id=$1", [amendment.claimId]);
  for (const resource of [{ kind: "order", id: f.order.providerOrderId, parentId: null, money: null, customId: f.order.id }, { kind: "capture", id: f.order.captureId, parentId: f.order.providerOrderId, money: { minor: f.order.capturedMinor, currency: "USD" }, customId: null }]) {
    await database().query("INSERT INTO wk_payment_resources(provider_id,tenant_id,order_id,kind,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_id) DO UPDATE SET payload=EXCLUDED.payload", [resource.id, f.session.id, f.order.id, resource.kind, { ...resource, source: "live_sandbox", status: "COMPLETED", links: [], observedAt: new Date().toISOString() }]);
  }
  f.input.orderId = f.order.id; f.input.expectedGraphHash = f.order.graphHash;
  return { ...f, amendment, compensation };
}
async function financialFingerprint(id: string) {
  const order = (await database().query("SELECT * FROM wk_commerce_orders WHERE id=$1", [id])).rows;
  const resources = (await database().query("SELECT * FROM wk_payment_resources WHERE order_id=$1 ORDER BY provider_id", [id])).rows;
  return hash({ order, resources });
}
test("official Toolkit observations are immutable, scoped, replayable and change no financial data", async () => {
  const f = await fixture(), before = await financialFingerprint(f.order.id);
  const first = await readPaymentEvidence({ session: f.session }, f.input, f.reader), again = await readPaymentEvidence({ session: f.session }, f.input, f.reader);
  assert.equal(first.state, "succeeded"); assert.equal(first.observation?.source, "synthetic_transport"); assert.deepEqual(first, again); assert.equal(f.calls(), 2);
  assert.equal(await financialFingerprint(f.order.id), before); const desk = await paymentEvidenceDesk(f.session); assert.equal(desk.records.length, 1); assert.deepEqual(desk.records[0], first);
  assert.deepEqual(desk.orders, [{ id: f.order.id, graphHash: f.order.graphHash, createdAt: f.order.createdAt, capturedMinor: 1200, purpose: "Studio service" }]);
  assert.equal(JSON.stringify(desk.orders).includes(f.order.captureId!), false);
});
test("concurrent duplicate identity dispatches once and exposes the saved running attempt", async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void; const blocked = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  f.hook(async method => { if (method === "POST") { entered(); await blocked; } });
  const pending = readPaymentEvidence({ session: f.session }, f.input, f.reader); await started;
  const duplicate = await readPaymentEvidence({ session: f.session }, f.input, f.reader); assert.equal(duplicate.state, "running"); assert.equal(f.calls(), 1); release();
  assert.equal((await pending).state, "succeeded"); assert.equal(f.calls(), 2);
});
test("same identity with another operation or caller is refused", async () => {
  const f = await fixture(); await readPaymentEvidence({ session: f.session }, f.input, f.reader);
  await assert.rejects(readPaymentEvidence({ session: f.session }, { ...f.input, operation: "list_transactions" }, f.reader), /different request or caller/);
  const grant = await createAccessToken(f.session, ["payment:read"]), principal = (await authenticateAccess(grant.token))!;
  await assert.rejects(readPaymentEvidence({ principal }, f.input, f.reader), /different request or caller/); assert.equal(f.calls(), 2);
});
test("foreign tenant, mismatched graph and sample order cannot reach OAuth", async () => {
  const f = await fixture(), other = await createSession();
  await assert.rejects(readPaymentEvidence({ session: other.session }, f.input, f.reader), /outside/);
  await assert.rejects(readPaymentEvidence({ session: f.session }, { ...f.input, expectedGraphHash: "f".repeat(64) }, f.reader), /exact saved graph/);
  await database().query("UPDATE wk_commerce_orders SET payload=jsonb_set(payload,'{sourceMode}','\"sample\"') WHERE id=$1", [f.order.id]);
  await assert.rejects(readPaymentEvidence({ session: f.session }, f.input, f.reader), /Sample and uncaptured/); assert.equal(f.calls(), 0);
});
test("payment scope is independent of existing kit scopes", async () => {
  const f = await fixture(), grant = await createAccessToken(f.session, ["kit:verify", "kit:propose", "kit:quote"]), principal = (await authenticateAccess(grant.token))!;
  await assert.rejects(readPaymentEvidence({ principal }, f.input, f.reader), /outside/); assert.equal(f.calls(), 0);
});
test("current grant revocation stops reads even with cached principal", async () => {
  const f = await fixture(), grant = await createAccessToken(f.session, ["payment:read"]), principal = (await authenticateAccess(grant.token))!;
  await revokeAccessToken(f.session, grant.id); await assert.rejects(readPaymentEvidence({ principal }, f.input, f.reader), /revoked/); assert.equal(f.calls(), 0);
});
test("grant revocation after OAuth prevents the business GET and retains failure", async () => {
  const f = await fixture(), grant = await createAccessToken(f.session, ["payment:read"]), principal = (await authenticateAccess(grant.token))!;
  f.hook(async method => { if (method === "POST") await revokeAccessToken(f.session, grant.id); });
  await assert.rejects(readPaymentEvidence({ principal }, f.input, f.reader), /revoked/); assert.equal(f.calls(), 1);
  const saved = (await paymentEvidenceDesk(f.session)).records[0]!; assert.equal(saved.state, "failed"); assert.equal(saved.observation, null);
});
test("removing current kit access after response prevents disclosure", async () => {
  const f = await fixture(), grant = await createAccessToken(f.session, ["payment:read"]), principal = (await authenticateAccess(grant.token))!;
  f.hook(async method => { if (method === "GET") await database().query("UPDATE wk_access_tokens SET kit_ids='[]'::jsonb WHERE id=$1", [grant.id]); });
  await assert.rejects(readPaymentEvidence({ principal }, f.input, f.reader), /outside/); assert.equal(f.calls(), 2); assert.equal((await paymentEvidenceDesk(f.session)).records[0]!.observation, null);
});
test("resource binding mutation during OAuth is withheld before GET", async () => {
  const f = await fixture(); f.hook(async method => { if (method === "POST") await database().query("UPDATE wk_payment_resources SET payload=jsonb_set(payload,'{parentId}','\"foreign\"') WHERE provider_id=$1", [f.order.captureId]); });
  await assert.rejects(readPaymentEvidence({ session: f.session }, f.input, f.reader), /outside/); assert.equal(f.calls(), 1); assert.equal((await paymentEvidenceDesk(f.session)).records[0]!.state, "failed");
});
test("current workspace expiration rejects old session and agent handles", async () => {
  const f = await fixture(), grant = await createAccessToken(f.session, ["payment:read"]), principal = (await authenticateAccess(grant.token))!;
  await database().query("UPDATE wk_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [f.session.id]);
  await assert.rejects(readPaymentEvidence({ session: f.session }, f.input, f.reader)); await assert.rejects(readPaymentEvidence({ principal }, f.input, f.reader)); assert.equal(f.calls(), 0);
});
test("a newer kit revision does not rewrite the historical paid graph", async () => {
  const f = await fixture(); await commitEdit(f.session, f.order.revisionId, f.order.graphHash, { kind: "connection", connectionId: "mic2-audio", enabled: false });
  const result = await readPaymentEvidence({ session: f.session }, f.input, f.reader); assert.equal(result.state, "succeeded"); assert.equal(result.observation?.binding.graphHash, f.order.graphHash);
});
test("interrupted read is retained and never silently redispatched", async () => {
  const f = await fixture(); f.hook(async method => { if (method === "GET") throw new Error("synthetic connection loss"); });
  const first = await readPaymentEvidence({ session: f.session }, f.input, f.reader); assert.equal(first.state, "failed");
  assert.deepEqual(await readPaymentEvidence({ session: f.session }, f.input, f.reader), first); assert.equal(f.calls(), 2);
});
test("workspace rate limits include every retained attempt", async () => {
  const f = await fixture(); for (let i = 0; i < 6; i++) await readPaymentEvidence({ session: f.session }, { ...f.input, requestId: randomUUID() }, f.reader);
  await assert.rejects(readPaymentEvidence({ session: f.session }, { ...f.input, requestId: randomUUID() }, f.reader), /Six evidence reads/); assert.equal(f.calls(), 12);
});
test("disabled production providers do not create an apparent provider attempt", async () => {
  const f = await fixture(); assert.equal(toolkitAvailability().available, false);
  await assert.rejects(readPaymentEvidence({ session: f.session }, f.input), /unavailable/); assert.equal((await paymentEvidenceDesk(f.session)).records.length, 0);
});
test("saved evidence selection includes controlled amendments and excludes foreign and Sample orders", async () => {
  const f = await fixture(), foreign = await fixture();
  await database().query("UPDATE wk_commerce_orders SET payload=payload||'{\"livingRepair\":{}}'::jsonb WHERE id=$1", [f.order.id]);
  const desk = await paymentEvidenceDesk(f.session); assert.equal(desk.orders.length, 1); assert.equal(desk.orders[0]!.purpose, "Controlled kit amendment"); assert.equal(JSON.stringify(desk.orders).includes(foreign.order.id), false);
  await database().query("UPDATE wk_commerce_orders SET payload=jsonb_set(payload,'{sourceMode}','\"sample\"') WHERE id=$1", [f.order.id]);
  assert.equal((await paymentEvidenceDesk(f.session)).orders.length, 0);
});
test("a controlled amendment resolves its exact accepted graph outside ordinary workspace revisions", async () => {
  const f = await repairFixture();
  assert.equal((await database().query("SELECT id FROM wk_revisions WHERE id=$1", [f.order.revisionId])).rowCount, 0);
  const result = await readPaymentEvidence({ session: f.session }, f.input, f.reader);
  assert.equal(result.state, "succeeded"); assert.equal(result.observation?.binding.revisionId, f.amendment.proposal.after.kit.id); assert.equal(f.calls(), 2);
});
test("controlled amendment tampering and a foreign commitment cannot reach OAuth", async () => {
  const f = await repairFixture();
  await database().query("UPDATE wk_kit_amendments SET proposal=jsonb_set(proposal,'{after,certificate,graphHash}','\"changed\"') WHERE id=$1", [f.amendment.proposal.id]);
  await assert.rejects(readPaymentEvidence({ session: f.session }, f.input, f.reader), /outside/); assert.equal(f.calls(), 0);
  const second = await repairFixture(); second.order.livingRepair!.commitmentId = f.order.livingRepair!.commitmentId;
  await database().query("UPDATE wk_commerce_orders SET payload=$2 WHERE id=$1", [second.order.id, second.order]);
  await assert.rejects(readPaymentEvidence({ session: second.session }, second.input, second.reader), /outside/); assert.equal(second.calls(), 0);
});
test("an accepted amendment manifest changing during OAuth prevents the resource GET", async () => {
  const f = await repairFixture(); f.hook(async method => { if (method === "POST") await database().query("UPDATE wk_kit_repair_claims SET payload=jsonb_set(payload,'{acceptedDigest}','\"changed\"') WHERE id=$1", [f.amendment.claimId]); });
  await assert.rejects(readPaymentEvidence({ session: f.session }, f.input, f.reader), /outside/); assert.equal(f.calls(), 1);
});
test("a separately consented restoration supplement resolves its historical restoration graph", async () => {
  const f = await repairFixture(true); assert.ok(f.compensation); assert.equal(f.order.capturedMinor, 200);
  const result = await readPaymentEvidence({ session: f.session }, f.input, f.reader); assert.equal(result.state, "succeeded"); assert.equal(result.observation?.binding.revisionId, f.compensation.restore!.kit.id);
  await database().query("UPDATE wk_kit_compensations SET payload=jsonb_set(payload,'{supplementalOrderId}','\"foreign\"') WHERE id=$1", [f.compensation.id]);
  await assert.rejects(readPaymentEvidence({ session: f.session }, { ...f.input, requestId: randomUUID() }, f.reader), /outside/); assert.equal(f.calls(), 2);
});
