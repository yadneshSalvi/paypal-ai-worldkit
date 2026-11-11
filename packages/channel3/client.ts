import { randomUUID } from "node:crypto";
import { Channel3, Channel3Error, type Channel3Api } from "@channel3/sdk";
import { CatalogSnapshotSchema, WorldKitError, type CatalogReceipt, type CatalogSnapshot, type FreshCatalogProduct } from "../contracts/index";
import { hash } from "../compatibility/index";
import type { AttributionReport, CatalogCategory, DiscoveryFilters, PriceHistory } from "./contracts";
import { productUrl, publicProductUrl } from "../security/url";

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
    availability: offer.availability, condition: offer.condition ?? "unknown", observedAt, shipping: "unknown" as const,
    ...(offer.dimensions ? { dimensions: { length: millimeters(offer.dimensions.length), width: millimeters(offer.dimensions.width), height: millimeters(offer.dimensions.height), unit: "mm" } } : {}) }));
  const snapshot: CatalogSnapshot = CatalogSnapshotSchema.parse({ id: randomUUID(), productId: product.id, title: product.title.slice(0, 300), brand: product.brands?.map(b => b.name).join(", ") || null,
    description: (product.description ?? "").replace(/<[^>]*>/g, " ").slice(0, 2200), selectedOptions, variantExact, offers,
    variantOptions: (product.variants?.options ?? []).map(option => ({ name: option.name, values: option.values.map(value => ({ value: value.label, exists: value.exists, availability: value.available ?? null, productId: value.product_id ?? null })) })),
    categoryIds: product.category ? [product.category.slug] : [], observedAt, source: "channel3", responseHash: hash(product), sourceMode: "live" });
  const buyLinks = (product.offers ?? []).flatMap((offer, i) => {
    try { const url = productUrl(offer.url); return [{ offerId: offers[i]!.id, url: url.href }]; } catch { return []; }
  });
  return { snapshot, buyLinks };
}
function millimeters(value: Channel3Api.LengthDimension | null | undefined): number | null {
  if (!value || !Number.isFinite(value.number) || value.number < 0) return null;
  return value.number * ({ mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[value.unit]);
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
export function providerFilters(filters?: DiscoveryFilters): Channel3Api.SearchFilters | undefined {
  return filters ? { conditions: filters.conditions,
    ...(filters.maxPriceMinor ? { price: { max_price: filters.maxPriceMinor / 100 } } : {}),
    ...(filters.maxWidthMm ? { dimensions: { width: { max: filters.maxWidthMm, unit: "mm" as const } } } : {}),
    ...(filters.categoryId ? { category_ids: [filters.categoryId] } : {}),
    ...(Object.keys(filters.attributes).length ? { attributes: filters.attributes } : {}),
  } : undefined;
}
export async function searchProducts(query: string, userId: string, filters?: DiscoveryFilters, mode: "default" | "agentic" = "default"): Promise<Result<CatalogSnapshot[]>> {
  return measured(mode === "agentic" ? "agentic_search" : "search", query, mode === "agentic" ? 5 : 1, async () => {
    const page = await catalogClient().products.search({ query, limit: 8, filters: providerFilters(filters), config: { country: "US", currency: "USD", language: "en", mode }, "x-user-id": userId });
    return { value: page.data.map(product => normalizeProduct(product).snapshot), ids: page.data.map(p => p.id), requestId: page.rawResponse.headers.get("x-request-id") };
  });
}
export async function retrieveProduct(productId: string, userId: string, selectedOptions: Record<string, string> = {}): Promise<Result<FreshCatalogProduct>> {
  return measured("details", productId, 0, async () => {
    const response = await catalogClient().products.retrieve({ product_id: productId, country: "US", currency: "USD", language: "en", selected_options: selectedOptions, "x-user-id": userId }).withRawResponse();
    const value = normalizeProduct(response.data, selectedOptions);
    value.snapshot.detailChecked = true;
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

export async function lookupProductUrl(url: string, userId: string): Promise<Result<CatalogSnapshot[]>> {
  const publicUrl = await publicProductUrl(url);
  return measured("url_lookup", `${publicUrl.hostname} · URL fingerprint ${hash(publicUrl.href).slice(0, 16)}`, 1, async () => {
    // The current API enforces a one-hour minimum even though SDK types only say number.
    const response = await catalogClient().products.lookup({ url: publicUrl.href, "x-user-id": userId, max_staleness_hours: 1, realtime_fetch: true }).withRawResponse();
    const snapshot = normalizeProduct(response.data.product).snapshot;
    return { value: [snapshot], ids: [snapshot.productId], requestId: response.rawResponse.headers.get("x-request-id") };
  });
}
export async function searchImageCrop(bytes: Buffer, hint: string, userId: string): Promise<Result<CatalogSnapshot[]>> {
  return measured("confirmed_crop_search", `Confirmed crop ${hash(bytes.toString("base64")).slice(0, 12)}${hint ? ` · ${hint.slice(0, 160)}` : ""}`, 1, async () => {
    const page = await catalogClient().products.search({ base64_image: bytes.toString("base64"), ...(hint.trim() ? { query: hint.trim() } : {}), limit: 8, config: { country: "US", currency: "USD", language: "en" }, "x-user-id": userId });
    return { value: page.data.map(product => normalizeProduct(product).snapshot), ids: page.data.map(p => p.id), requestId: page.rawResponse.headers.get("x-request-id") };
  });
}
export async function retrieveCategory(id: string): Promise<Result<CatalogCategory>> {
  return measured("category_attributes", id, 0, async () => {
    const category = await catalogClient().categories.retrieve({ slug: id });
    return { value: { id: category.slug, title: category.title, path: (category.path ?? []).map(p => p.title), children: (category.children ?? []).map(c => ({ id: c.slug, title: c.title })), attributes: (category.attributes ?? []).map(a => ({ id: a.slug, title: a.name, values: a.values ?? [] })) }, ids: [] };
  });
}
export async function browseProducts(filters: DiscoveryFilters, userId: string): Promise<Result<CatalogSnapshot[]>> {
  return measured("category_browse", filters.categoryId ?? "", 1, async () => {
    const page = await catalogClient().products.browse({ filters: providerFilters(filters), limit: 12, config: { country: "US", currency: "USD", language: "en" }, "x-user-id": userId });
    return { value: page.data.map(product => normalizeProduct(product).snapshot), ids: page.data.map(p => p.id), requestId: page.rawResponse.headers.get("x-request-id") };
  });
}
export async function normalizedHistory(productId: string): Promise<Result<PriceHistory>> {
  const result = await priceHistory(productId); const data = result.value; const s = data.statistics;
  const valid = (value: number) => Number.isFinite(value) && value >= 0;
  return { receipt: result.receipt, value: { productId: data.canonical_product_id, observedAt: result.receipt.completedAt,
    points: (data.history ?? []).filter(point => valid(point.price)).map(point => ({ at: new Date(point.timestamp).toISOString(), minor: Math.round(point.price * 100), currency: point.currency })),
    statistics: s && [s.min_price, s.max_price, s.mean, s.current_price].every(valid) ? { lowMinor: Math.round(s.min_price * 100), highMinor: Math.round(s.max_price * 100), meanMinor: Math.round(s.mean * 100), currentMinor: Math.round(s.current_price * 100), status: s.current_status, currency: s.currency } : null,
  } };
}
export async function attributionReport(userId: string, page = 1): Promise<{ value: AttributionReport; receipts: CatalogReceipt[] }> {
  // The caller cannot supply another attribution identity or request account-wide data.
  const endAt = new Date(); const startAt = new Date(endAt.getTime() - 30 * 86400000);
  const input = { user_id: userId, start_date: startAt, end_date: endAt, page, limit: 25 };
  const [clicks, transactions] = await Promise.all([
    measured("attributed_clicks", "This workspace · last 30 days", 0, async () => ({ value: await catalogClient().reporting.listClicks(input), ids: [] })),
    measured("attributed_transactions", "This workspace · last 30 days", 0, async () => ({ value: await catalogClient().reporting.listTransactions(input), ids: [] })),
  ]);
  return { receipts: [clicks.receipt, transactions.receipt], value: {
    startAt: startAt.toISOString(), endAt: endAt.toISOString(), page, hasMore: clicks.value.hasNextPage() || transactions.value.hasNextPage(),
    clicks: clicks.value.data.filter(item => item.user_id === userId).map(item => ({ id: item.id, at: new Date(item.timestamp).toISOString(), productId: item.product?.id ?? null, title: item.product?.title ?? null })),
    transactions: transactions.value.data.filter(item => item.user_id === userId).map(item => ({ id: item.id, at: new Date(item.purchased_at).toISOString(), productId: item.product?.id ?? null, title: item.product?.title ?? null, status: item.status })),
    scope: "this_workspace_only", amounts: "omitted_provider_currency_not_returned",
  } };
}
