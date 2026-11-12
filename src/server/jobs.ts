import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hash } from "../../packages/compatibility/index";
import { WorldKitError } from "../../packages/contracts/index";
import { database, initialize, transaction } from "./db";
import { appendEvent, type Session } from "./repository";
import { CatalogFailure } from "../../packages/channel3/client";
import { ModelPending } from "../../packages/spec-evidence/providers";

export type JobKind = "goal_proposal" | "inventory_regions" | "inventory_crop_search" | "source_retrieve" | "source_extract" | "source_document_delete" | "inventory_photo_delete";
export type Job = { id: string; kind: JobKind; status: "queued" | "running" | "retry_wait" | "succeeded" | "failed" | "cancelled"; attempts: number; continuations?: number; maxAttempts: number; progress: string; output: unknown; error: string | null; createdAt: string; updatedAt: string; nextAttemptAt: string; context?: { profileId?: string; documentId?: string } };
export type ClaimedJob = Job & { tenantId: string; input: unknown; leaseToken: string };
export type JobResult = { output: unknown; persist?: (db: PoolClient) => Promise<void> };
export type JobExecutor = (job: ClaimedJob) => Promise<JobResult>;
function publicJob(row: Record<string, any>): Job {
  return { id: row.id, kind: row.kind, status: row.status, attempts: row.attempts - (row.continuations ?? 0), continuations: row.continuations ?? 0, maxAttempts: row.max_attempts, progress: row.progress ?? "Waiting to start", output: row.output ?? null, error: row.error ?? null,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), nextAttemptAt: new Date(row.next_attempt_at).toISOString(), ...(String(row.kind).startsWith("source_") ? { context: { ...(typeof row.input?.profileId === "string" ? { profileId: row.input.profileId } : {}), ...(typeof row.input?.documentId === "string" ? { documentId: row.input.documentId } : {}) } } : {}) };
}
export async function enqueueJob(session: Session, kind: JobKind, input: unknown, requestId: string, progress: string): Promise<Job> {
  const inputHash = hash(input);
  return transaction(async db => {
    const active = await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>now() FOR UPDATE", [session.id]);
    if (!active.rowCount) throw new WorldKitError("forbidden", "This workspace has expired.", 401);
    const existing = await db.query("SELECT * FROM wk_jobs WHERE tenant_id=$1 AND kind=$2 AND idempotency_key=$3", [session.id, kind, requestId]);
    if (existing.rows[0]) {
      if (existing.rows[0].input_hash !== inputHash) throw new WorldKitError("stale_revision", "This request was already used for different work. Start a new action.", 409);
      return publicJob(existing.rows[0]);
    }
    const pending = await db.query("SELECT count(*)::int AS count FROM wk_jobs WHERE tenant_id=$1 AND managed=true AND status IN ('queued','running','retry_wait')", [session.id]);
    if (!["inventory_photo_delete", "source_document_delete"].includes(kind) && pending.rows[0].count >= 6) throw new WorldKitError("rate_limited", "Six tasks are already queued in this workspace. Let one finish or cancel it before starting another.", 429);
    const result = await db.query("INSERT INTO wk_jobs(id,tenant_id,kind,status,input,managed,idempotency_key,input_hash,progress) VALUES($1,$2,$3,'queued',$4,true,$5,$6,$7) RETURNING *", [randomUUID(), session.id, kind, input, requestId, inputHash, progress]);
    await appendEvent(db, session.id, "job.queued", progress, "Saved as a resumable task. You can leave this view and return to its result.", null);
    return publicJob(result.rows[0]);
  });
}
export async function getJob(tenantId: string, id: string): Promise<Job> {
  await initialize(); const result = await database().query("SELECT * FROM wk_jobs WHERE tenant_id=$1 AND id=$2 AND managed=true", [tenantId, id]);
  if (!result.rows[0]) throw new WorldKitError("not_found", "That task is not in this workspace.", 404);
  return publicJob(result.rows[0]);
}
export async function listJobs(tenantId: string): Promise<Job[]> {
  await initialize(); const result = await database().query("SELECT * FROM wk_jobs WHERE tenant_id=$1 AND managed=true ORDER BY created_at DESC LIMIT 30", [tenantId]);
  return result.rows.map(publicJob);
}
export async function cancelJob(tenantId: string, id: string): Promise<Job> {
  return transaction(async db => {
    const existing = await db.query("SELECT kind,status FROM wk_jobs WHERE tenant_id=$1 AND id=$2 AND managed=true FOR UPDATE", [tenantId, id]);
    if (existing.rows[0] && ["inventory_photo_delete", "source_document_delete"].includes(existing.rows[0].kind) && existing.rows[0].status !== "succeeded") throw new WorldKitError("invalid_request", "Private file removal is already requested. Its cleanup will finish in the background.", 409);
    const result = await db.query("UPDATE wk_jobs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,progress='Cancelled; your saved equipment is unchanged',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND managed=true AND status IN ('queued','running','retry_wait') RETURNING *", [tenantId, id]);
    if (!result.rows[0]) {
      const previous = await db.query("SELECT * FROM wk_jobs WHERE tenant_id=$1 AND id=$2 AND managed=true", [tenantId, id]);
      if (!previous.rows[0]) throw new WorldKitError("not_found", "That task is not in this workspace.", 404);
      return publicJob(previous.rows[0]);
    }
    await db.query("UPDATE wk_job_attempts SET status='cancelled',finished_at=now() WHERE job_id=$1 AND status='running'", [id]);
    await appendEvent(db, tenantId, "job.cancelled", "Background task cancelled", "An in-flight provider read may finish, but its result cannot change this task or your equipment.", null);
    return publicJob(result.rows[0]);
  });
}
export async function retryJob(session: Session, id: string): Promise<Job> {
  return transaction(async db => {
    const active = await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>now() FOR UPDATE", [session.id]);
    if (!active.rowCount) throw new WorldKitError("forbidden", "This workspace has expired.", 401);
    const queued = await db.query("SELECT count(*)::int AS count FROM wk_jobs WHERE tenant_id=$1 AND managed=true AND status IN ('queued','running','retry_wait') AND kind NOT IN ('inventory_photo_delete','source_document_delete')", [session.id]);
    if (queued.rows[0].count >= 6) throw new WorldKitError("rate_limited", "Let a queued task finish before retrying this one.", 429);
    const result = await db.query("UPDATE wk_jobs SET status='queued',error=NULL,progress='Queued for another attempt',next_attempt_at=now(),max_attempts=max_attempts+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND managed=true AND status='failed' AND max_attempts<6 RETURNING *", [session.id, id]);
    if (!result.rows[0]) throw new WorldKitError("invalid_request", "This task cannot be retried again. Review its evidence and start a new request.", 409);
    return publicJob(result.rows[0]);
  });
}
export async function claimJob(scope: { tenantId?: string; id?: string } = {}): Promise<ClaimedJob | null> {
  return transaction(async db => {
    // A short global claim lock makes tenant concurrency exact across Vercel instances.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('worldkit:job-claim:v1'))");
    // Recovery has the same scope as selection; a workspace poll cannot maintain another owner's jobs.
    const scopeValues = [scope.tenantId ?? null, scope.id ?? null];
    await db.query("UPDATE wk_job_attempts a SET status='interrupted',error='The lease expired before a durable result was saved.',finished_at=now() FROM wk_jobs j WHERE a.job_id=j.id AND a.attempt=j.attempts AND a.status='running' AND j.status='running' AND j.lease_expires_at<now() AND ($1::text IS NULL OR j.tenant_id=$1) AND ($2::text IS NULL OR j.id=$2)", scopeValues);
    await db.query("UPDATE wk_jobs j SET status='failed',error='The worker stopped before a durable result was saved.',progress='Needs another attempt',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE j.managed=true AND j.status='running' AND j.lease_expires_at<now() AND j.attempts-j.continuations>=j.max_attempts AND ($1::text IS NULL OR j.tenant_id=$1) AND ($2::text IS NULL OR j.id=$2)", scopeValues);
    await db.query("UPDATE wk_jobs j SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,progress='The workspace expired',updated_at=now() FROM wk_sessions s WHERE j.tenant_id=s.id AND s.expires_at<=now() AND j.managed=true AND j.kind NOT IN ('inventory_photo_delete','source_document_delete') AND j.status IN ('queued','running','retry_wait') AND ($1::text IS NULL OR j.tenant_id=$1) AND ($2::text IS NULL OR j.id=$2)", scopeValues);
    const result = await db.query(`SELECT j.* FROM wk_jobs j JOIN wk_sessions s ON s.id=j.tenant_id
      WHERE j.managed=true AND j.attempts-j.continuations<j.max_attempts AND (s.expires_at>now() OR j.kind IN ('inventory_photo_delete','source_document_delete'))
      AND (($1::text IS NULL) OR j.tenant_id=$1) AND (($2::text IS NULL) OR j.id=$2)
      AND ((j.status IN ('queued','retry_wait') AND j.next_attempt_at<=now()) OR (j.status='running' AND j.lease_expires_at<now()))
      AND (SELECT count(*) FROM wk_jobs running WHERE running.tenant_id=j.tenant_id AND running.managed=true AND running.status='running' AND running.lease_expires_at>now())<2
      AND (SELECT count(*) FROM wk_jobs running WHERE running.managed=true AND running.status='running' AND running.lease_expires_at>now())<8
      ORDER BY j.next_attempt_at,j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, scopeValues);
    const row = result.rows[0]; if (!row) return null;
    const token = randomUUID();
    const updated = await db.query("UPDATE wk_jobs SET status='running',attempts=attempts+1,lease_token=$2,lease_expires_at=now()+interval '210 seconds',progress=CASE WHEN attempts>0 THEN 'Resuming saved work' ELSE progress END,updated_at=now() WHERE id=$1 RETURNING *", [row.id, token]);
    await db.query("INSERT INTO wk_job_attempts(job_id,attempt,lease_token,status) VALUES($1,$2,$3,'running')", [row.id, updated.rows[0].attempts, token]);
    return { ...publicJob(updated.rows[0]), tenantId: row.tenant_id, input: row.input, leaseToken: token };
  });
}
export async function completeJob(job: ClaimedJob, result: JobResult): Promise<boolean> {
  return transaction(async db => {
    const active = await db.query("SELECT j.id FROM wk_jobs j JOIN wk_sessions s ON s.id=j.tenant_id WHERE j.id=$1 AND j.status='running' AND j.lease_token=$2 AND j.lease_expires_at>now() AND (s.expires_at>now() OR j.kind IN ('inventory_photo_delete','source_document_delete')) FOR UPDATE OF j", [job.id, job.leaseToken]);
    const receipt = result.output && typeof result.output === "object" && "receipt" in result.output ? result.output.receipt : null;
    if (!active.rowCount) { await db.query("UPDATE wk_job_attempts SET status='result_discarded',receipt=$3,finished_at=now() WHERE job_id=$1 AND lease_token=$2 AND status<>'succeeded'", [job.id, job.leaseToken, receipt]); return false; }
    if (result.persist) await result.persist(db);
    const deleted = ["inventory_photo_delete", "source_document_delete"].includes(job.kind);
    await db.query("UPDATE wk_jobs SET status='succeeded',output=$2,error=NULL,progress=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1", [job.id, result.output, deleted ? "Private file removed" : "Ready to review"]);
    await db.query("UPDATE wk_job_attempts SET status='succeeded',receipt=$3,finished_at=now() WHERE job_id=$1 AND lease_token=$2", [job.id, job.leaseToken, receipt]);
    await appendEvent(db, job.tenantId, "job.completed", deleted ? "Private file cleanup finished" : "Your background result is ready", deleted ? "The private file is removed. Saved equipment identities and historical fingerprints remain." : "The proposal is saved. Your confirmation is still required before it becomes equipment or changes the plan.", null, "live");
    return true;
  });
}
/** A provider poll yields the lease without consuming a failure attempt. */
export async function deferJob(job: ClaimedJob, pending: ModelPending): Promise<boolean> {
  return transaction(async db => {
    const updated = await db.query("UPDATE wk_jobs SET status='retry_wait',continuations=continuations+1,error=NULL,progress=$3,next_attempt_at=now()+($4::int*interval '1 second'),lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='running' AND lease_token=$5 AND lease_expires_at>now() RETURNING id", [job.id, job.tenantId, pending.progress, Math.max(5, Math.min(60, pending.delaySeconds)), job.leaseToken]);
    await db.query("UPDATE wk_job_attempts SET status=$3,finished_at=now() WHERE job_id=$1 AND lease_token=$2 AND status='running'", [job.id, job.leaseToken, updated.rowCount ? "deferred" : "result_discarded"]);
    return Boolean(updated.rowCount);
  });
}
export async function failJob(job: ClaimedJob, error: unknown) {
  const retryable = error instanceof WorldKitError ? error.code === "provider_unavailable" || error.status >= 500 : true;
  const message = error instanceof WorldKitError ? error.message : "The provider did not finish a usable response. Your saved equipment is safe.";
  const retry = retryable && job.attempts < job.maxAttempts;
  await transaction(async db => {
    const updated = await db.query("UPDATE wk_jobs SET status=$3,error=$4,progress=$5,next_attempt_at=now()+($6::int*interval '1 second'),lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_expires_at>now() RETURNING id", [job.id, job.leaseToken, retry ? "retry_wait" : "failed", message, retry ? "A provider request stopped. Retrying shortly…" : "Needs your attention", Math.min(120, 5 * 2 ** job.attempts)]);
    await db.query("UPDATE wk_job_attempts SET status=$3,error=$4,receipt=$5,finished_at=now() WHERE job_id=$1 AND lease_token=$2 AND status<>'succeeded'", [job.id, job.leaseToken, updated.rowCount ? "failed" : "result_discarded", message, error instanceof CatalogFailure ? error.receipt : null]);
  });
}
export async function runOneJob(scope: { tenantId?: string; id?: string } = {}, executor?: JobExecutor): Promise<boolean> {
  const job = await claimJob(scope); if (!job) return false;
  try {
    const execute = executor ?? (await import("./job-handlers")).executeWorldKitJob;
    const result = await execute(job); await completeJob(job, result);
  } catch (error) { if (error instanceof ModelPending) await deferJob(job, error); else await failJob(job, error); }
  return true;
}
export async function runQueuedJobs(tenantId?: string): Promise<number> {
  await Promise.all([(await import("./inventory-photos")).recoverPhotoIntents(tenantId), (await import("./source-evidence")).recoverSourceIntents(tenantId)]);
  const [results] = await Promise.all([
    Promise.allSettled([runOneJob({ tenantId }), runOneJob({ tenantId })]),
    (await import("./source-models")).recoverSourceModels(tenantId).catch(() => 0),
  ]);
  return results.filter(result => result.status === "fulfilled" && result.value).length;
}
