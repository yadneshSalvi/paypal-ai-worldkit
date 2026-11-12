import test from "node:test";
import assert from "node:assert/strict";
import { ResearchCommandSchema, ResearchConsentInputSchema, type ResearchAttempt, type ResearchParticipant, type ResearchProtocol, type ResearchStudy } from "../packages/research-notebook/contracts";
import { researchConsentCurrent, researchCounts, summarizeResearch } from "../packages/research-notebook/policy";
import { researchCsvCell } from "../src/server/research-notebook-export";

const at = "2026-11-12T00:00:00.000Z", fingerprint = "a".repeat(64);
const protocol: ResearchProtocol = { id: "protocol-one", number: 1, hash: fingerprint, reason: "Original controlled task", createdAt: at, tasks: [{ id: "task-one", title: "Explain evidence", instruction: "Explain the evidence boundaries.", successCriteria: "Distinguish modeled facts from observations." }] };
const study: ResearchStudy = { id: "synthetic-study", title: "Synthetic policy control", objective: "Qualify counts without real participants.", mode: "sample", phase: "open", version: 1, hash: fingerprint, currentProtocolId: protocol.id, createdAt: at, updatedAt: at, sealedAt: null,
  binding: { kind: "domain", subjectId: "synthetic-system", revisionId: "edition-one", graphHash: fingerprint, title: "Synthetic system", hash: fingerprint, certificateHash: fingerprint, ruleVersion: "synthetic-rule", graphSource: "sample", components: [], connections: [], configuration: [], sources: [], requirements: [] } };
function attempt(id: string, outcome: NonNullable<ResearchAttempt["result"]>["outcome"] | null, patch: Partial<ResearchAttempt> = {}): ResearchAttempt {
  return { id, hash: fingerprint, participantId: "person-one", mode: "sample", protocolId: protocol.id, protocolHash: protocol.hash, task: protocol.tasks[0]!, consentId: "consent-one", consentHash: fingerprint,
    number: 1, retryOf: null, firstAttempt: true, startedAt: at, finishedAt: outcome ? at : null, recordedIntervalMs: outcome ? 0 : null,
    startSource: { kind: "domain", subjectId: "synthetic-system", revisionId: "edition-one", graphHash: fingerprint, observedAt: at, availability: "available", matchesStudyBinding: true }, outcomeSource: null,
    state: outcome ? "finished" : "running", completionKind: outcome ? "operator_observation" : null,
    result: outcome ? { outcome, assistance: "none", comprehension: "not_assessed", observedNote: "Synthetic recorded observation.", response: "Synthetic response." } : null,
    visibility: "available", eligibleForPrivateSummary: true, eligibleForPublicSummary: true, exclusionReason: null, ...patch };
}
function participant(id: string, publiclyEligible: boolean): ResearchParticipant {
  return { id, hash: fingerprint, mode: "sample", pseudonym: "Fictional participant", experience: "novice", createdAt: at, withdrawnAt: null, availability: "current", currentConsent: null, consents: [], eligibleForPrivateSummary: true, eligibleForPublicSummary: publiclyEligible, runningAttemptId: null };
}

test("first-attempt denominator retains failure and abandonment while retries, unknown, pending and exclusions stay separate", () => {
  const records = [attempt("success", "success"), attempt("partial", "partial"), attempt("failure", "failure"), attempt("abandoned", "abandoned"), attempt("unknown", "unknown"), attempt("pending", null),
    attempt("excluded", "success", { eligibleForPrivateSummary: false, eligibleForPublicSummary: false }),
    attempt("retry-success", "success", { number: 2, firstAttempt: false, retryOf: "failure" })];
  assert.deepEqual(researchCounts(records), { success: 1, partial: 1, failure: 1, abandoned: 1, unknown: 1, pending: 1, excluded: 1, denominator: 4, unaidedSuccess: 1,
    assistance: { none: 5, prompted: 0, guided: 0, notRecorded: 0 }, comprehension: { correct: 0, incorrect: 0, uncertain: 0, notAssessed: 5 } });
});

test("Sample, protocol and aggregate-permission cohorts do not pool or expose privately excluded people", () => {
  const second: ResearchProtocol = { ...protocol, id: "protocol-two", number: 2, hash: "b".repeat(64), tasks: [{ ...protocol.tasks[0]!, instruction: "A different exact task instruction." }] };
  const original = attempt("original-failure", "failure"), retry = attempt("retry", "success", { firstAttempt: false, number: 2, retryOf: original.id, startSource: { ...original.startSource, revisionId: "edition-two", matchesStudyBinding: false } });
  const privateOnly = attempt("new-protocol", "success", { participantId: "person-two", protocolId: second.id, protocolHash: second.hash, task: second.tasks[0]!, eligibleForPublicSummary: false, outcomeSource: { ...original.startSource, availability: "missing", revisionId: null, graphHash: null, matchesStudyBinding: false } });
  const people = [participant("person-one", true), participant("person-two", false)], all = [original, retry, privateOnly];
  const privateSummary = summarizeResearch(study, protocol, [protocol, second], people, all);
  assert.equal(privateSummary.sampleParticipants, 2); assert.equal(privateSummary.operatorReportedParticipants, 0); assert.equal(privateSummary.independentlyVerifiedParticipants, 0);
  assert.equal(privateSummary.counts.failure, 1); assert.equal(privateSummary.counts.success, 0); assert.equal(privateSummary.counts.denominator, 1); assert.equal(privateSummary.allAttempts.retries, 1); assert.equal(privateSummary.variedSystemAttempts, 1);
  assert.equal(privateSummary.cohorts[1]!.counts.success, 1); assert.equal(privateSummary.cohorts[1]!.missingSourceAttempts, 1);
  const aggregate = summarizeResearch(study, protocol, [protocol, second], people, all, true);
  assert.equal(aggregate.sampleParticipants, 1); assert.equal(aggregate.excludedParticipants, 0); assert.equal(aggregate.cohorts[1]!.eligibleParticipants, 0); assert.equal(aggregate.cohorts[1]!.counts.excluded, 0); assert.equal(aggregate.cohorts[1]!.missingSourceAttempts, 0);
});

test("consent ends at the exact declared instant and aggregate permission cannot replace private permission", () => {
  const consent = { consentVersion: "synthetic-v1", privateResearch: true, anonymousPublicAggregate: false, consentReference: "Synthetic permission", grantedAt: at, expiresAt: "2026-11-12T00:01:00.000Z" };
  const expiry = Date.parse(consent.expiresAt);
  assert.equal(researchConsentCurrent(consent, Date.parse(at) - 1), false);
  assert.equal(researchConsentCurrent(consent, expiry - 1), true); assert.equal(researchConsentCurrent(consent, expiry), false);
  assert.equal(researchConsentCurrent({ ...consent, privateResearch: false, expiresAt: null }, expiry - 1), false);
  assert.equal(ResearchConsentInputSchema.safeParse({ ...consent, privateResearch: false, anonymousPublicAggregate: true }).success, false);
  assert.equal(ResearchConsentInputSchema.safeParse({ ...consent, expiresAt: at }).success, false);
});

test("administrative closure accepts no performance data, consent assertion or injected metric", () => {
  const command = { kind: "close_unreported_attempt", requestId: "6b9e802d-77ad-48ec-a156-f294663bd678", studyId: "synthetic-study", expectedVersion: 1, expectedStudyHash: fingerprint, attemptId: "original-interval", acknowledgedNoTaskOutcome: true };
  assert.equal(ResearchCommandSchema.safeParse(command).success, true);
  for (const extra of [{ result: { outcome: "success" } }, { observedNote: "Invented completion" }, { consentId: "new-grant" }, { denominator: 1 }, { acknowledgedNoTaskOutcome: false }]) assert.equal(ResearchCommandSchema.safeParse({ ...command, ...extra }).success, false);
});

test("CSV output quotes multiline text and neutralizes formula prefixes hidden by whitespace or control characters", () => {
  for (const value of ["=1+1", "+SUM(A1)", "-2+3", "@SUM(A1)", "  =1+1", "\t=1+1", "\r\n=1+1", "\0=1+1", " \u0001@SUM(A1)", "\u007f+1"]) assert.ok(researchCsvCell(value).startsWith("\"'"), JSON.stringify(value));
  assert.equal(researchCsvCell('ordinary,"quoted"\nsecond line'), '"ordinary,""quoted""\nsecond line"');
  assert.equal(researchCsvCell(null), '""'); assert.equal(researchCsvCell("already safe"), '"already safe"');
});
