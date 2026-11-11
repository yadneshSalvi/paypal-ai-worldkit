import test from "node:test";
import assert from "node:assert/strict";
import { candidateProfiles, candidateSources } from "../packages/device-library/candidates";
import { corpusDevices, sha256, type SourceDocument } from "../packages/spec-evidence/sources";
import { candidateProfile, immutableSource } from "../packages/spec-evidence/profile";
import { validateExtraction } from "../packages/spec-evidence/extractor";
import { sourceQueries } from "../packages/spec-evidence/queries";
import { corpusCatalogRules } from "../packages/inventory/catalog-variants";
import { catalogIdentityMatches, confirmedProfile, profileChoice } from "../packages/inventory/identity";
import { connectionIssues, graphHash, verifyKit } from "../packages/compatibility";
import { architectures, profiles, seedKit, sources } from "../packages/device-library";
import { catalog, identity } from "./support/inventory-fixtures";

const candidate = (id: string) => candidateProfiles.find(profile => profile.corpusId === id)!;
test("all sixty source candidates have explicit variant gates, immutable source identities and pending engineering review", () => {
  assert.equal(candidateProfiles.length, 60); assert.equal(candidateSources.length, 60);
  assert.deepEqual([...corpusCatalogRules].sort(), corpusDevices.map(device => device.id).sort());
  for (const profile of candidateProfiles) {
    assert.equal(profile.catalogId, null); assert.equal(profile.portMapStatus, "pending"); assert.equal(profile.ports.length, 0);
    assert.equal(profile.facts.technicalScope?.state, "unknown"); assert.equal(profile.facts.technicalScope?.critical, true);
    assert.ok(Object.values(profile.facts).every(fact => fact.review.status === "pending" && fact.review.reviewer === null));
    assert.ok(candidateSources.some(source => source.id === `manufacturer:${profile.corpusId}:${profile.sourceVersion}` && source.rights === "link_and_facts_only"));
  }
  const choices = candidateProfiles.map(profileChoice); assert.ok(Buffer.byteLength(JSON.stringify(choices)) < 40_000);
  assert.ok(choices.every(choice => !("facts" in choice) && !("ports" in choice)));
});
test("catalog matches require the exact scoped generation, model boundaries and variant instead of family resemblance", () => {
  const cases = [
    { id: "shure-sm58-lc", yes: "Shure SM58-LC wired microphone", no: ["Shure SM58S", "Shure SM58 wireless", "Shure SM58-LC 2-pack"] },
    { id: "beyerdynamic-dt770-80", yes: "beyerdynamic DT 770 PRO 80 ohm", no: ["beyerdynamic DT 770 PRO 250 ohm", "beyerdynamic DT 770 PRO", "beyerdynamic DT 770 PRO X 80 ohm"] },
    { id: "zoom-f3", yes: "Zoom F3 recorder", no: ["Zoom F3n recorder", "Zoom F3 kit with microphone"] },
    { id: "apple-ipad-air5", yes: "Apple iPad Air 5th generation M1 64GB Wi-Fi", no: ["Apple iPad Air M2 64GB Wi-Fi", "Apple iPad Air 5th generation M1 64GB Wi-Fi Cellular"] },
    { id: "sony-zve10", yes: "Sony ZV-E10 body", no: ["Sony ZV-E10 II body", "Sony ZV-E10 with lens"] },
    { id: "anker-735-a2668", yes: "Anker 735 Charger GaNPrime A2668 US plug", no: ["Anker 735 Charger A2667 US plug", "Anker 735 Charger GaNPrime A2668 UK plug"] },
    { id: "rode-podmic", yes: "RODE PodMic black XLR", no: ["RODE PodMic USB", "RODE PodMic white XLR"] },
  ];
  for (const row of cases) {
    const profile = candidate(row.id); assert.equal(catalogIdentityMatches({ ...catalog(profile), title: row.yes }, profile), true, row.yes);
    for (const title of row.no) assert.equal(catalogIdentityMatches({ ...catalog(profile), title }, profile), false, title);
  }
});
test("a candidate's source and proposal are immutable and never inherit a model-authored review", () => {
  const device = corpusDevices.find(device => device.id === "zoom-f3")!;
  const text = "Zoom F3. Synthetic test source; no factual hardware assertion.";
  const document: SourceDocument = { sourceId: "synthetic", url: "https://zoomcorp.com/synthetic", retrievedAt: "2026-11-11T00:00:00Z", contentHash: sha256(text), textHash: sha256(text), mediaType: "text/html", bytes: text.length, pages: [{ number: 1, text }], parser: "worldkit-text.1", identityMentioned: true };
  const draft = validateExtraction(device, document, sourceQueries(device), { facts: [], limitations: ["Synthetic missing-answer fixture"] });
  Object.assign(draft.facts[0]!.review, { status: "reviewed", reviewer: "Synthetic injected author", date: "2026-11-11" });
  const first = candidateProfile(device, document, draft); const before = structuredClone(first);
  const second = candidateProfile(device, document, { ...draft, id: `${draft.id}-another-proposal` });
  assert.notEqual(second.id, first.id); assert.deepEqual(first, before);
  assert.equal(immutableSource(device, document).id, immutableSource(device, { ...document, retrievedAt: "2026-11-12T00:00:00Z" }).id);
  assert.throws(() => candidateProfile(device, { ...document, contentHash: "a".repeat(64) }, draft), /exact source/);
  const confirmed = confirmedProfile("synthetic-inventory", identity(first), null, [first, second], new Date().toISOString());
  assert.equal(confirmed.basisProfileId, first.id); assert.equal(confirmed.baseProfileId, device.id); assert.equal(confirmed.portMapStatus, "pending");
  assert.deepEqual(confirmed.facts, first.facts); assert.ok(Object.values(confirmed.facts).every(fact => fact.review.status === "pending"));
});
test("an extracted but unmapped candidate keeps connections unknown without weakening an existing complete profile", () => {
  const kit = seedKit(); const before = graphHash(kit, profiles); const proposed = candidate("sony-mdr7506");
  kit.components.find(component => component.role === "monitor")!.profileId = proposed.id;
  assert.equal(connectionIssues(kit, [...profiles, proposed]).find(issue => issue.id === "audio-monitor")?.status, "unknown");
  assert.notEqual(verifyKit(kit, [...profiles, proposed], [...sources, ...candidateSources], architectures).status, "satisfied");
  assert.equal(graphHash(seedKit(), profiles), before);
  const broken = { ...proposed, portMapStatus: "reviewed" as const };
  assert.equal(connectionIssues(kit, [...profiles, broken]).find(issue => issue.id === "audio-monitor")?.status, "violated");
});
