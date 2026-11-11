import { hash } from "../compatibility";
import type { CatalogSnapshot, DeviceProfile, KitRevision } from "../contracts";
import { OFFER_MAX_AGE_MS, type CostEstimate, type CostLine, type OfferObservation } from "./contracts";

const selection = (options: DeviceProfile["selectedOptions"]) => hash(options.map(option => [option.name.toLowerCase(), option.value]).sort(([a], [b]) => a!.localeCompare(b!)));
const amount = (value: number | null) => value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
export const offerCurrent = (offer: OfferObservation, at: string) => Number.isFinite(Date.parse(offer.observedAt)) && Number.isFinite(Date.parse(offer.expiresAt)) && Date.parse(offer.observedAt) <= Date.parse(at) + 5_000 && Date.parse(offer.expiresAt) > Date.parse(at);

/** Only an exact, previously confirmed catalog identity can acquire an observation.
 * Retailer URLs are deliberately absent from this persisted comparison contract. */
export function catalogObservations(profiles: DeviceProfile[], snapshots: CatalogSnapshot[]): OfferObservation[] {
  return profiles.flatMap(profile => snapshots.filter(snapshot => Boolean(profile.catalogBinding) && snapshot.productId === profile.catalogBinding!.productId && snapshot.variantExact && snapshot.detailChecked && selection(snapshot.selectedOptions) === selection(profile.selectedOptions)).flatMap(snapshot => snapshot.offers.map(offer => {
    const observed = Math.min(Date.parse(snapshot.observedAt), Date.parse(offer.observedAt));
    return { id: `${profile.id}:${snapshot.id}:${offer.id}`, profileId: profile.id, profileHash: hash(profile), productId: snapshot.productId,
      selectedOptions: snapshot.selectedOptions, snapshotId: snapshot.id, snapshotHash: hash(snapshot), offerId: offer.id,
      retailer: offer.retailer, condition: offer.condition, currency: offer.price?.currency ?? "USD", unitMinor: offer.price?.minor ?? null,
      shippingMinor: null, taxMinor: null,
      availability: ["instock", "in_stock", "available"].includes(offer.availability.toLowerCase()) ? "available" as const : ["outofstock", "out_of_stock", "unavailable"].includes(offer.availability.toLowerCase()) ? "unavailable" as const : "unknown" as const,
      observedAt: Number.isFinite(observed) ? new Date(observed).toISOString() : "invalid", expiresAt: Number.isFinite(observed) ? new Date(observed + OFFER_MAX_AGE_MS).toISOString() : "invalid", mode: "live" as const,
      note: "Observed Channel3 retailer estimate. Shipping and tax have not been established; this is not a merchant quote." };
  })));
}

export function estimateCost(kit: KitRevision, profiles: DeviceProfile[], offers: OfferObservation[], at: string, plannedReuse: ReadonlyMap<string, number> = new Map()): CostEstimate {
  const remaining = new Map(plannedReuse);
  const lines: CostLine[] = kit.components.map(component => {
    const profile = profiles.find(value => value.id === component.profileId);
    const shared = Math.min(component.quantity, remaining.get(component.profileId) ?? 0);
    if (!component.owned && shared) remaining.set(component.profileId, (remaining.get(component.profileId) ?? 0) - shared);
    const owned = component.owned || shared === component.quantity;
    const quantity = component.owned ? component.quantity : component.quantity - shared;
    const basic = { componentId: component.id, profileId: component.profileId, name: profile?.model ?? "Exact equipment to confirm", quantity: owned ? component.quantity : quantity,
      kind: component.owned ? "owned" as const : owned ? "planned_reuse" as const : "new" as const };
    if (owned) return { ...basic, unitMinor: 0, subtotalMinor: 0, shippingMinor: 0, taxMinor: 0, state: "owned", observation: null };
    const all = offers.filter(offer => offer.profileId === component.profileId);
    const exact = all.filter(offer => profile && offer.profileHash === hash(profile) && selection(offer.selectedOptions) === selection(profile.selectedOptions)
      && (offer.mode === "sample" || (profile.catalogBinding && offer.productId === profile.catalogBinding.productId)));
    const usd = exact.filter(offer => offer.currency === kit.goal.currency);
    // The newest snapshot replaces an older observation for a specific merchant
    // and offer. A new stock-out cannot be masked by an older available response.
    const latest = [...usd].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id)).filter((offer, index, list) => list.findIndex(other => other.offerId === offer.offerId && other.retailer === offer.retailer && other.productId === offer.productId) === index);
    const fresh = latest.filter(offer => offerCurrent(offer, at));
    const available = fresh.filter(offer => offer.availability === "available" && amount(offer.unitMinor));
    const ranked = available.sort((a, b) => {
      const aComplete = amount(a.shippingMinor) && amount(a.taxMinor), bComplete = amount(b.shippingMinor) && amount(b.taxMinor);
      return Number(bComplete) - Number(aComplete) || ((a.unitMinor! + (a.shippingMinor ?? 0) + (a.taxMinor ?? 0)) - (b.unitMinor! + (b.shippingMinor ?? 0) + (b.taxMinor ?? 0))) || a.id.localeCompare(b.id);
    });
    const observation = ranked[0] ?? fresh[0] ?? latest[0] ?? exact[0] ?? all[0] ?? null;
    const state: CostLine["state"] = ranked.length ? "current" : all.length && !exact.length ? "identity_mismatch" : exact.length && !usd.length ? "currency_mismatch" : latest.length && !fresh.length ? "stale" : fresh.some(offer => offer.availability === "unavailable") ? "unavailable" : "missing";
    const current = state === "current" && observation;
    return { ...basic, unitMinor: current ? observation.unitMinor : null, subtotalMinor: current ? observation.unitMinor! * quantity : null,
      shippingMinor: current && amount(observation.shippingMinor) ? observation.shippingMinor! * quantity : null,
      taxMinor: current && amount(observation.taxMinor) ? observation.taxMinor! * quantity : null, state, observation };
  });
  const complete = lines.every(line => line.state === "owned" || (line.state === "current" && line.subtotalMinor !== null && line.shippingMinor !== null && line.taxMinor !== null));
  const subtotal = lines.reduce((sum, line) => sum + (line.subtotalMinor ?? 0), 0);
  const shipping = lines.every(line => line.shippingMinor !== null) ? lines.reduce((sum, line) => sum + line.shippingMinor!, 0) : null;
  const tax = lines.every(line => line.taxMinor !== null) ? lines.reduce((sum, line) => sum + line.taxMinor!, 0) : null;
  const modes = new Set(lines.flatMap(line => line.state === "current" && line.observation ? [line.observation.mode] : []));
  const expiries = lines.flatMap(line => line.observation && line.state === "current" ? [line.observation.expiresAt] : []).sort();
  return { currency: "USD", knownSubtotalMinor: subtotal, landedMinor: complete ? subtotal + (shipping ?? 0) + (tax ?? 0) : null,
    shippingMinor: shipping, taxMinor: tax, complete, mode: modes.size === 2 ? "mixed" : modes.has("sample") ? "sample" : modes.has("live") ? "live" : "unavailable",
    lines, missingComponents: lines.filter(line => line.state !== "owned" && (line.state !== "current" || line.shippingMinor === null || line.taxMinor === null)).map(line => line.componentId),
    validUntil: expiries[0] ?? null, scope: "Observed estimate; no quote, reservation or payment authority." };
}
