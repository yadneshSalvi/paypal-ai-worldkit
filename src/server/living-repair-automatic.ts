import { hash } from "../../packages/compatibility";
import { WorldKitError } from "../../packages/contracts";
import type { KitRepairPolicy, RepairCandidate, RepairRun } from "../../packages/living-repair/contracts";
import { database } from "./db";
import { proposeKitAmendment } from "./living-repair";
import { repairTransaction } from "./living-repair-db";
import { acceptKitAmendment, repairClaims } from "./living-repair-payments";
import { loadAmendment, loadRepair, repairNotice, repairNow, saveRepair } from "./living-repair-store";
import type { Session } from "./repository";

/** Only an explicitly accepted controlled-kit policy can enter this worker.
 * Discovery and a saved wallet by themselves never reach financial dispatch. */
export async function processAutomaticKitRepairs(tenantId?: string): Promise<number> {
  const rows = await database().query(`SELECT r.payload AS run,p.payload AS policy,s.* FROM wk_living_repairs r
    JOIN wk_kit_repair_policies p ON p.commitment_id=r.payload->>'commitmentId' AND p.tenant_id=r.tenant_id
    JOIN wk_sessions s ON s.id=r.tenant_id
    WHERE r.phase='ready' AND r.next_attempt_at<=now() AND p.payload->>'revokedAt' IS NULL AND p.payload->>'automatic'='true'
      AND (p.payload->>'expiresAt')::timestamptz>now() AND s.expires_at>now()
      AND ($1::text IS NULL OR r.tenant_id=$1) ORDER BY r.created_at LIMIT 6`, [tenantId ?? null]);
  let processed = 0;
  for (const row of rows.rows) {
    const run = row.run as RepairRun; const policy = row.policy as KitRepairPolicy;
    try {
    if (run.sourceMode === "replay" || !policy.origin || !policy.acceptedProposalDigest) continue;
    const claims = await repairClaims(run.tenantId, policy.commitmentId); const claimHash = hash(claims.map(claim => ({ id: claim.id, state: claim.state, amount: claim.additionalMinor })).sort((a, b) => a.id.localeCompare(b.id)));
    if (run.automaticEvaluation?.policyId === policy.id && run.automaticEvaluation.claimHash === claimHash) continue;
    const session: Session = { id: run.tenantId, expiresAt: new Date(row.expires_at).toISOString(), discoveryRequests: row.discovery_requests, liveRebuilds: row.live_rebuilds };
    let amendment = run.amendmentId ? await loadAmendment(run.tenantId, run.amendmentId) : null;
    if (amendment?.acceptedAt || amendment?.status === "cancelled") continue;
    if (!amendment) {
      const candidates = (await database().query("SELECT payload FROM wk_repair_candidates WHERE tenant_id=$1 AND run_id=$2", [run.tenantId, run.id])).rows.map(row => row.payload as RepairCandidate);
      const available = candidates.filter(candidate => run.candidateIds.includes(candidate.id) && candidate.technicalState === "satisfied" && policy.vendorDomains.includes(candidate.offer.domain) && Date.parse(candidate.evidence.expiresAt) > Date.now()).sort((a, b) => a.rank - b.rank || a.offer.unitMinor - b.offer.unitMinor || a.id.localeCompare(b.id));
      if (!available[0]) continue;
      amendment = await proposeKitAmendment(session, run.id, available[0].id, available[0].digest);
    }
    const result = await acceptKitAmendment(session, { amendmentId: amendment.proposal.id, proposalDigest: amendment.proposal.digest, paymentMode: policy.paymentMode, authority: "policy", policyId: policy.id, origin: policy.origin });
    await repairTransaction(async db => {
      const latest = await loadRepair(run.tenantId, run.id, db, true);
      latest.automaticEvaluation = { policyId: policy.id, proposalId: result.proposal.id, claimHash, state: result.status, at: repairNow() }; await saveRepair(db, latest);
      await repairNotice(db, run.tenantId, `automatic:${policy.id}:${result.proposal.id}:${result.status}`, { kind: "kit-automatic-decision", title: result.acceptedAt ? "Your scoped kit allowance handled a change" : "This change needs a fresh decision", detail: result.reason, sourceMode: run.sourceMode, runId: run.id, amendmentId: result.proposal.id });
    });
    processed++; if (processed >= 1) break;
    } catch (error) {
      await repairTransaction(async db => {
        const latest = await loadRepair(run.tenantId, run.id, db, true);
        if (latest.phase !== "ready") return;
        const amendment = latest.amendmentId ? await loadAmendment(run.tenantId, latest.amendmentId, db) : null;
        if (amendment?.acceptedAt) return;
        const needsReview = error instanceof WorldKitError && error.status < 500;
        latest.reason = error instanceof WorldKitError ? error.message : "The automatic decision could not finish. Its saved proposal remains available and no replacement payment was created.";
        if (needsReview) latest.phase = "stale";
        else latest.nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
        await saveRepair(db, latest);
        await repairNotice(db, run.tenantId, `automatic-error:${policy.id}:${latest.amendmentId ?? run.id}:${hash(latest.reason)}`, { kind: "kit-automatic-review", title: needsReview ? "A fresh repair review is needed" : "The saved repair will be checked again", detail: latest.reason, sourceMode: run.sourceMode, runId: run.id, amendmentId: latest.amendmentId });
      });
    }
  }
  return processed;
}
