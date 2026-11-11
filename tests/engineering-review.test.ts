import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hash } from "../packages/compatibility";
import { decisionSetHash, digestText, reviewAssessment, validAnchors } from "../packages/engineering-review/policy";
import { ProposalContentSchema, REVIEW_POLICY, type ReviewDecision, type ReviewEdition } from "../packages/engineering-review/contracts";
import type { SourceDocument } from "../packages/spec-evidence/sources";

function fixture() {
  const text = "Sample predicate is true only in the fictional declared mode.";
  const document: SourceDocument = { sourceId: "sample", url: "https://example.invalid/sample", retrievedAt: "2026-11-11T00:00:00.000Z", contentHash: hash(text), textHash: digestText(text), mediaType: "text/html", bytes: text.length, pages: [{ number: 1, text }], parser: "worldkit-text.1", identityMentioned: true };
  const content = ProposalContentSchema.parse({ scope: { manufacturer: "Fictional", model: "Policy fixture", variant: "A", firmware: "1", os: "Sample OS 1", application: "Sample app 1", conditions: [] }, claims: [{ id: "sim", predicate: "simultaneousUsbRecording", target: "device", value: true, unit: null, conditions: ["Fictional mode only"], category: "simultaneous", critical: true, originalAssertionId: null, evidence: [{ contentHash: document.contentHash, textHash: document.textHash, page: 1, start: 0, end: text.length, excerptHash: digestText(text) }], rationale: "Sample policy fixture" }], ports: [], portMapDeclaredComplete: true, notes: "Pure policy test, not a hardware profile." });
  const edition: ReviewEdition = { id: randomUUID(), proposalId: randomUUID(), version: 1, hash: hash(content), policy: REVIEW_POLICY, provenance: "sample", authorId: "author", authors: ["author"], authorIdentities: [{ actorId: "author", identityHash: null, qualificationId: null }], createdAt: "2026-11-11T00:00:00.000Z", predecessorId: null, correctionReason: "Sample fixture", binding: { kitId: "kit", revisionId: "revision", graphHash: hash("graph"), profileId: "profile", candidateId: "candidate", candidateHash: hash("candidate"), documentId: "document", sourceHash: document.contentHash, textHash: document.textHash, sourceHeadVersion: 1, profileHeadId: null, assetId: null, assetHash: null, cropHash: null, draftId: "draft", draftHash: hash("draft") }, content, requiredAssertions: [], disputedPredicates: [] };
  function vote(actor: string, outcome: ReviewDecision["outcome"] = "accept", overrides: Partial<ReviewDecision> = {}): ReviewDecision { return { id: randomUUID(), editionId: edition.id, editionHash: edition.hash, targetId: "sim", actorId: actor, actorName: `Sample ${actor}`, principalHash: hash(actor), capabilityId: `grant-${actor}`, capabilityVersion: 2, qualification: { id: `qualification-${actor}`, actorId: actor, identityHash: hash(actor), evidenceHash: hash("fictional"), expertise: ["engineering", "simultaneous"], method: "Explicit software-only Sample actor", issuer: "Sample tests", expiresAt: "2099-01-01T00:00:00.000Z", provenance: "sample" }, outcome, kind: "review", reason: "Sample software policy decision", decisionSetHash: null, createdAt: "2026-11-11T00:00:00.000Z", active: true, ...overrides }; }
  return { edition, document, vote, target: (votes: ReviewDecision[]) => reviewAssessment(edition, votes).targets.find(target => target.id === "sim")! };
}

test("critical simultaneous modes require distinct principals, independent of token count", () => {
  const f = fixture(), first = f.vote("A"), duplicate = f.vote("alias", "accept", { principalHash: first.principalHash });
  assert.equal(f.target([first, duplicate]).accepted, 1);
  assert.notEqual(f.target([first, duplicate]).status, "accepted");
  assert.equal(f.target([first, f.vote("B")]).status, "accepted");
});
test("author identity aliases and inactive decisions never supply independence", () => {
  const f = fixture(); f.edition.authorIdentities[0]!.identityHash = hash("same-person");
  assert.equal(f.target([f.vote("same-person"), f.vote("author"), f.vote("expired", "accept", { active: false }), f.vote("B")]).accepted, 1);
});
test("revoking a dissenting reviewer cannot erase the disagreement", () => {
  const f = fixture(), votes = [f.vote("A"), f.vote("B", "reject", { active: false }), f.vote("C")];
  assert.equal(f.target(votes).status, "conflicted");
});
test("adjudication needs two principals and the exact full decision set", () => {
  const f = fixture(), votes = [f.vote("A"), f.vote("B", "reject")], exact = decisionSetHash(votes);
  const adjudicate = (actor: string) => f.vote(actor, "accept", { kind: "adjudication", decisionSetHash: exact });
  assert.equal(f.target([...votes, adjudicate("C")]).status, "conflicted");
  assert.equal(f.target([...votes, adjudicate("C"), adjudicate("D")]).status, "accepted");
  assert.equal(f.target([...votes, adjudicate("C"), adjudicate("D"), f.vote("E")]).status, "conflicted");
});
test("unknown values cannot become accepted through any number of votes", () => {
  const f = fixture(); f.edition.content.claims[0]!.value = null;
  assert.equal(f.target([f.vote("A"), f.vote("B")]).status, "unresolved");
});
test("a stale source, profile or crop blocks promotion even after all decisions", () => {
  const f = fixture(), votes = [f.vote("A"), f.vote("B"), f.vote("A", "accept", { targetId: "$port-map" })];
  const result = reviewAssessment(f.edition, votes, ["The exact crop has changed."]);
  assert.equal(result.state, "stale"); assert.equal(result.eligible, false);
  assert.equal(result.actualReviewed, 0); assert.equal(result.physicalTests, 0);
});
test("Sample decisions cannot count in a human edition or establish author identity", () => {
  const f = fixture(); f.edition.provenance = "human";
  const result = reviewAssessment(f.edition, [f.vote("A"), f.vote("B")]);
  assert.equal(result.actualReviewed, 0); assert.equal(result.eligible, false);
  assert.match(result.blockers.join(" "), /author/);
});
test("changing a simultaneous claim's category cannot lower its threshold", () => {
  const f = fixture(); f.edition.content.claims[0]!.category = "fact";
  assert.equal(f.target([f.vote("A")]).required, 2);
});
test("source anchors require exact document, text, page, offsets and selected bytes", () => {
  const f = fixture(), claim = f.edition.content.claims[0]!;
  assert.equal(validAnchors(claim, f.document), true);
  for (const change of ["contentHash", "textHash", "excerptHash"] as const) { const bad = structuredClone(claim); bad.evidence[0]![change] = "0".repeat(64); assert.equal(validAnchors(bad, f.document), false); }
  const wrong = structuredClone(claim); wrong.evidence[0]!.end += 1; assert.equal(validAnchors(wrong, f.document), false);
});
