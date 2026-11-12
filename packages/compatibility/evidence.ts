import { SOURCE_CHECK_LABEL, type Fact, type Source } from "../contracts/index";

const primaryKinds = ["manufacturer", "software_publisher"];
/** A fact can carry a satisfied result only when its value is known, every cited source is a retained primary
 * document with a real content hash, and it has either a recorded human review or an independent source check.
 * Sample-kind sources count only when the caller explicitly evaluates a labelled Sample fixture. */
export function factSupported(fact: Fact | undefined, sources: Source[], options: { allowSample?: boolean } = {}): fact is Fact {
  if (!fact || fact.state !== "supported" || fact.value === null || !fact.sourceIds.length) return false;
  const kinds = options.allowSample ? [...primaryKinds, "sample"] : primaryKinds;
  if (!fact.sourceIds.every(id => sources.some(source => source.id === id && /^[a-f0-9]{64}$/.test(source.contentHash) && kinds.includes(source.kind)))) return false;
  if (fact.review.status === "reviewed") return Boolean(fact.review.reviewer && fact.review.date);
  if (fact.review.status === "source_checked") return Boolean(fact.review.date && fact.sourceCheck?.verdict === "confirmed" && fact.sourceCheck.checker && fact.sourceCheck.checker !== fact.sourceCheck.extractor);
  return false;
}
export type EvidenceTier = "human_reviewed" | "source_checked" | "open";
/** The weakest tier among the facts a result rests on. An empty or partly unsupported set is always open. */
export function evidenceTier(facts: Fact[], sources: Source[], options: { allowSample?: boolean } = {}): EvidenceTier {
  if (!facts.length || !facts.every(fact => factSupported(fact, sources, options))) return "open";
  return facts.every(fact => fact.review.status === "reviewed") ? "human_reviewed" : "source_checked";
}
export function evidenceTierLabel(tier: EvidenceTier): string {
  return tier === "human_reviewed" ? "Human-reviewed sources" : tier === "source_checked" ? SOURCE_CHECK_LABEL : "Evidence still open";
}
