import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hash } from "../packages/compatibility";
import { WorldKitError } from "../packages/contracts";
import { RESEARCH_STARTER_TASKS, ResearchCommandSchema, type ResearchCommand, type ResearchCommandResult, type ResearchConsentInput, type ResearchDetail, type ResearchHome, type ResearchParticipant, type ResearchSubject } from "../packages/research-notebook/contracts";
import { database, closeDatabase } from "../src/server/db";
import { createSession, findSession, getRevision, commitEdit, type Session } from "../src/server/repository";
import { errorResponse, sessionCookie } from "../src/server/http";
import { ownerResearchAccess, type ResearchAccess } from "../src/server/research-notebook-authority";
import { domainCommand, domainHome } from "../src/server/domain-packs";
import { researchNotebookHome } from "../src/server/research-notebook";
import { handleResearchNotebook, readResearchJson } from "../src/server/research-notebook-http";
import { researchExportResponse } from "../src/server/research-notebook-export";

// Independent real loopback HTTP + owned PostgreSQL controls. Every fixture is
// fictional software evidence, including operator_recorded type controls. No
// person is recruited/observed, no provider/model/merchant/physical action runs.
const target = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
assert.equal(process.env.WORLDKIT_QA_MODE, "research-notebook", "Research-only QA mode is required.");
assert.equal(process.env.WORLDKIT_DISABLE_PROVIDERS, "true");
assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55576");
assert.equal(target.pathname, "/worldkit_research"); assert.equal(target.username, "worldkit_research");
for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "GEMINI_API_KEY", "GEMINI_MODEL", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "CHANNEL3_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ACCESS_TOKEN", "PAYPAL_WEBHOOK_ID", "AI_GATEWAY_API_KEY", "BLOB_READ_WRITE_TOKEN"]) assert.ok(!process.env[name], `Provider/model value ${name} must be cleared.`);
assert.notEqual(sessionCookie, "wk_physical_qa");
const runId = randomUUID(), originalFetch = globalThis.fetch, originalPublic = process.env.WORLDKIT_PUBLIC_URL;
let server: Server | undefined, base = "", externalAttempts = 0, droppedAnswers = 0, issuedRequests = 0, activeHandlers = 0, validatedDatabase = false;
type Descriptor = { tenantId: string; originalExpiry: string; originalRevisionId: string; originalRevisionHash: string; expectedCurrentRevisionId: string; purpose: string; shortenedBeforeResearch: boolean; domain: null | { projectId: string; editionId: string; originalHash: string; expectedArchived: boolean } };
const descriptors: Descriptor[] = [];
type Fixture = { session: Session; cookie: string; access: ResearchAccess; detail: ResearchDetail; create: ResearchCommand; originalExpiry: string };
type HttpResult = { response: Response; data: any };
const expected = (detail: ResearchDetail) => ({ studyId: detail.study.id, expectedVersion: detail.study.version, expectedStudyHash: detail.study.hash });
const until = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();
const tokenOf = (request: Request) => request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length + 1);
async function accessFor(request: Request): Promise<ResearchAccess> { const session = await findSession(tokenOf(request)); if (!session) throw new WorldKitError("forbidden", "Synthetic research credential is absent or expired.", 401); return ownerResearchAccess(session); }
before(async () => {
  const identity = (await database().query("SELECT current_database() AS db,current_user AS role,inet_server_port() AS port")).rows[0];
  assert.deepEqual(identity, { db: "worldkit_research", role: "worldkit_research", port: 55576 }); validatedDatabase = true;
  server = createServer(async (incoming, outgoing) => {
    activeHandlers++;
    try {
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const chunks: Buffer[] = []; for await (const part of incoming) chunks.push(Buffer.from(part));
      const request = new Request(`${base}${incoming.url}`, { method: incoming.method, headers, ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: new Uint8Array(Buffer.concat(chunks)) }) });
      let response: Response;
      try { const access = await accessFor(request); response = new URL(request.url).pathname.endsWith("/export") ? await researchExportResponse(request, access) : await handleResearchNotebook(request, access); }
      catch (error) { response = errorResponse(error); }
      // Test-only transport boundary: lose the response only after the actual
      // handler has committed. No production route reads this private header.
      if (headers.get("x-research-qa-drop-answer") === "after-commit" && response.ok) { droppedAnswers++; outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!outgoing.destroyed) { outgoing.statusCode = 500; outgoing.end("Controlled research bridge failure"); } }
    finally { activeHandlers--; }
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.WORLDKIT_PUBLIC_URL = base;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => { const url = new URL(input instanceof Request ? input.url : String(input)); if (url.origin !== base) { externalAttempts++; throw new Error("External transport is forbidden in research qualification."); } issuedRequests++; return originalFetch(input, init); }) as typeof fetch;
});
after(async () => {
  const counts: Record<string, number> = {}, continuity: Record<string, unknown>[] = []; let auditPassed = false, auditFailure: null | { name: string; message: string } = null;
  try {
    if (!validatedDatabase) throw new Error("Research database identity was never validated; no audit queries are permitted.");
    await waitUntil(async () => activeHandlers === 0, "Every attempted HTTP handler must settle before continuity is audited.", 15_000);
    for (const table of ["wk_provider_receipts", "wk_source_model_requests", "wk_quotes", "wk_commerce_orders"]) if ((await database().query("SELECT to_regclass($1) AS relation", [table])).rows[0].relation) {
      counts[table] = Number((await database().query(`SELECT count(*) AS count FROM ${table} WHERE tenant_id=ANY($1::text[])`, [descriptors.map(d => d.tenantId)])).rows[0].count); assert.equal(counts[table], 0);
    }
    for (const descriptor of descriptors) {
      const row = (await database().query("SELECT s.expires_at,k.current_revision_id FROM wk_sessions s JOIN wk_kits k ON k.tenant_id=s.id WHERE s.id=$1", [descriptor.tenantId])).rows[0];
      assert.equal(new Date(row.expires_at).toISOString(), descriptor.originalExpiry, "No fixture expiry is renewed."); assert.equal(row.current_revision_id, descriptor.expectedCurrentRevisionId);
      assert.equal(hash(await getRevision(descriptor.tenantId, descriptor.originalRevisionId)), descriptor.originalRevisionHash, "The exact original source/certificate remains unchanged.");
      if (descriptor.domain) { const domainRow = (await database().query("SELECT p.archived_at,e.payload FROM wk_domain_projects p JOIN wk_domain_editions e ON e.project_id=p.id AND e.tenant_id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2 AND e.id=$3", [descriptor.domain.projectId, descriptor.tenantId, descriptor.domain.editionId])).rows[0]; assert.equal(hash(domainRow.payload), descriptor.domain.originalHash); assert.equal(!!domainRow.archived_at, descriptor.domain.expectedArchived); }
      continuity.push({ tenantId: descriptor.tenantId, expiryUnchanged: true, originalSourceUnchanged: true, currentRevisionId: row.current_revision_id });
    }
    assert.equal(externalAttempts, 0);
    auditPassed = true;
  } catch (error) { auditFailure = { name: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : "Audit did not complete" }; throw error;
  } finally {
    const directory = ".local/research-notebook-unit/adversarial"; await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(`${directory}/${runId}.private.json`, JSON.stringify({ kind: "controlled_loopback_and_fresh_owned_postgresql_only", at: new Date().toISOString(), runId, auditPassed, auditFailure, db: "worldkit_research", role: "worldkit_research", pgPort: 55576, cookieName: sessionCookie, issuedRequests, droppedAnswers, externalAttempts, actualParticipants: 0, actualConsentEvents: 0, actualHumanMeasurements: 0, providerModelFinancialActions: 0, physicalDatabaseAccess: 0, descriptors, continuity, counts }, null, 2), { mode: 0o600 });
    globalThis.fetch = originalFetch; if (originalPublic === undefined) delete process.env.WORLDKIT_PUBLIC_URL; else process.env.WORLDKIT_PUBLIC_URL = originalPublic; if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); } await closeDatabase(); }
});
async function http(cookie: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(15_000), headers: { Cookie: cookie, Origin: base, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, data: await response.json() };
}
function success(value: HttpResult): any { assert.equal(value.response.status, 200, value.data.error?.message ?? "Research request failed"); assert.match(value.response.headers.get("cache-control") ?? "", /no-store/); return value.data; }
async function fixture(purpose: string, { mode = "sample", ttlMs, domain = false }: { mode?: "sample" | "operator_recorded"; ttlMs?: number; domain?: boolean } = {}): Promise<Fixture> {
  assert.ok(descriptors.length < 25, "The independent suite is bounded to25 explicitly synthetic workspaces.");
  const fresh = await createSession();
  // A shorter initial lifetime is declared once, before this fresh fixture's
  // first research action. No expiry is increased, renewed or later reset.
  if (ttlMs !== undefined) { const row = (await database().query("UPDATE wk_sessions SET expires_at=LEAST(expires_at,date_trunc('milliseconds',clock_timestamp()+$2::double precision*interval '1 millisecond')) WHERE id=$1 RETURNING expires_at", [fresh.session.id, ttlMs])).rows[0]; fresh.session.expiresAt = new Date(row.expires_at).toISOString(); }
  const revision = await getRevision(fresh.session.id), subject: ResearchSubject = { kind: "creator", subjectId: revision.kit.kitId, revisionId: revision.kit.id, graphHash: revision.certificate.graphHash };
  descriptors.push({ tenantId: fresh.session.id, originalExpiry: fresh.session.expiresAt, originalRevisionId: revision.kit.id, originalRevisionHash: hash(revision), expectedCurrentRevisionId: revision.kit.id, purpose: `Synthetic only: ${purpose}`, shortenedBeforeResearch: ttlMs !== undefined, domain: null });
  if (domain) { const savedDomain = await domainCommand(fresh.session, { kind: "create", requestId: randomUUID(), packId: "desk-displays", title: "Synthetic archive-source control" }); const saved = (await domainHome(fresh.session, savedDomain.projectId)).selected!; Object.assign(subject, { kind: "domain", subjectId: saved.project.id, revisionId: saved.edition.id, graphHash: saved.edition.certificate.graphHash }); descriptors.at(-1)!.domain = { projectId: saved.project.id, editionId: saved.edition.id, originalHash: hash(saved.edition), expectedArchived: false }; }
  await mkdir(".local/research-notebook-unit/adversarial", { recursive: true, mode: 0o700 });
  await writeFile(`.local/research-notebook-unit/adversarial/${runId}.checkpoint.private.json`, JSON.stringify({ runId, at: new Date().toISOString(), phase: "fresh_diagnostic_fixtures_retained_before_research", descriptors }, null, 2), { mode: 0o600 });
  const cookie = `${sessionCookie}=${fresh.token}`;
  const create = ResearchCommandSchema.parse({ kind: "create", requestId: randomUUID(), subject, title: `Synthetic ${mode} ${purpose}`.slice(0, 120), objective: "Software qualification only; no actual participant, consent, comprehension or physical measurement.", mode, tasks: RESEARCH_STARTER_TASKS, acknowledgedOperatorScope: true });
  const saved = success(await http(cookie, "/api/research-notebook", create)) as ResearchCommandResult;
  const detail = (success(await http(cookie, `/api/research-notebook?studyId=${saved.studyId}`)) as ResearchHome).selected!;
  return { session: fresh.session, cookie, access: ownerResearchAccess(fresh.session), detail, create, originalExpiry: fresh.session.expiresAt };
}
async function refresh(f: Fixture, protocolId?: string) { f.detail = (success(await http(f.cookie, `/api/research-notebook?${new URLSearchParams({ studyId: f.detail.study.id, ...(protocolId ? { protocolId } : {}) })}`)) as ResearchHome).selected!; return f.detail; }
async function command(f: Fixture, body: Record<string, unknown>) { const input = ResearchCommandSchema.parse({ requestId: randomUUID(), ...expected(f.detail), ...body }); const saved = success(await http(f.cookie, "/api/research-notebook", input)) as ResearchCommandResult; await refresh(f); return { input, saved }; }
function consentInput({ publicUse = false, expiresAt = null, privateUse = true }: { publicUse?: boolean; expiresAt?: string | null; privateUse?: boolean } = {}): ResearchConsentInput { return { consentVersion: "synthetic-operator-declaration-v1", privateResearch: privateUse, anonymousPublicAggregate: publicUse, consentReference: `PRIVATE_SYNTHETIC_REFERENCE_${randomUUID()}`, grantedAt: new Date(Date.now() - 2000).toISOString(), expiresAt }; }
async function add(f: Fixture, input = consentInput()): Promise<ResearchParticipant> { const { saved } = await command(f, { kind: "add_participant", participant: { pseudonym: `PRIVATE_SYNTHETIC_PSEUDONYM_${randomUUID()}`, experience: "novice", consent: input }, acknowledgedConsentRecord: true, acknowledgedSampleIsFictional: f.detail.study.mode === "sample" }); return f.detail.participants.find(p => p.id === saved.participantId)!; }
function beginBody(f: Fixture, p: ResearchParticipant, { taskId = f.detail.protocol.tasks[0]!.id, retryOf = null }: { taskId?: string; retryOf?: string | null } = {}) { return ResearchCommandSchema.parse({ kind: "begin_task", requestId: randomUUID(), ...expected(f.detail), participantId: p.id, consentId: p.currentConsent!.id, consentHash: p.currentConsent!.hash, protocolId: f.detail.protocol.id, protocolHash: f.detail.protocol.hash, taskId, retryOf, acknowledgedOperatorObservation: true }); }
async function begin(f: Fixture, p: ResearchParticipant, options: Parameters<typeof beginBody>[2] = {}) { const input = beginBody(f, p, options), saved = success(await http(f.cookie, "/api/research-notebook", input)) as ResearchCommandResult; await refresh(f); return f.detail.attempts.find(a => a.id === saved.attemptId)!; }
async function outcome(f: Fixture, attemptId: string, value: "success" | "failure" | "unknown" | "abandoned" = "failure") { const original = f.detail.attempts.find(a => a.id === attemptId)!; return command(f, { kind: "record_outcome", attemptId, consentId: original.consentId, consentHash: original.consentHash, result: { outcome: value, assistance: "none", comprehension: "uncertain", observedNote: `PRIVATE_SYNTHETIC_OBSERVATION_${randomUUID()}`, response: `PRIVATE_SYNTHETIC_RESPONSE_${randomUUID()}` }, acknowledgedOperatorObservation: true }); }
async function amend(f: Fixture, p: ResearchParticipant, input: ResearchConsentInput) { const current = f.detail.participants.find(v => v.id === p.id)!; return command(f, { kind: "amend_consent", participantId: p.id, consentId: current.currentConsent!.id, consentHash: current.currentConsent!.hash, consent: input, reason: "Synthetic fresh declaration; no real participant event.", acknowledgedConsentRecord: true }); }
async function withdraw(f: Fixture, p: ResearchParticipant) { const current = f.detail.participants.find(v => v.id === p.id)!; return command(f, { kind: "withdraw_participant", participantId: p.id, consentId: current.currentConsent!.id, consentHash: current.currentConsent!.hash, reason: "Synthetic withdrawal control; no real participant event.", acknowledgedRetainedFingerprints: true }); }
const rowCount = async (table: string, f: Fixture) => Number((await database().query(`SELECT count(*) AS count FROM ${table} WHERE tenant_id=$1 AND study_id=$2`, [f.session.id, f.detail.study.id])).rows[0].count);
async function waitUntil(predicate: () => Promise<boolean>, message: string, milliseconds = 2000) { const deadline = Date.now() + milliseconds; while (Date.now() < deadline) { if (await predicate()) return; await delay(15); } assert.fail(message); }
async function lockOwner(f: Fixture) { const client = await database().connect(); await client.query("BEGIN"); const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid); await client.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [f.session.id]); return { client, pid }; }
async function waitBlocked(pid: number, count = 1) { await waitUntil(async () => Number((await database().query("WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE usename=current_user AND $1::integer=ANY(pg_blocking_pids(pid)) UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked prior ON prior.pid=ANY(pg_blocking_pids(activity.pid)) WHERE activity.usename=current_user) SELECT count(DISTINCT pid) AS count FROM blocked", [pid])).rows[0].count) >= count, "The research request must actually wait on the owned PostgreSQL authority lock."); }
async function readExport(f: Fixture, view: "private" | "redacted", format: "json" | "csv" = "json", protocolId = f.detail.protocol.id) { const response = await fetch(`${base}/api/research-notebook/export?${new URLSearchParams({ studyId: f.detail.study.id, protocolId, view, format })}`, { signal: AbortSignal.timeout(15_000), headers: { Cookie: f.cookie } }); const text = await response.text(); assert.equal(response.status, 200, "Current export authority is required."); assert.match(response.headers.get("cache-control") ?? "", /no-store/); assert.match(response.headers.get("content-disposition") ?? "", /attachment/); return { response, text, data: format === "json" ? JSON.parse(text) : null }; }
function assertNoPrivateFields(value: unknown) { if (!value || typeof value !== "object") return; for (const [key, nested] of Object.entries(value)) { assert.ok(!["pseudonym", "observedNote", "response", "consentReference"].includes(key), `Redacted aggregate must omit private field ${key}.`); assertNoPrivateFields(nested); } }

test("independent HTTP create is exact, owner-scoped, strict and idempotent under concurrent replay", async () => {
  const f = await fixture("concurrent original create"), bodies = await Promise.all([http(f.cookie, "/api/research-notebook", f.create), http(f.cookie, "/api/research-notebook", f.create)]); assert.ok(bodies.every(value => value.response.status === 200)); assert.ok(bodies.every(value => value.data.studyId === f.detail.study.id)); assert.equal(await rowCount("wk_research_protocols", f), 1);
  const collision = await http(f.cookie, "/api/research-notebook", { ...f.create, title: "Synthetic changed body under an original UUID" }); assert.equal(collision.response.status, 409);
  const forged = await http(f.cookie, "/api/research-notebook", { ...f.create, requestId: randomUUID(), independentlyVerifiedParticipants: 9 }); assert.equal(forged.response.status, 400);
  assert.equal((await http(f.cookie, "/api/research-notebook", { ...f.create, requestId: randomUUID() }, { Origin: "https://foreign.invalid" })).response.status, 403);
  const other = await fixture("foreign owner boundary"); assert.equal((await http(other.cookie, `/api/research-notebook?studyId=${f.detail.study.id}`)).response.status, 404); assert.equal((await http("", "/api/research-notebook")).response.status, 401);
  await assert.rejects(researchNotebookHome({ tenantId: f.session.id, actorId: other.session.id }, f.detail.study.id));
});
test("a real lost create answer recovers the original UUID without a replacement study", async () => {
  const f = await fixture("lost create answer"), original = { ...f.create, requestId: randomUUID(), title: "Synthetic retained unknown create" }; await assert.rejects(http(f.cookie, "/api/research-notebook", original, { "x-research-qa-drop-answer": "after-commit" })); const recovered = success(await http(f.cookie, "/api/research-notebook", original)); const again = success(await http(f.cookie, "/api/research-notebook", original)); assert.equal(recovered.studyId, again.studyId); assert.notEqual(recovered.studyId, f.detail.study.id); assert.equal(Number((await database().query("SELECT count(*) AS count FROM wk_research_commands WHERE tenant_id=$1 AND request_id=$2", [f.session.id, original.requestId])).rows[0].count), 1);
});
test("simultaneous exact task starts and outcomes each retain one original identity; a running participant cannot overlap", async () => {
  const f = await fixture("concurrent original intervals"), p = await add(f), input = beginBody(f, p), starts = await Promise.all([http(f.cookie, "/api/research-notebook", input), http(f.cookie, "/api/research-notebook", input)]); assert.ok(starts.every(value => value.response.status === 200)); assert.equal(starts[0]!.data.attemptId, starts[1]!.data.attemptId); await refresh(f); assert.equal(f.detail.attempts.length, 1); const original = f.detail.attempts[0]!;
  const overlapping = beginBody(f, f.detail.participants[0]!, { taskId: f.detail.protocol.tasks[1]!.id }); assert.ok([403, 409, 422].includes((await http(f.cookie, "/api/research-notebook", overlapping)).response.status)); assert.equal(await rowCount("wk_research_attempts", f), 1);
  const finish = ResearchCommandSchema.parse({ kind: "record_outcome", requestId: randomUUID(), ...expected(f.detail), attemptId: original.id, consentId: original.consentId, consentHash: original.consentHash, result: { outcome: "failure", assistance: "none", comprehension: "uncertain", observedNote: "Synthetic first failure retained", response: "No real person was observed" }, acknowledgedOperatorObservation: true }); const endings = await Promise.all([http(f.cookie, "/api/research-notebook", finish), http(f.cookie, "/api/research-notebook", finish)]); assert.ok(endings.every(value => value.response.status === 200)); assert.equal(await rowCount("wk_research_outcomes", f), 1); await refresh(f); assert.equal(f.detail.attempts[0]!.completionKind, "operator_observation"); assert.equal(f.detail.summary.counts.failure, 1); assert.equal(f.detail.summary.counts.denominator, 1);
});
test("a first failure survives retry success; protocol revisions never rewrite or pool its cohort", async () => {
  const f = await fixture("first failure and protocol cohorts"), p = await add(f), first = await begin(f, p); await outcome(f, first.id, "failure"); const firstHash = f.detail.attempts[0]!.hash, oldProtocol = structuredClone(f.detail.protocol), retry = await begin(f, f.detail.participants[0]!, { retryOf: first.id }); await outcome(f, retry.id, "success"); assert.equal(f.detail.summary.counts.success, 0); assert.equal(f.detail.summary.counts.failure, 1); assert.equal(f.detail.summary.counts.denominator, 1); assert.equal(f.detail.summary.allAttempts.retries, 1); const third = await begin(f, f.detail.participants[0]!, { retryOf: first.id }); await outcome(f, third.id, "success"); assert.equal(f.detail.summary.counts.failure, 1); assert.equal(f.detail.summary.counts.success, 0); assert.equal(f.detail.summary.allAttempts.retries, 2);
  await command(f, { kind: "revise_protocol", tasks: oldProtocol.tasks.map((task, i) => i === 0 ? { ...task, successCriteria: "Synthetic amended criterion declared before the next attempt." } : task), reason: "Synthetic distinct protocol cohort; original criterion retained." }); const nextProtocol = structuredClone(f.detail.protocol), next = await begin(f, f.detail.participants[0]!); await outcome(f, next.id, "success"); assert.equal(f.detail.summary.counts.success, 1); assert.equal(f.detail.summary.counts.failure, 0); assert.equal(f.detail.summary.counts.denominator, 1); assert.equal(f.detail.attempts.find(a => a.id === first.id)!.hash, firstHash); assert.deepEqual(f.detail.attempts.find(a => a.id === first.id)!.task, first.task);
  const history = await researchNotebookHome(f.access, f.detail.study.id, oldProtocol.id); assert.equal(history.selected!.historical, true); assert.equal(history.selected!.summary.counts.failure, 1); assert.equal(history.selected!.summary.counts.success, 0); assert.equal(history.selected!.protocol.hash, oldProtocol.hash); assert.ok(history.selected!.summary.cohorts.some(c => c.protocolId === oldProtocol.id && c.counts.failure === 1)); assert.ok(history.selected!.summary.cohorts.some(c => c.protocolId === nextProtocol.id && c.counts.success === 1));
});
test("a newer current consent can finish the still-live original scope but cannot expand its public permission", async () => {
  const f = await fixture("original scope non expansion"), p = await add(f, consentInput({ publicUse: false })), original = await begin(f, p), originalConsent = original.consentHash; await amend(f, p, consentInput({ publicUse: true })); await outcome(f, original.id, "success"); const saved = f.detail.attempts.find(a => a.id === original.id)!; assert.equal(saved.consentHash, originalConsent); assert.equal(saved.eligibleForPrivateSummary, true); assert.equal(saved.eligibleForPublicSummary, false); assert.equal(f.detail.summary.counts.success, 1); const aggregate = await readExport(f, "redacted"); assertNoPrivateFields(aggregate.data); assert.ok(!aggregate.text.includes(original.id), "A later public opt-in cannot expose an earlier non-public attempt.");
  const privateCopy = await readExport(f, "private"); assert.ok(privateCopy.text.includes(original.id)); await amend(f, f.detail.participants[0]!, consentInput({ publicUse: false, privateUse: false })); assert.equal(f.detail.attempts[0]!.eligibleForPrivateSummary, false); assert.equal(f.detail.attempts[0]!.result?.observedNote, null); const hidden = await readExport(f, "private"); assert.ok(!hidden.text.includes("PRIVATE_SYNTHETIC_OBSERVATION_"));
});
test("a task-start replay is refused after current consent withdrawal; history fingerprints remain private and unchanged", async () => {
  const f = await fixture("withdrawal replay boundary"), p = await add(f), input = beginBody(f, p), saved = success(await http(f.cookie, "/api/research-notebook", input)); await refresh(f); const originalId = saved.attemptId; await withdraw(f, p); const replay = await http(f.cookie, "/api/research-notebook", input); assert.ok([403, 409, 422].includes(replay.response.status)); assert.equal(await rowCount("wk_research_attempts", f), 1); assert.equal(f.detail.attempts[0]!.id, originalId); assert.equal(f.detail.participants[0]!.pseudonym, null); assert.equal(f.detail.attempts[0]!.eligibleForPrivateSummary, false);
  const copied = await readExport(f, "private"); assert.ok(!copied.text.includes("PRIVATE_SYNTHETIC_PSEUDONYM_")); assert.ok(!copied.text.includes("PRIVATE_SYNTHETIC_REFERENCE_")); const before = await rowCount("wk_research_outcomes", f); await command(f, { kind: "close_unreported_attempt", attemptId: originalId, acknowledgedNoTaskOutcome: true }); const closed = f.detail.attempts[0]!; assert.equal(await rowCount("wk_research_outcomes", f), before + 1); assert.equal(closed.completionKind, "administrative_no_outcome"); assert.equal(closed.result?.observedNote, null); assert.equal(closed.result?.response, null); assert.equal(closed.eligibleForPrivateSummary, false); assert.equal(f.detail.summary.counts.denominator, 0); assert.equal(f.detail.summary.counts.unknown, 0); assert.equal(f.detail.summary.counts.excluded, 1); await command(f, { kind: "seal", reason: "Synthetic no-outcome closure retained and excluded.", acknowledgedReportedEvidence: true });
});
test("every unfinished interval blocks overlap after its original consent expires; administrative close never renews the original scope", async () => {
  const f = await fixture("expired original interval"), expiry = until(2200), p = await add(f, consentInput({ expiresAt: expiry })), first = await begin(f, p); await delay(Math.max(0, Date.parse(expiry) - Date.now()) + 35); await refresh(f); await amend(f, p, consentInput({ publicUse: true })); const current = f.detail.participants[0]!; assert.equal(current.runningAttemptId, first.id, "Every unfinished interval remains bound even when its original consent ended."); const second = beginBody(f, current, { taskId: f.detail.protocol.tasks[1]!.id }); assert.ok([403, 409, 422].includes((await http(f.cookie, "/api/research-notebook", second)).response.status));
  const refused = await http(f.cookie, "/api/research-notebook", { kind: "record_outcome", requestId: randomUUID(), ...expected(f.detail), attemptId: first.id, consentId: first.consentId, consentHash: first.consentHash, result: { outcome: "success", assistance: "none", comprehension: "correct", observedNote: "Synthetic forbidden success after original permission ended", response: "" }, acknowledgedOperatorObservation: true }); assert.equal(refused.response.status, 403); await command(f, { kind: "close_unreported_attempt", attemptId: first.id, acknowledgedNoTaskOutcome: true }); assert.equal(f.detail.attempts[0]!.completionKind, "administrative_no_outcome"); assert.equal(f.detail.attempts[0]!.eligibleForPublicSummary, false); assert.equal(f.detail.summary.counts.denominator, 0); assert.equal(f.detail.summary.counts.excluded, 1); const retry = await begin(f, f.detail.participants[0]!, { retryOf: first.id }); await outcome(f, retry.id, "success"); assert.equal(f.detail.summary.counts.success, 0, "A retry cannot replace an excluded original first attempt."); assert.equal(f.detail.summary.counts.denominator, 0); assert.equal(f.detail.summary.allAttempts.retries, 1);
});
test("a real PostgreSQL authority lock cannot let an expired original consent record a late outcome", async () => {
  const f = await fixture("consent expiry under lock"), expiry = until(1800), p = await add(f, consentInput({ expiresAt: expiry })), original = await begin(f, p), lock = await lockOwner(f);
  const input = { kind: "record_outcome", requestId: randomUUID(), ...expected(f.detail), attemptId: original.id, consentId: original.consentId, consentHash: original.consentHash, result: { outcome: "success", assistance: "none", comprehension: "correct", observedNote: "Synthetic outcome must not cross its original expiry", response: "" }, acknowledgedOperatorObservation: true };
  try { const waiting = http(f.cookie, "/api/research-notebook", input); await waitBlocked(lock.pid); await delay(Math.max(0, Date.parse(expiry) - Date.now()) + 50); await lock.client.query("COMMIT"); const refused = await waiting; assert.equal(refused.response.status, 403); assert.equal(await rowCount("wk_research_outcomes", f), 0); }
  finally { await lock.client.query("ROLLBACK"); lock.client.release(); }
});
test("a workspace expiry reached while waiting on its real authority lock is never extended or replayed", async () => {
  const f = await fixture("workspace expiry under lock", { ttlMs: 1800 }), p = await add(f), input = beginBody(f, p), lock = await lockOwner(f);
  try { const waiting = http(f.cookie, "/api/research-notebook", input); await waitBlocked(lock.pid); await delay(Math.max(0, Date.parse(f.originalExpiry) - Date.now()) + 50); await lock.client.query("COMMIT"); const refused = await waiting; assert.ok([401, 403].includes(refused.response.status)); assert.equal(await rowCount("wk_research_attempts", f), 0); assert.equal((await http(f.cookie, "/api/research-notebook", input)).response.status, 401); assert.equal(new Date((await database().query("SELECT expires_at FROM wk_sessions WHERE id=$1", [f.session.id])).rows[0].expires_at).toISOString(), f.originalExpiry); }
  finally { await lock.client.query("ROLLBACK"); lock.client.release(); }
});
test("withdrawal that wins the authority lock defeats a concurrently prepared stale task start", async () => {
  const f = await fixture("withdrawal versus start race"), p = await add(f), start = beginBody(f, p), remove = { kind: "withdraw_participant", requestId: randomUUID(), ...expected(f.detail), participantId: p.id, consentId: p.currentConsent!.id, consentHash: p.currentConsent!.hash, reason: "Synthetic withdrawal is queued before any new task start.", acknowledgedRetainedFingerprints: true }, lock = await lockOwner(f);
  try { const withdrawal = http(f.cookie, "/api/research-notebook", remove); await waitBlocked(lock.pid); const startLater = http(f.cookie, "/api/research-notebook", start); await waitBlocked(lock.pid, 2); await lock.client.query("COMMIT"); assert.equal((await withdrawal).response.status, 200); assert.ok([403, 409, 422].includes((await startLater).response.status)); await refresh(f); assert.equal(f.detail.participants[0]!.availability, "withdrawn"); assert.equal(await rowCount("wk_research_attempts", f), 0); }
  finally { await lock.client.query("ROLLBACK"); lock.client.release(); }
});
test("actual source changes retain exact start/outcome identities without rewriting the study baseline", async () => {
  const f = await fixture("repair source variation"), p = await add(f), baseline = structuredClone(f.detail.study.binding), original = await begin(f, p), before = await getRevision(f.session.id), connection = before.kit.connections[0]!; assert.ok(connection); const changed = await commitEdit(f.session, before.kit.id, before.certificate.graphHash, { kind: "connection", connectionId: connection.id, enabled: !connection.enabled }); descriptors.find(value => value.tenantId === f.session.id)!.expectedCurrentRevisionId = changed.kit.id; await refresh(f); assert.equal(f.detail.currentSource.matchesStudyBinding, false); assert.equal(f.detail.currentSource.revisionId, changed.kit.id); assert.equal(f.detail.study.binding.graphHash, baseline.graphHash); await outcome(f, original.id, "failure"); const saved = f.detail.attempts.find(value => value.id === original.id)!; assert.equal(saved.startSource.revisionId, baseline.revisionId); assert.equal(saved.outcomeSource!.revisionId, changed.kit.id); assert.equal(f.detail.summary.variedSystemAttempts, 1); assert.deepEqual(f.detail.study.binding, baseline); const second = await begin(f, f.detail.participants[0]!, { taskId: f.detail.protocol.tasks[1]!.id }); assert.equal(second.startSource.revisionId, changed.kit.id);
});
test("administrative closure refuses live consent, arbitrary participant text and an invented result", async () => {
  const f = await fixture("administrative no authority expansion"), p = await add(f), original = await begin(f, p), close = { kind: "close_unreported_attempt", requestId: randomUUID(), ...expected(f.detail), attemptId: original.id, acknowledgedNoTaskOutcome: true }; assert.ok([403, 409, 422].includes((await http(f.cookie, "/api/research-notebook", close)).response.status)); assert.equal((await http(f.cookie, "/api/research-notebook", { ...close, requestId: randomUUID(), observedNote: "Synthetic injected finding" })).response.status, 400); assert.equal((await http(f.cookie, "/api/research-notebook", { ...close, requestId: randomUUID(), result: { outcome: "success" } })).response.status, 400); assert.equal(await rowCount("wk_research_outcomes", f), 0);
});
test("append-only SQL guards and sealed private payloads preserve failed observations and private references", async () => {
  const f = await fixture("private immutable failed evidence", { mode: "operator_recorded" }), p = await add(f), original = await begin(f, p); await outcome(f, original.id, "failure"); for (const table of ["wk_research_participants", "wk_research_consents", "wk_research_commands", "wk_research_revisions", "wk_research_events", "wk_research_outcomes"]) { const rows = await database().query(`SELECT to_jsonb(item)::text AS body FROM ${table} item WHERE tenant_id=$1`, [f.session.id]); assert.ok(rows.rows.every(row => !/PRIVATE_SYNTHETIC_(PSEUDONYM|REFERENCE|OBSERVATION|RESPONSE)_/.test(row.body)), `${table} must not retain participant free text in plaintext.`); }
  for (const table of ["wk_research_protocols", "wk_research_consents", "wk_research_attempts", "wk_research_outcomes", "wk_research_revisions", "wk_research_commands", "wk_research_events"]) { const client = await database().connect(); await client.query("BEGIN"); try { await assert.rejects(client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [f.session.id]), /append-only|retained/i); } finally { await client.query("ROLLBACK"); client.release(); } }
  assert.equal(f.detail.summary.sampleParticipants, 0); assert.equal(f.detail.summary.operatorReportedParticipants, 1); assert.equal(f.detail.summary.independentlyVerifiedParticipants, 0); assert.equal(f.detail.summary.counts.failure, 1); const aggregate = await readExport(f, "redacted"); assertNoPrivateFields(aggregate.data); const csv = await readExport(f, "redacted", "csv"); assert.ok(!/pseudonym|observedNote|consentReference|PRIVATE_SYNTHETIC_/i.test(csv.text));
});

test("valid offset timestamps retain the original consent instants after PostgreSQL UTC normalization", async () => {
  const f = await fixture("equivalent offset consent"), input = consentInput({ expiresAt: until(60_000) });
  const offset = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().replace("Z", "+05:30"); input.grantedAt = offset(input.grantedAt); input.expiresAt = offset(input.expiresAt!); const p = await add(f, input); assert.equal(Date.parse(p.currentConsent!.grantedAt), Date.parse(input.grantedAt)); assert.equal(Date.parse(p.currentConsent!.expiresAt!), Date.parse(input.expiresAt)); const original = await begin(f, p); await outcome(f, original.id, "unknown"); assert.equal(f.detail.attempts[0]!.eligibleForPrivateSummary, true); assert.equal(f.detail.summary.counts.denominator, 0); assert.equal(f.detail.summary.counts.unknown, 1);
});
test("an archived actual domain source holds new starts and retains a missing-source unknown original outcome", async () => {
  const f = await fixture("missing archived domain source", { domain: true }), p = await add(f), original = await begin(f, p), baseline = structuredClone(f.detail.study.binding), domain = (await domainHome(f.session, baseline.subjectId)).selected!;
  await domainCommand(f.session, { kind: "archive", requestId: randomUUID(), projectId: domain.project.id, expectedEditionId: domain.edition.id, expectedVersion: domain.project.version, expectedGraphHash: domain.edition.certificate.graphHash }); descriptors.find(value => value.tenantId === f.session.id)!.domain!.expectedArchived = true; await refresh(f); assert.equal(f.detail.currentSource.availability, "missing"); assert.deepEqual(f.detail.study.binding, baseline);
  const invalid = await http(f.cookie, "/api/research-notebook", { kind: "record_outcome", requestId: randomUUID(), ...expected(f.detail), attemptId: original.id, consentId: original.consentId, consentHash: original.consentHash, result: { outcome: "success", assistance: "none", comprehension: "correct", observedNote: "Synthetic source is missing; success must be refused", response: "" }, acknowledgedOperatorObservation: true }); assert.equal(invalid.response.status, 422); assert.equal(await rowCount("wk_research_outcomes", f), 0); await outcome(f, original.id, "unknown"); assert.equal(f.detail.attempts[0]!.outcomeSource!.availability, "missing"); assert.equal(f.detail.attempts[0]!.startSource.availability, "available"); assert.equal(f.detail.summary.missingSourceAttempts, 1); assert.equal((await http(f.cookie, "/api/research-notebook", beginBody(f, f.detail.participants[0]!, { taskId: f.detail.protocol.tasks[1]!.id }))).response.status, 422);
});
test("the bounded HTTP reader accepts the valid declared twenty-task protocol rather than an impossible form", async () => {
  const f = await fixture("maximum valid protocol payload"), input = { ...f.create, requestId: randomUUID(), title: "Sample only · ".padEnd(120, "観"), objective: "Software control; no people observed. ".padEnd(2000, "観"), tasks: Array.from({ length: 20 }, (_, index) => ({ id: `synthetic_max_${index}_`.padEnd(80, "x"), title: `Sample task ${index} · `.padEnd(120, "観"), instruction: "観".repeat(2000), successCriteria: "証".repeat(2000) })) }; ResearchCommandSchema.parse(input); assert.ok(Buffer.byteLength(JSON.stringify(input)) > 240_000); assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 262_144, "The fully valid multi-byte contract fits the bounded256KiB reader"); const saved = success(await http(f.cookie, "/api/research-notebook", input)); const copy = success(await http(f.cookie, `/api/research-notebook?studyId=${saved.studyId}`)) as ResearchHome; assert.equal(copy.selected!.protocol.tasks.length, 20); assert.equal(copy.selected!.protocol.tasks[19]!.successCriteria.length, 2000);
});

test("real HTTP rejects invalid UTF-8, wrong media and oversized bytes before any research mutation", async () => {
  const f = await fixture("strict HTTP byte boundaries"), before = Number((await database().query("SELECT count(*) AS count FROM wk_research_commands WHERE tenant_id=$1", [f.session.id])).rows[0].count);
  const send = (bytes: Uint8Array, contentType = "application/json") => fetch(`${base}/api/research-notebook`, { method: "POST", signal: AbortSignal.timeout(15_000), headers: { Cookie: f.cookie, Origin: base, "Content-Type": contentType }, body: new Uint8Array(bytes) });
  const otherwiseValid = Buffer.from(JSON.stringify({ ...f.create, requestId: randomUUID(), title: "Synthetic invalid UTF8 marker" })); const marker = otherwiseValid.indexOf(Buffer.from("UTF8")); assert.ok(marker > 0); otherwiseValid[marker] = 0xff; const invalid = await send(otherwiseValid); assert.equal(invalid.status, 400, "Fatal UTF8 must reject a malformed byte inside an otherwise valid free-text field before a study is created"); await invalid.arrayBuffer();
  const wrongMedia = await send(new TextEncoder().encode("{}"), "text/plain"); assert.equal(wrongMedia.status, 415); await wrongMedia.arrayBuffer();
  const tooLarge = await send(new Uint8Array(262_145).fill(0x20)); assert.equal(tooLarge.status, 413); await tooLarge.arrayBuffer();
  assert.equal(Number((await database().query("SELECT count(*) AS count FROM wk_research_commands WHERE tenant_id=$1", [f.session.id])).rows[0].count), before);
});

test("a lost no-text administrative close stays permanently unscored after a later private re-consent", async () => {
  const f = await fixture("administrative scope never resurrects"), p = await add(f), first = await begin(f, p); await amend(f, p, consentInput({ privateUse: false })); const input = ResearchCommandSchema.parse({ kind: "close_unreported_attempt", requestId: randomUUID(), ...expected(f.detail), attemptId: first.id, acknowledgedNoTaskOutcome: true });
  await assert.rejects(http(f.cookie, "/api/research-notebook", input, { "x-research-qa-drop-answer": "after-commit" })); const recovered = success(await http(f.cookie, "/api/research-notebook", input)); assert.equal(recovered.attemptId, first.id); await refresh(f); assert.equal(await rowCount("wk_research_outcomes", f), 1); const closedHash = f.detail.attempts[0]!.hash; await amend(f, f.detail.participants[0]!, consentInput({ privateUse: true, publicUse: true }));
  const closed = f.detail.attempts.find(value => value.id === first.id)!; assert.equal(closed.completionKind, "administrative_no_outcome"); assert.equal(closed.hash, closedHash); assert.equal(closed.eligibleForPrivateSummary, false); assert.equal(closed.eligibleForPublicSummary, false); assert.equal(closed.result?.observedNote, null); assert.equal(f.detail.summary.counts.unknown, 0); assert.equal(f.detail.summary.counts.excluded, 1); assert.equal(f.detail.summary.counts.denominator, 0); const retry = await begin(f, f.detail.participants[0]!, { retryOf: first.id }); await outcome(f, retry.id, "success"); assert.equal(f.detail.summary.counts.success, 0); assert.equal(f.detail.summary.counts.denominator, 0);
});

test("chunked request bytes cancel the actual bounded reader without a content-length or eager full buffer", async () => {
  let pulled = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(65_536).fill(0x20)); }, cancel() { cancelled = true; } });
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" };
  const request = new Request(`${base}/api/research-notebook`, init); assert.equal(request.headers.get("content-length"), null);
  await assert.rejects(readResearchJson(request), error => error instanceof WorldKitError && error.status === 413);
  assert.equal(cancelled, true, "The actual Request reader cancels its source once measured bytes cross256KiB."); assert.ok(pulled <= 6, "At most one source prefetch may follow the five measured64KiB chunks; no unbounded body is read.");
});

test("read-time-expiry: a home GET waiting on its exact domain binding must redact consent that expires before return", async () => {
  const directory = ".local/research-notebook-unit/adversarial/read-time-expiry"; await mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshots = await Promise.all(["src/server/research-notebook.ts", "src/server/research-notebook-records.ts"].map(async path => {
    const content = await readFile(path, "utf8"), file = `${directory}/${runId}.${path.split("/").at(-1)}.source.txt`;
    await writeFile(file, content, { mode: 0o600 }); return { path, file, sha256: createHash("sha256").update(content).digest("hex") };
  }));
  const f = await fixture("read-time consent expiry after source wait", { domain: true }), expiry = until(3500), input = consentInput({ publicUse: true, expiresAt: expiry }), p = await add(f, input), original = await begin(f, p);
  await outcome(f, original.id, "success");
  assert.equal(f.detail.participants[0]!.availability, "current"); assert.equal(f.detail.attempts[0]!.eligibleForPrivateSummary, true); assert.equal(f.detail.attempts[0]!.eligibleForPublicSummary, true); assert.equal(f.detail.summary.counts.success, 1);
  const baselineConsentId = f.detail.participants[0]!.currentConsent!.id, projectId = f.detail.study.binding.subjectId, lock = await database().connect();
  let waiting: Promise<HttpResult> | undefined, released = false, blockedPid = 0, blockedAt = "";
  await lock.query("BEGIN"); const lockerPid = Number((await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  await lock.query("SELECT id FROM wk_domain_projects WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [projectId, f.session.id]);
  try {
    const issuedAt = new Date().toISOString(); waiting = http(f.cookie, `/api/research-notebook?studyId=${f.detail.study.id}`);
    await waitUntil(async () => {
      const rows = (await database().query("SELECT pid,query,wait_event_type FROM pg_stat_activity WHERE usename=current_user AND $1::integer=ANY(pg_blocking_pids(pid))", [lockerPid])).rows;
      const row = rows.find(value => value.wait_event_type === "Lock" && /wk_domain_editions/.test(value.query) && /FOR SHARE OF p/i.test(value.query));
      if (row) { blockedPid = Number(row.pid); blockedAt = new Date().toISOString(); return true; } return false;
    }, "The GET must actually wait on the exact domain binding FOR SHARE query, not a mocked delay.", 1500);
    assert.ok(Date.parse(blockedAt) < Date.parse(expiry), "The source wait must begin while the original consent is still live.");
    await delay(Math.max(0, Date.parse(expiry) - Date.now()) + 50);
    await lock.query("COMMIT"); released = true;
    const value = success(await waiting) as ResearchHome, returnedAt = new Date().toISOString(), selected = value.selected!, participant = selected.participants.find(person => person.id === p.id)!, attempt = selected.attempts.find(item => item.id === original.id)!;
    assert.ok(Date.parse(value.serverTime) >= Date.parse(expiry), "The actual response is assembled after the original consent expiry.");
    const projection = {
      availability: participant.availability, pseudonymWithheld: participant.pseudonym === null, consentReferencesWithheld: participant.consents.every(consent => consent.consentReference === null), noteWithheld: attempt.result?.observedNote === null, responseWithheld: attempt.result?.response === null,
      participantPrivateEligible: participant.eligibleForPrivateSummary, participantPublicEligible: participant.eligibleForPublicSummary, attemptPrivateEligible: attempt.eligibleForPrivateSummary, attemptPublicEligible: attempt.eligibleForPublicSummary,
      eligibleParticipants: selected.summary.eligibleParticipants, publicAggregateEligibleParticipants: selected.summary.publicAggregateEligibleParticipants, sampleParticipants: selected.summary.sampleParticipants,
      success: selected.summary.counts.success, denominator: selected.summary.counts.denominator, excluded: selected.summary.counts.excluded,
      cohortDenominatorsZero: selected.summary.cohorts.every(cohort => cohort.counts.denominator === 0), cohortEligibleParticipantsZero: selected.summary.cohorts.every(cohort => cohort.eligibleParticipants === 0),
    };
    const expectedProjection = { availability: "consent_expired", pseudonymWithheld: true, consentReferencesWithheld: true, noteWithheld: true, responseWithheld: true, participantPrivateEligible: false, participantPublicEligible: false, attemptPrivateEligible: false, attemptPublicEligible: false, eligibleParticipants: 0, publicAggregateEligibleParticipants: 0, sampleParticipants: 0, success: 0, denominator: 0, excluded: 1, cohortDenominatorsZero: true, cohortEligibleParticipantsZero: true };
    await writeFile(`${directory}/${runId}.private.json`, JSON.stringify({ kind: "synthetic_actual_http_pg_source_lock_read_time_expiry", at: returnedAt, runId, tenantId: f.session.id, studyId: f.detail.study.id, projectId, participantId: p.id, attemptId: original.id, consentId: baselineConsentId, originalConsentExpiry: expiry, originalSessionExpiry: f.originalExpiry, issuedAt, blockedAt, returnedAt, serverTime: value.serverTime, lockerPid, blockedPid, observedWait: "actual domain binding FOR SHARE OF p", snapshots, projection, expectedProjection, returned: value, actualPeople: 0, actualConsentEvents: 0, originalExpiryModified: false }, null, 2), { mode: 0o600 });
    assert.deepEqual(projection, expectedProjection, "Private data and counts must use current consent after every awaited source wait.");
    assert.equal(participant.currentConsent!.id, baselineConsentId); assert.equal(participant.currentConsent!.expiresAt, expiry); assert.equal(await rowCount("wk_research_outcomes", f), 1);
  } finally {
    if (!released) await lock.query("ROLLBACK"); lock.release();
    if (waiting) await waiting.catch(() => undefined);
  }
});
