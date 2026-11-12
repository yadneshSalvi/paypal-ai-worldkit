import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeDatabase, database, initialize } from "../src/server/db";
import { runOneJob } from "../src/server/jobs";
import { requireIsolatedDatabase } from "./support/isolated-database";

requireIsolatedDatabase();
const url = new URL(process.env.DATABASE_URL!);
assert.equal(url.pathname, "/worldkit_release_final");
assert.equal(url.username, "wk_release_final_app");
assert.equal(url.port, "55576");
assert.equal(process.env.WORLDKIT_QA_MODE, "release-final");
for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "CHANNEL3_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENAI_API_KEY", "BLOB_READ_WRITE_TOKEN", "AI_GATEWAY_API_KEY"]) assert.equal(process.env[name] ?? "", "", `This control requires a blank ${name}.`);

type Snapshot = Record<string, string[]>;
const runId = randomUUID();
const observations: unknown[] = [];
const fixtures: { id: string; expiresAt: string }[] = [];
const jobs: string[] = [];
let baseline: Snapshot = {};
let executorCalls = 0;
let externalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { externalCalls++; throw new Error("No external request is permitted in this queue control."); };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function snapshot(): Promise<Snapshot> {
  const tables = await database().query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const result: Snapshot = {};
  for (const { tablename } of tables.rows) {
    assert.match(tablename, /^wk_[a-z0-9_]+$/);
    result[tablename] = (await database().query<{ value: string }>(`SELECT to_jsonb(t)::text AS value FROM "${tablename}" t ORDER BY 1`)).rows.map(row => row.value);
  }
  return result;
}

before(async () => {
  await initialize();
  const unsafe = await database().query(`SELECT count(*)::int AS count FROM wk_jobs j JOIN wk_sessions s ON s.id=j.tenant_id WHERE j.managed=true AND ((j.status='running' AND j.lease_expires_at<now()) OR (s.expires_at<=now() AND j.kind NOT IN ('inventory_photo_delete','source_document_delete') AND j.status IN ('queued','running','retry_wait')))`);
  assert.equal(unsafe.rows[0].count, 0, "A retained diagnostic job needs its own explicit cleanup before this pre-fix control can run.");
  baseline = await snapshot();
});

async function session(expired = false) {
  const id = randomUUID(); const expiresAt = new Date(Date.now() + (expired ? -60_000 : 3_600_000)).toISOString();
  await database().query("INSERT INTO wk_sessions(id,token_hash,expires_at) VALUES($1,$2,$3)", [id, digest(randomUUID()), expiresAt]);
  fixtures.push({ id, expiresAt }); return id;
}

async function stopped(tenantId: string, queued = false) {
  const id = randomUUID(); const lease = randomUUID();
  await database().query(`INSERT INTO wk_jobs(id,tenant_id,kind,status,input,managed,attempts,max_attempts,lease_token,lease_expires_at,progress) VALUES($1,$2,'inventory_regions',$3,$4,true,$5,3,$6,now()-interval '1 minute','Controlled stopped worker')`, [id, tenantId, queued ? "queued" : "running", { diagnostic: runId }, queued ? 0 : 3, queued ? null : lease]);
  if (!queued) await database().query("INSERT INTO wk_job_attempts(job_id,attempt,lease_token,status) VALUES($1,3,$2,'running')", [id, lease]);
  jobs.push(id); return id;
}

async function rows(ids: string[]) {
  return {
    jobs: (await database().query("SELECT to_jsonb(j) AS value FROM wk_jobs j WHERE id=ANY($1::text[]) ORDER BY id", [ids])).rows.map(row => row.value),
    attempts: (await database().query("SELECT to_jsonb(a) AS value FROM wk_job_attempts a WHERE job_id=ANY($1::text[]) ORDER BY job_id,attempt", [ids])).rows.map(row => row.value),
  };
}

async function run(scope: { tenantId: string; id?: string }) {
  assert.equal(await runOneJob(scope, async () => { executorCalls++; throw new Error("This control contains no runnable provider task."); }), false);
}

test("scoped polling preserves foreign attempts and deadlines while recovering its selected job or workspace", async () => {
  const own = await session(); const foreign = await session(); const expired = await session(true);
  const selected = await stopped(own); const sameOwner = await stopped(own); const otherOwner = await stopped(foreign); const expiredOwner = await stopped(expired, true);
  const untouched = await rows([sameOwner, otherOwner, expiredOwner]);
  await run({ tenantId: own, id: selected });
  observations.push({ phase: "exact-job-scope", scope: { tenantId: own, id: selected }, before: untouched, after: await rows(jobs) });
  assert.deepEqual(await rows([sameOwner, otherOwner, expiredOwner]), untouched, "An exact job poll must not maintain another job, owner, or expired workspace.");
  assert.equal((await rows([selected])).jobs[0].status, "failed");
  assert.equal((await rows([selected])).attempts[0].status, "interrupted");
  const foreignBefore = await rows([otherOwner, expiredOwner]);
  await run({ tenantId: own });
  assert.deepEqual(await rows([otherOwner, expiredOwner]), foreignBefore);
  assert.equal((await rows([sameOwner])).jobs[0].status, "failed");
  assert.equal((await rows([sameOwner])).attempts[0].status, "interrupted");
  await run({ tenantId: foreign });
  assert.equal((await rows([otherOwner])).jobs[0].status, "failed");
  assert.equal((await rows([otherOwner])).attempts[0].status, "interrupted");
  assert.deepEqual(await rows([expiredOwner]), { jobs: foreignBefore.jobs.filter(row => row.id === expiredOwner), attempts: [] });
  await run({ tenantId: expired });
  assert.equal((await rows([expiredOwner])).jobs[0].status, "cancelled");
  assert.equal(executorCalls, 0); assert.equal(externalCalls, 0);
  observations.push({ phase: "original-owner-maintenance", after: await rows(jobs) });
});

after(async () => {
  try {
    const current = await snapshot(); const missing: { table: string; hash: string }[] = [];
    for (const [table, oldRows] of Object.entries(baseline)) {
      const counts = new Map<string, number>();
      for (const row of current[table] ?? []) counts.set(row, (counts.get(row) ?? 0) + 1);
      for (const row of oldRows) { const left = counts.get(row) ?? 0; if (!left) missing.push({ table, hash: digest(row) }); else counts.set(row, left - 1); }
    }
    const sessions = (await database().query("SELECT id,expires_at FROM wk_sessions WHERE id=ANY($1::text[])", [fixtures.map(row => row.id)])).rows;
    const expiryPreserved = fixtures.every(row => sessions.some(actual => actual.id === row.id && new Date(actual.expires_at).toISOString() === row.expiresAt));
    const dir = resolve(".local/release-review/job-scope"); await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(resolve(dir, `${runId}.private.json`), JSON.stringify({ at: new Date().toISOString(), runId, controlledSyntheticOnly: true, baselineHash: digest(baseline), currentHash: digest(current), baselineRows: Object.values(baseline).reduce((n, value) => n + value.length, 0), originalRowsPreserved: missing.length === 0, missing, originalExpiryPreserved: expiryPreserved, fixtures, jobs, executorCalls, externalCalls, observations }, null, 2), { flag: "wx", mode: 0o600 });
    assert.equal(missing.length, 0); assert.equal(expiryPreserved, true);
  } finally { globalThis.fetch = originalFetch; await closeDatabase(); }
});
