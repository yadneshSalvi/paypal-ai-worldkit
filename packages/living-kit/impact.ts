import type { CatalogSnapshot } from "../contracts";
import type { CommercialSignal } from "../webhooks/contracts";
import { sameSelection } from "./subscriptions";

export type OfferImpact = { state: "resolved" | "informational" | "needs_repair_review" | "needs_evidence"; reason: string; title: string; currentPriceMinor: number | null };
/** A signed change is a cue to refresh. It cannot override the current catalog. */
export function assessOfferImpact(signal: CommercialSignal, current: CatalogSnapshot): OfferImpact {
  const unknown = (reason: string): OfferImpact => ({ state: "needs_evidence", reason, title: "Exact catalog state needs review", currentPriceMinor: null });
  if (!current.detailChecked || !current.variantExact || current.productId !== signal.productId || !sameSelection(current.selectedOptions.map(option => ({ name: option.name, label: option.value })), signal.selection)) return unknown("The refreshed product or selected variant differs from this watch. No substitute or purchase was accepted.");
  const offers = current.offers.filter(offer => offer.domain.toLowerCase() === signal.domain);
  const prices = offers.flatMap(offer => offer.price ? [offer.price.minor] : []);
  const currentPriceMinor = prices.length ? Math.min(...prices) : null;
  const resolved = (reason: string): OfferImpact => ({ state: "resolved", title: "Earlier catalog change resolved", reason, currentPriceMinor });
  if (signal.type === "offer.created") return offers.length ? { state: "informational", title: "A merchant offer is available", reason: "The refreshed exact product includes this merchant. A new offer is information, not purchase authority.", currentPriceMinor } : resolved("The current exact-product response no longer contains this merchant's offer.");
  if (signal.type === "offer.deleted") return offers.length ? resolved("The current response still contains this merchant. The old removal event does not force a repair.") : { state: "needs_repair_review", title: "A watched merchant offer is gone", reason: "A fresh exact-product response has no offer from this watched merchant. Compatibility, fulfillment and current authority must be checked before any replacement.", currentPriceMinor };
  if (signal.type === "offer.availability.changed") {
    if (!offers.length) return unknown("The current response has no matching merchant offer; its exact availability cannot be confirmed from this event alone.");
    if (signal.current === "InStock") return offers.some(offer => offer.availability === "InStock") ? { state: "informational", title: "A watched offer is back in stock", reason: "The current response reports this exact variant in stock. No stock is reserved and no purchase was made.", currentPriceMinor } : resolved("A fresh response contradicts the earlier back-in-stock notification.");
    if (offers.some(offer => offer.availability === "InStock")) return resolved("A fresh response reports an in-stock offer from this merchant. The earlier shortage does not force a repair.");
    if (offers.every(offer => offer.availability === "OutOfStock")) return { state: "needs_repair_review", title: "A watched offer is out of stock", reason: "The refreshed exact variant is reported out of stock at this merchant. A compatible substitute remains a separate reviewed decision.", currentPriceMinor };
    return unknown("Current merchant availability is not established.");
  }
  const reported = signal.current as { price?: unknown; currency?: unknown } | undefined;
  if (typeof reported?.price !== "number" || reported.currency !== "USD") return unknown("The price event does not establish a supported USD comparison.");
  if (!prices.includes(Math.round(reported.price * 100))) return resolved("The current merchant prices differ from this earlier price event. Historical prices have not replaced live offers.");
  return { state: "informational", title: "A watched price changed", reason: "The current price matches the notification. An honoured Studio quote is unchanged; any separate re-quote or added charge needs its own authority.", currentPriceMinor };
}
