import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import sharp from "sharp";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { architectures, profiles, seedKit, sources } from "../packages/device-library";
import { verifyKit } from "../packages/compatibility";
import type { InventoryPhoto } from "../packages/inventory/contracts";

// A separate explicit launcher loads only the assigned fresh authority. Ordinary
// integration runs skip this gate. Actual HTTP/SDK/PG use synthetic pixels and a
// controlled loopback Blob peer, never a real store, model or catalog provider.
const enabled = process.env.WORLDKIT_RELEASE_PHOTO_SOURCE_INDEPENDENT === "1";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => sha(canonical(value));
const syntheticBlobToken = "vercel_blob_rw_syntheticstore_00000000000000000000000000000000";
const sourcePaths = ["src/server/inventory-photo-http.ts", "src/server/inventory-photos.ts", "src/app/api/inventory/photos/route.ts", "src/server/http.ts", "src/server/db.ts", "src/server/repository.ts", "src/server/workspace-admission-http.ts", "packages/security/origin.ts"];
type Fixture = { id: string; expiry: string; revision: string; graphHash: string; cookie: string };
type Put = { pathname: string; hash: string; bytes: Buffer; headers: { access: string | undefined; type: string | undefined; suffix: string | undefined; overwrite: string | undefined }; syntheticTokenMatched: boolean };
type Answer = { status: number; data: { photo?: InventoryPhoto; error?: { code?: string; message?: string } } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(a => { resolve = a; }); return { promise, resolve }; }
function quote(name: string) { return `"${name.replaceAll('"', '""')}"`; }

describe("independent release-final inventory image-source HTTP/SDK/PG gate", { skip: !enabled, concurrency: false }, () => {
  let pool: Pool, apiServer: Server, blobServer: Server, apiBase = "", blobBase = "", cookieName = "";
  let handler: typeof import("../src/server/inventory-photo-http").handleInventoryPhotoUpload;
  let sourceDb: typeof import("../src/server/db");
  let mock: MockAgent, failed = false, active = 0, lostAnswers = 0, externalAttempts = 0, bridgeErrors = 0;
  let pendingPut: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  const puts: Put[] = [], fixtures: Fixture[] = [], observations: Record<string, unknown>[] = [], releases = new Set<() => void>();
  const originalFetch = globalThis.fetch, originalDispatcher = getGlobalDispatcher();
  let originals = new Map<string, string[]>(), sourceBefore: Record<string, string> = {}, identity: Record<string, unknown> = {};
  const runId = randomUUID(), evidence = fileURLToPath(new URL("../.local/release-review/inventory-photo-source/backend-independent/", import.meta.url));
  const attempt = process.env.WORLDKIT_PHOTO_SOURCE_ATTEMPT ?? "";

  async function snapshot() {
    const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => String(row.tablename));
    const result = new Map<string, string[]>();
    for (const table of tables) result.set(table, (await pool.query(`SELECT row_to_json(t) AS row FROM public.${quote(table)} t`)).rows.map(row => digest(row.row)).sort());
    return result;
  }
  async function incomingBytes(request: IncomingMessage, max = 3_500_000) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > max) throw Error("Controlled request exceeded its byte cap."); chunks.push(bytes); }
    return Buffer.concat(chunks);
  }
  async function responseBytes(response: Response) {
    const reader = response.body?.getReader(); assert.ok(reader); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; assert.ok(size <= 16384, "Controlled response exceeded 16 KiB."); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
  }
  async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
  async function sourceHashes() { return Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, sha(await readFile(file))]))); }

  before(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
    assert.ok(url.hostname === "127.0.0.1" && url.port === "55576" && url.pathname === "/worldkit_release_final" && url.username === "wk_release_final_app", "Only the assigned fresh database identity is accepted.");
    assert.equal(process.env.WORLDKIT_QA_MODE, "release-final"); assert.equal(process.env.WORLDKIT_DISABLE_PROVIDERS, "true");
    for (const key of ["host", "hostaddr", "port", "database", "user", "service"]) assert.equal(url.searchParams.has(key), false);
    for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "CHANNEL3_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "BLOB_READ_WRITE_TOKEN", "VERCEL_OIDC_TOKEN"]) assert.ok(!process.env[key], "No external provider authority may be loaded.");
    assert.equal(path.resolve(process.env.WORLDKIT_PHOTO_SOURCE_EVIDENCE_DIR ?? ""), path.resolve(evidence)); assert.match(attempt, /^attempt[0-9]+$/);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 12000 });
    identity = (await pool.query("SELECT current_database() AS db,current_user AS role,host(inet_server_addr()) AS host,inet_server_port() AS port")).rows[0];
    assert.deepEqual(identity, { db: "worldkit_release_final", role: "wk_release_final_app", host: "127.0.0.1", port: 55576 });
    originals = await snapshot(); sourceBefore = await sourceHashes();
    await writeFile(path.join(evidence, `baseline-${attempt}-${runId}.json`), JSON.stringify({ runId, attempt, identity, sourceHashes: sourceBefore, rowDigests: Object.fromEntries(originals) }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    sourceDb = await import("../src/server/db"); await sourceDb.initialize();

    blobServer = createServer(async (incoming, outgoing) => {
      active++;
      try {
        assert.equal(incoming.method, "PUT"); const target = new URL(incoming.url ?? "/", blobBase), pathname = target.searchParams.get("pathname");
        assert.ok(pathname && /^worldkit\/[a-f0-9-]+\/inventory\/[a-f0-9-]+\.webp$/.test(pathname));
        const bytes = await incomingBytes(incoming), entry: Put = { pathname, hash: sha(bytes), bytes, headers: { access: String(incoming.headers["x-vercel-blob-access"] ?? ""), type: String(incoming.headers["x-content-type"] ?? ""), suffix: String(incoming.headers["x-add-random-suffix"] ?? ""), overwrite: String(incoming.headers["x-allow-overwrite"] ?? "") }, syntheticTokenMatched: incoming.headers.authorization === `Bearer ${syntheticBlobToken}` };
        puts.push(entry);
        const hold = pendingPut; if (hold) { pendingPut = null; hold.entered.resolve(); await hold.release.promise; }
        const url = `${blobBase}/${pathname}`;
        outgoing.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        outgoing.end(JSON.stringify({ url, downloadUrl: `${url}?download=1`, pathname, contentType: "image/webp", contentDisposition: 'attachment; filename="controlled.webp"', etag: entry.hash }));
      } catch { bridgeErrors++; outgoing.writeHead(400, { "Content-Type": "application/json" }); outgoing.end(JSON.stringify({ error: { code: "controlled_peer_refused" } })); }
      finally { active--; }
    });
    blobBase = await listen(blobServer);
    apiServer = createServer(async (incoming, outgoing) => {
      active++;
      try {
        assert.equal(incoming.url, "/api/inventory/photos"); assert.equal(incoming.method, "POST");
        const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        const bytes = await incomingBytes(incoming), request = new Request(`${apiBase}${incoming.url}`, { method: "POST", headers, body: new Uint8Array(bytes) });
        const response = await handler(request), body = await responseBytes(response);
        if (headers.get("x-independent-drop-answer") === "after-commit" && response.ok) { lostAnswers++; outgoing.destroy(); return; }
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(body);
      } catch { bridgeErrors++; if (!outgoing.destroyed) { outgoing.writeHead(503, { "Content-Type": "application/json" }); outgoing.end(JSON.stringify({ error: { code: "controlled_bridge_failed" } })); } }
      finally { active--; }
    });
    apiBase = await listen(apiServer);
    mock = new MockAgent(); mock.disableNetConnect(); const allowedHosts = new Set([new URL(apiBase).host, new URL(blobBase).host]); mock.enableNetConnect(host => allowedHosts.has(host)); setGlobalDispatcher(mock);
    const allowed = new Set([apiBase, blobBase]);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => { const url = new URL(input instanceof Request ? input.url : String(input)); if (!allowed.has(url.origin)) { externalAttempts++; return Promise.reject(new Error("Non-loopback HTTP is forbidden by this gate.")); } return originalFetch(input, { ...init, redirect: "error" }); }) as typeof fetch;
    process.env.WORLDKIT_PUBLIC_URL = apiBase; process.env.BLOB_READ_WRITE_TOKEN = syntheticBlobToken; process.env.VERCEL_BLOB_API_URL = blobBase;
    // The installed SDK checks OIDC before the read/write-token fallback. A
    // synthetic, unexpired payload prevents local CLI credential discovery and
    // refresh. With no store ID it still falls back to our synthetic Blob token;
    // the controlled peer asserts that exact bearer. This is no real authority.
    process.env.VERCEL_OIDC_TOKEN = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "independent-synthetic-only" })).toString("base64url")}.synthetic`;
    delete process.env.BLOB_STORE_ID; delete process.env.VERCEL_URL;
    handler = (await import("../src/server/inventory-photo-http")).handleInventoryPhotoUpload;
    cookieName = (await import("../src/server/http")).sessionCookie; assert.equal(cookieName, "wk_release_final_qa");
    const sdk = JSON.parse(await readFile("node_modules/@vercel/blob/package.json", "utf8")); assert.equal(sdk.version, "2.9.0");
  });

  async function fresh(ttl = 7 * 86400000): Promise<Fixture> {
    const id = randomUUID(), token = randomBytes(32).toString("base64url"), expiry = new Date(Date.now() + ttl).toISOString(), revision = randomUUID(), kitId = randomUUID();
    const kit = { ...seedKit("T2", revision), kitId }, certificate = verifyKit(kit, profiles, sources, architectures), client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO wk_sessions(id,token_hash,expires_at) VALUES($1,$2,$3)", [id, sha(token), expiry]);
      await client.query("INSERT INTO wk_kits(id,tenant_id,current_revision_id) VALUES($1,$2,$3)", [kitId, id, revision]);
      await client.query("INSERT INTO wk_revisions(id,kit_id,tenant_id,revision,kit,certificate,profiles,sources) VALUES($1,$2,$3,1,$4,$5,$6,$7)", [revision, kitId, id, JSON.stringify(kit), JSON.stringify(certificate), JSON.stringify(profiles), JSON.stringify(sources)]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    const graph = (await pool.query("SELECT kit,certificate,profiles,sources FROM wk_revisions WHERE id=$1 AND tenant_id=$2", [revision, id])).rows[0];
    const fixture = { id, expiry, revision, graphHash: digest(graph), cookie: `${cookieName}=${token}` }; fixtures.push(fixture); return fixture;
  }
  async function image(red: number) { return sharp({ create: { width: 128, height: 96, channels: 3, background: { r: red, g: 79, b: 113 } } }).png().toBuffer(); }
  async function request(fixture: Fixture | null, bytes: Buffer, source?: string, extra: Record<string, string> = {}): Promise<Answer> {
    const response = await fetch(`${apiBase}/api/inventory/photos`, { method: "POST", headers: { Origin: apiBase, "Content-Type": "image/png", ...(fixture ? { Cookie: fixture.cookie } : {}), ...(source === undefined ? {} : { "X-WorldKit-Image-Source": source }), ...extra }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(15000) });
    const data = JSON.parse((await responseBytes(response)).toString("utf8")) as Answer["data"];
    observations.push({ status: response.status, source: data.photo?.sourceMode ?? null, photoId: data.photo?.id ?? null, contentHash: data.photo?.contentHash ?? null, errorCode: data.error?.code ?? null, message: data.error?.message?.slice(0, 200) ?? null });
    return { status: response.status, data };
  }
  async function rows(fixture: Fixture) { return (await pool.query("SELECT id,tenant_id,blob_path,content_hash,source_mode,status,width,height,bytes FROM wk_inventory_photos WHERE tenant_id=$1 ORDER BY created_at", [fixture.id])).rows; }
  function boundary(name: string, action: () => Promise<void>) {
    test(name, async context => { if (failed) { context.skip("A prior independent boundary failed; preserve its first observation before continuing."); return; } try { await action(); } catch (error) { failed = true; throw error; } });
  }

  boundary("explicit Sample bytes normalize into one hash-bound immutable Sample row and source conflicts cannot relabel it", async () => {
    const fixture = await fresh(), bytes = await image(41), before = puts.length, saved = await request(fixture, bytes, "sample");
    assert.equal(saved.status, 201, "Sample HTTP upload must succeed; bounded observation is retained privately."); assert.equal(puts.length, before + 1);
    const put = puts.at(-1)!, row = (await rows(fixture))[0]; assert.ok(row); assert.equal(row.source_mode, "sample"); assert.equal(row.status, "active");
    assert.equal(row.id, saved.data.photo?.id); assert.equal(row.content_hash, put.hash); assert.equal(saved.data.photo?.contentHash, put.hash); assert.notEqual(put.hash, sha(bytes));
    assert.deepEqual(put.headers, { access: "private", type: "image/webp", suffix: "0", overwrite: "0" }); assert.equal(put.syntheticTokenMatched, true);
    const metadata = await sharp(put.bytes).metadata(); assert.equal(metadata.format, "webp"); assert.equal(metadata.width, 128); assert.equal(metadata.height, 96);
    assert.equal(row.width, metadata.width); assert.equal(row.height, metadata.height); assert.equal(row.bytes, put.bytes.length);
    assert.equal(put.pathname, row.blob_path); assert.equal(row.blob_path, `worldkit/${fixture.id}/inventory/${row.id}.webp`);
    const conflict = await request(fixture, bytes, "live"); assert.equal(conflict.status, 409); assert.equal(puts.length, before + 1); assert.equal((await rows(fixture))[0].source_mode, "sample");
  });
  boundary("legacy and explicit Photograph declarations stay live while equal bytes remain separate owner assets", async () => {
    const first = await fresh(), second = await fresh(), bytes = await image(57), before = puts.length;
    const a = await request(first, bytes), b = await request(second, bytes, "live"); assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.data.photo?.sourceMode, "live"); assert.equal(b.data.photo?.sourceMode, "live");
    assert.ok(a.data.photo?.id !== b.data.photo?.id); assert.equal(puts.length, before + 2);
    const aRow = (await rows(first))[0], bRow = (await rows(second))[0]; assert.equal(aRow.content_hash, bRow.content_hash); assert.notEqual(aRow.blob_path, bRow.blob_path); assert.equal(aRow.tenant_id, first.id); assert.equal(bRow.tenant_id, second.id);
  });
  boundary("bad origin, anonymous/duplicate cookies, invalid source/type and unreadable bytes never reach Blob PUT", async () => {
    const fixture = await fresh(), bytes = await image(83), before = puts.length;
    const denied = [
      await request(fixture, bytes, "sample", { Origin: "https://foreign.invalid" }),
      await request(null, bytes, "sample"),
      await request(fixture, bytes, "sample", { Cookie: `${fixture.cookie}; ${fixture.cookie}` }),
      await request(fixture, bytes, "unexpected"),
      await request(fixture, bytes, "sample", { "Content-Type": "image/gif" }),
      await request(fixture, Buffer.from("synthetic unreadable image"), "sample"),
    ];
    assert.deepEqual(denied.map(x => x.status), [403, 401, 401, 400, 415, 400]); assert.equal(puts.length, before); assert.equal((await rows(fixture)).length, 0);
  });
  boundary("concurrent same-byte pending submissions produce one actual SDK PUT and one conflict", async () => {
    const fixture = await fresh(), bytes = await image(109), before = puts.length, hold = { entered: deferred(), release: deferred() };
    pendingPut = hold; releases.add(hold.release.resolve); const first = request(fixture, bytes, "sample");
    try {
      await Promise.race([hold.entered.promise, delay(10000, undefined, { ref: false }).then(() => { throw Error("The controlled Blob peer never received the first PUT."); })]);
      const pending = await rows(fixture); assert.equal(pending.length, 1); assert.equal(pending[0].status, "uploading");
      const second = await request(fixture, bytes, "sample"); assert.equal(second.status, 409); assert.equal(puts.length, before + 1);
    } finally { hold.release.resolve(); releases.delete(hold.release.resolve); }
    assert.equal((await first).status, 201); assert.equal((await rows(fixture)).length, 1); assert.equal(puts.length, before + 1);
  });
  boundary("a real socket loss after the committed answer recovers the original same-byte row without a second PUT", async () => {
    const fixture = await fresh(), bytes = await image(137), before = puts.length, lostBefore = lostAnswers;
    await assert.rejects(request(fixture, bytes, "sample", { "X-Independent-Drop-Answer": "after-commit" }));
    assert.equal(lostAnswers, lostBefore + 1); const original = (await rows(fixture))[0]; assert.ok(original); assert.equal(original.status, "active"); assert.equal(puts.length, before + 1);
    const recovered = await request(fixture, bytes, "sample"); assert.equal(recovered.status, 201); assert.equal(recovered.data.photo?.id, original.id); assert.equal(recovered.data.photo?.contentHash, original.content_hash); assert.equal(puts.length, before + 1); assert.equal((await rows(fixture)).length, 1);
  });
  boundary("the originally declared short expiry wins after an observed real owner-row lock wait, before PUT", async () => {
    const fixture = await fresh(5000), bytes = await image(173), before = puts.length, lock = await pool.connect(); let waiting: Promise<Answer> | undefined;
    try {
      await lock.query("BEGIN"); const pid = Number((await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid); await lock.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [fixture.id]);
      waiting = request(fixture, bytes, "sample"); let observed = false;
      for (let i = 0; i < 100; i++) { observed = Number((await pool.query("SELECT count(*) AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rows[0].count) > 0; if (observed) break; await delay(10); }
      assert.ok(observed, "The actual upload handler must be observed waiting on the owner row before expiry."); assert.ok(Date.now() < Date.parse(fixture.expiry));
      observations.push({ boundary: "owner-row-lock", observedBeforeOriginalExpiry: true, originalExpiry: fixture.expiry });
      await delay(Math.max(0, Date.parse(fixture.expiry) - Date.now() + 40)); await lock.query("COMMIT");
      assert.equal((await waiting).status, 401); assert.equal(puts.length, before); assert.equal((await rows(fixture)).length, 0);
    } finally { await lock.query("ROLLBACK"); lock.release(); await waiting?.catch(() => {}); }
  });

  after(async () => {
    releases.forEach(release => release()); const report: Record<string, unknown> = { runId, at: new Date().toISOString(), attempt, identity, originalTables: originals.size, originalRows: [...originals.values()].reduce((sum, rows) => sum + rows.length, 0), originalRowsPreserved: false, freshInitialExpiriesAndGraphsPreserved: false, externalAttempts, bridgeErrors, lostAnswers, blobPuts: puts.map(p => ({ pathname: p.pathname, contentHash: p.hash, bytes: p.bytes.length, headers: p.headers, syntheticTokenMatched: p.syntheticTokenMatched })), fixtures: fixtures.map(({ cookie: _private, ...fixture }) => fixture), observations, limits: "Actual official Blob SDK2.9.0/loopback HTTP/PostgreSQL with generated synthetic pixels; no real Blob store or actual photograph/provider/model/catalog/financial operation." };
    try {
      for (let i = 0; active && i < 100; i++) await delay(10); assert.equal(active, 0);
      const final = await snapshot(), additions: Record<string, number> = {}, allowed = new Set(["wk_sessions", "wk_kits", "wk_revisions", "wk_inventory_photos", "wk_events"]);
      for (const [table, old] of originals) { const counts = new Map<string, number>(); for (const value of final.get(table) ?? []) counts.set(value, (counts.get(value) ?? 0) + 1); for (const value of old) { assert.ok((counts.get(value) ?? 0) > 0, `Original ${table} row values must remain exact.`); counts.set(value, counts.get(value)! - 1); } }
      report.originalRowsPreserved = true;
      for (const fixture of fixtures) { const row = (await pool.query("SELECT expires_at FROM wk_sessions WHERE id=$1", [fixture.id])).rows[0], graph = (await pool.query("SELECT kit,certificate,profiles,sources FROM wk_revisions WHERE id=$1 AND tenant_id=$2", [fixture.revision, fixture.id])).rows[0]; assert.equal(new Date(row.expires_at).toISOString(), fixture.expiry); assert.equal(digest(graph), fixture.graphHash); }
      report.freshInitialExpiriesAndGraphsPreserved = true;
      for (const [table, rows] of final) { additions[table] = rows.length - (originals.get(table)?.length ?? 0); if (!allowed.has(table)) assert.equal(additions[table], 0, `No model/catalog/job/financial or other unapproved rows in ${table}.`); }
      report.rowAdditions = additions; assert.equal(externalAttempts, 0); assert.equal(bridgeErrors, 0); assert.deepEqual(await sourceHashes(), sourceBefore); report.sourceHashes = sourceBefore; report.passed = !failed;
    } catch (error) {
      report.passed = false; report.continuityFailure = error instanceof Error ? error.message.slice(0, 300) : "Unknown continuity failure"; process.exitCode = 1; throw error;
    } finally {
      await writeFile(path.join(evidence, `continuity-${attempt}-${runId}.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      globalThis.fetch = originalFetch; setGlobalDispatcher(originalDispatcher);
      for (const server of [apiServer, blobServer]) if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      await mock?.close(); await sourceDb?.closeDatabase(); await pool?.end();
    }
  });
});
