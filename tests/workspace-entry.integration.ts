import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { WorkspaceAdmissionSchema, type WorkspaceAdmission } from "../packages/workspace-entry";
import { database, closeDatabase } from "../src/server/db";
import { createSession, getRevision } from "../src/server/repository";
import { sessionCookie } from "../src/server/http";
import { initializeWorkspaceAdmission } from "../src/server/workspace-admission";
import { ADMISSION_MAX_BYTES, handleWorkspace, readAdmissionJson } from "../src/server/workspace-admission-http";
import { requireIsolatedDatabase } from "./support/isolated-database";

// Real loopback HTTP/PostgreSQL; fresh controlled records only. No Next runtime,
// provider, model, production authority, physical notebook or external request.
requireIsolatedDatabase(); const url = new URL(process.env.DATABASE_URL!);
assert.equal(url.pathname, "/worldkit_research"); assert.equal(url.username, "worldkit_research"); assert.equal(url.port, "55576");
for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "CHANNEL3_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "BLOB_READ_WRITE_TOKEN"]) assert.ok(!process.env[name]);
const runId = randomUUID(), sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const oldFetch = globalThis.fetch, oldPublic = process.env.WORLDKIT_PUBLIC_URL;
const originals = new Map<string, Map<string, string>>(), fixtures: { id: string; expiry: string; revision: string; sourceHash: string }[] = [];
let server: Server, base = "", calls = 0, lost = 0, active = 0, external = 0;
const tables = ["wk_sessions", "wk_kits", "wk_revisions", "wk_events", "wk_workspace_admissions"];
const rowKey = (table: string, row: any) => String(table === "wk_workspace_admissions" ? row.request_id : row.id);
async function quota() { return (await database().query("SELECT namespace,period,window_start,count FROM wk_session_windows ORDER BY namespace,period,window_start")).rows; }
async function counts() { return { sessions: Number((await database().query("SELECT count(*) AS count FROM wk_sessions")).rows[0].count), admissions: Number((await database().query("SELECT count(*) AS count FROM wk_workspace_admissions")).rows[0].count), quota: await quota() }; }
before(async () => {
  const identity = (await database().query("SELECT current_database() AS db,current_user AS role,inet_server_port() AS port")).rows[0]; assert.deepEqual(identity, { db: "worldkit_research", role: "worldkit_research", port: 55576 });
  await initializeWorkspaceAdmission();
  for (const table of tables) originals.set(table, new Map((await database().query(`SELECT * FROM ${table}`)).rows.map(row => [rowKey(table, row), sha(row)])));
  server = createServer(async (incoming, outgoing) => {
    active++;
    try {
      const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = new Request(`${base}${incoming.url}`, { method: incoming.method, headers, ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: new Uint8Array(Buffer.concat(chunks)) }) });
      const response = await handleWorkspace(request);
      if (headers.get("x-entry-drop") === "after-commit" && response.ok) { lost++; outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } finally { active--; }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.WORLDKIT_PUBLIC_URL = base;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => { const target = new URL(input instanceof Request ? input.url : String(input)); if (target.origin !== base) { external++; throw new Error("External transport is forbidden."); } calls++; return oldFetch(input, init); }) as typeof fetch;
});
after(async () => {
  const audit: Record<string, unknown> = { runId, at: new Date().toISOString(), scope: "fresh synthetic entry qualification only", calls, lostAnswers: lost, externalAttempts: external, fixtures, originalRowsUnchanged: false, providerModelQuoteRows: {} };
  try {
    for (let i = 0; active && i < 100; i++) await delay(10); assert.equal(active, 0);
    for (const table of tables) { const current = new Map((await database().query(`SELECT * FROM ${table}`)).rows.map(row => [rowKey(table, row), sha(row)])); for (const [key, hash] of originals.get(table)!) assert.equal(current.get(key), hash, `Original ${table} row remains exact.`); }
    audit.originalRowsUnchanged = true;
    for (const f of fixtures) { const row = (await database().query("SELECT expires_at FROM wk_sessions WHERE id=$1", [f.id])).rows[0]; assert.equal(new Date(row.expires_at).toISOString(), f.expiry); assert.equal(sha(await getRevision(f.id, f.revision)), f.sourceHash); }
    for (const table of ["wk_provider_receipts", "wk_source_model_requests", "wk_quotes", "wk_commerce_orders"]) if ((await database().query("SELECT to_regclass($1) AS relation", [table])).rows[0].relation) { const count = Number((await database().query(`SELECT count(*) AS count FROM ${table} WHERE tenant_id=ANY($1::text[])`, [fixtures.map(f => f.id)])).rows[0].count); (audit.providerModelQuoteRows as Record<string, number>)[table] = count; assert.equal(count, 0); }
    assert.equal(external, 0); audit.passed = true;
  } finally {
    await mkdir(".local/research-notebook-unit/entry", { recursive: true, mode: 0o700 }); await writeFile(`.local/research-notebook-unit/entry/${runId}.private.json`, JSON.stringify(audit, null, 2), { mode: 0o600 });
    globalThis.fetch = oldFetch; if (oldPublic === undefined) delete process.env.WORLDKIT_PUBLIC_URL; else process.env.WORLDKIT_PUBLIC_URL = oldPublic; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await closeDatabase();
  }
});
function body(): WorkspaceAdmission { return { kind: "start_sample", requestId: randomUUID(), recoveryKey: randomBytes(32).toString("hex"), acknowledgedSample: true }; }
async function request(command?: unknown, { cookie, headers = {}, method = command === undefined ? "GET" : "POST", raw }: { cookie?: string; headers?: Record<string, string>; method?: string; raw?: string | Uint8Array } = {}) {
  const response = await fetch(`${base}/api/workspace`, { method, headers: { Origin: base, ...(command === undefined && raw === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(command === undefined && raw === undefined ? {} : { body: raw instanceof Uint8Array ? new Uint8Array(raw) : raw ?? JSON.stringify(command) }), signal: AbortSignal.timeout(15_000) });
  return { response, data: method === "HEAD" ? null : await response.json() };
}
function cookieOf(response: Response) { const cookie = response.headers.get("set-cookie"); assert.ok(cookie); assert.ok(cookie.startsWith(`${sessionCookie}=`)); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.ok(!cookie.includes("Max-Age")); return cookie.split(";")[0]!; }
async function remember(data: any) { if (fixtures.some(f => f.id === data.session.id)) return; const revision = await getRevision(data.session.id, data.kit.id); fixtures.push({ id: data.session.id, expiry: data.session.expiresAt, revision: data.kit.id, sourceHash: sha(revision) }); }
async function created(command = body()) { const value = await request(command); assert.equal(value.response.status, 201); await remember(value.data); return { ...value, command, cookie: cookieOf(value.response) }; }
async function freshExisting(ttl?: number) { const fresh = await createSession(); if (ttl !== undefined) { const result = await database().query("UPDATE wk_sessions SET expires_at=date_trunc('milliseconds',clock_timestamp()+$2::double precision*interval '1 millisecond') WHERE id=$1 RETURNING expires_at", [fresh.session.id, ttl]); fresh.session.expiresAt = new Date(result.rows[0].expires_at).toISOString(); } const source = await getRevision(fresh.session.id); fixtures.push({ id: fresh.session.id, expiry: fresh.session.expiresAt, revision: source.kit.id, sourceHash: sha(source) }); return { ...fresh, cookie: `${sessionCookie}=${fresh.token}` }; }

test("passive GET/HEAD, legacy empty POST, false acknowledgement and foreign-origin requests cannot admit anything", async () => {
  const before = await counts(); assert.equal((await request()).response.status, 401); assert.equal((await request(undefined, { method: "HEAD" })).response.status, 401); assert.equal((await request({})).response.status, 400); assert.equal((await request({ ...body(), acknowledgedSample: false })).response.status, 400); assert.equal((await request(body(), { headers: { Origin: "https://foreign.invalid" } })).response.status, 403); assert.deepEqual(await counts(), before);
});
test("concurrent exact requests create one session, original cookie and absolute expiry", async () => {
  const command = body(), before = await counts(), results = await Promise.all([request(command), request(command)]); assert.deepEqual(results.map(r => r.response.status).sort(), [200, 201]);
  assert.equal(results[0]!.data.session.id, results[1]!.data.session.id); assert.equal(results[0]!.data.session.expiresAt, results[1]!.data.session.expiresAt); assert.equal(cookieOf(results[0]!.response), cookieOf(results[1]!.response));
  assert.equal(results[0]!.response.headers.get("x-worldkit-admission-request"), command.requestId); assert.equal((await counts()).sessions, before.sessions + 1); assert.equal((await counts()).admissions, before.admissions + 1); await remember(results[0]!.data);
});
test("a genuinely dropped post-commit answer recovers the exact original session without another quota claim", async () => {
  const command = body(); await assert.rejects(request(command, { headers: { "x-entry-drop": "after-commit" } })); const before = await counts(), recovered = await request(command); assert.equal(recovered.response.status, 200); assert.equal(recovered.response.headers.get("x-worldkit-admission"), "recovered"); await remember(recovered.data); assert.deepEqual(await counts(), before); const again = await request(command); assert.equal(cookieOf(recovered.response), cookieOf(again.response)); assert.equal(JSON.stringify(recovered.data), JSON.stringify(again.data));
});
test("same UUID with different recovery bodies races to one retained admission and one conflict", async () => {
  const a = body(), b = { ...a, recoveryKey: randomBytes(32).toString("hex") }, before = await counts(), values = await Promise.all([request(a), request(b)]); assert.deepEqual(values.map(v => v.response.status).sort(), [201, 409]); assert.equal((await counts()).sessions, before.sessions + 1); const saved = values.find(v => v.response.status === 201)!; await remember(saved.data); assert.equal(values.find(v => v.response.status === 409)!.response.headers.get("set-cookie"), null);
});
test("a valid existing workspace is acknowledged without a seed/counter/cookie change and has durable original recovery", async () => {
  const existing = await freshExisting(), command = body(), before = await counts(), value = await request(command, { cookie: existing.cookie }); assert.equal(value.response.status, 200); assert.equal(value.response.headers.get("x-worldkit-admission"), "existing"); assert.equal(value.response.headers.get("set-cookie"), null); assert.equal(value.data.session.id, existing.session.id); assert.equal(value.data.session.expiresAt, existing.session.expiresAt); const after = await counts(); assert.equal(after.sessions, before.sessions); assert.deepEqual(after.quota, before.quota);
  const recovered = await request(command); assert.equal(recovered.response.status, 200); assert.equal(cookieOf(recovered.response), existing.cookie); assert.equal(recovered.data.session.expiresAt, existing.session.expiresAt);
});
test("recovery cannot replace a different valid browser workspace", async () => {
  const a = await created(), b = await created(), before = await counts(), refused = await request(a.command, { cookie: b.cookie }); assert.equal(refused.response.status, 409); assert.equal(refused.response.headers.get("set-cookie"), null); assert.equal((await request(undefined, { cookie: b.cookie })).data.session.id, b.data.session.id); assert.deepEqual(await counts(), before);
});
test("a real expired original session cannot be renewed by its recovery receipt", async () => {
  const existing = await freshExisting(450), command = body(), bound = await request(command, { cookie: existing.cookie }); assert.equal(bound.response.status, 200); const before = await counts(); await delay(Math.max(0, Date.parse(existing.session.expiresAt) - Date.now() + 20)); const value = await request(command); assert.equal(value.response.status, 410); assert.equal(value.response.headers.get("set-cookie"), null); assert.deepEqual(await counts(), before);
});
test("current authority is sampled after a real row-lock wait crossing its original expiry", async () => {
  const existing = await freshExisting(1000), command = body(); assert.equal((await request(command, { cookie: existing.cookie })).response.status, 200);
  const lock = await database().connect(); let waiting: Promise<Awaited<ReturnType<typeof request>>> | null = null;
  try { await lock.query("BEGIN"); const pid = Number((await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid); await lock.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [existing.session.id]); waiting = request(command, { cookie: existing.cookie }); let observed = false; for (let i = 0; i < 40; i++) { observed = Number((await database().query("SELECT count(*) AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rows[0].count) > 0; if (observed) break; await delay(10); } assert.ok(observed, "The actual handler is observed waiting on the existing session row."); await delay(Math.max(0, Date.parse(existing.session.expiresAt) - Date.now() + 20)); await lock.query("COMMIT"); const result = await waiting; assert.equal(result.response.status, 410); assert.equal(result.response.headers.get("set-cookie"), null); }
  finally { await lock.query("ROLLBACK"); lock.release(); await waiting?.catch(() => {}); }
});
test("failure after Sample seed rolls back the quota, graph and admission together; the original request remains usable", async () => {
  const before = await counts(), command = body(), original = process.env.AUTH_SECRET; delete process.env.AUTH_SECRET;
  try { const failed = await request(command); assert.equal(failed.response.status, 503); assert.deepEqual(await counts(), before); }
  finally { process.env.AUTH_SECRET = original; }
  const result = await request(command); assert.equal(result.response.status, 201); await remember(result.data);
});
test("receipt storage contains sealed authority and hashes, and refuses mutation of its original deadline", async () => {
  const f = await created(), row = (await database().query("SELECT * FROM wk_workspace_admissions WHERE request_id=$1", [f.command.requestId])).rows[0]; const text = JSON.stringify(row); assert.ok(!text.includes(f.command.recoveryKey)); assert.ok(!text.includes(f.cookie.split("=")[1]!)); assert.equal(new Date(row.original_expires_at).toISOString(), f.data.session.expiresAt); assert.match(row.result_sealed.sealed, /^v1\./);
  await assert.rejects(database().query("UPDATE wk_workspace_admissions SET original_expires_at=original_expires_at+interval '1 second' WHERE request_id=$1", [f.command.requestId]), /immutable/);
});
test("bounded valid UTF-8 JSON accepts exactly 2KiB and refuses one extra byte, invalid media, duplicate cookies and malformed UTF-8", async () => {
  const input = body(), encoded = JSON.stringify(input), full = encoded + " ".repeat(ADMISSION_MAX_BYTES - Buffer.byteLength(encoded)); const value = await request(undefined, { raw: full, method: "POST" }); assert.equal(value.response.status, 201); await remember(value.data); const before = await counts();
  assert.equal((await request(undefined, { raw: full + " ", method: "POST" })).response.status, 413);
  assert.equal((await request(body(), { headers: { "Content-Type": "text/plain" } })).response.status, 415);
  assert.equal((await request(undefined, { cookie: `${sessionCookie}=a; ${sessionCookie}=b` })).response.status, 401);
  const invalid = Buffer.from(JSON.stringify(body())); invalid[invalid.indexOf("start_sample")] = 0xff; assert.equal((await request(undefined, { raw: new Uint8Array(invalid), method: "POST" })).response.status, 400); assert.deepEqual(await counts(), before);
});
test("an unending oversized Request body is cancelled without a database admission", async () => {
  const before = await counts(); let pulls = 0, cancelled = false; const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(512).fill(32)); }, cancel() { cancelled = true; } });
  const request = new Request(`${base}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit); await assert.rejects(readAdmissionJson(request), error => (error as { status?: number }).status === 413); assert.equal(cancelled, true); assert.ok(pulls <= 6); assert.deepEqual(await counts(), before);
});
