import type { Certificate, DeviceProfile, KitRevision, Source } from "../contracts";
import { hash } from "../compatibility";

export type ImpactSource = {
  profileId: string; model: string; variant: string; documentId: string | null;
  contentHash: string | null; textHash: string | null; url: string;
  status: "available" | "unavailable"; current: boolean; headVersion: number | null;
};
export type ImpactBundle = { kit: KitRevision; certificate: Certificate; profiles: DeviceProfile[]; sources: Source[]; current: boolean };
export type SourceImpact = {
  revisionId: string; kitId: string; revision: number; title: string; current: boolean;
  state: "same_document" | "changed_document" | "unavailable_document" | "incomplete_binding";
  previousHashes: string[]; componentIds: string[];
  facts: { id: string; property: string; critical: boolean; review: string; sourceBound: boolean }[];
  paths: { id: string; from: string; to: string; signal: string; cable: string; direct: boolean }[];
  requirements: { id: string; title: string; historicalStatus: string; witnessId: string }[];
  historicalCertificate: { id: string; graphHash: string; sourceHash: string; status: string; issuedAt: string };
};
export type SourceImpactReport = {
  version: "source-impact.v1"; source: ImpactSource; impacts: SourceImpact[]; digest: string;
  coverage: { revisionsInspected: number; totalSavedRevisions: number; complete: boolean; limit: number };
  interpretation: "Dependency review targets only. A changed document does not establish changed hardware behavior. Historical certificates are not recomputed.";
};
const fingerprint = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const unique = (values: string[]) => [...new Set(values)].sort();
function sourceUrl(value: string) { try { const url = new URL(value); url.hash = ""; return url.href; } catch { return value; } }

/** Pure lineage analysis; never changes a fact, review, graph or certificate. */
export function traceSourceImpact(source: ImpactSource, bundles: ImpactBundle[], totalSavedRevisions = bundles.length, limit = 100): SourceImpactReport {
  const impacts: SourceImpact[] = [];
  for (const bundle of bundles) {
    const { kit, certificate } = bundle;
    const used = new Set(kit.components.map(component => component.profileId));
    const profiles = bundle.profiles.filter(profile => used.has(profile.id) &&
      (profile.corpusId === source.profileId || (!profile.corpusId && (profile.id === source.profileId || profile.baseProfileId === source.profileId))));
    if (!profiles.length) continue;
    const profileIds = new Set(profiles.map(profile => profile.id));
    const componentIds = unique(kit.components.filter(component => profileIds.has(component.profileId)).map(component => component.id));
    const referencedSources = new Set(profiles.flatMap(profile => Object.values(profile.facts).flatMap(fact => fact.sourceIds)));
    const matchedSources = bundle.sources.filter(record => referencedSources.has(record.id) && sourceUrl(record.url) === sourceUrl(source.url));
    const sourceIds = new Set(matchedSources.map(record => record.id));
    const previousHashes = unique([...profiles.map(profile => profile.sourceVersion).filter(fingerprint), ...matchedSources.map(record => record.contentHash).filter(fingerprint)]);
    const previous = new Set(previousHashes);
    const facts = profiles.flatMap(profile => Object.values(profile.facts).map(fact => ({
      id: fact.id, property: fact.property, critical: fact.critical, review: fact.review.status,
      sourceBound: fact.sourceIds.some(id => sourceIds.has(id)) || Boolean(fact.evidence?.some(anchor => previous.has(anchor.contentHash))),
    }))).sort((a, b) => a.id.localeCompare(b.id));
    const factIds = new Set(facts.filter(fact => fact.sourceBound).map(fact => fact.id));
    const components = new Map(kit.components.map(component => [component.id, component]));
    const affected = new Set(componentIds), direct = new Set<string>(), reachableEdges = new Set<string>();
    const enabled = kit.connections.filter(edge => edge.enabled && components.has(edge.from.componentId) && components.has(edge.to.componentId));
    // Incident edges are review targets in either direction. Propagation follows
    // only enabled directed paths from the changed component, never backwards.
    for (const edge of enabled) if (affected.has(edge.from.componentId) || affected.has(edge.to.componentId)) direct.add(edge.id);
    const queue = [...componentIds];
    for (let i = 0; i < queue.length; i++) for (const edge of enabled) if (edge.from.componentId === queue[i]) {
      reachableEdges.add(edge.id);
      if (!affected.has(edge.to.componentId)) { affected.add(edge.to.componentId); queue.push(edge.to.componentId); }
    }
    const pathIds = new Set([...direct, ...reachableEdges]);
    const paths = enabled.filter(edge => pathIds.has(edge.id)).map(edge => ({ id: edge.id,
      from: components.get(edge.from.componentId)!.role, to: components.get(edge.to.componentId)!.role,
      signal: edge.signal, cable: edge.cable, direct: direct.has(edge.id),
    })).sort((a, b) => a.id.localeCompare(b.id));
    const requirementIds = new Set(kit.goal.requirements.map(requirement => requirement.id));
    const requirements = certificate.results.filter(witness => requirementIds.has(witness.requirementId) &&
      (witness.factIds.some(id => factIds.has(id)) || witness.sourceIds.some(id => sourceIds.has(id)) ||
        witness.componentIds.some(id => affected.has(id)) || witness.connectionIds.some(id => pathIds.has(id))))
      .map(witness => ({ id: witness.requirementId, title: witness.title, historicalStatus: witness.status, witnessId: witness.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const state = source.status !== "available" ? "unavailable_document" : !fingerprint(source.contentHash) || !previousHashes.length ? "incomplete_binding" :
      previousHashes.every(value => value === source.contentHash) ? "same_document" : "changed_document";
    impacts.push({ revisionId: kit.id, kitId: kit.kitId, revision: kit.revision, title: kit.goal.title, current: bundle.current,
      state, previousHashes, componentIds, facts, paths, requirements,
      historicalCertificate: { id: certificate.id, graphHash: certificate.graphHash, sourceHash: certificate.sourceHash, status: certificate.status, issuedAt: certificate.issuedAt },
    });
  }
  impacts.sort((a, b) => Number(b.current) - Number(a.current) || a.kitId.localeCompare(b.kitId) || b.revision - a.revision || a.revisionId.localeCompare(b.revisionId));
  const payload = { version: "source-impact.v1" as const, source, impacts,
    coverage: { revisionsInspected: bundles.length, totalSavedRevisions, complete: bundles.length === totalSavedRevisions, limit },
    interpretation: "Dependency review targets only. A changed document does not establish changed hardware behavior. Historical certificates are not recomputed." as const };
  return { ...payload, digest: hash(payload) };
}
