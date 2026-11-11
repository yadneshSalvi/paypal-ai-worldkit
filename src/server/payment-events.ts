import { randomUUID } from "node:crypto";
import { canonicalJson, payloadHash, type PaymentCore, type PaymentOperation, type ProviderAdapter, type ProviderResource, type SqlPaymentStore } from "@fracture/paypal-core";
import type { PoolClient } from "pg";
import type { CommerceOrder, FinancialAuthority, PaymentHealth, RepairClaim, RepairPolicy } from "../../packages/commerce/contracts";
import { paymentNeedsReview, projectPaymentResources } from "../../packages/commerce/observations";
import { safeApprovalUrl } from "../../packages/commerce/policy";
import { WorldKitError } from "../../packages/contracts";
import { sandboxParent, type PaymentSignal } from "../../packages/webhooks/contracts";
import { database } from "./db";
import { loadOrder, paymentEngine } from "./commerce";
import { orderResources, storeOwnedPaymentResource } from "./payment-resources";
import { publishNotification } from "./notifications";
import { appendEvent } from "./repository";
import { unseal } from "./secrets";
import { finishWebhook, type EventOwners, type WebhookClaim } from "./webhooks";

export type PaymentReadRuntime = { provider: Pick<ProviderAdapter, "source" | "read">; store: Pick<SqlPaymentStore, "get">; core: Pick<PaymentCore, "reconcile"> };
const reject = (message: string): never => { throw new WorldKitError("needs_evidence", message, 409); };
const observedNow = () => new Date().toISOString();

async function acceptedOperations(order: CommerceOrder, runtime: PaymentReadRuntime): Promise<PaymentOperation[]> {
  const rows = await database().query("SELECT operation_id,payload FROM wk_financial_authorities WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at LIMIT 12", [order.tenantId, order.id]);
  const operations: PaymentOperation[] = [];
  for (const row of rows.rows) {
    const authority = unseal<FinancialAuthority>(order.tenantId, row.payload);
    const operation = await runtime.store.get({ tenantId: order.tenantId, projectId: "worldkit" }, row.operation_id);
    if (!operation) continue;
    if (authority.tenantId !== order.tenantId || authority.orderId !== order.id || authority.command.operationId !== row.operation_id || !order.operationIds.includes(row.operation_id) || operation.command.scope.tenantId !== order.tenantId || operation.command.scope.projectId !== "worldkit" || canonicalJson(authority.command) !== canonicalJson(operation.command) || operation.command.payloadHash !== payloadHash(operation.command.action)) reject("The payment event has no matching accepted operation in this order.");
    if (operation.receipt && (operation.receipt.source !== runtime.provider.source || operation.receipt.resources.some(resource => resource.source !== runtime.provider.source))) reject("The payment event and its accepted operation have different evidence sources.");
    operations.push(operation);
  }
  return operations;
}

async function retireObservedPolicies(db: PoolClient, order: CommerceOrder) {
  const reason: RepairPolicy["endedReason"] | null = order.refundedMinor > 0 ? "base_refunded" : paymentNeedsReview(order) ? "payment_review" : null;
  if (!reason) return;
  const rows = await db.query("SELECT id,payload FROM wk_repair_policies WHERE tenant_id=$1 AND payload->>'baseOrderId'=$2 AND payload->>'revokedAt' IS NULL FOR UPDATE", [order.tenantId, order.id]);
  for (const row of rows.rows) {
    await db.query("UPDATE wk_repair_policies SET payload=$2 WHERE id=$1", [row.id, { ...row.payload, revokedAt: observedNow(), endedReason: reason }]);
    await appendEvent(db, order.tenantId, "policy.ended", "Automatic setup changes ended", "The original payment has a refund or an unresolved provider observation. Its existing policy is closed; gross spent and pending history remains recorded.", order.revisionId, order.sourceMode === "live_sandbox" ? "live" : order.sourceMode);
  }
}

/** This worker's runtime intentionally has no execute/retry/refund interface.
 * A callback can reconcile a saved operation and reread its owned resources. */
export async function processPaymentEvent(job: WebhookClaim, owners: EventOwners, suppliedRuntime?: PaymentReadRuntime): Promise<void> {
  if (!owners.orderId || owners.tenantIds.length !== 1 || !job.signal) reject("This event has no unambiguous owned order.");
  const signal = job.signal as PaymentSignal;
  const tenantId = owners.tenantIds[0]!;
  const original = await loadOrder(tenantId, owners.orderId!);
  const runtime = suppliedRuntime ?? await paymentEngine();
  const expectedSource = job.source_mode === "live" ? "live_sandbox" : job.source_mode;
  if (runtime.provider.source !== expectedSource) reject("Live, sample and replay payment observations cannot be mixed.");
  const deadline = AbortSignal.timeout(90_000);
  const operations = await acceptedOperations(original, runtime);
  if (!operations.length) reject("This order has no accepted payment operation to reconcile.");
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!;
    if (["dispatching", "pending_reconciliation"].includes(operation.status)) {
      const reconciled = await runtime.core.reconcile(operation.command.scope, operation.command.operationId, deadline);
      if (canonicalJson(reconciled.command) !== canonicalJson(operation.command) || reconciled.receipt && (reconciled.receipt.source !== expectedSource || reconciled.receipt.resources.some(resource => resource.source !== expectedSource))) reject("Reconciliation returned a different accepted operation or evidence source.");
      operations[index] = reconciled;
    }
  }
  const saved = await orderResources(database(), original);
  const anchors = [...saved, ...operations.flatMap(operation => operation.receipt?.resources ?? [])];
  if (anchors.some(resource => resource.source !== expectedSource)) reject("The order contains a different source of payment evidence.");
  const orderIds = [...new Set(anchors.filter(resource => resource.kind === "order").map(resource => resource.id))];
  if (orderIds.length !== 1 || original.providerOrderId && original.providerOrderId !== orderIds[0]) reject("The accepted operation does not establish one exact provider order.");
  const providerOrderId = orderIds[0]!;
  if (signal.identityConflict || signal.relatedOrderId && signal.relatedOrderId !== providerOrderId || signal.resourceKind === "order" && signal.resourceId !== providerOrderId) reject("The callback names a different order from the accepted payment.");

  const fresh = await runtime.provider.read("order", providerOrderId, deadline);
  const providerOrder = fresh.find(resource => resource.kind === "order" && resource.id === providerOrderId);
  if (!providerOrder || fresh.filter(resource => resource.kind === "order").length !== 1 || fresh.some(resource => resource.source !== expectedSource || !Number.isFinite(Date.parse(resource.observedAt)) || resource.kind === "order" && resource.id !== providerOrderId || resource.kind !== "order" && resource.parentId !== providerOrderId)) reject("The fresh provider response does not establish the owned order and its child resources.");
  const captureIds = [...new Set([...anchors, ...fresh].filter(resource => resource.kind === "capture").map(resource => resource.id))];
  if (captureIds.length > 1) reject("This Studio order has more than one capture identity and requires an explicit payment review.");
  if (signal.relatedCaptureId && !captureIds.includes(signal.relatedCaptureId) || signal.resourceKind === "capture" && !captureIds.includes(signal.resourceId)) reject("The event's capture does not belong to the freshly read order.");
  const captureId = captureIds[0] ?? null;
  if (captureId) {
    const values = await runtime.provider.read("capture", captureId, deadline);
    const capture = values.find(resource => resource.kind === "capture" && resource.id === captureId);
    if (!capture || capture.source !== expectedSource || capture.money?.currency !== "USD" || capture.money.minor !== original.quote.total.minor || sandboxParent(capture.links, "order") && sandboxParent(capture.links, "order") !== providerOrderId) reject("The exact current capture does not match this order's accepted amount and parent.");
    fresh.push({ ...capture!, parentId: providerOrderId });
  }
  if (signal.resourceKind === "refund") {
    const refundId = signal.resourceId;
    const alreadyOwned = anchors.some(resource => resource.kind === "refund" && resource.id === refundId);
    const listedByOrder = fresh.some(resource => resource.kind === "refund" && resource.id === refundId && resource.parentId === providerOrderId);
    if (!captureId || !alreadyOwned && !listedByOrder && signal.relatedCaptureId !== captureId) reject("This refund has no established relationship to an owned capture.");
    if (signal.relatedRefundId && signal.relatedRefundId !== refundId) reject("The callback's refund identities disagree.");
    const values = await runtime.provider.read("refund", refundId, deadline);
    const refund = values.find(resource => resource.kind === "refund" && resource.id === refundId);
    const parent = refund ? sandboxParent(refund.links, "capture") : null;
    if (!refund || refund.source !== expectedSource || refund.money?.currency !== "USD" || !Number.isSafeInteger(refund.money.minor) || refund.money.minor < 0 || refund.money.minor > original.quote.total.minor || parent && parent !== captureId || !alreadyOwned && !listedByOrder && parent !== captureId) reject("The fresh refund does not establish this exact owned capture and amount.");
    fresh.push({ ...refund!, parentId: captureId });
  }
  const observedAt = observedNow();
  let health: PaymentHealth = { status: "clear", reason: "The owned order and current payment resources were reread from the provider.", observedAt, webhookId: job.id };
  if (signal.type === "PAYMENT.CAPTURE.REVERSED" && !fresh.some(resource => resource.kind === "capture" && ["REVERSED", "REFUNDED"].includes(resource.status))) health = { ...health, status: "needs_review", reason: "The signed reversal notification and current capture response disagree. Gross history is retained and automatic changes are paused for review." };
  if (fresh.some(resource => resource.kind === "refund" && resource.id === signal.resourceId && ["FAILED", "CANCELLED"].includes(resource.status))) health = { ...health, status: "needs_review", reason: "PayPal did not complete the requested refund. The original capture remains recorded and the refund needs review." };
  if (original.paymentHealth && ["needs_review", "reversed"].includes(original.paymentHealth.status) && health.status === "clear" && !fresh.some(resource => resource.kind === "refund" && resource.status === "COMPLETED")) health = { ...original.paymentHealth, observedAt, webhookId: job.id };
  await persistPaymentObservation(job, original, anchors, fresh, providerOrder!, health);
}

async function persistPaymentObservation(job: WebhookClaim, original: CommerceOrder, anchors: ProviderResource[], fresh: ProviderResource[], providerOrder: ProviderResource, health: PaymentHealth) {
  const signal = job.signal as PaymentSignal; const tenantId = original.tenantId;
  const expectedSource = job.source_mode === "live" ? "live_sandbox" : job.source_mode; const observedAt = health.observedAt;
  await finishWebhook(job, "completed", { orderId: original.id, resourceIds: [...new Set(fresh.map(resource => resource.id))], observedAt, source: expectedSource, financialWrites: 0 }, null, 0, async db => {
    await db.query("SELECT id FROM wk_commerce_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, original.id]);
    let order = await loadOrder(tenantId, original.id, db);
    if ((await orderResources(db, order)).some(resource => resource.source !== expectedSource)) reject("This order's payment evidence changed source while it was reread.");
    order.sourceMode = expectedSource;
    for (const resource of [...anchors, ...fresh]) await storeOwnedPaymentResource(db, order, resource);
    order.providerOrderId = providerOrder.id;
    order.approvalUrl = safeApprovalUrl(providerOrder.links.find(link => ["approve", "payer-action"].includes(link.rel))?.href);
    order.error = null;
    order = projectPaymentResources(order, await orderResources(db, order), health);
    order.updatedAt = observedAt;
    await db.query("UPDATE wk_commerce_orders SET payload=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, order.id, order]);
    if (order.repairClaimId) {
      const row = (await db.query("SELECT payload FROM wk_repair_claims WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, order.repairClaimId])).rows[0];
      if (row) {
        const claim = row.payload as RepairClaim;
        claim.state = order.state === "refunded" ? "refunded" : order.capturedMinor > 0 ? "paid" : order.state === "refused" ? "refused" : "payment_pending";
        if (claim.state === "refunded") claim.reversedAt ??= observedAt;
        await db.query("UPDATE wk_repair_claims SET payload=$2 WHERE id=$1", [claim.id, claim]);
      }
    }
    await retireObservedPolicies(db, order);
    await db.query("INSERT INTO wk_payment_observations(id,tenant_id,order_id,webhook_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(webhook_id,order_id) DO NOTHING", [randomUUID(), tenantId, order.id, job.id, { eventId: signal.eventId, signal, sourceMode: job.source_mode, source: expectedSource, resources: fresh, observedAt, state: order.state, paymentHealth: order.paymentHealth, financialWrites: 0 }]);
    await appendEvent(db, tenantId, "payment.observed", "A provider payment update is saved", `The current Studio order is ${order.state.replaceAll("_", " ")}. Gross capture and refund history remain attached to the original purchased graph.`, order.revisionId, job.source_mode);
    await publishNotification(db, tenantId, `webhook:${job.id}:order:${order.id}`, { kind: "payment-observation", title: paymentNeedsReview(order) ? "A payment update needs review" : "Your payment record is up to date", detail: order.paymentHealth?.status !== "clear" ? order.paymentHealth?.reason ?? "Review the saved Studio receipt." : `The Studio order is ${order.state.replaceAll("_", " ")}. Open its retained receipt in Studio.`, sourceMode: job.source_mode, incidentId: null, orderId: order.id });
  });
}
