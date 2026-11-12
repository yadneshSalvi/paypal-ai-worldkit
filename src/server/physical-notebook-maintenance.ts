import { randomUUID } from "node:crypto";
import { database, transaction } from "./db";
import { benchEvent, benchFail, benchIso, type BenchRow } from "./physical-notebook-authority";
import { benchStorageMode, deleteBenchObject } from "./physical-notebook-storage";

/** Operator maintenance, deliberately absent from browser GET/read paths.
 * Every deletion names an owned original path from a durable upload intent.
 * Existing tokens must expire first, so deletion cannot be undone by a late PUT.
 */
export async function maintainPhysicalNotebook(options: { apply?: boolean; limit?: number } = {}) {
  if (options.apply && process.env.WORLDKIT_PHYSICAL_MAINTENANCE !== "true") benchFail("Explicitly enable physical-original retention maintenance before applying deletion.");
  const mode = benchStorageMode(), limit = Math.min(100, Math.max(1, options.limit ?? 40));
  if (mode === "unavailable" || !(await database().query("SELECT to_regclass('wk_bench_uploads') AS relation")).rows[0].relation) return { mode, apply: !!options.apply, candidates: [], removed: 0, deferred: 0, failed: 0 };
  const rows = (await database().query(`SELECT u.id,u.run_id,u.tenant_id,u.asset_id,u.token_expires_at,
    CASE WHEN s.expires_at<=clock_timestamp() THEN 'workspace_expired' WHEN (u.file->'rights'->>'expiresAt')::timestamptz<=clock_timestamp() THEN 'permission_expired' ELSE 'withdrawn' END AS reason
    FROM wk_bench_uploads u JOIN wk_sessions s ON s.id=u.tenant_id
    WHERE u.transport=$1 AND u.purged_at IS NULL AND (u.withdrawn_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR (u.file->'rights'->>'expiresAt')::timestamptz<=clock_timestamp())
    ORDER BY u.created_at,u.id LIMIT $2`, [mode, limit])).rows;
  const result = { mode, apply: !!options.apply, candidates: rows.map(row => ({ uploadId: row.id as string, runId: row.run_id as string, reason: row.reason as string, tokenExpiresAt: row.token_expires_at ? benchIso(row.token_expires_at) : null })), removed: 0, deferred: 0, failed: 0 };
  if (!options.apply) return result;
  for (const candidate of rows) {
    const lease = randomUUID();
    const claim = await transaction(async db => {
      await db.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [candidate.tenant_id]);
      const row: BenchRow | undefined = (await db.query(`SELECT u.*,s.expires_at AS workspace_expiry FROM wk_bench_uploads u JOIN wk_sessions s ON s.id=u.tenant_id
        WHERE u.id=$1 AND u.tenant_id=$2 AND u.purged_at IS NULL AND (u.withdrawn_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR (u.file->'rights'->>'expiresAt')::timestamptz<=clock_timestamp()) FOR UPDATE OF u`, [candidate.id, candidate.tenant_id])).rows[0];
      if (!row) return null;
      const access = { tenantId: row.tenant_id, actorId: "retention:physical-originals", kind: "owner" as const, grantId: null };
      if (!row.withdrawn_at) {
        await db.query("UPDATE wk_bench_uploads SET withdrawn_at=clock_timestamp(),phase=CASE WHEN asset_id IS NULL THEN 'rejected' ELSE phase END,lease_token=NULL,lease_expires_at=NULL,failure='Private original retention ended; removal is pending.' WHERE id=$1", [row.id]);
        await benchEvent(db, access, row.run_id, "retention.withdrawn", "Private original access ended under the existing workspace or rights deadline. Neither deadline was renewed.", { uploadId: row.id, reason: candidate.reason });
      }
      let asset: BenchRow | undefined;
      if (row.asset_id) {
        asset = (await db.query("SELECT * FROM wk_bench_asset_access WHERE asset_id=$1 AND tenant_id=$2 FOR UPDATE", [row.asset_id, row.tenant_id])).rows[0];
        if (!asset) benchFail("The original's retained access record is missing.", "needs_evidence");
        if (asset.state === "available") await db.query("UPDATE wk_bench_asset_access SET state='withdrawn',withdrawn_at=clock_timestamp(),reason='Existing private retention deadline ended' WHERE asset_id=$1", [row.asset_id]);
        if (asset.state === "purged") { await db.query("UPDATE wk_bench_uploads SET purged_at=clock_timestamp() WHERE id=$1", [row.id]); return null; }
      }
      if (row.token_expires_at && Date.parse(benchIso(row.token_expires_at)) > Date.now() || asset?.lease_expires_at && Date.parse(benchIso(asset.lease_expires_at)) > Date.now() || !row.asset_id && row.withdrawn_at && row.lease_expires_at && Date.parse(benchIso(row.lease_expires_at)) > Date.now()) return null;
      if (asset) await db.query("UPDATE wk_bench_asset_access SET state='purging',lease_token=$2,lease_expires_at=clock_timestamp()+interval '2 minutes',attempts=attempts+1 WHERE asset_id=$1", [row.asset_id, lease]);
      else await db.query("UPDATE wk_bench_uploads SET lease_token=$2,lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE id=$1", [row.id, lease]);
      return { row, access };
    });
    if (!claim) { result.deferred++; continue; }
    try {
      await deleteBenchObject({ pathname: claim.row.pathname, transport: claim.row.transport });
      await transaction(async db => {
        if (claim.row.asset_id) {
          const changed = await db.query("UPDATE wk_bench_asset_access SET state='purged',purged_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,failure=NULL WHERE asset_id=$1 AND tenant_id=$2 AND lease_token=$3", [claim.row.asset_id, claim.row.tenant_id, lease]);
          if (!changed.rowCount) benchFail("The retention deletion lease changed.", "stale_revision");
        }
        const changed = await db.query("UPDATE wk_bench_uploads SET purged_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,failure='The private store acknowledged removal under the original retention deadline.' WHERE id=$1 AND tenant_id=$2 AND withdrawn_at IS NOT NULL AND purged_at IS NULL AND ($3::boolean OR lease_token=$4)", [claim.row.id, claim.row.tenant_id, !!claim.row.asset_id, lease]);
        if (!changed.rowCount) benchFail("The original retention receipt changed.", "stale_revision");
        await benchEvent(db, claim.access, claim.row.run_id, "retention.purged", "The private store acknowledged deletion of the expired or withdrawn original. Immutable report hashes and historical observations remain retained.", { uploadId: claim.row.id, assetId: claim.row.asset_id, reason: candidate.reason });
      }); result.removed++;
    } catch {
      if (claim.row.asset_id) await database().query("UPDATE wk_bench_asset_access SET state='retry_wait',lease_token=NULL,lease_expires_at=NULL,failure='Retention deletion was not acknowledged; access remains withdrawn.' WHERE asset_id=$1 AND tenant_id=$2 AND lease_token=$3", [claim.row.asset_id, claim.row.tenant_id, lease]);
      else await database().query("UPDATE wk_bench_uploads SET lease_token=NULL,lease_expires_at=NULL,failure='Retention deletion was not acknowledged; access remains withdrawn.' WHERE id=$1 AND tenant_id=$2 AND lease_token=$3", [claim.row.id, claim.row.tenant_id, lease]);
      result.failed++;
    }
  }
  return result;
}
