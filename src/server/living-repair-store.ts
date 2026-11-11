import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hash } from "../../packages/compatibility";
import { WorldKitError } from "../../packages/contracts";
import type { AmendmentProposal, KitAmendment, KitCommitment, RepairCandidate, RepairNotice, RepairRun, RepairSource } from "../../packages/living-repair/contracts";
import { database } from "./db";
import { initializeLivingRepair, repairTransaction } from "./living-repair-db";
import { publishNotification } from "./notifications";

export type RepairDb = Pick<PoolClient, "query">;
export const repairNow = () => new Date().toISOString();
const tables = { run: "wk_living_repairs", candidate: "wk_repair_candidates", commitment: "wk_kit_commitments", amendment: "wk_kit_amendments", compensation: "wk_kit_compensations", policy: "wk_kit_repair_policies" } as const;
export async function ownedRepairRow<T>(kind: keyof typeof tables, tenantId: string, id: string, db: RepairDb = database(), lock = false): Promise<T> {
  const row = (await db.query(`SELECT * FROM ${tables[kind]} WHERE id=$1 AND tenant_id=$2${lock ? " FOR UPDATE" : ""}`, [id, tenantId])).rows[0];
  if (!row) throw new WorldKitError("not_found", "This repair record does not belong to this workspace.", 404);
  if (kind === "amendment") return { ...row.payload, proposal: row.proposal } as T;
  return row.payload as T;
}
export const loadRepair = (tenantId: string, id: string, db?: RepairDb, lock = false) => ownedRepairRow<RepairRun>("run", tenantId, id, db, lock);
export const loadCandidate = (tenantId: string, id: string, db?: RepairDb) => ownedRepairRow<RepairCandidate>("candidate", tenantId, id, db);
export const loadCommitment = (tenantId: string, id: string, db?: RepairDb, lock = false) => ownedRepairRow<KitCommitment>("commitment", tenantId, id, db, lock);
export const loadAmendment = (tenantId: string, id: string, db?: RepairDb, lock = false) => ownedRepairRow<KitAmendment>("amendment", tenantId, id, db, lock);
export async function saveRepair(db: RepairDb, run: RepairRun) {
  await db.query("UPDATE wk_living_repairs SET phase=$3,payload=$4,updated_at=now(),next_attempt_at=$5 WHERE id=$1 AND tenant_id=$2", [run.id, run.tenantId, run.phase, { ...run, updatedAt: repairNow() }, run.nextAttemptAt]);
}
export async function saveAmendment(db: RepairDb, tenantId: string, amendment: KitAmendment) {
  const { proposal, ...state } = amendment;
  const result = await db.query("UPDATE wk_kit_amendments SET state=$3,payload=$4,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND proposal_digest=$5", [proposal.id, tenantId, amendment.status, { ...state, updatedAt: repairNow() }, proposal.digest]);
  if (!result.rowCount) throw new WorldKitError("stale_revision", "The immutable amendment no longer matches this action.", 409);
}
export async function insertAmendment(db: RepairDb, tenantId: string, proposal: AmendmentProposal): Promise<KitAmendment> {
  const amendment: KitAmendment = { proposal, status: proposal.technicalState === "satisfied" ? "proposed" : "awaiting_consent", reason: proposal.technicalState === "satisfied" ? "Review the exact change, evidence and controlled merchant quote." : "Critical evidence remains open. This proposal cannot authorize a payment.", orderId: null, policyId: null, claimId: null, paymentMode: null, acceptedAt: null, committedAt: null, committedVersion: null, updatedAt: repairNow(), undoUntil: null };
  const { proposal: _proposal, ...state } = amendment;
  await db.query("INSERT INTO wk_kit_amendments(id,tenant_id,run_id,candidate_id,commitment_id,proposal,proposal_digest,state,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [proposal.id, tenantId, proposal.runId, proposal.candidateId, proposal.commitmentId, proposal, proposal.digest, amendment.status, state]);
  return amendment;
}
export async function saveCommitmentVersion(db: RepairDb, commitment: KitCommitment, kind: "baseline" | "amendment" | "undo" | "shipment", amendmentId: string | null) {
  if (kind === "baseline") await db.query("INSERT INTO wk_kit_commitments(id,tenant_id,kit_id,version,payload) VALUES($1,$2,$3,$4,$5)", [commitment.id, commitment.tenantId, commitment.kitId, commitment.version, commitment]);
  else {
    const changed = await db.query("UPDATE wk_kit_commitments SET version=$3,payload=$4,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND version=$5", [commitment.id, commitment.tenantId, commitment.version, commitment, commitment.version - 1]);
    if (!changed.rowCount) throw new WorldKitError("stale_revision", "Another change updated this merchant commitment.", 409);
  }
  await db.query("INSERT INTO wk_kit_commitment_versions(id,tenant_id,commitment_id,version,amendment_id,kind,payload) VALUES($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), commitment.tenantId, commitment.id, commitment.version, amendmentId, kind, { commitment, digest: hash(commitment) }]);
}
export async function repairNotice(db: RepairDb, tenantId: string, cause: string, value: { kind: string; title: string; detail: string; sourceMode: RepairSource; runId?: string | null; amendmentId?: string | null }) {
  const payload: RepairNotice = { id: randomUUID(), ...value, createdAt: repairNow(), deliveredAt: null, attempts: 0, runId: value.runId ?? null, amendmentId: value.amendmentId ?? null };
  await db.query("INSERT INTO wk_kit_repair_outbox(id,tenant_id,cause_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,cause_key) DO NOTHING", [payload.id, tenantId, cause, payload]);
}
export async function drainRepairNotices(tenantId?: string): Promise<number> {
  await initializeLivingRepair();
  return repairTransaction(async db => {
    const rows = await db.query("SELECT * FROM wk_kit_repair_outbox WHERE delivered_at IS NULL AND next_attempt_at<=now() AND ($1::text IS NULL OR tenant_id=$1) ORDER BY created_at LIMIT 30 FOR UPDATE SKIP LOCKED", [tenantId ?? null]);
    for (const row of rows.rows) {
      const notice = row.payload as RepairNotice;
      await publishNotification(db, row.tenant_id, `repair-outbox:${row.cause_key}`, { kind: notice.kind, title: notice.title, detail: notice.detail, sourceMode: notice.sourceMode, incidentId: null, orderId: null });
      await db.query("UPDATE wk_kit_repair_outbox SET delivered_at=now(),attempts=attempts+1,payload=$2 WHERE id=$1", [row.id, { ...notice, deliveredAt: repairNow(), attempts: row.attempts + 1 }]);
    }
    return rows.rowCount ?? 0;
  });
}
