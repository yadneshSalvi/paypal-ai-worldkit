import { randomUUID } from "node:crypto";
import { hash } from "../../packages/compatibility";
import { WorldKitError } from "../../packages/contracts";
import { ModelPending, OpenAIBackgroundGateway, safeObservation, validResponseId, type BackgroundCheckpoint, type BackgroundGateway, type BackgroundStore } from "../../packages/spec-evidence/providers";
import { database, initialize, transaction } from "./db";
import type { ClaimedJob } from "./jobs";
import { reserveUsage } from "./repository";

/** The job fence authorizes dispatch; the request identity outlives individual leases. */
export class SourceModelStore implements BackgroundStore {
  constructor(private job: ClaimedJob, private provider: "openai" | "gemini") {}
  async reserve(initial: BackgroundCheckpoint) {
    if (initial.operationId !== this.job.id) throw new WorldKitError("invalid_request", "The model operation must match its saved task.");
    return transaction(async db => {
      const active = await db.query("SELECT j.id FROM wk_jobs j JOIN wk_sessions s ON s.id=j.tenant_id WHERE j.id=$1 AND j.tenant_id=$2 AND j.status='running' AND j.lease_token=$3 AND j.lease_expires_at>now() AND s.expires_at>now() FOR UPDATE OF j", [this.job.id, this.job.tenantId, this.job.leaseToken]);
      if (!active.rowCount) throw new WorldKitError("stale_revision", "This task is no longer authorized to start a model request.", 409);
      const prior = await db.query("SELECT payload,provider FROM wk_source_model_requests WHERE job_id=$1 AND tenant_id=$2", [this.job.id, this.job.tenantId]);
      if (prior.rows[0]) {
        if (prior.rows[0].provider !== this.provider) throw new WorldKitError("stale_revision", "The saved request belongs to a different provider.", 409);
        return { created: false, checkpoint: prior.rows[0].payload as BackgroundCheckpoint };
      }
      await db.query("SELECT pg_advisory_xact_lock(hashtext('worldkit:source-model-dispatch:v1'))");
      const counts = await db.query("SELECT count(*)::int AS global_count,count(*) FILTER(WHERE tenant_id=$1)::int AS tenant_count FROM wk_source_model_requests WHERE phase IN ('dispatching','polling')", [this.job.tenantId]);
      if (counts.rows[0].tenant_count >= 2 || counts.rows[0].global_count >= 8) throw new ModelPending("Waiting for a source analysis slot", 15);
      await reserveUsage(this.job.tenantId, "model", db);
      await db.query("INSERT INTO wk_source_model_requests(operation_id,job_id,tenant_id,provider,model,request_hash,phase,payload) VALUES($1,$1,$2,$3,$4,$5,$6,$7)", [initial.operationId, this.job.tenantId, this.provider, initial.model, initial.requestHash, initial.phase, initial]);
      await db.query("INSERT INTO wk_source_model_observations(operation_id,payload_hash,payload) VALUES($1,$2,$3)", [initial.operationId, hash(initial), initial]);
      return { created: true, checkpoint: initial };
    });
  }
  async save(checkpoint: BackgroundCheckpoint) { await saveModelCheckpoint(this.job.tenantId, this.job.id, checkpoint); }
}

export async function saveModelCheckpoint(tenantId: string, jobId: string, checkpoint: BackgroundCheckpoint) {
  await transaction(async db => {
    const result = await db.query("SELECT * FROM wk_source_model_requests WHERE operation_id=$1 AND job_id=$2 AND tenant_id=$3 FOR UPDATE", [checkpoint.operationId, jobId, tenantId]);
    const row = result.rows[0]; const current = row?.payload as BackgroundCheckpoint | undefined;
    if (!current || current.requestHash !== checkpoint.requestHash || current.model !== checkpoint.model || current.responseId && checkpoint.responseId !== current.responseId) throw new WorldKitError("stale_revision", "The provider observation does not belong to this source task.", 409);
    // Preserve late observations for audit, but do not regress a terminal or newer checkpoint.
    await db.query("INSERT INTO wk_source_model_observations(operation_id,payload_hash,payload) VALUES($1,$2,$3) ON CONFLICT(operation_id,payload_hash) DO NOTHING", [checkpoint.operationId, hash(checkpoint), checkpoint]);
    if (["received", "failed"].includes(current.phase) || checkpoint.pollCount < current.pollCount) return;
    await db.query("UPDATE wk_source_model_requests SET payload=$2,phase=$3,response_id=$4,updated_at=now() WHERE operation_id=$1", [checkpoint.operationId, checkpoint, checkpoint.phase, checkpoint.responseId]);
  });
}

/** Cancel the original provider operation after its task ends. Never create a replacement. */
export async function recoverSourceModels(tenantId?: string, gateway?: BackgroundGateway): Promise<number> {
  await initialize();
  const rows = await transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('worldkit:source-model-cleanup:v1'))");
    const abandoned = await db.query(`SELECT r.* FROM wk_source_model_requests r JOIN wk_jobs j ON j.id=r.job_id
      WHERE ($1::text IS NULL OR r.tenant_id=$1) AND r.phase='dispatching' AND r.updated_at<now()-interval '210 seconds'
      AND (j.status<>'running' OR j.lease_expires_at<now()) FOR UPDATE OF r SKIP LOCKED`, [tenantId ?? null]);
    for (const row of abandoned.rows) {
      const checkpoint: BackgroundCheckpoint = { ...row.payload, phase: "indeterminate", failure: "dispatch_interrupted", observedAt: new Date().toISOString() };
      await db.query("UPDATE wk_source_model_requests SET phase='indeterminate',payload=$2,updated_at=now() WHERE operation_id=$1", [row.operation_id, checkpoint]);
      await db.query("INSERT INTO wk_source_model_observations(operation_id,payload_hash,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [row.operation_id, hash(checkpoint), checkpoint]);
    }
    const result = await db.query(`SELECT r.* FROM wk_source_model_requests r JOIN wk_jobs j ON j.id=r.job_id JOIN wk_sessions s ON s.id=r.tenant_id
      WHERE ($1::text IS NULL OR r.tenant_id=$1) AND r.provider='openai' AND r.phase='polling' AND r.response_id IS NOT NULL
      AND (j.status IN ('cancelled','failed') OR s.expires_at<=now()) AND (r.cleanup_expires_at IS NULL OR r.cleanup_expires_at<now())
      ORDER BY r.updated_at LIMIT 2 FOR UPDATE OF r SKIP LOCKED`, [tenantId ?? null]);
    return await Promise.all(result.rows.map(async row => {
      const token = randomUUID();
      await db.query("UPDATE wk_source_model_requests SET cleanup_token=$2,cleanup_expires_at=now()+interval '90 seconds' WHERE operation_id=$1", [row.operation_id, token]);
      return { ...row, cleanupToken: token };
    }));
  });
  if (!rows.length) return 0;
  const client = gateway ?? new OpenAIBackgroundGateway();
  const results = await Promise.all(rows.map(async row => {
    const current = row.payload as BackgroundCheckpoint;
    if (!validResponseId(current.responseId)) return false;
    try {
      let result = await client.retrieve(current.responseId);
      if (result.id !== current.responseId || !(result.model === current.model || result.model.startsWith(`${current.model}-`))) throw new Error("Provider identity mismatch");
      if (["queued", "in_progress"].includes(result.status)) result = await client.cancel(current.responseId);
      if (result.id !== current.responseId || !["completed", "failed", "incomplete", "cancelled"].includes(result.status)) throw new Error("Cancellation not yet settled");
      await saveModelCheckpoint(row.tenant_id, row.job_id, { ...current, phase: "failed", providerStatus: result.status, observation: safeObservation(result), failure: "task_ended_result_not_applied", pollAfter: null, observedAt: new Date().toISOString() });
      return true;
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? error.status : null;
      if (status === 404 || status === 410) {
        await saveModelCheckpoint(row.tenant_id, row.job_id, { ...current, phase: "failed", failure: "ended_task_response_unavailable", pollAfter: null, observedAt: new Date().toISOString() });
      }
      return false;
    } finally {
      await database().query("UPDATE wk_source_model_requests SET cleanup_token=NULL,cleanup_expires_at=now()+interval '30 seconds' WHERE operation_id=$1 AND cleanup_token=$2", [row.operation_id, row.cleanupToken]);
    }
  }));
  return results.filter(Boolean).length;
}
