import { walletView, type CommerceOrder, type WalletConsent } from "../../packages/commerce/contracts";
import type { KitAmendment, KitRepairClaim, KitRepairPolicy, RepairRunSummary, RepairView } from "../../packages/living-repair/contracts";
import { grossAllowance } from "../../packages/living-repair/policy";
import { database } from "./db";
import { processRepairQueue } from "./living-repair";
import { processAutomaticKitRepairs } from "./living-repair-automatic";
import { refreshKitCompensation } from "./living-repair-compensation";
import { initializeLivingRepair } from "./living-repair-db";
import { paypalRepairReady, refreshKitAmendment } from "./living-repair-payments";
import { drainRepairNotices, loadRepair } from "./living-repair-store";
import { unresolvedPaymentEvents } from "./payment-event-holds";
import type { Session } from "./repository";
import { unseal } from "./secrets";

export async function livingRepairView(session: Session, runId?: string): Promise<RepairView> {
  await initializeLivingRepair();
  const runs = (await database().query(`SELECT jsonb_build_object('id',r.id,'sourceMode',r.source_mode,'phase',r.phase,'title',r.payload->'title','createdAt',r.payload->'createdAt','amendmentId',r.payload->'amendmentId','amendmentStatus',a.state) AS summary
    FROM wk_living_repairs r LEFT JOIN wk_kit_amendments a ON a.id=r.payload->>'amendmentId' AND a.tenant_id=r.tenant_id
    WHERE r.tenant_id=$1 ORDER BY r.created_at DESC LIMIT 30`, [session.id])).rows.map(row => row.summary as RepairRunSummary);
  const selectedId = runId ?? runs[0]?.id; const selected = selectedId ? await loadRepair(session.id, selectedId) : null;
  if (selected && !runs.some(run => run.id === selected.id)) runs.unshift({ id: selected.id, sourceMode: selected.sourceMode, phase: selected.phase, title: selected.title, createdAt: selected.createdAt, amendmentId: selected.amendmentId, amendmentStatus: null });
  const result = await Promise.all([
    database().query("SELECT payload FROM wk_repair_candidates WHERE tenant_id=$1 AND run_id=$2 AND id=ANY($3::text[]) ORDER BY (payload->>'rank')::int,created_at LIMIT 30", [session.id, selected?.id ?? null, selected?.candidateIds ?? []]),
    database().query("SELECT payload FROM wk_kit_commitments WHERE tenant_id=$1 AND id=$2", [session.id, selected?.commitmentId ?? null]),
    database().query("SELECT proposal,payload FROM wk_kit_amendments WHERE tenant_id=$1 AND id=$2", [session.id, selected?.amendmentId ?? null]),
    database().query("SELECT payload FROM wk_kit_repair_policies WHERE tenant_id=$1 AND commitment_id=$2 ORDER BY created_at DESC", [session.id, selected?.commitmentId ?? null]),
    database().query("SELECT payload FROM wk_kit_repair_claims WHERE tenant_id=$1 AND commitment_id=$2 ORDER BY created_at DESC", [session.id, selected?.commitmentId ?? null]),
    database().query("SELECT payload FROM wk_kit_compensations WHERE tenant_id=$1 AND amendment_id=$2 ORDER BY created_at DESC", [session.id, selected?.amendmentId ?? null]),
    database().query("SELECT payload FROM wk_commerce_orders WHERE tenant_id=$1 AND payload->'livingRepair'->>'amendmentId'=$2 ORDER BY created_at DESC", [session.id, selected?.amendmentId ?? null]),
    database().query("SELECT payload FROM wk_wallet_consents WHERE tenant_id=$1 ORDER BY created_at DESC", [session.id]),
    database().query("SELECT payload FROM wk_kit_repair_outbox WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100", [session.id]),
  ]);
  const [candidates, commitments, amendments, policies, claims, compensations, orders, wallets, notices] = result;
  const savedClaims = claims!.rows.map(row => row.payload as KitRepairClaim); const savedOrders = orders!.rows.map(row => row.payload as CommerceOrder); const holds = await unresolvedPaymentEvents(savedOrders);
  return { run: selected, runs, candidates: candidates!.rows.map(row => row.payload), commitments: commitments!.rows.map(row => row.payload), amendments: amendments!.rows.map(row => ({ ...row.payload, proposal: row.proposal })), policies: policies!.rows.map(row => { const policy = row.payload as KitRepairPolicy; const allowance = grossAllowance(savedClaims, policy.id); return { ...policy, consumedMinor: allowance.consumedMinor, pendingMinor: allowance.pendingMinor, remainingMinor: Math.max(0, policy.capMinor - allowance.claimedMinor) }; }), claims: savedClaims, compensations: compensations!.rows.map(row => row.payload), orders: savedOrders.map(order => holds.has(order.id) ? { ...order, state: "payment_pending", error: "An authenticated payment update is still being reconciled. The original gross history remains saved." } : order), wallets: wallets!.rows.map(row => walletView(unseal<WalletConsent>(session.id, row.payload))), notices: notices!.rows.map(row => row.payload), readiness: { catalog: Boolean(process.env.CHANNEL3_API_KEY), paypal: paypalRepairReady(), boundary: "Channel3 supplies discovery and current offer observations. WorldKit Studio commitments are controlled demonstrations; no retailer order, reservation, fulfillment or refund is made." } };
}
export async function processRepairMaintenance(tenantId?: string): Promise<{ repairChecks: number; repairErrors: number }> {
  await initializeLivingRepair(); let checks = 0; let errors = 0;
  try { checks += await processRepairQueue(tenantId); } catch { errors++; }
  try { checks += await processAutomaticKitRepairs(tenantId); } catch { errors++; }
  const rows = await database().query("SELECT a.id,a.tenant_id FROM wk_kit_amendments a JOIN wk_sessions s ON s.id=a.tenant_id WHERE a.state IN ('payment_pending','requires_payment_approval','ready_to_commit') AND ($1::text IS NULL OR a.tenant_id=$1) ORDER BY a.updated_at LIMIT 2", [tenantId ?? null]);
  for (const row of rows.rows) {
    try { const session = await retainedSession(row.tenant_id); if (session) { await refreshKitAmendment(session, row.id); checks++; } } catch { errors++; }
  }
  const compensations = await database().query("SELECT id,tenant_id FROM wk_kit_compensations WHERE state IN ('payment_pending','requires_payment_approval','refund_pending','restoring') AND payload->>'consentedAt' IS NOT NULL AND ($1::text IS NULL OR tenant_id=$1) ORDER BY updated_at LIMIT 2", [tenantId ?? null]);
  for (const row of compensations.rows) {
    try { const session = await retainedSession(row.tenant_id); if (session) { await refreshKitCompensation(session, row.id); checks++; } } catch { errors++; }
  }
  try { await drainRepairNotices(tenantId); } catch { errors++; }
  return { repairChecks: checks, repairErrors: errors };
}
// Read-only reconciliation can outlive browser authority. Financial dispatch still
// checks the real session expiry in the existing domain payment authorization.
async function retainedSession(id: string): Promise<Session | null> {
  const row = (await database().query("SELECT * FROM wk_sessions WHERE id=$1", [id])).rows[0];
  return row ? { id, expiresAt: new Date(row.expires_at).toISOString(), discoveryRequests: row.discovery_requests, liveRebuilds: row.live_rebuilds } : null;
}
