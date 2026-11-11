import { Channel3Error, type Channel3, type Channel3Api } from "@channel3/sdk";
import { ProviderSubscriptionSchema, type ProviderSubscription, type SubscriptionScope } from "../living-kit/subscriptions";
import { catalogClient } from "./client";

export class SubscriptionFailure extends Error {
  constructor(public code: "canonicalizing" | "not_found" | "rejected" | "unavailable" | "invalid_response", public outcome: "rejected" | "unknown", public status: number | null) { super("The catalog subscription operation could not be confirmed."); }
}
export interface SubscriptionGateway {
  list(cursor: string | null): Promise<{ items: ProviderSubscription[]; nextCursor: string | null }>;
  create(scope: SubscriptionScope): Promise<ProviderSubscription>;
  retrieve(id: string): Promise<ProviderSubscription>;
  cancel(id: string): Promise<ProviderSubscription>;
}
function subscription(value: Channel3Api.ProductSubscriptionResponse): ProviderSubscription {
  const parsed = ProviderSubscriptionSchema.safeParse({ id: value.subscription_id, scope: { productId: value.product_id, selection: (value.selection ?? []).map(option => ({ name: option.name, label: option.label })), domains: value.domains ?? null, events: value.events, locale: value.locale }, state: value.status, createdAt: value.created_at instanceof Date ? value.created_at.toISOString() : value.created_at });
  if (!parsed.success) throw new SubscriptionFailure("invalid_response", "unknown", null);
  return parsed.data;
}
/** SDK 4.9.0. Writes have no automatic retry and no invented request-ID field. */
export class Channel3Subscriptions implements SubscriptionGateway {
  constructor(private client?: Channel3) {}
  private options() { return { maxRetries: 0, timeoutInSeconds: 35, abortSignal: AbortSignal.timeout(40_000) }; }
  private async call<T>(work: (client: Channel3) => Promise<T>): Promise<T> {
    try { return await work(this.client ?? catalogClient()); }
    catch (error) {
      if (error instanceof SubscriptionFailure) throw error;
      const status = error instanceof Channel3Error ? error.statusCode ?? null : null;
      throw new SubscriptionFailure(status === 409 ? "canonicalizing" : status === 404 ? "not_found" : status && status >= 400 && status < 500 && status !== 408 && status !== 429 ? "rejected" : "unavailable", status && status >= 400 && status < 500 && status !== 408 ? "rejected" : "unknown", status);
    }
  }
  list(cursor: string | null) {
    return this.call(async client => {
      const page = await client.productSubscriptions.list({ status: "active", limit: 100, ...(cursor ? { cursor } : {}) }, this.options());
      return { items: page.data.map(subscription), nextCursor: page.response.next_cursor ?? null };
    });
  }
  create(scope: SubscriptionScope) {
    return this.call(async client => subscription(await client.productSubscriptions.create({ product_id: scope.productId, events: scope.events, domains: scope.domains, ...(scope.selection.length ? { selection: scope.selection } : {}) }, this.options())));
  }
  retrieve(id: string) { return this.call(async client => subscription(await client.productSubscriptions.retrieve({ subscription_id: id }, this.options()))); }
  cancel(id: string) { return this.call(async client => subscription(await client.productSubscriptions.cancel({ subscription_id: id }, this.options()))); }
}
