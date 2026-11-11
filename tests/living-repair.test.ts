import assert from "node:assert/strict";
import test from "node:test";
import { hash, verifyKit } from "../packages/compatibility";
import { architectures } from "../packages/device-library";
import type { AmendmentProposal, KitCommitment, KitRepairClaim, KitRepairPolicy, RepairRun } from "../packages/living-repair/contracts";
import { affectedClosure, preservedIntent, semanticCause } from "../packages/living-repair/impact";
import { criticalFactChecks, makeCandidate, replacementBundle, technicalState } from "../packages/living-repair/planner";
import { evaluateKitPolicy, grossAllowance } from "../packages/living-repair/policy";
import { sampleAlternativeProfile, sampleCatalog, sampleRepairBundle } from "../packages/living-repair/sample";

const at = () => new Date().toISOString();
function runFixture() {
  const base = sampleRepairBundle("unit", at());
  const run: RepairRun = { id: "unit-run", tenantId: "tenant", kitId: base.kit.kitId, sourceMode: "sample", catalogMode: "sample", incidentIds: [], causeKey: "unit", commitmentId: null, scenario: "available-alternative", phase: "ready", title: "Sample", reason: "", createdAt: at(), updatedAt: at(), base, itemId: null, productId: "sample-recorder-a", selectedOptions: [], affectedDomain: "original.example.invalid", impact: affectedClosure(base, ["audio"]), steps: [], candidateIds: [], selectedCandidateId: null, amendmentId: null, original: null, discovery: [], discoveryCursor: 0, attempts: 0, nextAttemptAt: at(), error: null };
  const response = sampleCatalog(run.productId, run.scenario!);
  const evidence = { mode: "sample" as const, snapshots: [response.value.snapshot], receipts: [response.receipt], checkedAt: at(), expiresAt: new Date(Date.now() + 600_000).toISOString(), query: "Sample", method: "sample_fixture" as const };
  return { run, base, response, evidence };
}
test("repair cause deduplicates equivalent selection order but separates tenant and provenance", () => {
  const input = { tenantId: "one", namespace: "live", kitId: "kit", baseGraphHash: "graph", itemId: "item", productId: "product", selectedOptions: [{ name: "Color", value: "Black" }, { name: "Size", value: "One" }], domain: "STORE.EXAMPLE", condition: "unavailable" };
  assert.equal(semanticCause(input), semanticCause({ ...input, selectedOptions: [...input.selectedOptions].reverse(), domain: "store.example" }));
  assert.notEqual(semanticCause(input), semanticCause({ ...input, namespace: "sample" }));
  assert.notEqual(semanticCause(input), semanticCause({ ...input, tenantId: "two" }));
});
test("affected closure follows connected branches while preserving owned equipment", () => {
  const { base } = runFixture(); base.kit.components.push({ id: "detached", profileId: "sample:shure-sm58-lc", owned: false, quantity: 1, role: "spare", position: { x: 0, y: 0 }, settings: {} });
  base.certificate = verifyKit(base.kit, base.profiles, base.sources, architectures);
  const impact = affectedClosure(base, ["audio"]);
  assert.ok(impact.componentIds.includes("host")); assert.ok(impact.connectionIds.includes("audio-monitor")); assert.ok(impact.requirementIds.includes("R7"));
  assert.ok(!impact.componentIds.includes("detached")); assert.deepEqual(impact.protectedComponentIds, ["camera", "headphones", "host"]);
});
test("same-variant retailer change retains the exact technical identity and graph hash", () => {
  const { run, base, response, evidence } = runFixture();
  const candidate = makeCandidate({ run, snapshot: response.value.snapshot, domain: "alternate.example.invalid", profile: sampleAlternativeProfile(base, false), sources: base.sources, evidence, rank: 0 })!;
  assert.equal(candidate.kind, "merchant_change"); assert.equal(candidate.afterProfileId, candidate.beforeProfileId);
  assert.equal(candidate.bundle.certificate.graphHash, base.certificate.graphHash); assert.equal(candidate.technicalState, "satisfied");
  assert.equal(candidate.bundle.certificate.results.find(result => result.requirementId === "R5")?.status, "unknown", "retailer landed costs remain unknown even in a technically passing fixture");
});
test("a variant change reruns critical premises and clears old device settings", () => {
  const { run, base, evidence } = runFixture(); const snapshot = sampleCatalog("sample-recorder-b", "unknown-evidence").value.snapshot;
  const candidate = makeCandidate({ run, snapshot, domain: "alternate.example.invalid", profile: sampleAlternativeProfile(base, true), sources: base.sources, evidence, rank: 0 })!;
  assert.equal(candidate.kind, "variant_change"); assert.equal(candidate.technicalState, "unknown");
  assert.deepEqual(candidate.bundle.kit.components.find(component => component.id === "audio")!.settings, {});
  assert.ok(candidate.criticalChecks.some(check => check.property === "simultaneousUsbRecording" && check.state === "unknown"));
});
test("one unavailable product used in several positions produces one complete replacement revision", () => {
  const { run, base, evidence } = runFixture();
  const audio = base.kit.components.find(component => component.id === "audio")!;
  base.kit.components.push({ ...structuredClone(audio), id: "spare-recorder", role: "spare", position: { x: 3, y: 3 } });
  base.certificate = verifyKit(base.kit, base.profiles, base.sources, architectures);
  run.impact = affectedClosure(base, ["audio", "spare-recorder"]);
  const profile = sampleAlternativeProfile(base, false); const snapshot = sampleCatalog("sample-recorder-b", "available-alternative").value.snapshot;
  const candidate = makeCandidate({ run, snapshot, domain: "alternate.example.invalid", profile, sources: base.sources, evidence, rank: 0 })!;
  assert.deepEqual(candidate.impact.changedComponentIds, ["audio", "spare-recorder"]);
  assert.ok(candidate.bundle.kit.components.filter(component => ["audio", "spare-recorder"].includes(component.id)).every(component => component.profileId === profile.id));
  assert.equal(candidate.bundle.kit.revision, base.kit.revision + 1); assert.equal(candidate.bundle.kit.parentRevisionId, base.kit.id);
  assert.equal(preservedIntent(base, candidate.bundle).preserved, true);
});
test("missing review cannot be bypassed by removing the review requirement", () => {
  const { base } = runFixture(); const recorder = base.profiles.find(profile => profile.id === base.kit.components.find(component => component.id === "audio")!.profileId)!;
  recorder.facts.onboardIsolated!.review = { status: "pending", reviewer: null, date: null };
  base.kit.goal.requirements = base.kit.goal.requirements.filter(requirement => requirement.kind !== "source_review");
  base.certificate = verifyKit(base.kit, base.profiles, base.sources, architectures);
  assert.equal(technicalState(base, "sample"), "unknown");
});
test("synthetic source premises never qualify as live manufacturer evidence", () => {
  const { base } = runFixture(); assert.equal(technicalState(base, "sample"), "satisfied");
  assert.equal(technicalState(base, "live"), "unknown"); assert.ok(criticalFactChecks(base, "live").every(check => check.state === "unknown"));
});
test("replacement ports require unambiguous semantic equivalence", () => {
  const { base } = runFixture(); const profile = sampleAlternativeProfile(base, false);
  profile.ports = profile.ports.map(port => ({ ...port, id: `other-${port.id}` }));
  const result = replacementBundle(base, "audio", profile, base.sources, [], at());
  assert.ok(result.kit.connections.filter(edge => edge.to.componentId === "audio").every(edge => edge.to.portId.startsWith("unmapped:")));
  assert.equal(technicalState(result, "sample"), "violated");
});
test("owned equipment and hard brief are invariant across amendments", () => {
  const { base } = runFixture(); const changed = structuredClone(base);
  changed.kit.components.find(component => component.owned)!.settings.test = true;
  assert.equal(preservedIntent(base, changed).preserved, false);
  const goal = structuredClone(base); goal.kit.goal.requirements[0]!.hard = false;
  assert.equal(preservedIntent(base, goal).preserved, false);
});
function policyFixture() {
  const { base } = runFixture(); const commitment = { id: "commit", tenantId: "tenant", version: 1, current: base, lines: [{ fulfillment: "unfulfilled", domain: "alternate.example.invalid", category: "recorder", condition: "new" }] } as KitCommitment;
  const proposal = { commitmentId: commitment.id, commitmentVersion: 1, before: base, after: structuredClone(base), technicalState: "satisfied", quote: { merchantId: "worldkit-studio", currency: "USD", deltaMinor: 2000, afterLines: [{ componentId: "audio", domain: "alternate.example.invalid", category: "recorder", condition: "new" }] }, impact: { changedComponentIds: ["audio"] } } as AmendmentProposal;
  const policy: KitRepairPolicy = { origin: "http://127.0.0.1:4506", automatic: true, acceptedProposalDigest: "digest", id: "policy", tenantId: "tenant", commitmentId: commitment.id, scope: "controlled_kit_amendments", version: 1, digest: "digest", capMinor: 2500, currency: "USD", merchantIds: ["worldkit-studio"], vendorDomains: ["alternate.example.invalid"], categories: ["recorder"], conditions: ["new"], preserveOwned: true, preserveHardRequirements: true, stopAfterFulfillment: true, createdAt: at(), expiresAt: new Date(Date.now() + 600_000).toISOString(), revokedAt: null, paymentMode: "sample", walletConsentId: null, walletConsentVersion: null, walletConsentDigest: null, sampleInstrumentConsent: hash({ id: "policy", scope: "controlled_kit_amendments", commitmentId: "commit", paymentMode: "sample" }) };
  const claim = (minor: number, state: KitRepairClaim["state"]) => ({ id: `claim-${minor}`, policyId: policy.id, additionalMinor: minor, state }) as KitRepairClaim;
  return { commitment, proposal, policy, claim };
}
test("$8 plus $20 cannot fit a $25 allowance, including pending and refunded claims", () => {
  const f = policyFixture();
  for (const state of ["reserved", "payment_pending", "paid", "refunded"] as const) assert.equal(evaluateKitPolicy({ ...f, claims: [f.claim(800, state)], wallet: null }).allowed, false, state);
  assert.equal(grossAllowance([f.claim(800, "refunded")], f.policy.id).consumedMinor, 800);
});
test("a positive refusal releases only the unspent claim, while revocation and fulfillment stop new writes", () => {
  const f = policyFixture(); assert.equal(evaluateKitPolicy({ ...f, claims: [f.claim(800, "refused")], wallet: null }).allowed, true);
  assert.equal(evaluateKitPolicy({ ...f, policy: { ...f.policy, revokedAt: at() }, claims: [], wallet: null }).allowed, false);
  f.commitment.lines[0]!.fulfillment = "shipped";
  assert.equal(evaluateKitPolicy({ ...f, claims: [], wallet: null }).allowed, false);
});
test("a missing wallet asks for payment approval without widening the allowance", () => {
  const f = policyFixture(); f.policy.paymentMode = "live_sandbox";
  assert.equal(evaluateKitPolicy({ ...f, claims: [], wallet: null }).next, "requires_payment_approval");
  f.proposal.quote.deltaMinor = 2800;
  assert.equal(evaluateKitPolicy({ ...f, claims: [], wallet: null }).next, "awaiting_consent");
});
test("automatic authority cannot silently change new equipment to a used or unknown-condition offer", () => {
  const f = policyFixture(); f.proposal.quote.afterLines[0]!.condition = "used";
  assert.equal(evaluateKitPolicy({ ...f, claims: [], wallet: null }).allowed, false);
  f.proposal.quote.afterLines[0]!.condition = "unknown";
  assert.equal(evaluateKitPolicy({ ...f, claims: [], wallet: null }).allowed, false);
});
