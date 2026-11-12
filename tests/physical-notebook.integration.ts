import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { hash } from "../packages/compatibility";
import { WorldKitError } from "../packages/contracts";
import type { BenchAccess, BenchCommandResult, BenchDetail, BenchFileInput, BenchHome } from "../packages/physical-notebook/contracts";
import { sampleBenchWave } from "../packages/physical-notebook/inspect";
import { database, closeDatabase, transaction } from "../src/server/db";
import { createSession, findSession, getRevision, type Session } from "../src/server/repository";
import { domainCommand, domainHome } from "../src/server/domain-packs";
import { initializePhysicalNotebook } from "../src/server/physical-notebook-db";
import { authenticateBenchReviewer, benchPrincipal, ownerBenchAccess } from "../src/server/physical-notebook-authority";
import { physicalNotebookCommand, physicalNotebookHome } from "../src/server/physical-notebook";
import { controlledBenchIntake } from "../src/server/physical-notebook-assets";
import { benchError, benchHeaders, benchOrigin, handlePhysicalNotebook, physicalOriginalResponse } from "../src/server/physical-notebook-http";
import { physicalExportResponse } from "../src/server/physical-notebook-export";
import { benchUploadTokenOptions, handleBenchBlob } from "../src/server/physical-notebook-blob";
import { POST as redeemRoute } from "../src/app/api/physical-notebook/redeem/route";
import { maintainPhysicalNotebook } from "../src/server/physical-notebook-maintenance";
import { requireIsolatedDatabase } from "./support/isolated-database";

requireIsolatedDatabase();
let server: Server, base = "", lostResponses = 0, externalAttempts = 0;
const originalFetch = globalThis.fetch, originalPublic = process.env.WORLDKIT_PUBLIC_URL;
const fixtures: { id: string; expiresAt: string; initialRevisionHash: string }[] = [];
type Fixture = { session: Session; token: string; cookie: string; access: BenchAccess; runId: string; detail: BenchDetail; createInput: Record<string, unknown> };
const expected = (detail: BenchDetail) => ({ runId: detail.runId, expectedEditionId: detail.currentEditionId, expectedVersion: detail.currentVersion, expectedEditionHash: detail.currentEditionHash });
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const cookieValue = (request: Request, name: string) => request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
async function requestAccess(request: Request, reviewer = false) {
  if (reviewer) { const access = await authenticateBenchReviewer(cookieValue(request, "wk_bench_review_qa")); if (access) return access; }
  else { const session = await findSession(cookieValue(request, "wk_physical_qa")); if (session) return ownerBenchAccess(session); }
  throw new WorldKitError("forbidden", "A current private notebook credential is required.", 401);
}
before(async () => {
  await initializePhysicalNotebook();
  server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const chunks: Buffer[] = []; for await (const part of incoming) chunks.push(Buffer.from(part));
      const request = new Request(`${base}${incoming.url}`, { method: incoming.method, headers, ...(["GET", "HEAD"].includes(incoming.method!) ? {} : { body: Buffer.concat(chunks) }) });
      const url = new URL(request.url); let response: Response;
      try {
        if (url.pathname.endsWith("/redeem")) response = await redeemRoute(request);
        else if (url.pathname === "/api/physical-notebook/uploads") response = await handleBenchBlob(request, () => requestAccess(request));
        else if (url.pathname.includes("/uploads/")) { benchOrigin(request); response = Response.json(await controlledBenchIntake(await requestAccess(request), url.searchParams.get("runId") ?? "", url.pathname.split("/").at(-1)!, request.body!), { headers: benchHeaders }); }
        else if (url.pathname.includes("/originals/")) response = await physicalOriginalResponse(request, await requestAccess(request, url.searchParams.get("access") === "review"), url.pathname.split("/").at(-1)!);
        else if (url.pathname.endsWith("/export")) response = await physicalExportResponse(request, await requestAccess(request, url.searchParams.get("access") === "review"));
        else response = await handlePhysicalNotebook(request, await requestAccess(request, url.pathname.endsWith("/review")));
      } catch (error) { response = benchError(error); }
      if (headers.get("x-qa-drop-response") === "after-commit" && response.ok) { lostResponses++; outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!outgoing.destroyed) { outgoing.statusCode = 500; outgoing.end("Controlled HTTP bridge failure"); } }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.WORLDKIT_PUBLIC_URL = base;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => { const target = input instanceof Request ? input.url : String(input); if (!target.startsWith(`${base}/`)) { externalAttempts++; throw new Error("External transport is forbidden in physical notebook software qualification."); } return originalFetch(input, init); }) as typeof fetch;
});
after(async () => {
  try {
    const ids = fixtures.map(value => value.id), counts: Record<string, number> = {};
    for (const table of ["wk_provider_receipts", "wk_source_model_requests", "wk_source_model_observations", "wk_quotes", "wk_commerce_orders"]) {
      if ((await database().query("SELECT to_regclass($1) AS relation", [table])).rows[0].relation) {
        const sql = table === "wk_source_model_observations" ? "SELECT count(*) AS count FROM wk_source_model_observations o JOIN wk_source_model_requests r ON r.operation_id=o.operation_id WHERE r.tenant_id=ANY($1::text[])" : `SELECT count(*) AS count FROM ${table} WHERE tenant_id=ANY($1::text[])`;
        counts[table] = Number((await database().query(sql, [ids])).rows[0].count); assert.equal(counts[table], 0);
      }
    }
    assert.equal(externalAttempts, 0);
    const directory = ".local/physical-notebook-unit"; await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(`${directory}/integration-fixtures.private.json`, JSON.stringify({ at: new Date().toISOString(), kind: "controlled_loopback_and_fresh_postgresql_only", actualPhysicalTests: 0, actualHumanReviews: 0, externalAttempts, lostResponses, fixtures, counts }, null, 2), { mode: 0o600 });
  } finally { globalThis.fetch = originalFetch; process.env.WORLDKIT_PUBLIC_URL = originalPublic; if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } await closeDatabase(); }
});
async function json(cookie: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: base, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); return { response, data };
}
function successful(result: Awaited<ReturnType<typeof json>>) { assert.equal(result.response.status, 200, result.data.error?.message ?? "Notebook request failed"); return result.data; }
async function fixture(mode: "sample" | "operator_recorded" = "sample", domain = false): Promise<Fixture> {
  const created = await createSession(), revision = await getRevision(created.session.id); fixtures.push({ id: created.session.id, expiresAt: created.session.expiresAt, initialRevisionHash: hash(revision) });
  let subject = { kind: "creator" as "creator" | "domain", subjectId: revision.kit.kitId, revisionId: revision.kit.id, graphHash: revision.certificate.graphHash };
  if (domain) { const result = await domainCommand(created.session, { kind: "create", requestId: randomUUID(), packId: "desk-displays", title: "Synthetic notebook desk fixture" }); const selected = (await domainHome(created.session, result.projectId)).selected!; subject = { kind: "domain", subjectId: result.projectId, revisionId: selected.edition.id, graphHash: selected.edition.certificate.graphHash }; }
  const cookie = `wk_physical_qa=${created.token}`, createInput = { kind: "create", requestId: randomUUID(), subject, title: `Synthetic ${mode} software validation`, sourceMode: mode, acknowledgedEvidenceScope: true };
  const result = successful(await json(cookie, "/api/physical-notebook", createInput)) as BenchCommandResult;
  const home = successful(await json(cookie, `/api/physical-notebook?runId=${result.runId}`)) as BenchHome;
  return { session: created.session, token: created.token, cookie, access: ownerBenchAccess(created.session), runId: result.runId, detail: home.selected!, createInput };
}
async function refresh(f: Fixture) { f.detail = (successful(await json(f.cookie, `/api/physical-notebook?runId=${f.runId}`)) as BenchHome).selected!; return f.detail; }
async function command(f: Fixture, input: Record<string, unknown>, current = true) {
  const body = { requestId: randomUUID(), ...(current ? expected(f.detail) : { runId: f.runId }), ...input };
  const result = successful(await json(f.cookie, "/api/physical-notebook", body)) as BenchCommandResult; await refresh(f); return result;
}
async function begin(f: Fixture) {
  const conditions = structuredClone(f.detail.edition.conditions); conditions.hardware = conditions.hardware.map(value => ({ ...value, revision: "Synthetic fixture — not a physical measurement", firmware: "Not applicable — no real device", matchesBoundModel: true }));
  Object.assign(conditions, { hostOs: "Synthetic host", appAndVersion: "Synthetic application 1", recordingSettings: "No actual recording — software fixture", streamSettings: "No actual stream — software fixture", storage: "Controlled local fixture", power: "No powered equipment", hubsAndCables: "No physical cables", monitoring: "No actual listener", operator: "Synthetic operator", declaredSeconds: 60 });
  await command(f, { kind: "plan", conditions, reason: "Declare the controlled software rehearsal conditions" }); await command(f, { kind: "start", confirmedExactEquipment: true, acknowledgedOperatorReport: true });
}
async function samples(f: Fixture) {
  const prepared = await command(f, { kind: "sample_originals", acknowledgedGeneratedSample: true });
  for (const uploadId of prepared.sampleUploadIds!) await command(f, { kind: "verify_upload", uploadId }, false);
  return f.detail.assets;
}
async function sealed(f: Fixture) {
  await begin(f); const assets = await samples(f), first = f.detail.edition.binding.steps.find(step => step.evidenceKinds.includes("isolated_track"))!;
  await command(f, { kind: "observe", observation: { stepId: first.id, outcome: "observed_failure", detail: "Synthetic software rehearsal deliberately retains a failed observation. No hardware was tested.", observedAt: f.detail.edition.startedAt } });
  await command(f, { kind: "attach", assetId: assets.find(asset => asset.kind === "isolated_track")!.id, stepId: first.id, note: "Generated Sample original linked explicitly for software review." });
  await command(f, { kind: "finish", note: "Early finish is retained in this synthetic workflow." }); await command(f, { kind: "seal", acknowledgedManifestIsReportedEvidence: true }); return f;
}
async function invite(f: Fixture, provenance: "sample" | "human" = "sample") {
  const inviteInput = { kind: "invite_reviewer", requestId: randomUUID(), ...expected(f.detail), actorId: null, name: provenance === "sample" ? "Fictional Sample reviewer" : "Unestablished fictional invitation", provenance, hours: 1, acknowledgedPrivateReviewOnly: true };
  const result = await command(f, inviteInput);
  const redeem = { requestId: randomUUID(), invitation: result.grant!.invitation! }, response = await json("", "/api/physical-notebook/redeem", redeem); successful(response);
  const cookie = response.response.headers.get("set-cookie")!.split(";")[0]!; return { grant: result.grant!, cookie, redeem, inviteInput };
}
function fileInput(bytes: Buffer, overrides: Partial<BenchFileInput> = {}): BenchFileInput {
  return { filename: "Synthetic-retained-original.wav", bytes: bytes.length, mediaType: "audio/wav", kind: "isolated_track", provenance: "third_party", expectedSha256: digest(bytes), rights: { basis: "original_creator", holder: "Synthetic test fixture", permissionReference: "Controlled local validation bytes; no real physical evidence.", grantedAt: new Date().toISOString(), expiresAt: null, attribution: "Synthetic workflow test", privateReviewAllowed: true, publicSharingAllowed: false, identifiablePeople: false, participantConsentConfirmed: false, restrictions: "Do not claim physical performance or authentic human rights." }, ...overrides };
}
async function upload(f: Fixture, bytes: Buffer, file = fileInput(bytes)) {
  const result = await command(f, { kind: "upload_intent", file }); const intent = result.upload!;
  const response = await fetch(`${base}/api/physical-notebook/uploads/${intent.id}?runId=${f.runId}`, { method: "PUT", headers: { Cookie: f.cookie, Origin: base, "Content-Type": file.mediaType }, body: new Uint8Array(bytes) }); assert.equal(response.status, 200); return intent;
}

test("actual HTTP create/replay/collision preserves one exact binding and original certificate", async () => {
  const f = await fixture(); const again = successful(await json(f.cookie, "/api/physical-notebook", f.createInput)); assert.equal(again.runId, f.runId);
  const collision = await json(f.cookie, "/api/physical-notebook", { ...f.createInput, title: "Different body under the same UUID" }); assert.equal(collision.response.status, 409);
  const other = await fixture(); const foreign = await json(other.cookie, `/api/physical-notebook?runId=${f.runId}`); assert.equal(foreign.response.status, 404);
  assert.equal((await json("", "/api/physical-notebook")).response.status, 401);
  assert.equal((await json(f.cookie, "/api/physical-notebook", { ...f.createInput, requestId: randomUUID() }, { Origin: "https://foreign.invalid" })).response.status, 403);
  assert.equal(hash(await getRevision(f.session.id)), fixtures.find(value => value.id === f.session.id)!.initialRevisionHash);
  assert.equal((await database().query("SELECT count(*) AS count FROM wk_bench_runs WHERE tenant_id=$1", [f.session.id])).rows[0].count, "1");
});
test("actual socket loss after create commit recovers the same report with the original UUID", async () => {
  const f = await fixture(); const input = { ...f.createInput, requestId: randomUUID(), title: "Synthetic lost-response report" };
  await assert.rejects(json(f.cookie, "/api/physical-notebook", input, { "x-qa-drop-response": "after-commit" }));
  const recovered = successful(await json(f.cookie, "/api/physical-notebook", input)); assert.ok(recovered.runId);
  assert.equal((await database().query("SELECT count(*) AS count FROM wk_bench_commands WHERE tenant_id=$1 AND request_id=$2", [f.session.id, input.requestId])).rows[0].count, "1");
});
test("domain binding is exact and never adds camera requirements to an SD podcast", async () => {
  const f = await fixture("sample", true); assert.equal(f.detail.edition.binding.kind, "domain"); assert.ok(f.detail.edition.binding.steps.some(step => step.id === "display_two"));
  const { session } = await createSession(); fixtures.push({ id: session.id, expiresAt: session.expiresAt, initialRevisionHash: hash(await getRevision(session.id)) });
  const project = await domainCommand(session, { kind: "create", requestId: randomUUID(), packId: "podcast-classroom", title: "Synthetic SD-only protocol" }); const p = (await domainHome(session, project.projectId)).selected!;
  const run = await physicalNotebookCommand(ownerBenchAccess(session), { kind: "create", requestId: randomUUID(), subject: { kind: "domain", subjectId: p.project.id, revisionId: p.edition.id, graphHash: p.edition.certificate.graphHash }, title: "Synthetic SD notebook", sourceMode: "sample", acknowledgedEvidenceScope: true });
  assert.equal((await physicalNotebookHome(ownerBenchAccess(session), run.runId)).selected!.edition.binding.steps.find(step => step.id === "camera")!.required, false);
});
test("private serial stays sealed and historical plans preserve the original empty identity", async () => {
  const f = await fixture(); const priorId = f.detail.edition.id, componentId = f.detail.edition.binding.components[0]!.id, serial = "SYNTHETIC_PRIVATE_SERIAL_42";
  await command(f, { kind: "private_serial", componentId, serial }); assert.equal(f.detail.serials.length, 1); assert.doesNotMatch(JSON.stringify(f.detail), /SYNTHETIC_PRIVATE_SERIAL_42/);
  const row = (await database().query("SELECT * FROM wk_bench_serials WHERE tenant_id=$1", [f.session.id])).rows[0]; assert.equal(JSON.stringify(row).includes(serial), false);
  const old = successful(await json(f.cookie, `/api/physical-notebook?runId=${f.runId}&editionId=${priorId}`)) as BenchHome; assert.equal(old.selected!.serials.length, 0); assert.equal(old.selected!.historical, true);
  const exported = successful(await json(f.cookie, `/api/physical-notebook/export?runId=${f.runId}&view=private`)); assert.equal(JSON.stringify(exported).includes(serial), false);
});
test("early finish, failed observation, immutable sealing and Sample markers remain honest", async () => {
  const f = await sealed(await fixture()); assert.equal(f.detail.assessment.physicalExecution, "not_performed"); assert.equal(f.detail.assessment.actualQualifiedReviews, 0); assert.equal(f.detail.assessment.reportedFailures, 1); assert.ok(f.detail.assessment.missing.some(value => value.includes("declared 60")));
  assert.equal(f.detail.assets.length, 3); assert.ok(f.detail.assets.every(asset => asset.detectedModelExport && asset.provenance === "sample_generated"));
  const edit = await json(f.cookie, "/api/physical-notebook", { kind: "plan", requestId: randomUUID(), ...expected(f.detail), conditions: f.detail.edition.conditions, reason: "Cannot rewrite a sealed report" }); assert.equal(edit.response.status, 409);
  for (const table of ["wk_bench_editions", "wk_bench_assets", "wk_bench_commands", "wk_bench_events"]) await assert.rejects(database().query(`DELETE FROM ${table} WHERE tenant_id=$1`, [f.session.id]));
});
test("original bytes survive upload, verification, range playback and hash-bound attachment", async () => {
  const f = await fixture(), bytes = sampleBenchWave(2, hash("controlled-original")); const intent = await upload(f, bytes);
  await command(f, { kind: "verify_upload", uploadId: intent.id }, false); const asset = f.detail.assets[0]!; assert.equal(asset.sha256, digest(bytes)); assert.equal(asset.detectedModelExport, true);
  const response = await fetch(`${base}/api/physical-notebook/originals/${asset.id}?runId=${f.runId}`, { headers: { Cookie: f.cookie, Range: "bytes=0-99" } }); assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 100)); assert.equal(response.headers.get("x-worldkit-original-sha256"), digest(bytes)); assert.match(response.headers.get("cache-control")!, /no-store/);
  const original = await fetch(`${base}/api/physical-notebook/originals/${asset.id}?runId=${f.runId}`, { headers: { Cookie: f.cookie } }); assert.equal(digest(Buffer.from(await original.arrayBuffer())), digest(bytes));
  const before = f.detail.edition.hash; await command(f, { kind: "attach", assetId: asset.id, stepId: f.detail.edition.binding.steps.find(step => step.evidenceKinds.includes("isolated_track"))!.id, note: "Explicitly attach retained generated bytes for software validation." }); assert.notEqual(f.detail.edition.hash, before); assert.equal(f.detail.edition.attachments[0]!.assetHash, digest(bytes));
});

test("a lost original PUT is recovered by exact bytes; different replacement bytes are refused", async () => {
  const f = await fixture(), bytes = sampleBenchWave(2, hash("lost-original")); const prepared = await command(f, { kind: "upload_intent", file: fileInput(bytes) }); const intent = prepared.upload!;
  const target = `${base}/api/physical-notebook/uploads/${intent.id}?runId=${f.runId}`, init = { method: "PUT", headers: { Cookie: f.cookie, Origin: base, "Content-Type": "audio/wav" }, body: new Uint8Array(bytes) };
  await assert.rejects(fetch(target, { ...init, headers: { ...init.headers, "x-qa-drop-response": "after-commit" } }));
  assert.equal((await fetch(target, init)).status, 200);
  const different = Buffer.from(bytes); different[different.length - 1]! ^= 1; assert.equal((await fetch(target, { ...init, body: new Uint8Array(different) })).status, 409);
  await command(f, { kind: "verify_upload", uploadId: intent.id }, false); assert.equal(f.detail.assets[0]!.sha256, digest(bytes));
});
test("wrong SHA or signature rejects an upload without an asset or automatic manifest attachment", async () => {
  const f = await fixture(), bytes = sampleBenchWave(2, hash("bad-hash")); const intent = await upload(f, bytes, fileInput(bytes, { expectedSha256: "0".repeat(64) }));
  await command(f, { kind: "verify_upload", uploadId: intent.id }, false); assert.equal(f.detail.uploads[0]!.phase, "rejected"); assert.equal(f.detail.assets.length, 0); assert.equal(f.detail.edition.attachments.length, 0);
  await command(f, { kind: "verify_upload", uploadId: intent.id }, false); assert.equal(f.detail.uploads[0]!.phase, "rejected");
});
test("reviewer is bound to one sealed edition and only its attached originals", async () => {
  const f = await sealed(await fixture()), invited = await invite(f); const home = successful(await json(invited.cookie, "/api/physical-notebook/review")) as BenchHome;
  assert.equal(home.selected!.role, "reviewer"); assert.equal(home.runs.length, 1); assert.equal(home.subjects.length, 0); assert.equal(home.selected!.history.length, 1); assert.equal(home.selected!.uploads.length, 0);
  assert.equal(home.selected!.assets.length, 1); assert.equal(JSON.stringify(home).includes(invited.grant.invitation!), false);
  const other = await fixture(); assert.equal((await json(invited.cookie, `/api/physical-notebook/review?runId=${other.runId}`)).response.status, 404);
  const unattached = f.detail.assets.find(asset => !f.detail.edition.attachments.some(link => link.assetId === asset.id))!;
  assert.equal((await fetch(`${base}/api/physical-notebook/originals/${unattached.id}?runId=${f.runId}&access=review`, { headers: { Cookie: invited.cookie } })).status, 404);
  assert.equal((await json(invited.cookie, `/api/physical-notebook/export?runId=${f.runId}&view=private&access=review`)).response.status, 403);
  assert.equal((await json(invited.cookie, "/api/physical-notebook/review", { kind: "finish", requestId: randomUUID(), ...expected(f.detail), note: "Reviewer cannot edit the creator's report" })).response.status, 403);
  const replay = await json("", "/api/physical-notebook/redeem", invited.redeem); successful(replay); assert.equal(digest(Buffer.from(replay.response.headers.get("set-cookie")!)), digest(Buffer.from((await json("", "/api/physical-notebook/redeem", invited.redeem)).response.headers.get("set-cookie")!)));
  assert.equal((await json("", "/api/physical-notebook/redeem", { ...invited.redeem, requestId: randomUUID() })).response.status, 409);
  const recoveredInvitation = successful(await json(f.cookie, "/api/physical-notebook", invited.inviteInput)); assert.equal(recoveredInvitation.grant.status, "active"); assert.equal(recoveredInvitation.grant.invitation, undefined);
});
test("Sample reviewer decisions replay once and revoked authority cannot read, replay or revive originals", async () => {
  const f = await sealed(await fixture()), invited = await invite(f), assetId = f.detail.edition.attachments[0]!.assetId;
  const input = { kind: "review", requestId: randomUUID(), ...expected(f.detail), decision: { outcome: "contradiction", finding: "Synthetic Sample review deliberately records a contradiction for this workflow only.", limitations: "No real engineer or physical hardware participated.", inspectedAssetIds: [assetId], inspectedOriginals: true, reviewedExactConditions: true } };
  const first = successful(await json(invited.cookie, "/api/physical-notebook/review", input)); assert.equal(successful(await json(invited.cookie, "/api/physical-notebook/review", input)).decisionId, first.decisionId);
  await refresh(f); assert.equal(f.detail.assessment.sampleReviews, 1); assert.equal(f.detail.assessment.actualQualifiedReviews, 0); assert.equal(f.detail.decisions.length, 1);
  await command(f, { kind: "revoke_reviewer", grantId: invited.grant.id }, false); assert.equal(f.detail.decisions[0]!.currentAuthority, false);
  assert.equal((await json(invited.cookie, "/api/physical-notebook/review", input)).response.status, 401);
  assert.equal((await json("", "/api/physical-notebook/redeem", invited.redeem)).response.status, 404);
  assert.equal((await fetch(`${base}/api/physical-notebook/originals/${assetId}?runId=${f.runId}&access=review`, { headers: { Cookie: invited.cookie } })).status, 401);
});
test("a human invitation alone never permits genuine review or changes physical classification", async () => {
  const f = await sealed(await fixture()), invited = await invite(f, "human"), home = successful(await json(invited.cookie, "/api/physical-notebook/review")) as BenchHome;
  assert.equal(home.selected!.reviewer!.qualified, false); assert.equal(home.selected!.grants[0]!.qualification, "unestablished");
  const result = await json(invited.cookie, "/api/physical-notebook/review", { kind: "review", requestId: randomUUID(), ...expected(f.detail), decision: { outcome: "supports_reported_scope", finding: "This unqualified synthetic person must not manufacture an actual engineering review.", limitations: "Invitation access is not independent identity or expertise.", inspectedAssetIds: [f.detail.edition.attachments[0]!.assetId], inspectedOriginals: true, reviewedExactConditions: true } });
  assert.equal(result.response.status, 403); await refresh(f); assert.equal(f.detail.assessment.actualQualifiedReviews, 0); assert.equal(f.detail.decisions.length, 0);
});
test("withdrawal denies access, removes owned bytes and retains the sealed hash and observed failure", async () => {
  const f = await sealed(await fixture()), invited = await invite(f), asset = f.detail.assets.find(value => value.id === f.detail.edition.attachments[0]!.assetId)!, before = f.detail.edition.hash;
  await command(f, { kind: "withdraw_asset", assetId: asset.id, reason: "Withdraw controlled original consent in this synthetic validation", acknowledgedRetainedManifestHash: true }, false);
  assert.equal(f.detail.edition.hash, before); assert.equal(f.detail.assets.find(value => value.id === asset.id)!.availability, "purged"); assert.equal(f.detail.assessment.reportedFailures, 1);
  assert.equal((await fetch(`${base}/api/physical-notebook/originals/${asset.id}?runId=${f.runId}`, { headers: { Cookie: f.cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/physical-notebook/originals/${asset.id}?runId=${f.runId}&access=review`, { headers: { Cookie: invited.cookie } })).status, 404);
  await command(f, { kind: "withdraw_asset", assetId: asset.id, reason: "Explicit retry keeps a purged original unavailable", acknowledgedRetainedManifestHash: true }, false); assert.equal(f.detail.edition.hash, before);
  await assert.rejects(database().query("UPDATE wk_bench_asset_access SET state='available' WHERE asset_id=$1", [asset.id]));
});
test("pending upload verification never silently attaches to a later or sealed edition", async () => {
  const f = await fixture(), bytes = sampleBenchWave(2, hash("late-file")), intent = await upload(f, bytes); await begin(f); await command(f, { kind: "finish", note: "Synthetic early finish before original verification" }); await command(f, { kind: "seal", acknowledgedManifestIsReportedEvidence: true }); const before = f.detail.edition.hash;
  await command(f, { kind: "verify_upload", uploadId: intent.id }, false); assert.equal(f.detail.assets.length, 1); assert.equal(f.detail.edition.hash, before); assert.equal(f.detail.edition.attachments.length, 0);
  const attach = await json(f.cookie, "/api/physical-notebook", { kind: "attach", requestId: randomUUID(), ...expected(f.detail), assetId: f.detail.assets[0]!.id, stepId: f.detail.edition.binding.steps[0]!.id, note: "Cannot attach this late original to an already sealed manifest" }); assert.equal(attach.response.status, 409);
});
test("workspace expiry while waiting for the real row lock blocks command replay without renewal", async () => {
  const f = await fixture(); await database().query("UPDATE wk_sessions SET expires_at=clock_timestamp()+interval '160 milliseconds' WHERE id=$1", [f.session.id]);
  const blocker = await database().connect(); await blocker.query("BEGIN"); await blocker.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [f.session.id]);
  const pending = json(f.cookie, "/api/physical-notebook", f.createInput); await delay(220); await blocker.query("COMMIT"); blocker.release();
  assert.ok([401, 403].includes((await pending).response.status));
  assert.equal((await database().query("SELECT count(*) AS count FROM wk_bench_runs WHERE tenant_id=$1", [f.session.id])).rows[0].count, "1");
  assert.equal((await json(f.cookie, "/api/physical-notebook")).response.status, 401);
});
test("a saved operator report cannot use the generated-Sample command to invent physical originals", async () => {
  const f = await fixture("operator_recorded"); const result = await json(f.cookie, "/api/physical-notebook", { kind: "sample_originals", requestId: randomUUID(), ...expected(f.detail), acknowledgedGeneratedSample: true }); assert.equal(result.response.status, 403);
  await begin(f); await command(f, { kind: "finish", note: "Software-only validation of an incomplete operator report" }); await command(f, { kind: "seal", acknowledgedManifestIsReportedEvidence: true }); assert.equal(f.detail.assessment.status, "evidence_incomplete"); assert.equal(f.detail.assessment.actualQualifiedReviews, 0);
});
test("the installed Blob SDK verifies controlled callback signatures and exact resource ownership without external transport", async () => {
  const f = await fixture(), bytes = sampleBenchWave(2, hash("signed-controlled-callback")), priorDisabled = process.env.WORLDKIT_DISABLE_PROVIDERS, priorBlob = process.env.BLOB_READ_WRITE_TOKEN;
  const syntheticKey = "vercel_blob_rw_controllednotebook_ThisIsAnExplicitSyntheticTestKeyOnly";
  process.env.WORLDKIT_DISABLE_PROVIDERS = "false"; process.env.BLOB_READ_WRITE_TOKEN = syntheticKey;
  try {
    const prepared = await command(f, { kind: "upload_intent", file: fileInput(bytes) }), intent = prepared.upload!; assert.equal(intent.transport, "private_blob");
    const options = await benchUploadTokenOptions(f.access, intent.pathname, JSON.stringify({ runId: f.runId, uploadId: intent.id })); assert.equal(options.allowOverwrite, false); assert.equal(options.maximumSizeInBytes, bytes.length);
    await assert.rejects(benchUploadTokenOptions(f.access, `${intent.pathname}.foreign`, JSON.stringify({ runId: f.runId, uploadId: intent.id })), (error: any) => error.status === 404);
    const body = { type: "blob.upload-completed", payload: { tokenPayload: options.tokenPayload, blob: { url: `https://controllednotebook.private.blob.vercel-storage.com/${intent.pathname}`, downloadUrl: `https://controllednotebook.private.blob.vercel-storage.com/${intent.pathname}?download=1`, pathname: intent.pathname, contentType: "audio/wav", contentDisposition: "attachment; filename=synthetic.wav" } } };
    const sign = (value: unknown) => createHmac("sha256", syntheticKey).update(JSON.stringify(value)).digest("hex");
    const invalid = await json("", "/api/physical-notebook/uploads", body, { "x-vercel-signature": "0".repeat(64) }); assert.equal(invalid.response.status, 403);
    const foreign = structuredClone(body); foreign.payload.blob.pathname = `${intent.pathname}.foreign`; assert.equal((await json("", "/api/physical-notebook/uploads", foreign, { "x-vercel-signature": sign(foreign) })).response.status, 404);
    successful(await json("", "/api/physical-notebook/uploads", body, { "x-vercel-signature": sign(body) })); successful(await json("", "/api/physical-notebook/uploads", body, { "x-vercel-signature": sign(body) }));
    assert.equal((await database().query("SELECT count(*) AS count FROM wk_bench_events WHERE tenant_id=$1 AND kind='original.authenticated_callback'", [f.session.id])).rows[0].count, "1");
    await refresh(f); assert.equal(f.detail.uploads[0]!.phase, "uploaded"); assert.equal(f.detail.assets.length, 0); assert.equal(f.detail.edition.attachments.length, 0);
    await command(f, { kind: "withdraw_upload", uploadId: intent.id, reason: "Withdraw the controlled test before any real provider object exists", acknowledgedRetainedManifestHash: true }, false);
    assert.ok(f.detail.uploads[0]!.withdrawnAt); assert.equal(f.detail.uploads[0]!.purgedAt, null); assert.match(f.detail.uploads[0]!.failure!, /token expires/);
    assert.equal((await database().query("SELECT completed_receipt->>'source' AS source FROM wk_bench_uploads WHERE id=$1", [intent.id])).rows[0].source, "controlled_blob_signature_test");
  } finally { process.env.WORLDKIT_DISABLE_PROVIDERS = priorDisabled; if (priorBlob === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = priorBlob; }
});

test("rejected upload bytes can be withdrawn and removed without creating a physical asset", async () => {
  const f = await fixture(), bytes = sampleBenchWave(2, hash("rejected-withdrawal")), intent = await upload(f, bytes, fileInput(bytes, { expectedSha256: "0".repeat(64) }));
  await command(f, { kind: "verify_upload", uploadId: intent.id }, false);
  await command(f, { kind: "withdraw_upload", uploadId: intent.id, reason: "Remove rejected controlled bytes and retain the original declaration", acknowledgedRetainedManifestHash: true }, false);
  assert.equal(f.detail.assets.length, 0); assert.equal(f.detail.uploads[0]!.phase, "rejected"); assert.ok(f.detail.uploads[0]!.withdrawnAt && f.detail.uploads[0]!.purgedAt);
  await assert.rejects(readFile(`${process.env.WORLDKIT_PHYSICAL_LOCAL_DIR}/${intent.pathname}`), (error: any) => error.code === "ENOENT");
  const retry = await fetch(`${base}/api/physical-notebook/uploads/${intent.id}?runId=${f.runId}`, { method: "PUT", headers: { Cookie: f.cookie, Origin: base, "Content-Type": "audio/wav" }, body: new Uint8Array(bytes) }); assert.equal(retry.status, 409);
});
test("retention preview is read-only and applied cleanup removes expired owned originals without renewing anything", async () => {
  const f = await fixture(); await samples(f); const editionHash = f.detail.edition.hash, paths = f.detail.uploads.map(upload => upload.pathname);
  await database().query("UPDATE wk_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.session.id]);
  const expiry = (await database().query("SELECT expires_at FROM wk_sessions WHERE id=$1", [f.session.id])).rows[0].expires_at.toISOString();
  const before = hash((await database().query("SELECT * FROM wk_bench_asset_access WHERE tenant_id=$1 ORDER BY asset_id", [f.session.id])).rows);
  const preview = await maintainPhysicalNotebook({ limit: 100 }); assert.ok(preview.candidates.filter(candidate => candidate.runId === f.runId).length === 3); assert.equal(hash((await database().query("SELECT * FROM wk_bench_asset_access WHERE tenant_id=$1 ORDER BY asset_id", [f.session.id])).rows), before);
  const flag = process.env.WORLDKIT_PHYSICAL_MAINTENANCE; process.env.WORLDKIT_PHYSICAL_MAINTENANCE = "true";
  try { const result = await maintainPhysicalNotebook({ apply: true, limit: 100 }); assert.ok(result.removed >= 3); assert.equal(result.failed, 0); }
  finally { if (flag === undefined) delete process.env.WORLDKIT_PHYSICAL_MAINTENANCE; else process.env.WORLDKIT_PHYSICAL_MAINTENANCE = flag; }
  assert.equal((await database().query("SELECT expires_at FROM wk_sessions WHERE id=$1", [f.session.id])).rows[0].expires_at.toISOString(), expiry);
  assert.equal((await database().query("SELECT content_hash FROM wk_bench_editions WHERE id=$1", [f.detail.edition.id])).rows[0].content_hash, editionHash);
  assert.ok((await database().query("SELECT state FROM wk_bench_asset_access WHERE tenant_id=$1", [f.session.id])).rows.every(row => row.state === "purged"));
  for (const pathname of paths) await assert.rejects(readFile(`${process.env.WORLDKIT_PHYSICAL_LOCAL_DIR}/${pathname}`), (error: any) => error.code === "ENOENT");
});
test("rollback-only identity fixtures exercise independent qualification and exact expertise without inventing retained people", async () => {
  const f = await fixture(), client = await database().connect(), actorId = randomUUID(); await client.query("BEGIN");
  const putQualification = async (id: string, expertise: string[], identity: string) => {
    const q = { id: randomUUID(), actorId: id, identityHash: hash(identity), evidenceHash: hash("Fictional rollback-only evidence. No real review occurred."), expertise, method: "Fictional transactional software assertion, immediately rolled back.", issuer: "Controlled software test", expiresAt: new Date(Date.now() + 60000).toISOString(), provenance: "human" };
    await client.query("INSERT INTO wk_review_qualifications(id,tenant_id,actor_id,identity_hash,evidence_hash,payload) VALUES($1,$2,$3,$4,$5,$6)", [q.id, f.session.id, id, q.identityHash, q.evidenceHash, q]);
    await client.query("INSERT INTO wk_review_identities(tenant_id,identity_hash,actor_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [f.session.id, q.identityHash, id]);
    await client.query("UPDATE wk_review_actors SET qualification_id=$2,version=version+1 WHERE id=$1", [id, q.id]);
  };
  try {
    await client.query("INSERT INTO wk_review_actors(id,tenant_id,name,kind,provenance) VALUES($1,$2,'Fictional rollback-only reviewer','specialist','human')", [actorId, f.session.id]);
    await putQualification(f.session.id, ["identity"], "fictional-creator"); await putQualification(actorId, ["engineering", "simultaneous"], "fictional-independent-reviewer");
    const access = { tenantId: f.session.id, actorId, kind: "reviewer" as const, grantId: null };
    assert.equal((await benchPrincipal(client, access, f.detail.edition.binding)).qualified, true);
    await putQualification(actorId, ["engineering"], "fictional-independent-reviewer"); assert.equal((await benchPrincipal(client, access, f.detail.edition.binding)).qualified, false);
    await client.query("UPDATE wk_review_actors SET revoked_at=clock_timestamp(),version=version+1 WHERE id=$1", [actorId]); assert.equal((await benchPrincipal(client, access, f.detail.edition.binding)).qualified, false);
  } finally { await client.query("ROLLBACK"); client.release(); }
  assert.equal((await database().query("SELECT count(*) AS count FROM wk_review_qualifications WHERE tenant_id=$1", [f.session.id])).rows[0].count, "0"); assert.equal((await database().query("SELECT count(*) AS count FROM wk_review_actors WHERE id=$1", [actorId])).rows[0].count, "0");
});
