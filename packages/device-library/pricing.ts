import book from "./price-book.json";

/** One captured Channel3 offer used as WorldKit Studio's sandbox listing price for an exact library profile. */
export type PriceBookEntry = {
  profileId: string; query: string; channel3ProductId: string; title: string; brand: string | null;
  selectedOptions: { name: string; value: string }[];
  offer: { id: string; retailer: string; domain: string; unitMinor: number; currency: "USD"; availability: string; condition: string; observedAt: string };
  responseHash: string; receiptId: string;
  /** `exact_model`: the captured product title names this exact model/variant. Anything else is never priced. */
  match: "exact_model" | "unmatched";
};
export type PriceBook = { schema: "worldkit.price-book.1"; capturedAt: string | null; provider: "channel3"; merchant: string; note: string; entries: PriceBookEntry[] };
export const priceBook = book as PriceBook;
export type Listing = {
  profileId: string; channel3ProductId: string; title: string; brand: string | null; selectedOptions: { name: string; value: string }[];
  unitMinor: number; currency: "USD"; retailer: string; offerId: string; observedAt: string; responseHash: string;
  /** Always "captured": a retained Channel3 observation, not a live quote. */
  mode: "captured";
};
/** The sandbox listing for an exact profile, or null when no exact captured offer exists (never guess a price). */
export function listingFor(profileId: string): Listing | null {
  const entry = priceBook.entries.find(value => value.profileId === profileId && value.match === "exact_model" && value.offer.currency === "USD" && Number.isSafeInteger(value.offer.unitMinor) && value.offer.unitMinor > 0);
  return entry ? { profileId, channel3ProductId: entry.channel3ProductId, title: entry.title, brand: entry.brand, selectedOptions: entry.selectedOptions, unitMinor: entry.offer.unitMinor, currency: "USD", retailer: entry.offer.retailer, offerId: entry.offer.id, observedAt: entry.offer.observedAt, responseHash: entry.responseHash, mode: "captured" } : null;
}
