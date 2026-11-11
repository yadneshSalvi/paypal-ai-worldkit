import { randomUUID } from "node:crypto";
import { Webhook } from "svix";
import { offerEventTypes, type Channel3Event } from "../../packages/webhooks/contracts";
import type { ProviderSubscription, SubscriptionScope } from "../../packages/living-kit/subscriptions";
export const fixtureSecret = `whsec_${Buffer.from("synthetic webhook test key only!!").toString("base64")}`;
export const fixtureScope = (productId = `fixture-product-${randomUUID()}`): SubscriptionScope => ({ productId, selection: [{ name: "Color", label: "Black" }], domains: ["merchant.example"], events: [...offerEventTypes], locale: { language: "en", country: "US", currency: "USD" } });
export function providerSubscription(scope: SubscriptionScope, id = `fixture-sub-${randomUUID()}`): ProviderSubscription { return { id, scope, state: "active", createdAt: new Date().toISOString() }; }
export function catalogEvent(subscription: ProviderSubscription): Channel3Event {
  return { id: `fixture-event-${randomUUID()}`, type: "offer.availability.changed", timestamp: new Date().toISOString(), data: { subscription_id: subscription.id, subject: { product_id: subscription.scope.productId, selection: subscription.scope.selection, domain: subscription.scope.domains![0]!, locale: subscription.scope.locale }, previous: "InStock", current: "OutOfStock" } };
}
export function signedHeaders(raw: string, id = `fixture-delivery-${randomUUID()}`, secret = fixtureSecret, at = new Date()): Headers {
  return new Headers({ "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": new Webhook(secret).sign(id, at, raw) });
}
export function paypalHeaders(id = `fixture-transmission-${randomUUID()}`): Headers {
  return new Headers({ "content-type": "application/json", "paypal-transmission-id": id, "paypal-transmission-time": new Date().toISOString(), "paypal-auth-algo": "SHA256withRSA", "paypal-transmission-sig": "synthetic-only-never-a-provider-signature", "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/synthetic" });
}
