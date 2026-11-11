import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ProviderResource } from "@fracture/paypal-core";
import { closeDatabase, database } from "../src/server/db";
import { authorizePayment, deliverDossier, loadOrder, reserveRepair, syncOperation } from "../src/server/commerce";
import { acceptWebhook, claimWebhook, webhookSummaries } from "../src/server/webhooks";
import { executeWebhook } from "../src/server/webhook-runner";
import { unresolvedPaymentEvents } from "../src/server/payment-event-holds";
import { livingView } from "../src/server/living-kit";
import { getRevision } from "../src/server/repository";
import { paypalHeaders } from "./support/webhook-fixtures";
import { paymentEventFixture } from "./support/payment-events-fixture";

after(async () => { await closeDatabase(); });
type Fixture = Awaited<ReturnType<typeof paymentEventFixture>>;
async function paymentEvent(f: Fixture, options: { type?: string; resource?: ProviderResource; relatedOrderId?: string } = {}) {
  const resource = options.resource ?? [...f.provider.resources.values()].find(value => value.kind === "capture")!;
  const namespace = `payment-fixture-${randomUUID()}`;
  const event = { id: `fixture-event-${randomUUID()}`, event_type: options.type ?? "PAYMENT.CAPTURE.COMPLETED", create_time: new Date().toISOString(), resource_type: resource.kind,
    resource: { id: resource.id, custom_id: f.order.id, links: resource.links, supplementary_data: { related_ids: { order_id: options.relatedOrderId ?? f.order.providerOrderId, ...(resource.kind === "refund" ? { capture_id: resource.parentId } : {}) } } } };
  const raw = JSON.stringify(event, null, 2); const headers = paypalHeaders();
  const accept = () => acceptWebhook("paypal", raw, headers, { sourceMode: "sample", namespace, paypalVerifier: { verify: async (body, received) => { assert.equal(body, raw); return { verified: true, transmissionId: received.get("paypal-transmission-id")! }; } } });
  await accept();
  const process = async () => { const job = await claimWebhook(undefined, namespace); assert.ok(job); await executeWebhook(job, { payments: f.runtime }); return job; };
  return { accept, process, namespace, event };
}
async function policy(f: Fixture) { return (await database().query("SELECT payload FROM wk_repair_policies WHERE id=$1", [f.policy!.id])).rows[0].payload; }

test("duplicate PayPal transmissions reconcile once using reads only and retain original purchase identity", async () => {
  const f = await paymentEventFixture(); const before = await getRevision(f.session.id); const writes = f.provider.writes.length;
  const event = await paymentEvent(f); await Promise.all([event.accept(), event.accept()]); const job = await event.process();
  const order = await loadOrder(f.session.id, f.order.id); assert.equal(order.sourceMode, "sample"); assert.equal(order.state, "paid"); assert.equal(order.capturedMinor, 1200); assert.equal(order.refundedMinor, 0);
  assert.equal(f.provider.writes.length, writes); assert.ok(f.provider.reads.some(read => read.kind === "order")); assert.deepEqual(await getRevision(f.session.id), before);
  assert.equal((await database().query("SELECT id FROM wk_payment_observations WHERE webhook_id=$1", [job.id])).rowCount, 1);
  const view = await livingView(f.session.id); assert.equal(view.events[0]!.deliveries, 3); assert.equal(view.events[0]!.state, "completed"); assert.equal(view.notifications.length, 1);
  await event.accept(); assert.equal(await claimWebhook(undefined, event.namespace), null); assert.equal(f.provider.writes.length, writes);
});
test("an unfinished authenticated update blocks delivery and authority until owned-resource reconciliation finishes", async () => {
  const f = await paymentEventFixture(); const event = await paymentEvent(f);
  await assert.rejects(deliverDossier(f.session, f.order.id), /reconciled/);
  const op = await f.runtime.store.get({ tenantId: f.session.id, projectId: "worldkit" }, `capture:${f.order.id}`); assert.ok(op);
  assert.equal((await authorizePayment(op.command, f.provider)).allowed, false);
  await event.process(); assert.equal((await unresolvedPaymentEvents([await loadOrder(f.session.id, f.order.id)])).size, 0);
});
test("a core receipt recovers a missing domain capture projection without a second capture", async () => {
  const f = await paymentEventFixture(); const writes = f.provider.writes.length;
  const capture = [...f.provider.resources.values()].find(value => value.kind === "capture")!;
  await database().query("DELETE FROM wk_payment_resources WHERE tenant_id=$1 AND provider_id=$2", [f.session.id, capture.id]);
  const event = await paymentEvent(f); await event.process();
  assert.equal((await webhookSummaries(f.session.id))[0]!.state, "completed");
  assert.equal((await database().query("SELECT provider_id FROM wk_payment_resources WHERE tenant_id=$1 AND provider_id=$2", [f.session.id, capture.id])).rowCount, 1);
  assert.equal(f.provider.writes.length, writes);
});
test("a lost accepted capture response reconciles the original operation without repeating its mutation", async () => {
  const f = await paymentEventFixture({ lostCapture: true }); assert.equal(f.order.capturedMinor, 0); const writes = f.provider.writes.length;
  f.provider.holdReconcile = false;
  const event = await paymentEvent(f); await event.process();
  const order = await loadOrder(f.session.id, f.order.id); assert.equal(order.capturedMinor, 1200); assert.equal(order.state, "paid");
  assert.equal(f.provider.writes.length, writes); assert.equal(f.provider.writes.filter(write => write.action.kind === "capture_order").length, 1);
});
test("an external partial refund retires standing authority and preserves gross payment and amendment claims", async () => {
  const f = await paymentEventFixture({ policy: true });
  const reserved = await reserveRepair(f.session, f.policy!.id, { scenarioId: "synthetic-stock-change", title: "Synthetic proposal", detail: "No external charge", minor: 800, businessKey: `fixture-${randomUUID()}`, revision: f.revision });
  const old = await f.runtime.store.get({ tenantId: f.session.id, projectId: "worldkit" }, `capture:${f.order.id}`); assert.ok(old);
  const refund = f.provider.externalRefund(f.order.captureId!, 400); const event = await paymentEvent(f, { type: "PAYMENT.CAPTURE.REFUNDED", resource: refund }); const writes = f.provider.writes.length;
  await event.process(); let order = await loadOrder(f.session.id, f.order.id);
  assert.equal(order.state, "partially_refunded"); assert.equal(order.capturedMinor, 1200); assert.equal(order.refundedMinor, 400); assert.equal((await policy(f)).endedReason, "base_refunded");
  await syncOperation(f.session, f.order.id, old); order = await loadOrder(f.session.id, f.order.id); assert.equal(order.refundedMinor, 400); assert.equal(order.state, "partially_refunded");
  const claim = (await database().query("SELECT payload FROM wk_repair_claims WHERE id=$1", [reserved.claim.id])).rows[0].payload; assert.equal(claim.additionalMinor, 800); assert.equal(claim.state, "reserved");
  assert.equal(f.provider.writes.length, writes);
});
test("a reversal remains distinct from a refund and permanently closes the original repair policy", async () => {
  const f = await paymentEventFixture({ policy: true }); const capture = f.provider.resources.get(f.order.captureId!)!;
  f.provider.resources.set(capture.id, { ...capture, status: "REVERSED" }); const event = await paymentEvent(f, { type: "PAYMENT.CAPTURE.REVERSED" }); await event.process();
  const order = await loadOrder(f.session.id, f.order.id); assert.equal(order.state, "payment_pending"); assert.equal(order.paymentHealth?.status, "reversed"); assert.equal(order.refundedMinor, 0); assert.equal(order.capturedMinor, 1200); assert.equal((await policy(f)).endedReason, "payment_review");
});
test("a pending refund settles only after a current completed receipt, retaining the original gross capture", async () => {
  const f = await paymentEventFixture(); const refund = f.provider.externalRefund(f.order.captureId!, 1200, "PENDING");
  const pending = await paymentEvent(f, { type: "PAYMENT.REFUND.PENDING", resource: refund }); await pending.process();
  assert.equal((await loadOrder(f.session.id, f.order.id)).refundedMinor, 0); assert.equal((await loadOrder(f.session.id, f.order.id)).paymentHealth?.status, "pending");
  f.provider.resources.set(refund.id, { ...refund, status: "COMPLETED" }); const capture = f.provider.resources.get(f.order.captureId!)!; f.provider.resources.set(capture.id, { ...capture, status: "REFUNDED" });
  const settled = await paymentEvent(f, { type: "PAYMENT.CAPTURE.REFUNDED", resource: { ...refund, status: "COMPLETED" } }); await settled.process();
  const order = await loadOrder(f.session.id, f.order.id); assert.equal(order.state, "refunded"); assert.equal(order.refundedMinor, 1200); assert.equal(order.capturedMinor, 1200); assert.equal(order.paymentHealth?.status, "clear");
});
test("an event naming two tenants is quarantined before either provider can be read", async () => {
  const a = await paymentEventFixture(); const b = await paymentEventFixture();
  const event = await paymentEvent(a, { relatedOrderId: b.order.providerOrderId! }); assert.equal(await claimWebhook(undefined, event.namespace), null);
  assert.equal(a.provider.reads.length, 0); assert.equal(b.provider.reads.length, 0);
  const stored = (await database().query("SELECT state,tenant_ids FROM wk_webhook_events WHERE namespace=$1", [event.namespace])).rows[0]; assert.equal(stored.state, "dead_letter"); assert.deepEqual(stored.tenant_ids, []);
});
test("a mismatched fresh amount cannot clear a payment hold or replace accepted payment history", async () => {
  const f = await paymentEventFixture(); const capture = f.provider.resources.get(f.order.captureId!)!;
  f.provider.resources.set(capture.id, { ...capture, money: { currency: "USD", minor: 1201 } }); const event = await paymentEvent(f); await event.process();
  const order = await loadOrder(f.session.id, f.order.id); assert.equal(order.capturedMinor, 1200); assert.equal(order.refundedMinor, 0); assert.equal((await webhookSummaries(f.session.id))[0]!.state, "dead_letter"); assert.equal((await unresolvedPaymentEvents([order])).get(order.id), 1);
  await assert.rejects(deliverDossier(f.session, f.order.id), /reconciled/);
});

test("an extra order identity in a malformed fresh read cannot acquire another payment resource", async () => {
  const f = await paymentEventFixture(); const foreignId = `fixture-foreign-${randomUUID()}`; const read = f.provider.read.bind(f.provider);
  f.provider.read = async (kind, id) => { const resources = await read(kind, id); return kind === "order" ? [...resources, { ...resources[0]!, id: foreignId }] : resources; };
  const event = await paymentEvent(f); await event.process();
  assert.equal((await webhookSummaries(f.session.id))[0]!.state, "dead_letter"); assert.equal((await database().query("SELECT provider_id FROM wk_payment_resources WHERE provider_id=$1", [foreignId])).rowCount, 0);
});

test("a late payment worker cannot replace the refund observed after its lease expired", async () => {
  const f = await paymentEventFixture(); const event = await paymentEvent(f); const old = await claimWebhook(undefined, event.namespace); assert.ok(old);
  let resume!: () => void; let entered!: () => void; const waiting = new Promise<void>(resolve => { resume = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const originalRead = f.provider.read.bind(f.provider); let first = true;
  const running = executeWebhook(old, { payments: { ...f.runtime, provider: { source: "sample", read: async (kind, id) => { const value = await originalRead(kind, id); if (first) { first = false; entered(); await waiting; } return value; } } } });
  await started; f.provider.externalRefund(f.order.captureId!, 1200);
  await database().query("UPDATE wk_webhook_events SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [old.id]);
  const fresh = await claimWebhook(undefined, event.namespace); assert.ok(fresh); await executeWebhook(fresh, { payments: f.runtime }); resume(); await running;
  const order = await loadOrder(f.session.id, f.order.id); assert.equal(order.state, "refunded"); assert.equal(order.refundedMinor, 1200); assert.equal(order.capturedMinor, 1200);
  assert.equal((await database().query("SELECT id FROM wk_payment_observations WHERE webhook_id=$1", [old.id])).rowCount, 1); assert.equal((await livingView(f.session.id)).notifications.length, 1);
});
