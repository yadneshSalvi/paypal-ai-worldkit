import { WorldKitError } from "../../packages/contracts";
import { transaction } from "./db";
import { processCommercialEvent, type CommercialRuntime } from "./living-kit";
import { processPaymentEvent, type PaymentReadRuntime } from "./payment-events";
import { assertWebhookLease, claimWebhook, failWebhook, finishWebhook, routeEventOwners, type WebhookClaim } from "./webhooks";

export type WebhookRuntime = { catalog?: CommercialRuntime; payments?: PaymentReadRuntime };
export async function executeWebhook(job: WebhookClaim, runtime: WebhookRuntime = {}): Promise<void> {
  try {
    if (!job.signal) { await finishWebhook(job, "dead_letter", null, "The authenticated event schema needs review."); return; }
    const owners = await routeEventOwners(job.provider, job.signal, job.source_mode);
    if (owners.ambiguous) { await finishWebhook(job, "dead_letter", null, "The event relates to more than one owned order. No observation was applied."); return; }
    if (!owners.ownerKey) {
      const expired = Date.now() - new Date(job.received_at).getTime() >= 15 * 60_000;
      await finishWebhook(job, expired ? "ignored" : "retry_wait", { financialWrites: 0 }, expired ? "unowned" : "Waiting for a matching saved subscription or accepted payment operation.", 60); return;
    }
    const canRun = await transaction(async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('worldkit:webhook-claim:v1'))"); await assertWebhookLease(db, job);
      const busy = await db.query("SELECT id FROM wk_webhook_events WHERE id<>$1 AND owner_key=$2 AND state='processing' AND lease_expires_at>now() LIMIT 1", [job.id, owners.ownerKey]);
      if (busy.rowCount) return false;
      await db.query("UPDATE wk_webhook_events SET owner_key=$2,tenant_ids=$3 WHERE id=$1", [job.id, owners.ownerKey, JSON.stringify(owners.tenantIds)]); return true;
    });
    if (!canRun) { await finishWebhook(job, "retry_wait", null, "A prior event for this same resource is still being reconciled.", 5); return; }
    if (job.provider === "channel3") {
      if (job.source_mode !== "live" && !runtime.catalog) throw new WorldKitError("needs_evidence", "This scenario needs its declared catalog context; it cannot impersonate a live delivery.", 409);
      await processCommercialEvent(job, owners, runtime.catalog);
    } else {
      if (job.source_mode !== "live" && !runtime.payments) throw new WorldKitError("needs_evidence", "This payment scenario needs its declared read-only provider context.", 409);
      await processPaymentEvent(job, owners, runtime.payments);
    }
  } catch (error) {
    if (error instanceof WorldKitError && error.code === "stale_revision") return;
    if (error instanceof WorldKitError && error.status < 500) await finishWebhook(job, "dead_letter", null, error.message);
    else await failWebhook(job);
  }
}
export async function processWebhookQueue(tenantId?: string, runtime: WebhookRuntime = {}, namespace = "live"): Promise<number> {
  const results = await Promise.allSettled([0, 1].map(async () => { const job = await claimWebhook(tenantId, namespace); if (!job) return false; await executeWebhook(job, runtime); return true; }));
  return results.filter(result => result.status === "fulfilled" && result.value).length;
}
