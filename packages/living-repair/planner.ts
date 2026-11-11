import { combine, graphHash, hash, verifyKit } from "../compatibility";
import type { CatalogSnapshot, DeviceProfile, Source, Truth } from "../contracts";
import { architectures } from "../device-library";
import { assertExactSelection, catalogIdentityMatches, engineeringId } from "../inventory/identity";
import type { CriticalCheck, RepairBundle, RepairCandidate, RepairEvidence, RepairOffer, RepairRun } from "./contracts";
import { affectedClosure, preservedIntent } from "./impact";

export const inStock = (value: string) => ["instock", "in_stock", "available"].includes(value.toLowerCase());
export function sameSelection(a: { name: string; value: string }[], b: { name: string; value: string }[]) {
  const normalized = (values: typeof a) => values.map(option => `${option.name.toLowerCase()}=${option.value}`).sort();
  return hash(normalized(a)) === hash(normalized(b));
}
export function evidenceFresh(evidence: RepairEvidence, at = Date.now()) {
  return Number.isFinite(Date.parse(evidence.checkedAt)) && Date.parse(evidence.checkedAt) <= at + 5_000 && Date.parse(evidence.expiresAt) > at;
}
export function offerFrom(snapshot: CatalogSnapshot, domain: string): RepairOffer | null {
  const offer = snapshot.offers.find(offer => offer.domain.toLowerCase() === domain.toLowerCase() && offer.price?.currency === "USD" && inStock(offer.availability));
  if (!offer?.price) return null;
  return { productId: snapshot.productId, selectedOptions: snapshot.selectedOptions, offerId: offer.id, domain: offer.domain.toLowerCase(), retailer: offer.retailer, unitMinor: offer.price.minor, currency: "USD", availability: offer.availability, checkedAt: snapshot.observedAt, snapshotId: snapshot.id, snapshotHash: hash(snapshot), shipping: "unknown", condition: offer.condition };
}
export function criticalFactChecks(bundle: RepairBundle, mode: "live" | "sample"): CriticalCheck[] {
  const used = new Set(bundle.kit.components.map(component => component.profileId));
  return bundle.profiles.filter(profile => used.has(profile.id)).flatMap(profile => {
    const facts = Object.values(profile.facts).filter(fact => fact.critical);
    if (!facts.length) return [{ factId: `${profile.id}:coverage`, profileId: profile.id, property: "critical fact coverage", state: "unknown" as const, reason: "This profile has no critical engineering premises to verify.", sourceIds: [] }];
    return facts.map(fact => {
      const sources = fact.sourceIds.map(id => bundle.sources.find(source => source.id === id));
      let reason = "The exact fact, source hash and recorded review are present.";
      let state: Truth = "satisfied";
      if (fact.state !== "supported" || fact.value === null) { state = "unknown"; reason = fact.state === "conflicted" ? "Sources conflict on this critical fact." : "The critical fact is not supported."; }
      else if (!sources.length || sources.some(source => !source || !/^[a-f0-9]{64}$/.test(source.contentHash) || !["manufacturer", "software_publisher", ...(mode === "sample" ? ["sample"] : [])].includes(source.kind))) { state = "unknown"; reason = "An exact primary source and immutable content hash are required."; }
      else if (fact.review.status !== "reviewed" || !fact.review.reviewer || !fact.review.date) { state = "unknown"; reason = "Independent review is still pending. A generated proposal cannot review itself."; }
      if (mode === "sample" && state === "satisfied" && sources.every(source => source?.kind === "sample")) reason = "Synthetic fixture premise checked. This is not a manufacturer claim or a human review.";
      return { factId: fact.id, profileId: profile.id, property: fact.property, state, reason, sourceIds: fact.sourceIds };
    });
  });
}
export function technicalState(bundle: RepairBundle, mode: "live" | "sample", checks = criticalFactChecks(bundle, mode)): Truth {
  const technical = bundle.certificate.results.filter(result => bundle.kit.goal.requirements.some(requirement => requirement.id === result.requirementId && requirement.hard && requirement.kind !== "budget"));
  return combine([...technical.map(result => result.status), ...checks.map(check => check.state), checks.length ? "satisfied" : "unknown"]);
}
export function replacementBundle(base: RepairBundle, componentId: string, profile: DeviceProfile, addedSources: Source[], snapshots: CatalogSnapshot[], at: string): RepairBundle {
  const bundle = structuredClone(base); const component = bundle.kit.components.find(component => component.id === componentId);
  if (!component || component.owned) return bundle;
  const old = bundle.profiles.find(value => value.id === component.profileId);
  if (old?.id !== profile.id) {
    const compatible = (oldPort: DeviceProfile["ports"][number], next: DeviceProfile["ports"][number]) => oldPort.direction === next.direction && oldPort.connector === next.connector && oldPort.signal === next.signal && oldPort.channels <= next.channels && oldPort.protocols.every(protocol => next.protocols.includes(protocol));
    const portMap = new Map((old?.ports ?? []).map(port => {
      const exact = profile.ports.find(next => next.id === port.id && compatible(port, next));
      const equivalent = profile.ports.filter(next => compatible(port, next));
      return [port.id, exact?.id ?? (equivalent.length === 1 ? equivalent[0]!.id : `unmapped:${port.id}`)];
    }));
    for (const edge of bundle.kit.connections) for (const end of [edge.from, edge.to]) if (end.componentId === componentId) end.portId = portMap.get(end.portId) ?? `unmapped:${end.portId}`;
    component.profileId = profile.id;
    if (old && engineeringId(old) !== engineeringId(profile)) component.settings = {};
    delete component.inventoryItemId; delete component.ownershipSource;
  }
  if (!bundle.profiles.some(value => value.id === profile.id)) bundle.profiles.push(structuredClone(profile));
  const neededSources = new Set(Object.values(profile.facts).flatMap(fact => fact.sourceIds));
  for (const source of addedSources) if (neededSources.has(source.id) && !bundle.sources.some(value => value.id === source.id)) bundle.sources.push(source);
  bundle.kit.id = `repair-revision:${hash({ base: base.kit.id, componentId, profile: hash(profile), at }).slice(0, 32)}`;
  bundle.kit.parentRevisionId = base.kit.id; bundle.kit.revision = base.kit.revision + 1; bundle.kit.createdAt = at;
  bundle.certificate = verifyKit(bundle.kit, bundle.profiles, bundle.sources, architectures, snapshots, at);
  return bundle;
}
export function makeCandidate(input: { run: RepairRun; snapshot: CatalogSnapshot; domain: string; profile: DeviceProfile; sources: Source[]; evidence: RepairEvidence; rank: number }): RepairCandidate | null {
  const { run, snapshot, profile, evidence } = input; const componentId = run.impact.changedComponentIds[0];
  if (!componentId) return null;
  try { assertExactSelection(snapshot, snapshot.selectedOptions); } catch { return null; }
  const offer = offerFrom(snapshot, input.domain); if (!offer) return null;
  const component = run.base.kit.components.find(component => component.id === componentId); if (!component || component.owned) return null;
  const sameVariant = snapshot.productId === run.productId && sameSelection(snapshot.selectedOptions, run.selectedOptions);
  const previous = run.base.profiles.find(value => value.id === component.profileId);
  if (!previous) return null;
  // A merchant switch keeps the original technical identity and its reviewed modes.
  const chosen = sameVariant ? previous : profile;
  const exactIdentity = evidence.mode === "sample" || catalogIdentityMatches(snapshot, chosen);
  let bundle = run.base;
  for (const id of run.impact.changedComponentIds) {
    const target = run.base.kit.components.find(value => value.id === id);
    const original = run.base.profiles.find(value => value.id === target?.profileId);
    if (!target || target.owned || !original) return null;
    bundle = replacementBundle(bundle, id, sameVariant ? original : chosen, input.sources, [snapshot], evidence.checkedAt);
  }
  // One proposal is one revision even when the same exact product occupies
  // several positions. No intermediate partial graph is a commitment.
  bundle.kit.id = `repair-revision:${hash({ base: run.base.kit.id, components: run.impact.changedComponentIds, profile: hash(chosen), at: evidence.checkedAt }).slice(0, 32)}`;
  bundle.kit.parentRevisionId = run.base.kit.id; bundle.kit.revision = run.base.kit.revision + 1;
  bundle.certificate = verifyKit(bundle.kit, bundle.profiles, bundle.sources, architectures, [snapshot], evidence.checkedAt);
  const criticalChecks = criticalFactChecks(bundle, evidence.mode);
  if (!sameVariant && engineeringId(previous) !== engineeringId(chosen)) {
    const conditionalFacts = Object.values(chosen.facts).filter(fact => fact.critical && fact.conditions.length > 0);
    for (const fact of conditionalFacts) criticalChecks.push({ factId: `${fact.id}:conditions`, profileId: chosen.id, property: `${fact.property} operating conditions`, state: "unknown", reason: `Confirm the exact documented operating mode for the new device: ${fact.conditions.join("; ")}. Old device settings are not carried forward.`, sourceIds: fact.sourceIds });
  }
  const preservation = preservedIntent(run.base, bundle);
  const state = combine([technicalState(bundle, evidence.mode, criticalChecks), exactIdentity ? "satisfied" : "unknown", preservation.preserved ? "satisfied" : "violated"]);
  const blockers = [...new Set([
    ...criticalChecks.filter(check => check.state !== "satisfied").map(check => check.reason),
    ...bundle.certificate.results.filter(result => result.status !== "satisfied" && bundle.kit.goal.requirements.some(requirement => requirement.id === result.requirementId && requirement.hard && requirement.kind !== "budget")).map(result => result.title),
    ...(!exactIdentity ? ["The listing needs exact engineering-profile identity confirmation."] : []), ...(!preservation.preserved ? [preservation.reason] : []),
  ])];
  const id = `candidate:${hash({ run: run.id, product: snapshot.productId, selection: snapshot.selectedOptions, domain: offer.domain, graph: graphHash(bundle.kit, bundle.profiles), snapshot: offer.snapshotHash }).slice(0, 40)}`;
  const value = { id, runId: run.id, kind: sameVariant ? "merchant_change" as const : "variant_change" as const, title: sameVariant ? `Same ${chosen.model}, another retailer` : chosen.model, explanation: sameVariant ? "The exact product and selected options stay the same in every affected position. Availability, price and all critical premises are checked again." : "A different exact model is mapped to every affected position and its saved paths. Every hard requirement and critical premise is checked again.", offer, componentId, beforeProfileId: component.profileId, afterProfileId: chosen.id, bundle, impact: affectedClosure(bundle, run.impact.changedComponentIds), criticalChecks, technicalState: state, identityState: exactIdentity ? "exact_profile_match" as const : "needs_confirmation" as const, evidence, rank: input.rank, createdAt: evidence.checkedAt, blockers };
  return { ...value, digest: hash(value) };
}
export function repairQuery(run: RepairRun): string {
  const component = run.base.kit.components.find(component => run.impact.changedComponentIds.includes(component.id));
  const profile = run.base.profiles.find(profile => profile.id === component?.profileId);
  const needs = run.base.kit.goal.requirements.filter(requirement => requirement.hard).map(requirement => requirement.kind);
  const constraints = [needs.includes("isolated_tracks") ? `${run.base.kit.goal.requirements.find(requirement => requirement.kind === "isolated_tracks")?.target ?? 2} independent microphone inputs` : "", component?.role === "audio" && needs.includes("simultaneous") ? "simultaneous onboard recording USB stereo audio" : "", ...profile?.ports.filter(port => port.direction === "in").map(port => port.connector) ?? []].filter(Boolean);
  return `${profile?.kind ?? "creator equipment"} ${constraints.join(" ")}`.slice(0, 250);
}
