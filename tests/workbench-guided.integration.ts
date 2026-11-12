import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { hash, canonical, verifyKit } from "../packages/compatibility";
import { architectures, profiles, sources, seedKit } from "../packages/device-library";
import { renderSoundcheck, rms } from "../packages/soundcheck";
import { WorkbenchPreviewSchema, WorkbenchReceiptSchema, workbenchCanonical, type Edit, type WorkbenchApplyInput, type WorkbenchPreview } from "../packages/workbench/contracts";
import { database, closeDatabase, transaction } from "../src/server/db";
import { commitEdit, createSession, getRevision, saveRevision, type Session } from "../src/server/repository";
import { initializeWorkbench } from "../src/server/workbench-db";
import { workbenchCommand } from "../src/server/workbench-commands";
import { handleWorkbench, readWorkbenchJson, WORKBENCH_MAX_BYTES } from "../src/server/workbench-http";
import { sessionCookie } from "../src/server/http";
import { requireIsolatedDatabase } from "./support/isolated-database";

// Fresh explicitly synthetic fixtures on this unit's least-privilege database.
// The installed HTTP handler, PostgreSQL, byte parser and actual socket loss run.
// No Next runtime, other fixture, external service, person or hardware is used.
requireIsolatedDatabase();
const dbUrl = new URL(process.env.DATABASE_URL!);
assert.equal(dbUrl.pathname, "/worldkit_guided"); assert.equal(dbUrl.username, "worldkit_guided"); assert.equal(dbUrl.port, "55576");
for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "CHANNEL3_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "BLOB_READ_WRITE_TOKEN"]) assert.ok(!process.env[key]);
const runId = randomUUID(), oldFetch = globalThis.fetch, oldOrigin = process.env.WORLDKIT_PUBLIC_URL;
const tables = ["wk_sessions", "wk_kits", "wk_revisions", "wk_events", "wk_catalog", "wk_workbench_commands"];
const originalRows = new Map<string, string[]>();
const fixtures: { id: string; expiry: string; revisionId: string; sourceHash: string }[] = [];
let server: Server, base = "", requests = 0, lostAnswers = 0, externalAttempts = 0, active = 0;
type Fixture = { session: Session; cookie: string; initial: Awaited<ReturnType<typeof getRevision>> };
const micEdit: Edit = { kind: "microphone", componentId: "mic-2", profileId: "at2020-xlr" };
async function snapshot() { return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await database().query(`SELECT to_jsonb(t)::text AS body FROM ${table} t`)).rows.map(row => createHash("sha256").update(row.body).digest("hex")).sort()]))); }
async function size(tenant: string) { const result: Record<string, number> = {}; for (const table of ["wk_revisions", "wk_events", "wk_workbench_commands"]) result[table] = Number((await database().query(`SELECT count(*) AS count FROM ${table} WHERE tenant_id=$1`, [tenant])).rows[0].count); return result; }
before(async () => {
  assert.equal(sessionCookie, "wk_guided_qa");
  assert.deepEqual((await database().query("SELECT current_user AS role,current_database() AS db,inet_server_port() AS port")).rows[0], { role: "worldkit_guided", db: "worldkit_guided", port: 55576 });
  await initializeWorkbench(); for (const [table, rows] of Object.entries(await snapshot())) originalRows.set(table, rows as string[]);
  server = createServer(async (incoming, outgoing) => {
    active++;
    try {
      const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = new Request(`${base}${incoming.url}`, { method: incoming.method, headers, ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: new Uint8Array(Buffer.concat(chunks)) }) });
      const response = await handleWorkbench(request);
      if (headers.get("x-guided-drop") === "after-commit" && response.ok) { lostAnswers++; outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } finally { active--; }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.WORLDKIT_PUBLIC_URL = base;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => { const target = new URL(input instanceof Request ? input.url : String(input)); if (target.origin !== base) { externalAttempts++; throw new Error("External transport is forbidden."); } requests++; return oldFetch(input, init); }) as typeof fetch;
});
after(async () => {
  const audit: Record<string, unknown> = { at: new Date().toISOString(), runId, requests, lostAnswers, externalAttempts, fixtures, originalRowsUnchanged: false, providerModelQuoteRows: {} };
  try {
    for (let i = 0; active && i < 100; i++) await delay(10); assert.equal(active, 0);
    const current = await snapshot();
    for (const [table, rows] of originalRows) { const available = [...current[table] as string[]]; for (const original of rows) { const index = available.indexOf(original); assert.ok(index >= 0, `Original ${table} row remains exact`); available.splice(index, 1); } }
    audit.originalRowsUnchanged = true;
    for (const f of fixtures) { const row = (await database().query("SELECT expires_at FROM wk_sessions WHERE id=$1", [f.id])).rows[0]; assert.equal(new Date(row.expires_at).toISOString(), f.expiry); assert.equal(hash(await getRevision(f.id, f.revisionId)), f.sourceHash); }
    for (const table of ["wk_provider_receipts", "wk_source_model_requests", "wk_quotes"]) { const count = Number((await database().query(`SELECT count(*) AS count FROM ${table} WHERE tenant_id=ANY($1::text[])`, [fixtures.map(f => f.id)])).rows[0].count); (audit.providerModelQuoteRows as Record<string, number>)[table] = count; assert.equal(count, 0); }
    assert.equal(externalAttempts, 0); audit.passed = true;
  } finally {
    await mkdir(".local/guided-journey-unit/http", { recursive: true, mode: 0o700 }); await writeFile(`.local/guided-journey-unit/http/${runId}.private.json`, JSON.stringify(audit, null, 2) + "\n", { mode: 0o600 });
    globalThis.fetch = oldFetch; if (oldOrigin === undefined) delete process.env.WORLDKIT_PUBLIC_URL; else process.env.WORLDKIT_PUBLIC_URL = oldOrigin;
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await closeDatabase();
  }
});
async function fresh(lifetimeMs?: number): Promise<Fixture> {
  let token: string, session: Session;
  if (lifetimeMs === undefined) ({ token, session } = await createSession());
  else {
    token = randomBytes(32).toString("base64url"); const id = randomUUID(), expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
    session = { id, expiresAt, discoveryRequests: 0, liveRebuilds: 0 }; const kit = { ...seedKit("T2", randomUUID()), kitId: randomUUID(), createdAt: new Date().toISOString() };
    await transaction(async db => { await db.query("INSERT INTO wk_sessions(id,token_hash,expires_at) VALUES($1,$2,$3)", [id, createHash("sha256").update(token).digest("hex"), expiresAt]); await db.query("INSERT INTO wk_kits(id,tenant_id,current_revision_id) VALUES($1,$2,$3)", [kit.kitId, id, kit.id]); await saveRevision(db, id, { kit, certificate: verifyKit(kit, profiles, sources, architectures), profiles, sources }); });
  }
  const initial = await getRevision(session.id); fixtures.push({ id: session.id, expiry: session.expiresAt, revisionId: initial.kit.id, sourceHash: hash(initial) });
  return { session, cookie: `${sessionCookie}=${token}`, initial };
}
async function send(f: Fixture | null, input?: unknown, options: { raw?: string | Uint8Array; method?: string; headers?: Record<string, string> } = {}) {
  const body = options.raw instanceof Uint8Array ? new Uint8Array(options.raw).buffer : options.raw ?? JSON.stringify(input);
  const response = await fetch(`${base}/api/workbench`, { method: options.method ?? "POST", headers: { "Content-Type": "application/json", Origin: base, ...(f ? { Cookie: f.cookie } : {}), ...options.headers }, ...((options.method ?? "POST") === "GET" ? {} : { body }) });
  const data = await response.json(); assert.match(response.headers.get("cache-control") ?? "", /no-store/); return { response, data };
}
async function proposed(f: Fixture, edit: Edit = micEdit, source = f.initial) {
  const input = { kind: "preview" as const, expectedRevisionId: source.kit.id, expectedGraphHash: source.certificate.graphHash, edit };
  const result = await send(f, input); assert.equal(result.response.status, 200, JSON.stringify(result.data)); return { input, preview: WorkbenchPreviewSchema.parse(result.data) };
}
function apply(preview: WorkbenchPreview, requestId = randomUUID()): WorkbenchApplyInput { return { kind: "apply", requestId, expectedRevisionId: preview.base.revisionId, expectedGraphHash: preview.base.graphHash, edit: preview.edit, previewHash: preview.previewHash, acknowledgedModelledChange: true }; }

test("the real preview changes the condenser power witness and modeled second channel without a row write", async () => {
  const f = await fresh(), before = await snapshot(), { preview, input } = await proposed(f); assert.deepEqual(await snapshot(), before);
  assert.equal(preview.changed, true); assert.equal(preview.beforeRouting.input2, true); assert.equal(preview.afterRouting.input2, false); assert.equal(preview.after.physicalTest, "not_performed"); assert.ok(preview.after.counts.unknown > 0);
  assert.ok(preview.changes.some(change => change.after.status === "violated" && change.after.ruleId.includes("power")));
  await delay(5); const second = await send(f, input); assert.equal(second.data.previewHash, preview.previewHash); assert.notEqual(second.data.evaluatedAt, preview.evaluatedAt);
  assert.equal(workbenchCanonical(input), canonical(input)); assert.equal(preview.base.graphHash, f.initial.certificate.graphHash); assert.equal((await getRevision(f.session.id)).kit.id, f.initial.kit.id);
});
test("simultaneous identical saves create one edition, event and immutable command receipt", async () => {
  const f = await fresh(), { preview } = await proposed(f), command = apply(preview), before = await size(f.session.id);
  const values = await Promise.all([send(f, command), send(f, command)]); for (const v of values) assert.equal(v.response.status, 200, JSON.stringify(v.data));
  const a = WorkbenchReceiptSchema.parse(values[0]!.data), b = WorkbenchReceiptSchema.parse(values[1]!.data); assert.deepEqual(a.saved, b.saved); assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
  assert.equal(a.saved.graphHash, preview.after.graphHash); assert.equal(a.saved.revision, 2); assert.equal(a.base.revisionId, f.initial.kit.id); assert.equal(a.inputHash, hash(command));
  assert.deepEqual(await size(f.session.id), { wk_revisions: before.wk_revisions! + 1, wk_events: before.wk_events! + 1, wk_workbench_commands: before.wk_workbench_commands! + 1 });
});
test("two different bodies racing for one UUID retain only the winning exact edit", async () => {
  const f = await fresh(), one = await proposed(f), two = await proposed(f, { kind: "connection", connectionId: "mic2-audio", enabled: false }), id = randomUUID();
  const results = await Promise.all([send(f, apply(one.preview, id)), send(f, apply(two.preview, id))]); assert.deepEqual(results.map(r => r.response.status).sort(), [200, 409]); assert.equal((await size(f.session.id)).wk_workbench_commands, 1); assert.equal((await size(f.session.id)).wk_revisions, 2);
});
test("a socket actually destroyed after commit recovers the original receipt without another edition", async () => {
  const f = await fresh(), { preview } = await proposed(f), command = apply(preview);
  await assert.rejects(send(f, command, { headers: { "x-guided-drop": "after-commit" } })); const before = await snapshot(), recovered = await send(f, command); assert.equal(recovered.response.status, 200); assert.equal(recovered.data.replayed, true); assert.deepEqual(await snapshot(), before); assert.equal(recovered.data.saved.graphHash, preview.after.graphHash);
});
test("recovery retains its original saved edition after another edit and never resets the current head", async () => {
  const f = await fresh(), { preview } = await proposed(f), command = apply(preview), first = await send(f, command); const second = await commitEdit(f.session, first.data.saved.revisionId, first.data.saved.graphHash, { kind: "repair", repairId: "phantom" }); const before = await snapshot();
  const replay = await send(f, command); assert.equal(replay.response.status, 200); assert.equal(replay.data.saved.revisionId, first.data.saved.revisionId); assert.equal(replay.data.current.revisionId, second.kit.id); assert.equal(replay.data.current.revision, 3); assert.deepEqual(await snapshot(), before);
});
test("the documented repair rechecks the graph, restores only the modeled signal and retains open evidence", async () => {
  const f = await fresh(), condenser = await proposed(f); assert.equal((await send(f, apply(condenser.preview))).response.status, 200); const broken = await getRevision(f.session.id); assert.equal(rms(renderSoundcheck(broken.kit).track2), 0); assert.ok(rms(renderSoundcheck(broken.kit).track1) > 0);
  const repair = await proposed(f, { kind: "repair", repairId: "phantom" }, broken); assert.equal(repair.preview.afterRouting.input2, true); assert.ok(repair.preview.after.counts.unknown > 0);
  const power = repair.preview.changes.find(c => c.after.requirementId === "R4"); assert.equal(power?.before?.status, "violated"); assert.equal(power?.after.status, "unknown"); assert.equal(power?.after.nextAction, "Source the exact power supply"); assert.match(power.after.explanation, /exact supply.*hub/);
  assert.equal((await send(f, apply(repair.preview))).response.status, 200); const fixed = await getRevision(f.session.id); assert.ok(rms(renderSoundcheck(fixed.kit).track2) > 0); assert.equal(fixed.certificate.graphHash, repair.preview.after.graphHash); assert.equal(fixed.certificate.physicalTest, "not_performed"); assert.equal(fixed.certificate.review.reviewed, 0);
});
test("same-base edits with distinct UUIDs cannot both commit", async () => {
  const f = await fresh(), { preview } = await proposed(f); const values = await Promise.all([send(f, apply(preview)), send(f, apply(preview))]); assert.deepEqual(values.map(v => v.response.status).sort(), [200, 409]); assert.equal((await size(f.session.id)).wk_revisions, 2); assert.equal((await size(f.session.id)).wk_workbench_commands, 1);
});
test("changed source evidence invalidates an otherwise current preview without saving", async () => {
  const f = await fresh(), { preview } = await proposed(f); const snapshotId = randomUUID();
  const observed = { id: snapshotId, productId: "synthetic-guided-evidence", title: "Synthetic evidence boundary; no provider call", brand: null, description: "Controlled snapshot changes the source fingerprint only", selectedOptions: [], variantExact: true, offers: [], detailChecked: true, categoryIds: [], observedAt: new Date().toISOString(), source: "channel3", responseHash: "b".repeat(64), sourceMode: "sample" };
  await database().query("INSERT INTO wk_catalog(id,tenant_id,product_id,snapshot) VALUES($1,$2,$3,$4)", [snapshotId, f.session.id, observed.productId, observed]);
  const before = await snapshot(), denied = await send(f, apply(preview)); assert.equal(denied.response.status, 409); assert.deepEqual(await snapshot(), before); const current = await proposed(f); assert.notEqual(current.preview.previewHash, preview.previewHash);
});
test("tampered fingerprints, stale revisions and no-op previews do not create editions", async () => {
  const f = await fresh(), { preview } = await proposed(f), before = await snapshot();
  assert.equal((await send(f, { ...apply(preview), previewHash: "f".repeat(64) })).response.status, 409);
  assert.equal((await send(f, { kind: "preview", expectedRevisionId: f.initial.kit.id, expectedGraphHash: "0".repeat(64), edit: micEdit })).response.status, 409); assert.deepEqual(await snapshot(), before);
  const noop = await proposed(f, { kind: "connection", connectionId: "mic2-audio", enabled: true }); assert.equal(noop.preview.changed, false); assert.equal((await send(f, apply(noop.preview))).response.status, 422); assert.deepEqual(await snapshot(), before);
});
test("origin, owner, anonymous and duplicate-cookie boundaries retain every private row", async () => {
  const a = await fresh(), b = await fresh(), { input, preview } = await proposed(a), before = await snapshot();
  assert.equal((await send(null, input)).response.status, 401); assert.equal((await send(a, input, { headers: { Origin: "https://foreign.example.invalid" } })).response.status, 403);
  const foreign = await send(b, input); assert.equal(foreign.response.status, 409); assert.ok(!JSON.stringify(foreign.data).includes(a.initial.kit.id)); assert.equal((await send(b, apply(preview))).response.status, 409);
  assert.equal((await send(a, input, { headers: { Cookie: `${a.cookie}; ${a.cookie}` } })).response.status, 401); assert.equal((await send(a, undefined, { method: "GET" })).response.status, 405); assert.deepEqual(await snapshot(), before);
});
async function observeWait(lockerPid: number) { for (let i = 0; i < 60; i++) { if (Number((await database().query("SELECT count(*) AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [lockerPid])).rows[0].count) > 0) return; await delay(10); } assert.fail("Actual PostgreSQL lock wait was not observed"); }
test("a held owner lock crossing the original expiry refuses a save after actual HTTP admission", async () => {
  const f = await fresh(1800), { preview } = await proposed(f), command = apply(preview), before = await size(f.session.id), db = await database().connect(); let pending: ReturnType<typeof send> | undefined;
  try { await db.query("BEGIN"); const pid = Number((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid); await db.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [f.session.id]); pending = send(f, command); await observeWait(pid); await delay(Math.max(0, Date.parse(f.session.expiresAt) - Date.now() + 20)); await db.query("COMMIT"); assert.equal((await pending).response.status, 401); assert.deepEqual(await size(f.session.id), before); }
  finally { await db.query("ROLLBACK"); db.release(); await pending?.catch(() => {}); }
});
test("legacy edits also recheck current authority after a real kit-lock wait and roll back late work", async () => {
  const f = await fresh(1100), before = await size(f.session.id), db = await database().connect(); let pending: Promise<unknown> | undefined;
  try { await db.query("BEGIN"); const pid = Number((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid); await db.query("SELECT id FROM wk_kits WHERE id=$1 FOR UPDATE", [f.initial.kit.kitId]); pending = commitEdit(f.session, f.initial.kit.id, f.initial.certificate.graphHash, micEdit).then(value => ({ value }), error => ({ error })); await observeWait(pid); await delay(Math.max(0, Date.parse(f.session.expiresAt) - Date.now() + 20)); await db.query("COMMIT"); const result = await pending as { error?: { status: number } }; assert.equal(result.error?.status, 401); assert.deepEqual(await size(f.session.id), before); }
  finally { await db.query("ROLLBACK"); db.release(); await pending?.catch(() => {}); }
});
test("an old successful request cannot recover under expired authority or a forged future session descriptor", async () => {
  const f = await fresh(500), { preview } = await proposed(f), command = apply(preview); assert.equal((await send(f, command)).response.status, 200); await delay(Math.max(0, Date.parse(f.session.expiresAt) - Date.now() + 20)); const before = await snapshot(); assert.equal((await send(f, command)).response.status, 401);
  await assert.rejects(workbenchCommand({ ...f.session, expiresAt: "2099-01-01T00:00:00.000Z" }, command), (error: any) => error.status === 401); assert.deepEqual(await snapshot(), before);
});
test("immutable receipt guards reject updates, deletes and foreign revision bindings", async () => {
  const f = await fresh(), foreign = await fresh(), { preview } = await proposed(f), command = apply(preview); const saved = await send(f, command); assert.equal(saved.response.status, 200); const before = await snapshot();
  await assert.rejects(database().query("UPDATE wk_workbench_commands SET preview_hash=$3 WHERE tenant_id=$1 AND request_id=$2", [f.session.id, command.requestId, "a".repeat(64)]), /immutable/);
  await assert.rejects(database().query("DELETE FROM wk_workbench_commands WHERE tenant_id=$1 AND request_id=$2", [f.session.id, command.requestId]), /immutable/);
  await assert.rejects(database().query("INSERT INTO wk_workbench_commands(tenant_id,request_id,input_hash,preview_hash,base_revision_id,result_revision_id,result) VALUES($1,$2,$3,$3,$4,$5,$6)", [foreign.session.id, randomUUID(), "a".repeat(64), f.initial.kit.id, saved.data.saved.revisionId, saved.data]), /own workspace/); assert.deepEqual(await snapshot(), before);
});
test("a real receipt-insert failure rolls back the preceding graph, head and event atomically", async () => {
  const f = await fresh(), { preview } = await proposed(f), command = apply(preview), before = await snapshot(); const name = `wk_guided_fault_${runId.replaceAll("-", "")}`;
  assert.match(f.session.id, /^[a-f0-9-]+$/); assert.match(name, /^[a-z_][a-z0-9_]+$/);
  await database().query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${f.session.id}' THEN RAISE EXCEPTION 'Controlled receipt-insert failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE INSERT ON wk_workbench_commands FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try { assert.equal((await send(f, command)).response.status, 503); assert.deepEqual(await snapshot(), before); }
  finally { await database().query(`DROP TRIGGER ${name} ON wk_workbench_commands; DROP FUNCTION ${name}()`); }
  const retry = await send(f, command); assert.equal(retry.response.status, 200); assert.equal(retry.data.replayed, false); assert.equal((await size(f.session.id)).wk_revisions, 2);
});
test("actual HTTP accepts exactly 32KiB and rejects overflow, malformed UTF-8, wrong media and extra assertions", async () => {
  const f = await fresh(), { input } = await proposed(f), body = JSON.stringify(input), full = body + " ".repeat(WORKBENCH_MAX_BYTES - Buffer.byteLength(body)), before = await snapshot();
  assert.equal((await send(f, undefined, { raw: full })).response.status, 200); assert.equal((await send(f, undefined, { raw: full + " " })).response.status, 413);
  assert.equal((await send(f, input, { headers: { "Content-Type": "text/plain" } })).response.status, 415); assert.equal((await send(f, { ...input, actualPhysicalResult: "passed" })).response.status, 400);
  const invalid = Buffer.from(body); invalid[invalid.indexOf("preview")] = 0xff; assert.equal((await send(f, undefined, { raw: new Uint8Array(invalid) })).response.status, 400); assert.deepEqual(await snapshot(), before);
});
test("the bounded reader cancels an unending oversized stream rather than buffering it", async () => {
  const before = await snapshot(); let pulls = 0, cancelled = false; const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(8192).fill(32)); }, cancel() { cancelled = true; } });
  const request = new Request(`${base}/api/workbench`, { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(readWorkbenchJson(request), (error: any) => error.status === 413); assert.equal(cancelled, true); assert.ok(pulls <= 6); assert.deepEqual(await snapshot(), before);
});
