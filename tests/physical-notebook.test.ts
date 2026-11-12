import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { BENCH_MAX_BYTES, BENCH_SCHEMA, BenchCommandSchema, BenchFileInputSchema, type BenchAsset, type BenchBinding, type BenchDecision, type BenchEdition } from "../packages/physical-notebook/contracts";
import { benchProtocol, assessBench, initialBenchConditions } from "../packages/physical-notebook/policy";
import { BenchInspectionError, inspectBenchOriginal, sampleBenchWave } from "../packages/physical-notebook/inspect";
import { hash } from "../packages/compatibility";
import { benchByteRange, sliceBenchStream } from "../src/server/physical-notebook-storage";
import { benchExport } from "../src/server/physical-notebook-export";
import { readBenchJson } from "../src/server/physical-notebook-http";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function stream(bytes: Buffer, width = 113): ReadableStream<Uint8Array> { let offset = 0; return new ReadableStream({ pull(controller) { if (offset === bytes.length) { controller.close(); return; } controller.enqueue(bytes.subarray(offset, offset += Math.min(width, bytes.length - offset))); } }); }
const at = "2026-11-12T10:00:00.000Z";
const rights = { basis: "original_creator" as const, holder: "Synthetic policy fixture", permissionReference: "Unit-test-only fictional declaration", grantedAt: "2020-01-01T00:00:00.000Z", expiresAt: null, attribution: "Fictional validation fixture", privateReviewAllowed: true as const, publicSharingAllowed: false, identifiablePeople: false, participantConsentConfirmed: false, restrictions: "No actual recording or rights grant occurred." };
function specimen() {
  const binding: BenchBinding = { kind: "creator", subjectId: "synthetic-system", revisionId: "synthetic-revision", graphHash: hash("graph"), title: "Synthetic policy fixture", hash: hash("binding"), certificateHash: hash("certificate"), ruleVersion: "fixture-only", components: [{ id: "mic", profileId: "fixture-mic", model: "Synthetic microphone", profileHash: hash("mic") }], connections: [], configuration: [], sources: [], requirements: [], steps: [{ id: "source:mic", title: "Private participant marker", instruction: "Synthetic step", required: true, evidenceKinds: ["isolated_track"] }], graphSource: "sample" };
  const conditions = initialBenchConditions(binding); conditions.hardware = conditions.hardware.map(value => ({ ...value, revision: "Not applicable — synthetic fixture", firmware: "Not applicable — passive fixture", matchesBoundModel: true }));
  Object.assign(conditions, { hostOs: "Synthetic host", appAndVersion: "Synthetic app 1", recordingSettings: "16 kHz fixture", streamSettings: "Not applicable in fixture", storage: "Memory fixture", power: "No hardware powered", hubsAndCables: "None — fixture", monitoring: "No actual listener", declaredSeconds: 1, operator: "PRIVATE_OPERATOR_SENTINEL", notes: "PRIVATE_NOTE_SENTINEL" });
  const asset: BenchAsset = { id: randomUUID(), runId: "run", uploadId: "upload", filename: "PRIVATE_FILENAME.wav", bytes: 100, mediaType: "audio/wav", kind: "isolated_track", provenance: "operator_original", expectedSha256: null, rights, sha256: hash("bytes"), verifiedAt: at, observedMediaType: "audio/wav", originalBytesRetained: true, availability: "available", detectedModelExport: false, audio: null, inspectionNotes: [] };
  asset.audio = { format: "pcm", channels: 1, sampleRate: 16000, bitsPerSample: 16, frames: 32000, durationSeconds: 2, channelPeaks: [0.2], channelRms: [0.1], envelope: [[0.2]], clippingSamples: [0], scope: "Byte-derived waveform and channel statistics; neither physical origin nor microphone independence is inferred." };
  const edition: BenchEdition = { schema: BENCH_SCHEMA, id: "edition", runId: "run", number: 7, parentId: "previous", hash: hash("edition"), title: "PRIVATE_TITLE_SENTINEL", sourceMode: "operator_recorded", phase: "sealed", binding, conditions, observations: [{ id: "observation", stepId: "source:mic", outcome: "observed_pass", detail: "PRIVATE_OBSERVATION_SENTINEL", observedAt: at, recordedAt: at, actorId: "owner" }], attachments: [{ id: "attachment", assetId: asset.id, assetHash: asset.sha256, stepId: "source:mic", note: "PRIVATE_ATTACHMENT_SENTINEL", attachedAt: at }], declaredAt: at, startedAt: at, finishedAt: "2026-11-12T10:00:02.000Z", sealedAt: "2026-11-12T10:00:03.000Z", createdAt: at, reason: "PRIVATE_REASON_SENTINEL" };
  const decision: BenchDecision = { id: "decision", editionId: edition.id, editionHash: edition.hash, actorId: "fictional-reviewer", actorName: "PRIVATE_REVIEWER_SENTINEL", principalHash: hash("fictional-identity"), qualificationId: "fictional-qualification", grantId: "grant", grantVersion: 2, provenance: "human", createdAt: at, currentlyQualified: true, currentAuthority: true, outcome: "supports_reported_scope", finding: "PRIVATE_FINDING_SENTINEL", limitations: "PRIVATE_LIMITATIONS_SENTINEL", inspectedAssetIds: [asset.id], inspectedOriginals: true, reviewedExactConditions: true };
  return { binding, asset, edition, decision };
}

test("streamed generated WAV retains exact hash and per-channel waveform without inferring hardware", async () => {
  const bytes = sampleBenchWave(3, hash("graph"));
  for (const width of [1, 7, 64, 8192]) {
    const result = await inspectBenchOriginal(stream(bytes, width), { bytes: bytes.length, mediaType: "audio/wav", expectedSha256: sha(bytes) });
    assert.equal(result.sha256, sha(bytes)); assert.equal(result.audio?.channels, 3); assert.equal(result.audio.durationSeconds, 2);
    assert.equal(result.detectedModelExport, true); assert.ok(result.audio.channelRms.every(value => value > 0));
    assert.ok(result.audio.envelope[0]!.slice(40).every(value => value === 0));
    assert.match(result.audio.scope, /neither physical origin/);
  }
});
test("unsupported WAV encoding remains explicitly uninspected rather than guessed", async () => {
  const bytes = sampleBenchWave(2, hash("graph")); bytes.writeUInt16LE(6, 20);
  const result = await inspectBenchOriginal(stream(bytes), { bytes: bytes.length, mediaType: "audio/wav", expectedSha256: null });
  assert.equal(result.audio, null); assert.match(result.inspectionNotes.join(" "), /no computed waveform|no supported complete/);
});
test("wrong original hash and media signature are refused", async () => {
  const bytes = sampleBenchWave(2, hash("graph"));
  await assert.rejects(inspectBenchOriginal(stream(bytes), { bytes: bytes.length, mediaType: "audio/wav", expectedSha256: "0".repeat(64) }), BenchInspectionError);
  await assert.rejects(inspectBenchOriginal(stream(bytes), { bytes: bytes.length, mediaType: "image/png", expectedSha256: null }), BenchInspectionError);
});
test("oversized and incomplete original streams stop without allocating the declared maximum", async () => {
  let pulls = 0, cancelled = false;
  const source = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(32)); }, cancel() { cancelled = true; } });
  await assert.rejects(inspectBenchOriginal(source, { bytes: 64, mediaType: "image/png", expectedSha256: null }), BenchInspectionError);
  assert.equal(cancelled, true); assert.ok(pulls <= 5);
  await assert.rejects(inspectBenchOriginal(stream(Buffer.alloc(8)), { bytes: 12, mediaType: "audio/wav", expectedSha256: null }), /incomplete/);
});
test("desk and SD podcast protocols preserve their actual camera/display scope", () => {
  assert.equal(benchProtocol("desk", [], { displays: 1 }).find(value => value.id === "display_two")?.required, false);
  assert.equal(benchProtocol("audio", [{ id: "a", label: "A" }], { cameraRequired: false }).find(value => value.id === "camera")?.required, false);
  assert.equal(benchProtocol("audio", [{ id: "a", label: "A" }], { cameraRequired: true }).find(value => value.id === "camera")?.required, true);
});
test("rights and byte-size input cannot silently omit participant permission", () => {
  const input = { filename: "recording.wav", bytes: 100, mediaType: "audio/wav", kind: "isolated_track", provenance: "operator_original", expectedSha256: null, rights };
  assert.equal(BenchFileInputSchema.safeParse(input).success, true);
  assert.equal(BenchFileInputSchema.safeParse({ ...input, bytes: BENCH_MAX_BYTES + 1 }).success, false);
  assert.equal(BenchFileInputSchema.safeParse({ ...input, filename: "../private.wav" }).success, false);
  assert.equal(BenchFileInputSchema.safeParse({ ...input, rights: { ...rights, identifiablePeople: true } }).success, false);
  assert.equal(BenchFileInputSchema.safeParse({ ...input, rights: { ...rights, expiresAt: "2019-01-01T00:00:00.000Z" } }).success, false);
});
test("an illustrative qualified decision supports only its exact complete sealed report", () => {
  const { edition, asset, decision } = specimen();
  const accepted = assessBench(edition, [asset], [decision]); assert.equal(accepted.status, "reviewed_exact_conditions"); assert.equal(accepted.existingCertificateChanged, false);
  assert.equal(assessBench(edition, [asset], [{ ...decision, editionHash: hash("other") }]).actualQualifiedReviews, 0);
  assert.equal(assessBench(edition, [asset], [{ ...decision, currentAuthority: false }]).physicalExecution, "operator_reported");
  assert.equal(assessBench(edition, [asset], [{ ...decision, currentlyQualified: false }]).actualQualifiedReviews, 0);
});
test("Sample reports and Sample reviews never count as real physical/human evidence", () => {
  const { edition, asset, decision } = specimen();
  const sample = assessBench({ ...edition, sourceMode: "sample" }, [asset], [decision]);
  assert.equal(sample.actualQualifiedReviews, 0); assert.equal(sample.physicalExecution, "not_performed"); assert.equal(sample.status, "sample_only");
  const review = assessBench(edition, [asset], [{ ...decision, provenance: "sample" }]); assert.equal(review.actualQualifiedReviews, 0); assert.equal(review.sampleReviews, 1);
});
test("withheld, generated or expired originals cannot support complete physical evidence", () => {
  const { edition, asset, decision } = specimen();
  for (const patch of [{ availability: "withdrawn" as const }, { originalBytesRetained: false }, { detectedModelExport: true }, { provenance: "model_export" as const }, { rights: { ...asset.rights, expiresAt: "2020-01-02T00:00:00.000Z" } }]) assert.equal(assessBench(edition, [{ ...asset, ...patch }], [decision]).status, "evidence_incomplete");
});
test("observed failures and an independent contradiction survive later support/revocation", () => {
  const { edition, asset, decision } = specimen(); edition.observations.push({ ...edition.observations[0]!, id: "failure", outcome: "observed_failure" });
  assert.equal(assessBench(edition, [asset], [decision]).status, "reported_failure");
  assert.equal(assessBench(edition, [], [decision]).physicalExecution, "operator_reported");
  assert.equal(assessBench(edition, [asset], [{ ...decision, outcome: "contradiction", currentAuthority: false, currentlyQualified: false }]).status, "review_contradicted");
});
test("unknown conditions and short intervals cannot be covered by a positive review", () => {
  const { edition, asset, decision } = specimen(); edition.conditions.declaredSeconds = 60; edition.conditions.power = "Not recorded";
  const result = assessBench(edition, [asset], [decision]); assert.equal(result.status, "evidence_incomplete"); assert.ok(result.missing.some(value => value.includes("declared 60"))); assert.ok(result.missing.some(value => value.includes("power")));
});
test("qualified reviewer aliases count once", () => {
  const { edition, asset, decision } = specimen();
  assert.equal(assessBench(edition, [asset], [decision, { ...decision, id: "second", grantId: "second-grant", actorId: "alias" }]).actualQualifiedReviews, 1);
});
test("redacted export excludes private text and URLs while binding hashes remain reproducible", () => {
  const { edition, asset, decision } = specimen(); const assessment = assessBench(edition, [asset], [decision]);
  const detail = { runId: "run", currentEditionId: edition.id, currentVersion: edition.number, currentEditionHash: edition.hash, edition, historical: false, subjectCurrent: true, subjectIssues: [], history: [], assets: [asset], uploads: [], grants: [], decisions: [decision], serials: [], assessment, role: "owner" as const, reviewer: null, events: [] };
  const exported = benchExport(detail, true); assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_|Private participant marker|Synthetic policy fixture/);
  const { exportHash, ...body } = exported; assert.equal(hash(body), exportHash); assert.match(JSON.stringify(benchExport(detail, false)), /PRIVATE_OBSERVATION_SENTINEL/);
});
test("single-byte and suffix media ranges preserve the exact original bytes", async () => {
  const bytes = Buffer.from("0123456789"); assert.deepEqual(benchByteRange("bytes=-3", 10), { start: 7, end: 9 }); assert.deepEqual(benchByteRange("bytes=2-", 10), { start: 2, end: 9 });
  assert.equal(Buffer.from(await new Response(sliceBenchStream(stream(bytes, 2), 3, 6)).arrayBuffer()).toString(), "3456");
  for (const invalid of ["bytes=10-", "bytes=8-2", "bytes=-0", "bytes=0-2,5-8", "bytes=-"]) assert.throws(() => benchByteRange(invalid, 10));
});
test("JSON parser bounds bytes, preserves split UTF-8, and rejects unsupported media", async () => {
  const body = Buffer.from(JSON.stringify({ note: "Two voices · original" }));
  const parsed = await readBenchJson(new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream(body, 1), duplex: "half" } as RequestInit)); assert.deepEqual(parsed, { note: "Two voices · original" });
  let pulls = 0, cancelled = false;
  const huge = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(16384)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBenchJson(new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: huge, duplex: "half" } as RequestInit)), (error: any) => error.status === 413); assert.ok(cancelled && pulls <= 6);
});
test("command scope cannot contain unexpected authority or overwrite fields", () => {
  const command = { kind: "create", requestId: randomUUID(), subject: { kind: "creator", subjectId: "kit", revisionId: "revision", graphHash: hash("graph") }, title: "Synthetic report", sourceMode: "sample", acknowledgedEvidenceScope: true };
  assert.equal(BenchCommandSchema.safeParse(command).success, true); assert.equal(BenchCommandSchema.safeParse({ ...command, actualQualifiedReviews: 10 }).success, false);
});
