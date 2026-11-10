import { randomUUID } from "node:crypto";
import { Channel3, Channel3Error, type Channel3Api } from "@channel3/sdk";
import { CatalogSnapshotSchema, WorldKitError, type CatalogReceipt, type CatalogSnapshot, type FreshCatalogProduct } from "../contracts/index";
import { hash } from "../compatibility/index";

let singleton: Channel3 | undefined;
export function catalogClient(): Channel3 {
  if (!process.env.CHANNEL3_API_KEY) throw new WorldKitError("provider_unavailable", "Live discovery is not configured. Your saved plans remain available.", 503);
  const configured = new URL(process.env.CHANNEL3_API_BASE_URL ?? "https://api.trychannel3.com");
  if (configured.origin !== "https://api.trychannel3.com" || !["", "/", "/v1", "/v1/"].includes(configured.pathname) || configured.username || configured.password || configured.search) throw new WorldKitError("provider_unavailable", "The catalog endpoint is not the approved Channel3 origin.", 503);
  // SDK 4.9.0 appends v1/ itself. Legacy provisioned config includes that path.
  return singleton ??= new Channel3({ apiKey: process.env.CHANNEL3_API_KEY, baseUrl: configured.origin, timeoutInSeconds: 35, maxRetries: 0, country: "US", currency: "USD", language: "en" });
}
export function normalizeProduct(product: Channel3Api.Product, requested: Record<string, string> = {}, observedAt = new Date().toISOString()): FreshCatalogProduct {
  const selectedOptions = (product.variants?.selected ?? []).map(x => ({ name: x.name, value: x.label }));
  const variantExact = Object.entries(requested).every(([name, value]) => selectedOptions.some(s => s.name.toLowerCase() === name.toLowerCase() && s.value === value));
  const offers = (product.offers ?? []).map((offer, i) => ({ id: `${product.id}:${i}:${hash({ domain: offer.domain, selectedOptions }).slice(0, 10)}`, retailer: offer.domain, domain: offer.domain,
    price: offer.price.currency === "USD" && Number.isFinite(offer.price.price) && offer.price.price >= 0 ? { currency: "USD" as const, minor: Math.round(offer.price.price * 100) } : null,
    availability: offer.availability, condition: offer.condition ?? "unknown", observedAt, shipping: "unknown" as const }));
  const snapshot: CatalogSnapshot = CatalogSnapshotSchema.parse({ id: randomUUID(), productId: product.id, title: product.title.slice(0, 300), brand: product.brands?.map(b => b.name).join(", ") || null,
    description: (product.description ?? "").replace(/<[^>]*>/g, " ").slice(0, 2200), selectedOptions, variantExact, offers, categoryIds: product.category ? [product.category.slug] : [], observedAt, source: "channel3", responseHash: hash(product), sourceMode: "live" });
  const buyLinks = (product.offers ?? []).flatMap((offer, i) => {
    try { const url = new URL(offer.url); return url.protocol === "https:" ? [{ offerId: offers[i]!.id, url: url.href }] : []; } catch { return []; }
  });
  return { snapshot, buyLinks };
}
export class CatalogFailure extends WorldKitError {
  constructor(message: string, public receipt: CatalogReceipt) { super("provider_unavailable", message, 502, "Retry live discovery or inspect saved evidence"); }
}
type Result<T> = { value: T; receipt: CatalogReceipt };
async function measured<T>(operation: string, query: string, estimatedCredits: number, call: () => Promise<{ value: T; ids: string[]; requestId?: string | null }>): Promise<Result<T>> {
  const requestedAt = new Date().toISOString(); const start = Date.now();
  const base = { id: randomUUID(), operation, query, requestedAt, mode: "live" as const, estimatedCredits };
  try {
    const { value, ids, requestId } = await call();
    return { value, receipt: { ...base, completedAt: new Date().toISOString(), durationMs: Date.now() - start, resultIds: ids, providerRequestId: requestId ?? null, status: "succeeded", error: null } };
  } catch (error) {
    const message = error instanceof Channel3Error ? `Channel3 returned HTTP ${error.statusCode ?? "error"}. ${error.statusCode === 402 ? "The account needs catalog credits." : error.statusCode === 429 ? "The catalog rate limit was reached." : "Please retry or use your saved evidence."}` : error instanceof WorldKitError ? error.message : "The catalog request did not complete. Please retry or use your saved evidence.";
    throw new CatalogFailure(message, { ...base, completedAt: new Date().toISOString(), durationMs: Date.now() - start, resultIds: [], providerRequestId: null, status: "failed", error: message });
  }
}
export async function searchProducts(query: string, userId: string): Promise<Result<CatalogSnapshot[]>> {
  return measured("search", query, 1, async () => {
    const page = await catalogClient().products.search({ query, limit: 8, config: { country: "US", currency: "USD", language: "en" }, "x-user-id": userId });
    return { value: page.data.map(product => normalizeProduct(product).snapshot), ids: page.data.map(p => p.id), requestId: page.rawResponse.headers.get("x-request-id") };
  });
}
export async function retrieveProduct(productId: string, userId: string, selectedOptions: Record<string, string> = {}): Promise<Result<FreshCatalogProduct>> {
  return measured("details", productId, 1, async () => {
    const response = await catalogClient().products.retrieve({ product_id: productId, country: "US", currency: "USD", language: "en", selected_options: selectedOptions, "x-user-id": userId }).withRawResponse();
    const value = normalizeProduct(response.data, selectedOptions);
    return { value, ids: [value.snapshot.productId], requestId: response.rawResponse.headers.get("x-request-id") };
  });
}
export async function similarProducts(productId: string, userId: string): Promise<Result<CatalogSnapshot[]>> {
  return measured("similar", productId, 1, async () => {
    const page = await catalogClient().products.findSimilar({ product_id: productId, limit: 6, config: { country: "US", currency: "USD", language: "en" }, "x-user-id": userId });
    return { value: page.data.map(product => normalizeProduct(product).snapshot), ids: page.data.map(p => p.id), requestId: page.rawResponse.headers.get("x-request-id") };
  });
}
export async function searchCategories(query: string) {
  return measured("categories", query, 0, async () => {
    const response = await catalogClient().categories.search({ query, limit: 8 });
    return { value: response, ids: [] };
  });
}
export async function priceHistory(productId: string) {
  return measured("price_history", productId, 0, async () => ({ value: await catalogClient().priceTracking.retrieveHistory({ canonical_product_id: productId }), ids: [productId] }));
}
