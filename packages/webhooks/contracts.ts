import { z } from "zod";

export const offerEventTypes = ["offer.price.changed", "offer.availability.changed", "offer.created", "offer.deleted"] as const;
export const OfferEventTypeSchema = z.enum(offerEventTypes);
export type OfferEventType = z.infer<typeof OfferEventTypeSchema>;
export const ProviderIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
export const EventTimeSchema = z.iso.datetime({ offset: true });
export const DomainSchema = z.string().min(3).max(253).transform(value => value.toLowerCase()).refine(value => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value), "Use an exact merchant hostname.");
export const SelectionSchema = z.array(z.object({ name: z.string().min(1).max(120), label: z.string().min(1).max(200) })).max(24).refine(values => new Set(values.map(value => value.name.toLowerCase())).size === values.length, "Variant names must be distinct.");
export type Selection = z.infer<typeof SelectionSchema>;
export const LocaleSchema = z.object({ language: z.string().min(2).max(10), country: z.string().length(2), currency: z.string().length(3) });
const price = z.object({ price: z.number().finite().nonnegative().max(10_000_000), compare_at_price: z.number().finite().nonnegative().max(10_000_000).nullable(), currency: z.string().length(3) });
const availability = z.enum(["InStock", "OutOfStock"]);
const subject = z.object({ product_id: ProviderIdSchema, domain: DomainSchema, locale: LocaleSchema, selection: SelectionSchema.nullable() });
const identity = { id: ProviderIdSchema, timestamp: EventTimeSchema };
const common = { subscription_id: ProviderIdSchema, subject };
const offer = z.object({ url: z.string().max(8_000), domain: DomainSchema, price, availability, condition: z.string().min(1).max(80) });
export const Channel3EventSchema = z.discriminatedUnion("type", [
  z.object({ ...identity, type: z.literal("offer.price.changed"), data: z.object({ ...common, previous: price, current: price }) }),
  z.object({ ...identity, type: z.literal("offer.availability.changed"), data: z.object({ ...common, previous: availability, current: availability }) }),
  z.object({ ...identity, type: z.literal("offer.created"), data: z.object({ ...common, offer }) }),
  z.object({ ...identity, type: z.literal("offer.deleted"), data: z.object({ ...common, offer }) }),
]).refine(event => !("offer" in event.data) || event.data.offer.domain === event.data.subject.domain, "The offer and subject must name the same merchant.");
export type Channel3Event = z.infer<typeof Channel3EventSchema>;
export type CommercialSignal = {
  eventId: string; type: OfferEventType; committedAt: string; subscriptionId: string;
  productId: string; domain: string; locale: z.infer<typeof LocaleSchema>; selection: Selection;
  previous?: unknown; current?: unknown;
  offer?: { domain: string; price: z.infer<typeof price>; availability: z.infer<typeof availability>; condition: string };
};
/** Buy URLs remain only in the encrypted, signed raw receipt. Never make them actionable later. */
export function commercialSignal(event: Channel3Event): CommercialSignal {
  const value: CommercialSignal = { eventId: event.id, type: event.type, committedAt: event.timestamp, subscriptionId: event.data.subscription_id, productId: event.data.subject.product_id, domain: event.data.subject.domain, locale: event.data.subject.locale, selection: event.data.subject.selection ?? [] };
  if ("previous" in event.data) { value.previous = event.data.previous; value.current = event.data.current; }
  if ("offer" in event.data) { const { url: _url, ...saved } = event.data.offer; value.offer = saved; }
  return value;
}
export const paypalEventTypes = ["CHECKOUT.ORDER.APPROVED", "CHECKOUT.ORDER.COMPLETED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DECLINED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "PAYMENT.REFUND.PENDING", "PAYMENT.REFUND.FAILED"] as const;
export const PayPalEventSchema = z.object({
  id: ProviderIdSchema, event_type: z.enum(paypalEventTypes), create_time: EventTimeSchema, resource_type: z.string().max(64).optional(),
  resource: z.object({
    id: ProviderIdSchema, custom_id: z.string().max(128).optional(),
    purchase_units: z.array(z.object({ custom_id: z.string().max(128).optional() })).max(10).optional(),
    links: z.array(z.object({ rel: z.string().max(64), href: z.string().max(2000), method: z.string().max(12).optional() })).max(24).optional(),
    supplementary_data: z.object({ related_ids: z.object({ order_id: ProviderIdSchema.optional(), capture_id: ProviderIdSchema.optional(), refund_id: ProviderIdSchema.optional() }).optional() }).optional(),
  }),
});
export type PaymentSignal = { eventId: string; type: typeof paypalEventTypes[number]; committedAt: string; resourceId: string; resourceKind: "order" | "capture" | "refund"; relatedOrderId: string | null; relatedCaptureId: string | null; relatedRefundId: string | null; customId: string | null; identityConflict: boolean };
/** A relationship hint only. Never fetch the URL supplied by a webhook. */
export function sandboxParent(links: { rel: string; href: string; method?: string }[], kind: "order" | "capture"): string | null {
  const ids = new Set<string>();
  for (const link of links.filter(link => link.rel === "up" && (!link.method || link.method === "GET"))) {
    try {
      const url = new URL(link.href);
      if (url.protocol !== "https:" || !["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash) continue;
      const prefix = kind === "order" ? "/v2/checkout/orders/" : "/v2/payments/captures/";
      const id = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
      if (/^[A-Za-z0-9_-]{1,100}$/.test(id)) ids.add(id);
    } catch { /* An untrusted URL is never a request target. */ }
  }
  return ids.size === 1 ? [...ids][0]! : null;
}
export function paymentSignal(event: z.infer<typeof PayPalEventSchema>): PaymentSignal {
  const related = event.resource.supplementary_data?.related_ids;
  const orderParent = sandboxParent(event.resource.links ?? [], "order"); const captureParent = sandboxParent(event.resource.links ?? [], "capture");
  const resourceKind = event.resource_type === "refund" || event.event_type === "PAYMENT.CAPTURE.REFUNDED" || event.event_type.startsWith("PAYMENT.REFUND.") ? "refund" : event.event_type.startsWith("CHECKOUT.ORDER.") ? "order" : "capture";
  return { eventId: event.id, type: event.event_type, committedAt: event.create_time, resourceId: event.resource.id, resourceKind, relatedOrderId: related?.order_id ?? orderParent, relatedCaptureId: related?.capture_id ?? captureParent, relatedRefundId: related?.refund_id ?? null, customId: event.resource.custom_id ?? (event.resource.purchase_units?.length === 1 ? event.resource.purchase_units[0]?.custom_id ?? null : null), identityConflict: Boolean(related?.order_id && orderParent && related.order_id !== orderParent || related?.capture_id && captureParent && related.capture_id !== captureParent) };
}
export type WebhookProvider = "channel3" | "paypal";
export type WebhookState = "queued" | "processing" | "retry_wait" | "completed" | "ignored" | "dead_letter";
export type WebhookSource = "live" | "sample" | "replay";
export type WebhookSummary = { id: string; provider: WebhookProvider; eventId: string; eventType: string; sourceMode: WebhookSource; state: WebhookState; receivedAt: string; committedAt: string | null; bodyHash: string; attempts: number; deliveries: number; conflicts: number; error: string | null };
