import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSession, type Session } from "../src/server/repository";
import { closeDatabase, database } from "../src/server/db";
import { cancelJob, claimJob, completeJob, deferJob, enqueueJob, getJob } from "../src/server/jobs";
import { SourceModelStore, recoverSourceModels } from "../src/server/source-models";
import { deleteSourceJob, recoverSourceIntents } from "../src/server/source-evidence";
import { backgroundStep, ModelPending, type BackgroundGateway, type BackgroundObservation } from "../packages/spec-evidence/providers";

const sessions: string[] = [];
async function workspace(): Promise<Session> { const { session } = await createSession(); sessions.push(session.id); return session; }
async function jobFor(session: Session) { return enqueueJob(session, "source_extract", { synthetic: "Persistence test; never dispatch through the real executor" }, randomUUID(), "Synthetic source job test"); }
const request = { model: "synthetic-test-model", background: true, store: false, input: "Synthetic transport test, no external call" };
const observed = (id: string, status: string, text = ""): BackgroundObservation => ({ id, model: request.model, status, output: text ? [{ type: "message", content: [{ type: "output_text", text }] }] : [] });
function fakeGateway(id: string) {
  let creates = 0, polls = 0, cancels = 0;
  const gateway: BackgroundGateway = { create: async () => { creates++; return observed(id, "queued"); }, retrieve: async () => { polls++; return observed(id, "in_progress"); }, cancel: async () => { cancels++; return observed(id, "cancelled"); } };
  return { gateway, counts: () => ({ creates, polls, cancels }) };
}
async function due(id: string) {
  await database().query("UPDATE wk_jobs SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [id]);
  await database().query("UPDATE wk_source_model_requests SET payload=jsonb_set(payload,'{pollAfter}','null'::jsonb) WHERE job_id=$1", [id]);
}
after(async () => {
  await database().query("UPDATE wk_jobs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=ANY($1::text[]) AND status IN ('queued','running','retry_wait')", [sessions]);
  await database().query("UPDATE wk_source_model_requests SET phase='failed',payload=jsonb_set(payload,'{phase}','\"failed\"'::jsonb) WHERE tenant_id=ANY($1::text[])", [sessions]);
  await closeDatabase();
});

test("twelve durable continuations retain one provider request and one usage reservation", async () => {
  const session = await workspace(); const queued = await jobFor(session); const fake = fakeGateway(`resp_synthetic_${randomUUID()}`);
  for (let cycle = 0; cycle < 12; cycle++) {
    await due(queued.id); const job = (await claimJob({ tenantId: session.id, id: queued.id }))!; assert.ok(job);
    try { await backgroundStep(job.id, request, new SourceModelStore(job, "openai"), fake.gateway); assert.fail("Expected a saved pending response"); }
    catch (error) { assert.ok(error instanceof ModelPending); assert.equal(await deferJob(job, error), true); }
    if (cycle === 3) await closeDatabase();
  }
  const pending = await getJob(session.id, queued.id); assert.equal(pending.status, "retry_wait"); assert.equal(pending.continuations, 12); assert.equal(pending.attempts, 0); assert.equal(pending.maxAttempts, 3);
  await due(queued.id); const final = (await claimJob({ tenantId: session.id, id: queued.id }))!;
  fake.gateway.retrieve = async id => observed(id, "completed", '{"synthetic":true}');
  const checkpoint = await backgroundStep(final.id, request, new SourceModelStore(final, "openai"), fake.gateway);
  assert.equal(checkpoint.phase, "received"); await completeJob(final, { output: { synthetic: true, responseId: checkpoint.responseId } });
  assert.equal(fake.counts().creates, 1); assert.equal((await getJob(session.id, queued.id)).attempts, 1);
  const usage = await database().query("SELECT live_rebuilds FROM wk_sessions WHERE id=$1", [session.id]); assert.equal(usage.rows[0].live_rebuilds, 1);
  const attempts = await database().query("SELECT status FROM wk_job_attempts WHERE job_id=$1", [queued.id]); assert.equal(attempts.rowCount, 13);
});
test("a cancelled lease cannot reserve a model or defer a task back into the queue", async () => {
  const session = await workspace(); const queued = await jobFor(session); const job = (await claimJob({ tenantId: session.id, id: queued.id }))!;
  await cancelJob(session.id, queued.id); const fake = fakeGateway(`resp_synthetic_${randomUUID()}`);
  await assert.rejects(() => backgroundStep(job.id, request, new SourceModelStore(job, "openai"), fake.gateway), /no longer authorized/);
  assert.equal(await deferJob(job, new ModelPending()), false); assert.equal(fake.counts().creates, 0); assert.equal((await getJob(session.id, queued.id)).status, "cancelled");
});
test("unsettled provider requests retain concurrency slots between worker leases", async () => {
  const session = await workspace(); const jobs = await Promise.all([jobFor(session), jobFor(session), jobFor(session)]); const gateways = jobs.map(() => fakeGateway(`resp_synthetic_${randomUUID()}`));
  for (let index = 0; index < 2; index++) {
    const job = (await claimJob({ tenantId: session.id, id: jobs[index]!.id }))!;
    await assert.rejects(() => backgroundStep(job.id, request, new SourceModelStore(job, "openai"), gateways[index]!.gateway), ModelPending); await deferJob(job, new ModelPending());
  }
  const third = (await claimJob({ tenantId: session.id, id: jobs[2]!.id }))!;
  await assert.rejects(() => backgroundStep(third.id, request, new SourceModelStore(third, "openai"), gateways[2]!.gateway), /analysis slot/);
  assert.equal(gateways[2]!.counts().creates, 0); await deferJob(third, new ModelPending());
  await cancelJob(session.id, jobs[0]!.id); assert.equal(await recoverSourceModels(session.id, gateways[0]!.gateway), 1); assert.equal(gateways[0]!.counts().cancels, 1);
  await due(third.id); const resumed = (await claimJob({ tenantId: session.id, id: third.id }))!;
  await assert.rejects(() => backgroundStep(resumed.id, request, new SourceModelStore(resumed, "openai"), gateways[2]!.gateway), ModelPending);
  assert.equal(gateways[2]!.counts().creates, 1); await deferJob(resumed, new ModelPending());
  for (const queued of jobs) await cancelJob(session.id, queued.id);
  await database().query("UPDATE wk_source_model_requests SET phase='failed' WHERE tenant_id=$1", [session.id]);
});
test("a saved model observation cannot cross tenants or change its request hash", async () => {
  const session = await workspace(); const foreign = await workspace(); const queued = await jobFor(session); const job = (await claimJob({ tenantId: session.id, id: queued.id }))!; const fake = fakeGateway(`resp_synthetic_${randomUUID()}`); const store = new SourceModelStore(job, "openai");
  await assert.rejects(() => backgroundStep(job.id, request, store, fake.gateway), ModelPending);
  const row = await database().query("SELECT payload FROM wk_source_model_requests WHERE job_id=$1", [job.id]);
  await assert.rejects(() => new SourceModelStore({ ...job, tenantId: foreign.id }, "openai").save(row.rows[0].payload), /does not belong/);
  await assert.rejects(() => store.save({ ...row.rows[0].payload, requestHash: "f".repeat(64) }), /does not belong/);
  await cancelJob(session.id, job.id); await recoverSourceModels(session.id, fake.gateway);
});
test("a late provider completion after cancellation is retained but never applied to the job", async () => {
  const session = await workspace(); const queued = await jobFor(session); const job = (await claimJob({ tenantId: session.id, id: queued.id }))!; const fake = fakeGateway(`resp_synthetic_${randomUUID()}`); const store = new SourceModelStore(job, "openai");
  await assert.rejects(() => backgroundStep(job.id, request, store, fake.gateway), ModelPending); await deferJob(job, new ModelPending()); await cancelJob(session.id, job.id);
  fake.gateway.retrieve = async id => observed(id, "completed", '{"late":true}');
  assert.equal(await recoverSourceModels(session.id, fake.gateway), 1); assert.equal(fake.counts().cancels, 0);
  const row = await database().query("SELECT payload FROM wk_source_model_requests WHERE job_id=$1", [job.id]); assert.equal(row.rows[0].payload.providerStatus, "completed"); assert.equal(row.rows[0].payload.failure, "task_ended_result_not_applied");
  assert.equal((await getJob(session.id, job.id)).output, null); assert.equal((await getJob(session.id, job.id)).status, "cancelled");
});
test("orphaned source intents recover once and cleanup is authorized after workspace expiry", async () => {
  const session = await workspace(); const id = randomUUID(); const queued = await enqueueJob(session, "source_retrieve", { profileId: "zoom-f3", documentId: id, expectedHeadId: null }, id, "Synthetic unfulfilled retrieval intent");
  await database().query("UPDATE wk_jobs SET status='failed' WHERE id=$1", [queued.id]);
  await database().query("INSERT INTO wk_source_documents(id,tenant_id,profile_id,job_id,source_url,blob_path,status,created_at,updated_at) VALUES($1,$2,'zoom-f3',$3,'https://zoomcorp.com/manuals/f3-en/',$4,'retrieving',now()-interval '11 minutes',now()-interval '11 minutes')", [id, session.id, queued.id, `worldkit/${session.id}/sources/${id}.source`]);
  await database().query("UPDATE wk_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [session.id]);
  assert.equal(await recoverSourceIntents(session.id), 1); assert.equal(await recoverSourceIntents(session.id), 0);
  const cleanup = (await claimJob({ tenantId: session.id }))!; assert.equal(cleanup.kind, "source_document_delete");
  assert.equal(await completeJob(cleanup, { output: { synthetic: true, noExternalStorageCall: true }, persist: async db => { await db.query("UPDATE wk_source_documents SET status='deleted' WHERE id=$1", [id]); } }), true);
});
test("private-source deletion waits for the durable upload window and cannot be abandoned by cancelling cleanup", async () => {
  const session = await workspace(); const id = randomUUID(); const retrieval = await enqueueJob(session, "source_retrieve", { profileId: "zoom-f3", documentId: id, expectedHeadId: null }, id, "Synthetic upload-window fixture");
  await database().query("UPDATE wk_jobs SET status='cancelled' WHERE id=$1", [retrieval.id]);
  await database().query("INSERT INTO wk_source_documents(id,tenant_id,profile_id,job_id,source_url,blob_path,status,write_until) VALUES($1,$2,'zoom-f3',$3,'https://zoomcorp.com/synthetic',$4,'deleting',now()+interval '40 seconds')", [id, session.id, retrieval.id, `worldkit/${session.id}/sources/${id}.source`]);
  const cleanup = await enqueueJob(session, "source_document_delete", { documentId: id }, id, "Synthetic removal without external storage call");
  await assert.rejects(() => cancelJob(session.id, cleanup.id), /cleanup will finish/);
  const job = (await claimJob({ tenantId: session.id, id: cleanup.id }))!;
  await assert.rejects(() => deleteSourceJob(job), ModelPending); await deferJob(job, new ModelPending());
  assert.equal((await getJob(session.id, cleanup.id)).attempts, 0);
  await database().query("UPDATE wk_source_documents SET status='deleted',write_until=NULL WHERE id=$1", [id]);
  await due(job.id); const resumed = (await claimJob({ tenantId: session.id, id: cleanup.id }))!;
  assert.equal(await completeJob(resumed, await deleteSourceJob(resumed)), true);
});
test("a failed private-source cleanup is recovered with the same identity after bounded backoff", async () => {
  const session = await workspace(); const id = randomUUID(); const retrieval = await enqueueJob(session, "source_retrieve", { profileId: "zoom-f3", documentId: id, expectedHeadId: null }, id, "Synthetic cleanup-backoff fixture");
  await database().query("UPDATE wk_jobs SET status='failed' WHERE id=$1", [retrieval.id]);
  await database().query("INSERT INTO wk_source_documents(id,tenant_id,profile_id,job_id,source_url,blob_path,status) VALUES($1,$2,'zoom-f3',$3,'https://zoomcorp.com/synthetic',$4,'deleting')", [id, session.id, retrieval.id, `worldkit/${session.id}/sources/${id}.source`]);
  const cleanup = await enqueueJob(session, "source_document_delete", { documentId: id }, id, "Synthetic failed removal");
  await database().query("UPDATE wk_jobs SET status='failed',attempts=3,updated_at=now()-interval '30 minutes' WHERE id=$1", [cleanup.id]);
  await recoverSourceIntents(session.id); assert.equal((await getJob(session.id, cleanup.id)).status, "failed");
  await database().query("UPDATE wk_jobs SET updated_at=now()-interval '61 minutes' WHERE id=$1", [cleanup.id]);
  await recoverSourceIntents(session.id); const recovered = await getJob(session.id, cleanup.id); assert.equal(recovered.status, "retry_wait"); assert.equal(recovered.maxAttempts, 6);
  assert.equal((await database().query("SELECT id FROM wk_jobs WHERE tenant_id=$1 AND kind='source_document_delete' AND idempotency_key=$2", [session.id, id])).rowCount, 1);
  await database().query("UPDATE wk_source_documents SET status='deleted' WHERE id=$1", [id]);
});
