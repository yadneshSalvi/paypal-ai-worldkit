import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { candidateProfiles } from "../packages/device-library/candidates";
import { profileChoice } from "../packages/inventory/identity";
import { sha256, type SourceDocument } from "../packages/spec-evidence/sources";
import type { ExtractionDraft } from "../packages/spec-evidence/contracts";
import type { ModelReceipt } from "../packages/planner";

// This audit uses retained private source copies. It never calls a provider or
// claims that the quotation semantically supports the extracted interpretation.
const bytes = await readFile("packages/device-library/corpus-proposals.json");
const proposals = JSON.parse(bytes.toString()) as { profileId: string; draft: ExtractionDraft; receipt: ModelReceipt }[];
assert.equal(proposals.length, 60); assert.equal(new Set(proposals.map(row => row.profileId)).size, 60);
let anchors = 0;
const counts = { located: 0, unknown: 0, conflicted: 0, rejected: 0 };
for (const { profileId, draft, receipt } of proposals) {
  const prefix = `.artifacts/manufacturer-corpus/${profileId}/${draft.sourceHash}`;
  const document = JSON.parse(await readFile(`${prefix}.json`, "utf8")) as SourceDocument;
  assert.equal(sha256(await readFile(`${prefix}.source`)), draft.sourceHash);
  assert.equal(sha256(document.pages.map(page => page.text).join("\n\n")), draft.textHash);
  assert.equal(draft.promotion, "human_review_required"); assert.equal(receipt.provider, "openai"); assert.ok(receipt.requestId);
  for (const fact of draft.facts) {
    assert.deepEqual(fact.review, { status: "pending", reviewer: null, date: null });
    for (const anchor of fact.evidence) {
      const page = document.pages.find(page => page.number === anchor.page); assert.ok(page);
      assert.equal(anchor.contentHash, draft.sourceHash); assert.equal(anchor.textHash, draft.textHash);
      assert.ok(anchor.end > anchor.start && anchor.start >= 0 && anchor.end <= page.text.length);
      assert.equal(sha256(page.text.slice(anchor.start, anchor.end)), anchor.excerptHash); anchors++;
    }
  }
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] += draft.counts[key];
}
assert.ok(candidateProfiles.every(profile => profile.portMapStatus === "pending" && profile.facts.technicalScope?.state === "unknown" && Object.values(profile.facts).every(fact => fact.review.status === "pending")));
const report = { checkedAt: new Date().toISOString(), providerCallsInThisAudit: 0, sourceProfiles: proposals.length, actualPrimaryProviderProposals: proposals.length, primaryProvider: "openai", proposalFileHash: sha256(bytes), counts, locatedAnchorsCheckedAgainstRetainedSource: anchors, compactIdentityBytes: Buffer.byteLength(JSON.stringify(candidateProfiles.map(profileChoice))), humanReviews: 0, verifiedPromotions: 0, physicalTests: 0, limitations: ["Exact UTF-16 source locations and fingerprints were checked. Semantic support and engineering correctness remain unreviewed.", "A library candidate is not a complete port map or a physical test.", "Held-out reference agreement is reported separately and is not human-gold accuracy."] };
await writeFile("docs/evidence/corpus-library-qualification.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
