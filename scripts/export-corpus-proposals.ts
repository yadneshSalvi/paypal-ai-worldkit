import { readFile, writeFile } from "node:fs/promises";
import { corpusDevices } from "../packages/spec-evidence/sources";
import type { ExtractionDraft } from "../packages/spec-evidence/contracts";
import type { ModelReceipt } from "../packages/planner";

const manifest = JSON.parse(await readFile("packages/device-library/corpus-source-manifest.json", "utf8")) as { profileId: string; contentHash: string; textHash: string }[];
const proposals: { profileId: string; draft: ExtractionDraft; receipt: ModelReceipt }[] = [];
const unavailable: string[] = [];
for (const device of corpusDevices) {
  const path = device.split === "held_out" ? `.artifacts/source-evaluation/v2/${device.id}.openai.json` : `.artifacts/development-source-extraction/v1/${device.id}.json`;
  const result = JSON.parse(await readFile(path, "utf8")) as { status: string; draft: ExtractionDraft | null; receipt: ModelReceipt | null };
  if (result.status === "running") throw new Error("Wait for the declared primary provider's complete run before exporting.");
  if (result.status !== "succeeded" || !result.draft || !result.receipt) { unavailable.push(device.id); continue; }
  const source = manifest.find(row => row.profileId === device.id);
  if (!source || source.contentHash !== result.draft.sourceHash || source.textHash !== result.draft.textHash || result.draft.promotion !== "human_review_required" || result.draft.facts.some(fact => fact.review.status !== "pending")) throw new Error("A corpus proposal lost its immutable source or review boundary.");
  proposals.push({ profileId: device.id, draft: result.draft, receipt: result.receipt });
}
await writeFile("packages/device-library/corpus-proposals.json", JSON.stringify(proposals, null, 2) + "\n");
console.log(JSON.stringify({ sourceProfiles: corpusDevices.length, actualPrimaryProviderProposals: proposals.length, unavailable, humanReviews: 0, verifiedPromotions: 0, physicalTests: 0 }));
