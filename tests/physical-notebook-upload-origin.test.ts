import test from "node:test";
import assert from "node:assert/strict";
import { BenchFileInputSchema } from "../packages/physical-notebook/contracts";
import { assertBenchRights, benchUploadDto } from "../src/server/physical-notebook-assets";

const file = BenchFileInputSchema.parse({
  filename: "Synthetic-manual-upload.wav", bytes: 128_044, mediaType: "audio/wav", kind: "isolated_track",
  provenance: "sample_generated", expectedSha256: null,
  rights: { basis: "sample_generated", holder: "Synthetic control", permissionReference: "Generated test tones; no equipment or participant recording.", grantedAt: "2026-11-12T00:00:00.000Z", expiresAt: null, attribution: "Synthetic control", privateReviewAllowed: true, publicSharingAllowed: false, identifiablePeople: false, participantConsentConfirmed: false, restrictions: "Never physical evidence." },
});
const row = {
  id: "b53d0847-e05c-43f6-89c8-ac4ba683f2b6", run_id: "33c97f7a-9e9b-4cb5-9519-39fd391f2410", file,
  created_at: "2026-11-12T00:00:00.000Z", expires_at: "2026-11-12T01:00:00.000Z", phase: "awaiting_upload",
  asset_id: null, failure: null, transport: "controlled_local", pathname: "physical-notebook/sample/synthetic/control/original.wav",
  attempts: 0, withdrawn_at: null, purged_at: null, completed_receipt: null,
};

test("a manually selected Sample original keeps its declared rights and is distinguished from an app-generated helper", () => {
  assert.doesNotThrow(() => assertBenchRights(file));
  const value = benchUploadDto(row);
  assert.equal(value.generatedSample, false);
  assert.deepEqual(value.file, file);
  assert.equal(value.phase, "awaiting_upload");
  assert.equal(value.attempts, 0);
});

test("only the retained internal helper receipt identifies an app-generated Sample, including after DTO reconstruction", () => {
  const generated = benchUploadDto({ ...row, completed_receipt: { generator: "worldkit.physical-sample.1", part: 0, graphHash: "a".repeat(64), inputs: 6 } });
  assert.equal(generated.generatedSample, true);
  assert.equal(generated.file.provenance, "sample_generated");
  const deliveredManual = benchUploadDto({ ...row, phase: "uploaded", completed_receipt: { source: "controlled_blob_signature_test", deliveryHash: "b".repeat(64) } });
  assert.equal(deliveredManual.generatedSample, false);
  assert.equal(deliveredManual.file.provenance, "sample_generated");
});

test("a caller cannot turn a manually declared file into an internal helper or remove its Sample rights", () => {
  assert.equal(BenchFileInputSchema.safeParse({ ...file, generatedSample: true }).success, false);
  assert.equal(BenchFileInputSchema.safeParse({ ...file, completed_receipt: { generator: "worldkit.physical-sample.1" } }).success, false);
  assert.throws(() => assertBenchRights({ ...file, rights: { ...file.rights, basis: "original_creator" } }));
});
