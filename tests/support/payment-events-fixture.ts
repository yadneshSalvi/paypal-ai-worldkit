import { randomUUID } from "node:crypto";
import { ProviderError, SqlPaymentStore, payloadHash, type PaymentCommand, type PaymentOperation, type ProviderAdapter, type ProviderReceipt, type ProviderResource } from "@fracture/paypal-core";
import type { WalletConsent } from "../../packages/commerce/contracts";
import { acceptCheckout, captureCheckout, createCommerceEngine, enableRepairPolicy } from "../../src/server/commerce";
import { initializeCommerce, paymentDatabase } from "../../src/server/commerce-db";
import { createQuote, createSession, getRevision } from "../../src/server/repository";
import { database } from "../../src/server/db";
import { createWalletConsent } from "../../src/server/wallets";
import { seal } from "../../src/server/secrets";

export class PaymentEventFixture implements ProviderAdapter {
  readonly source = "sample" as const;
  writes: PaymentCommand[] = []; reads: { kind: string; id: string }[] = []; resources = new Map<string, ProviderResource>();
  loseCapture = false; holdReconcile = false;
  make(kind: ProviderResource["kind"], id: string, status: string, command: PaymentCommand, parentId: string | null = null): ProviderResource {
    const links = kind === "order" ? status === "CREATED" ? [{ rel: "approve", method: "GET", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] : [] : parentId ? [{ rel: "up", method: "GET", href: `https://api-m.sandbox.paypal.com/v2/${kind === "refund" ? "payments/captures" : "checkout/orders"}/${parentId}` }] : [];
    return { kind, id, status, money: kind === "order" ? null : command.action.money, parentId, observedAt: new Date().toISOString(), source: "sample", customId: command.action.kind === "create_order" ? command.action.customId : null, links };
  }
  receipt(command: PaymentCommand, resources: ProviderResource[], reconciled = false): ProviderReceipt {
    return { id: randomUUID(), operationId: command.operationId, providerRequestId: command.providerRequestId, transport: "local_fixture", source: "sample", status: reconciled ? 200 : 201, resources, observedAt: new Date().toISOString(), debugId: null, bodyHash: payloadHash(command.action), reconciled };
  }
  async execute(command: PaymentCommand): Promise<ProviderReceipt> {
    this.writes.push(command); let resources: ProviderResource[]; const action = command.action;
    if (action.kind === "create_order") resources = [this.make("order", `fixture-order-${randomUUID()}`, "CREATED", command)];
    else if (action.kind === "capture_order") resources = [this.make("order", action.orderId, "COMPLETED", command), this.make("capture", `fixture-capture-${randomUUID()}`, "COMPLETED", command, action.orderId)];
    else if (action.kind === "refund_capture") resources = [this.make("refund", `fixture-refund-${randomUUID()}`, "COMPLETED", command, action.captureId)];
    else throw new Error("Unsupported synthetic payment action");
    for (const resource of resources) this.resources.set(resource.id, resource);
    if (action.kind === "capture_order" && this.loseCapture) throw new ProviderError("timeout", "Synthetic accepted capture with a lost response", "unknown", 502);
    return this.receipt(command, resources);
  }
  async read(kind: ProviderResource["kind"], id: string): Promise<ProviderResource[]> {
    this.reads.push({ kind, id }); const current = this.resources.get(id); if (!current || current.kind !== kind) return [];
    const at = new Date().toISOString();
    if (kind !== "order") return [{ ...current, parentId: null, observedAt: at }];
    const captures = [...this.resources.values()].filter(resource => resource.kind === "capture" && resource.parentId === id);
    const refunds = [...this.resources.values()].filter(resource => resource.kind === "refund" && captures.some(capture => capture.id === resource.parentId));
    return [current, ...captures, ...refunds].map(resource => ({ ...resource, parentId: resource.kind === "order" ? null : id, observedAt: at }));
  }
  async reconcile(operation: PaymentOperation): Promise<ProviderReceipt | null> {
    if (this.holdReconcile) return null;
    const action = operation.command.action;
    if (action.kind === "capture_order") {
      const resources = await this.read("order", action.orderId);
      return resources.some(resource => resource.kind === "capture") ? this.receipt(operation.command, resources, true) : null;
    }
    return null;
  }
  externalRefund(captureId: string, minor: number, status = "COMPLETED") {
    const capture = this.resources.get(captureId)!; const id = `fixture-external-refund-${randomUUID()}`;
    const refund: ProviderResource = { kind: "refund", id, status, source: "sample", money: { currency: "USD", minor }, parentId: captureId, customId: null, observedAt: new Date().toISOString(), links: [{ rel: "up", method: "GET", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}` }] };
    this.resources.set(id, refund);
    if (status === "COMPLETED") this.resources.set(captureId, { ...capture, status: minor >= capture.money!.minor ? "REFUNDED" : "PARTIALLY_REFUNDED", observedAt: new Date().toISOString() });
    return refund;
  }
}
export async function paymentEventFixture(options: { paid?: boolean; policy?: boolean; lostCapture?: boolean } = {}) {
  await initializeCommerce(); const store = new SqlPaymentStore(paymentDatabase); await store.initialize();
  const { session } = await createSession(); const revision = await getRevision(session.id); const quote = await createQuote(session.id, revision);
  const provider = new PaymentEventFixture(); provider.loseCapture = options.lostCapture ?? false; provider.holdReconcile = options.lostCapture ?? false;
  const runtime = createCommerceEngine(provider, store); const engine = Promise.resolve(runtime);
  let order = await acceptCheckout(session, quote.id, quote.quoteHash, false, "http://localhost:4106", engine);
  if (options.paid !== false) order = await captureCheckout(session, order.id, engine);
  if (!options.policy) return { session, revision, quote, provider, runtime, engine, order, policy: null, wallet: null };
  const consent = await createWalletConsent(session, "http://localhost:4106", "separate_setup");
  const wallet: WalletConsent = { ...consent, state: "active", tokenId: `synthetic-wallet-${randomUUID()}`, customerId: "synthetic-customer", payerId: "synthetic-payer", verifiedAt: new Date().toISOString() };
  await database().query("UPDATE wk_wallet_consents SET payload=$2 WHERE id=$1", [wallet.id, seal(session.id, wallet)]);
  const policy = await enableRepairPolicy(session, order.id, wallet.id, wallet.digest);
  return { session, revision, quote, provider, runtime, engine, order, policy, wallet };
}
