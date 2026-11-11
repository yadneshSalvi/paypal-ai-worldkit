import type { ProviderResource } from "@fracture/paypal-core";
import type { CommerceOrder, PaymentHealth } from "./contracts";

export function paymentNeedsReview(order: CommerceOrder): boolean {
  return Boolean(order.paymentHealth && order.paymentHealth.status !== "clear");
}

/** Payment history is gross history. Current observations may stop delivery or
 * authority, but cannot erase money that was previously captured or refunded. */
export function projectPaymentResources(previous: CommerceOrder, resources: ProviderResource[], health?: PaymentHealth): CommerceOrder {
  const order = structuredClone(previous);
  const valid = resources.filter(resource => resource.source === order.sourceMode);
  const captures = valid.filter(resource => resource.kind === "capture" && resource.money?.currency === "USD" && resource.money.minor === order.quote.total.minor);
  const captured = captures.filter(resource => ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "REVERSED"].includes(resource.status));
  if (captured.length === 1) { order.captureId = captured[0]!.id; order.capturedMinor = Math.max(order.capturedMinor, captured[0]!.money!.minor); order.approvalUrl = null; }
  const refunds = valid.filter(resource => resource.kind === "refund" && resource.status === "COMPLETED" && resource.money?.currency === "USD");
  const settled = refunds.reduce((sum, resource) => sum + resource.money!.minor, 0);
  const review = (reason: string): PaymentHealth => ({ status: "needs_review", reason, observedAt: health?.observedAt ?? new Date().toISOString(), webhookId: health?.webhookId ?? order.paymentHealth?.webhookId ?? null });
  if (settled <= order.capturedMinor) order.refundedMinor = Math.max(order.refundedMinor, settled);
  let nextHealth = health ?? order.paymentHealth;
  if (previous.state === "cancelled" && order.capturedMinor > 0) nextHealth = review("A completed capture was observed after this order was cancelled locally. The money remains recorded and needs support review.");
  if (captured.length > 1 || settled > order.capturedMinor) nextHealth = review("Provider resources do not establish one capture and a valid refund total for this order. Gross history remains unchanged.");
  const capture = captures.find(resource => resource.id === order.captureId) ?? captures[0];
  if (capture?.status === "REVERSED") nextHealth = { ...review("PayPal reports this capture as reversed. A reversal is recorded separately from a completed refund."), status: "reversed" };
  else if (order.capturedMinor > 0 && capture && ["DENIED", "DECLINED", "FAILED"].includes(capture.status)) nextHealth = review("A current capture status conflicts with previously settled money. The original gross payment remains recorded while this discrepancy is reviewed.");
  else if (capture?.status === "REFUNDED" && order.refundedMinor < order.capturedMinor || capture?.status === "PARTIALLY_REFUNDED" && order.refundedMinor === 0) nextHealth = review("PayPal reports a refund, but the exact completed refund receipts are not all mapped to this order yet.");
  else if (valid.some(resource => resource.kind === "refund" && resource.status === "PENDING") || capture?.status === "PENDING") nextHealth = { status: "pending", reason: "PayPal has not completed this payment or refund. Delivery and automatic changes remain paused.", observedAt: health?.observedAt ?? new Date().toISOString(), webhookId: health?.webhookId ?? order.paymentHealth?.webhookId ?? null };
  if (nextHealth) order.paymentHealth = nextHealth;
  if (order.state !== "cancelled") order.state = order.refundedMinor >= order.capturedMinor && order.capturedMinor > 0 ? "refunded" : order.refundedMinor > 0 ? "partially_refunded" : order.capturedMinor > 0 ? "paid" : capture && ["DENIED", "DECLINED", "FAILED"].includes(capture.status) ? "refused" : order.approvalUrl ? "awaiting_approval" : "payment_pending";
  if (paymentNeedsReview(order)) { order.state = "payment_pending"; order.error = order.paymentHealth!.reason; }
  return order;
}
