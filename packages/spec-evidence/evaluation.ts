import type { DraftReference, ExtractionDraft, ExtractionQuery } from "./contracts";
import { ExtractionQuerySchema } from "./contracts";
import type { CorpusDevice, SourceDocument } from "./sources";
import { sha256 } from "./sources";

/** Expected answers and reference locations never cross the extractor boundary. */
export function evaluationQueries(assertions: DraftReference["assertions"]): ExtractionQuery[] {
  return assertions.map(({ id, property, question, valueType, unit, scope, critical }) => ExtractionQuerySchema.parse({ id, property, question, valueType, unit, scope, critical }));
}

export function validateReference(reference: DraftReference, corpus: CorpusDevice[], documents: Map<string, SourceDocument>) {
  const held = corpus.filter(device => device.split === "held_out");
  const developmentFamilies = new Set(corpus.filter(device => device.split === "development").map(device => device.family));
  if (held.some(device => developmentFamilies.has(device.family))) throw new Error("Development and held-out device families overlap.");
  if (new Set(reference.assertions.map(assertion => assertion.id)).size !== reference.assertions.length) throw new Error("The draft reference repeats an assertion ID.");
  for (const assertion of reference.assertions) {
    const device = held.find(device => device.id === assertion.profileId);
    if (!device || device.family !== assertion.family) throw new Error("A draft assertion is outside the frozen held-out device families.");
    const document = documents.get(assertion.profileId);
    if (!document || document.contentHash !== assertion.sourceHash) throw new Error("The draft reference source version changed.");
    for (const anchor of assertion.evidence) {
      const page = document.pages.find(page => page.number === anchor.page);
      if (!page || anchor.end <= anchor.start || anchor.end > page.text.length || sha256(page.text.slice(anchor.start, anchor.end)) !== anchor.excerptHash) throw new Error(`The draft reference passage moved: ${assertion.id}.`);
    }
    if (assertion.expectedState === "supported" && !assertion.evidence.length) throw new Error("A supported draft answer needs a located passage.");
    if (assertion.expectedState === "conflicted" && assertion.evidence.length < 2) throw new Error("A draft conflict needs two located passages.");
  }
}

function equalValue(actual: unknown, expected: unknown) {
  if (typeof actual !== typeof expected) return false;
  if (typeof actual === "number" && typeof expected === "number") return Math.abs(actual - expected) <= 1e-9;
  if (typeof actual === "string" && typeof expected === "string") return actual.normalize("NFKC").trim().toLowerCase() === expected.normalize("NFKC").trim().toLowerCase();
  return actual === expected;
}
export function compareDraftReference(reference: DraftReference, drafts: ExtractionDraft[]) {
  const facts = new Map(drafts.flatMap(draft => draft.facts.map(fact => [fact.assertionId, fact] as const)));
  let supportedAgreement = 0, typedValueAgreement = 0, supportedPredictions = 0, correctlyAbstained = 0, conflictAgreement = 0, rejected = 0, missing = 0, located = 0, rawSupportedPredictions = 0;
  const disagreements: { assertionId: string; reason: string }[] = [];
  for (const expected of reference.assertions) {
    const actual = facts.get(expected.id);
    if (!actual) { missing++; disagreements.push({ assertionId: expected.id, reason: "No completed extraction result." }); continue; }
    if (actual.proposedState === "supported") rawSupportedPredictions++;
    if (actual.validation === "rejected") rejected++;
    if (actual.state === "supported") {
      supportedPredictions++;
      if (actual.evidence.length && actual.validation === "located_pending_review") located++;
      if (expected.expectedState === "supported" && equalValue(actual.value, expected.expectedValue)) {
        typedValueAgreement++;
        if (actual.unit === expected.unit && actual.scope === expected.scope) supportedAgreement++;
        else disagreements.push({ assertionId: expected.id, reason: "Value agrees but unit or scope differs from draft." });
      } else disagreements.push({ assertionId: expected.id, reason: "Supported proposal differs from unreviewed draft." });
    } else if (actual.state === "unknown" && actual.validation === "abstained" && expected.expectedState === "unknown") correctlyAbstained++;
    else if (actual.state === "conflicted" && actual.validation === "conflicted" && expected.expectedState === "conflicted") conflictAgreement++;
    else disagreements.push({ assertionId: expected.id, reason: actual.validation === "rejected" ? "Rejected by source/type/scope validation." : "Abstention or conflict differs from unreviewed draft." });
  }
  const expectedSupported = reference.assertions.filter(assertion => assertion.expectedState === "supported").length;
  const expectedUnknown = reference.assertions.filter(assertion => assertion.expectedState === "unknown").length;
  const fraction = (numerator: number, denominator: number) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
  return {
    mode: "agreement_with_unreviewed_ai_draft" as const,
    assertions: reference.assertions.length, expectedSupported, expectedUnknown,
    expectedConflicted: reference.assertions.filter(assertion => assertion.expectedState === "conflicted").length,
    completedAssertions: facts.size, missing, rawSupportedPredictions, supportedPredictions, rejected,
    typedValueAgreement, exactValueUnitScopeAgreement: supportedAgreement,
    draftTypedPrecision: fraction(supportedAgreement, supportedPredictions),
    draftTypedRecall: fraction(supportedAgreement, expectedSupported),
    draftCorrectAbstention: fraction(correctlyAbstained, expectedUnknown),
    draftConflictAgreement: conflictAgreement,
    locatedCitationCoverage: fraction(located, rawSupportedPredictions),
    humanSourceSupportPrecision: null,
    humanGoldAccuracy: null,
    verifiedFactPromotions: 0,
    independentHumanReviews: 0,
    physicalTests: 0,
    limitations: [
      "This reference was prepared by an AI from manufacturer documents. It has not been adjudicated by the two required human reviewers.",
      "Draft agreement is not accuracy. A shared mistake in the draft and extractor may appear as agreement.",
      "Located quotations prove traceability, not semantic source support. Semantic source-support precision remains unmeasured.",
      "Scope equality checks the requested string. It does not establish that every quoted passage supports that exact variant or mode.",
      "Operating conditions are retained for review; free-text condition correctness is not automatically scored.",
      "Failed provider calls count as missing assertions, not successful abstentions. Rejected proposals are also not correct abstentions.",
      "All extracted facts remain pending review. None can promote itself into verified device evidence.",
    ], disagreements,
  };
}
