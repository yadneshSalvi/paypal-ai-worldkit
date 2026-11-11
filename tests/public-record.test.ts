import test from "node:test";
import assert from "node:assert/strict";
import { architectures, profiles, seedKit, sources } from "../packages/device-library/index";
import { verifyKit } from "../packages/compatibility/index";
import { projectPublicRecord, publicRecordHash, publicReferenceUrl, PublicRecordPayloadSchema } from "../packages/public-record/index";

function fixture() {
  const kit = seedKit(), devices = structuredClone(profiles), refs = structuredClone(sources);
  return { kit, profiles: devices, sources: refs, certificate: verifyKit(kit, devices, refs, architectures) };
}
test("a public projection preserves exact graph, witnesses and unknowns without claiming physical results", () => {
  const f = fixture(), publicRecord = projectPublicRecord(f, "A studio for two musicians");
  assert.equal(publicRecord.graphHash, f.certificate.graphHash); assert.equal(publicRecord.certificateId, f.certificate.id);
  assert.equal(publicRecord.physicalTest, "not_performed"); assert.deepEqual(publicRecord.counts, f.certificate.counts);
  assert.equal(publicRecord.requirements.length, f.kit.goal.requirements.length);
  for (const requirement of publicRecord.requirements) {
    const original = f.certificate.results.find(result => result.requirementId === requirement.id)!;
    assert.equal(requirement.status, original.status); assert.deepEqual(requirement.witness.factIds, original.factIds);
    assert.deepEqual(requirement.witness.connectionIds, original.connectionIds);
  }
  assert.ok(publicRecord.requirements.some(r => r.status === "unknown"));
  assert.equal(publicRecord.review.pending, f.certificate.review.pending);
});
test("private inventory, notes, raw source text, reviewer identities, signed links and extra properties never enter the payload", () => {
  const f = fixture();
  f.kit.goal.brief = "PRIVATE_GOAL_BRIEF"; f.kit.goal.title = "PRIVATE_GOAL_TITLE";
  f.kit.components[0]!.inventoryItemId = "PRIVATE_INVENTORY_ID";
  f.kit.components[0]!.settings.apiKey = "PRIVATE_API_KEY";
  Object.assign(f.kit.components[0]!, { serial: "PRIVATE_SERIAL" });
  for (const profile of f.profiles) {
    Object.assign(profile, { privateNote: "PRIVATE_INVENTORY_NOTE" });
    for (const fact of Object.values(profile.facts)) {
      fact.review.reviewer = "PRIVATE_REVIEWER";
      fact.extraction = { draftId: "PRIVATE_DRAFT_ID", validation: "located_pending_review" };
      fact.interpretation = "PRIVATE_UNREVIEWED_INTERPRETATION";
    }
  }
  for (const source of f.sources) { source.summary = "PRIVATE_SOURCE_EXCERPT"; source.location = "PRIVATE_STORAGE_PATH"; source.url = "https://example.org/manual?token=PRIVATE_DOWNLOAD_TOKEN"; }
  Object.assign(f, { receipts: [{ destination: "PRIVATE_PAYMENT_DESTINATION" }], tenantId: "PRIVATE_TENANT_ID" });
  f.certificate = verifyKit(f.kit, f.profiles, f.sources, architectures);
  const publicRecord = projectPublicRecord(f, "Explicitly reviewed public title");
  assert.equal(JSON.stringify(publicRecord).includes("PRIVATE_"), false);
  assert.ok(publicRecord.sources.length); assert.ok(publicRecord.sources.every(source => source.url === null && source.linkState === "withheld"));
  assert.throws(() => PublicRecordPayloadSchema.parse({ ...publicRecord, tenantId: "PRIVATE_TENANT_ID" }));
});
test("public reference links reject local addresses, private storage, credentials and token-bearing URLs", () => {
  for (const url of ["https://127.0.0.1/x", "https://[::1]/x", "http://localhost/manual", "https://router.local/x", "https://user:password@example.com/x", "https://example.com/?signed=secret", "https://example.com/#token", "javascript:alert(1)", "https://private.blob.vercel-storage.com/x", "https://127.0.0.1.nip.io/x", "http://10.0.0.1/x", "https://example.com:8443/private"]) assert.equal(publicReferenceUrl(url), null, url);
  assert.equal(publicReferenceUrl("https://zoomcorp.com/manuals/recorder.pdf"), "https://zoomcorp.com/manuals/recorder.pdf");
});
test("a disabled saved path remains disabled in the guide and cannot be described as a completed test", () => {
  const f = fixture(); f.kit.connections[0]!.enabled = false; f.certificate = verifyKit(f.kit, f.profiles, f.sources, architectures);
  const record = projectPublicRecord(f, "Disconnected path exercise"), step = record.assembly.find(item => item.connectionId === f.kit.connections[0]!.id)!;
  assert.equal(step.enabled, false); assert.match(step.instruction, /Do not assemble/); assert.equal(record.physicalTest, "not_performed");
  assert.equal(record.assembly.length, f.kit.connections.length); assert.deepEqual(record.assembly.map(step => step.connectionId), f.kit.connections.map(edge => edge.id));
});
test("stale graph identity, altered witnesses and inconsistent totals are rejected before review", () => {
  const changed = fixture(); changed.kit.components[0]!.quantity = 2;
  assert.throws(() => projectPublicRecord(changed, "Changed graph"), /exact saved graph/);
  const forged = fixture(); forged.certificate.results[0]!.status = forged.certificate.results[0]!.status === "satisfied" ? "unknown" : "satisfied";
  assert.throws(() => projectPublicRecord(forged, "Changed witness"), /inconsistent/);
  const totals = fixture(); totals.certificate.counts.satisfied++;
  assert.throws(() => projectPublicRecord(totals, "Changed totals"), /inconsistent/);
});
test("publication fingerprints cover title and the exact guide, without depending on object-key order", () => {
  const record = projectPublicRecord(fixture(), "Reviewed studio", "2026-11-11T09:00:00.000Z"), original = publicRecordHash(record);
  assert.equal(publicRecordHash({ ...record }), original);
  assert.notEqual(publicRecordHash({ ...record, title: "A different title" }), original);
  const changed = structuredClone(record); changed.assembly[0]!.instruction += " Changed.";
  assert.notEqual(publicRecordHash(changed), original);
});
test("publication cannot promote unknown checks or fabricate a reviewed critical-fact count", () => {
  const status = fixture(); status.certificate.status = "satisfied";
  assert.throws(() => projectPublicRecord(status, "False green status"), /status or review coverage/);
  const review = fixture(); review.certificate.review.reviewed = review.certificate.review.required; review.certificate.review.pending = 0;
  assert.throws(() => projectPublicRecord(review, "False review status"), /status or review coverage/);
  const missing = fixture(); missing.sources = missing.sources.filter(s => s.id !== "zoom-h4-manual"); missing.certificate = verifyKit(missing.kit, missing.profiles, missing.sources, architectures);
  assert.throws(() => projectPublicRecord(missing, "Missing source record"), /referenced source is missing/);
});
