import test from "node:test";
import assert from "node:assert/strict";
import { traceSourceImpact } from "../packages/spec-evidence/impact";
import { impactFixture } from "./support/source-impact-fixture";

test("a changed document traces direct and downstream review targets without changing historical verdicts", () => {
  const { bundle, source } = impactFixture(), before = structuredClone(bundle);
  const report = traceSourceImpact(source, [bundle]), result = report.impacts[0]!;
  assert.equal(result.state, "changed_document");
  assert.deepEqual(result.componentIds, ["audio"]);
  assert.ok(result.paths.some(path => path.id === "mic1-audio" && path.direct));
  assert.ok(result.paths.some(path => path.id === "hub-host" && !path.direct));
  assert.ok(!result.paths.some(path => path.id === "camera-capture" || path.id === "power-hub"));
  assert.ok(result.requirements.some(value => value.id === "R1"));
  assert.equal(result.historicalCertificate.graphHash, bundle.certificate.graphHash);
  assert.equal(result.historicalCertificate.status, bundle.certificate.status);
  assert.deepEqual(bundle, before);
  assert.equal(traceSourceImpact(source, [bundle]).digest, report.digest);
});
test("a repeated retrieval of identical bytes does not create a source change", () => {
  const { source, bundle, profile } = impactFixture(); source.contentHash = profile.sourceVersion!;
  assert.equal(traceSourceImpact(source, [bundle]).impacts[0]!.state, "same_document");
  const history = { ...source, current: false, documentId: "historical-retrieval" };
  assert.equal(traceSourceImpact(history, [bundle]).impacts[0]!.state, "same_document");
  assert.notEqual(traceSourceImpact(history, [bundle]).digest, traceSourceImpact(source, [bundle]).digest);
});
test("disabled edges stop downstream propagation and cycles remain bounded", () => {
  const { source, bundle } = impactFixture(); bundle.kit.connections.find(edge => edge.id === "audio-hub")!.enabled = false;
  let result = traceSourceImpact(source, [bundle]).impacts[0]!;
  assert.ok(!result.paths.some(path => path.id === "audio-hub" || path.id === "hub-host"));
  const edge = structuredClone(bundle.kit.connections.find(value => value.id === "audio-monitor")!);
  edge.id = "cycle"; [edge.from, edge.to] = [edge.to, edge.from]; bundle.kit.connections.push(edge);
  result = traceSourceImpact(source, [bundle]).impacts[0]!;
  assert.equal(result.paths.filter(path => path.id === "cycle").length, 1);
  assert.equal(result.paths.length, 4);
});
test("exact model identity excludes a similar generation and unused profile records", () => {
  const { source, bundle, profile } = impactFixture();
  assert.equal(traceSourceImpact({ ...source, profileId: source.profileId + "-ii" }, [bundle]).impacts.length, 0);
  profile.corpusId = "different-variant";
  assert.equal(traceSourceImpact(source, [bundle]).impacts.length, 0);
  delete profile.corpusId; bundle.kit.components = bundle.kit.components.filter(component => component.profileId !== profile.id);
  assert.equal(traceSourceImpact(source, [bundle]).impacts.length, 0);
});
test("confirmed inventory derivatives retain their exact corpus lineage", () => {
  const { source, bundle, profile } = impactFixture();
  bundle.kit.components.find(component => component.id === "audio")!.profileId = "inventory:exact";
  profile.baseProfileId = profile.id; profile.id = "inventory:exact";
  assert.equal(traceSourceImpact(source, [bundle]).impacts.length, 1);
  profile.baseProfileId = "another-variant";
  assert.equal(traceSourceImpact(source, [bundle]).impacts.length, 0);
});
test("unavailable and unbound sources retain explicit uncertainty", () => {
  const { source, bundle, profile, sourceRecord } = impactFixture();
  assert.equal(traceSourceImpact({ ...source, status: "unavailable" }, [bundle]).impacts[0]!.state, "unavailable_document");
  delete profile.sourceVersion; sourceRecord.contentHash = "";
  assert.equal(traceSourceImpact(source, [bundle]).impacts[0]!.state, "incomplete_binding");
  const unreferenced = { ...sourceRecord, id: "unrelated-record", contentHash: source.contentHash! };
  bundle.sources.push(unreferenced);
  assert.equal(traceSourceImpact(source, [bundle]).impacts[0]!.state, "incomplete_binding");
});
test("multiple instances and historical revisions are explicit and incomplete scans cannot imply full coverage", () => {
  const { source, bundle } = impactFixture();
  const duplicate = { ...structuredClone(bundle.kit.components.find(component => component.id === "audio")!), id: "second-recorder" };
  bundle.kit.components.push(duplicate);
  const older = structuredClone(bundle); older.current = false; older.kit.id = "older"; older.kit.revision = 0;
  const report = traceSourceImpact(source, [older, bundle], 101, 2);
  assert.deepEqual(report.impacts[0]!.componentIds, ["audio", "second-recorder"]);
  assert.equal(report.impacts[0]!.current, true); assert.equal(report.impacts[1]!.current, false);
  assert.deepEqual(report.coverage, { revisionsInspected: 2, totalSavedRevisions: 101, complete: false, limit: 2 });
});
