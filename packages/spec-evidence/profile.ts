import { DeviceSchema, type DeviceProfile, type Fact, type Source } from "../contracts";
import { hash } from "../compatibility";
import type { ExtractionDraft } from "./contracts";
import type { CorpusDevice, SourceDocument } from "./sources";
import { sourceQueries } from "./queries";

export type SourceFingerprint = Pick<SourceDocument, "url" | "retrievedAt" | "contentHash" | "textHash">;
export function immutableSource(device: CorpusDevice, document: SourceFingerprint): Source {
  return { id: `manufacturer:${device.id}:${document.contentHash}`, title: device.source.title, publisher: device.manufacturer, url: document.url, kind: "manufacturer", retrievedAt: document.retrievedAt, contentHash: document.contentHash, location: "Pinned manufacturer document; fact anchors refer to its normalized text pages.", summary: "Manufacturer material was retrieved and fingerprinted. Interpretation, exact variant scope and technical review remain pending.", rights: "link_and_facts_only" };
}

export function candidateProfile(device: CorpusDevice, document: SourceFingerprint, draft?: ExtractionDraft): DeviceProfile {
  if (draft && (draft.profileId !== device.id || draft.sourceHash !== document.contentHash || draft.textHash !== document.textHash || draft.promotion !== "human_review_required")) throw new Error("The proposal does not match its exact source version.");
  const source = immutableSource(device, document);
  const id = `research:${device.id}:${hash({ source: document.contentHash, draft: draft?.id ?? null }).slice(0, 20)}`;
  const facts: Record<string, Fact> = {};
  if (draft) for (const fact of draft.facts) {
    // A located quote can create a review candidate, never a reviewed fact or a port map.
    facts[fact.property] = { id: `${id}:${fact.property}`, property: fact.property, value: fact.value, unit: fact.unit, sourceIds: fact.evidence.length ? [source.id] : [], scope: fact.scope, conditions: fact.conditions, state: fact.state, critical: fact.critical, review: { status: "pending", reviewer: null, date: null }, evidence: fact.evidence.map(anchor => ({ ...anchor, sourceId: source.id })), extraction: { draftId: draft.id, validation: fact.validation }, interpretation: fact.explanation };
  } else for (const query of sourceQueries(device)) {
    facts[query.property] = { id: `${id}:${query.property}`, property: query.property, value: null, unit: null, sourceIds: [], scope: query.scope, conditions: [], state: "unknown", critical: query.critical, review: { status: "pending", reviewer: null, date: null } };
  }
  // Every candidate explicitly retains the unreviewed engineering boundary, including no-fact results.
  facts.technicalScope = { id: `${id}:technicalScope`, property: "technicalScope", value: null, unit: null, sourceIds: [source.id], scope: `${device.manufacturer} ${device.model}; ${device.variant}`, conditions: ["A complete source-backed port map and independent technical review are pending."], state: "unknown", critical: true, review: { status: "pending", reviewer: null, date: null } };
  return DeviceSchema.parse({ id, manufacturer: device.manufacturer, model: device.model, variant: device.variant, kind: device.kind, version: 1, baseProfileId: device.id, corpusId: device.id, sourceVersion: document.contentHash, shortName: device.model, description: draft ? "An exact manufacturer source with traceable model proposals. Every technical claim and the port map await review." : "Manufacturer source collected. Technical extraction and a reviewed port map remain open.", ports: [], portMapStatus: "pending", facts, catalogId: null, selectedOptions: [], reviewState: draft ? draft.counts.conflicted ? "conflicted" : "review_pending" : "sources_collected", art: "original_line_art", accent: ["microphone", "recorder", "interface", "mixer"].includes(device.kind) ? "#dbe6e2" : ["camera", "capture", "host"].includes(device.kind) ? "#dfdff0" : "#ece3d3" });
}
