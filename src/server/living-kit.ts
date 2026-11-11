import { randomUUID } from "node:crypto";
import { retrieveProduct } from "../../packages/channel3/client";
import { hash } from "../../packages/compatibility";
import { WorldKitError, type CatalogReceipt, type CatalogSnapshot, type DeviceProfile } from "../../packages/contracts";
import { catalogIdentityMatches } from "../../packages/inventory/identity";
import { assessOfferImpact } from "../../packages/living-kit/impact";
import type { LivingIncident, LivingView } from "../../packages/living-kit/contracts";
import type { CommercialSignal } from "../../packages/webhooks/contracts";
import { database } from "./db";
import { initializeLiving } from "./living-db";
import { initializeLivingRepair } from "./living-repair-db";
import { enqueueIncidentRepair } from "./living-repair";
import { notifications, publishNotification } from "./notifications";
import { appendEvent, saveCatalogResultInTransaction } from "./repository";
import { getOfferWatches } from "./subscriptions";
import { finishWebhook, webhookReadiness, webhookSummaries, type EventOwners, type WebhookClaim } from "./webhooks";

export type CommercialRuntime = { mode: "live" | "sample"; refresh: (productId: string, userId: string, selection: Record<string, string>) => Promise<{ value: { snapshot: CatalogSnapshot }; receipt: CatalogReceipt }> };
export async function livingView(tenantId: string): Promise<LivingView> {
  await initializeLiving();
  const [watches, incidents, messages, events] = await Promise.all([getOfferWatches(tenantId), database().query("SELECT payload FROM wk_living_incidents WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100", [tenantId]), notifications(tenantId), webhookSummaries(tenantId)]);
  return { watches, incidents: incidents.rows.map(row => row.payload), notifications: messages, events, readiness: webhookReadiness(), cadence: "priority_daily_refresh" };
}
export async function dismissIncident(tenantId: string, id: string): Promise<void> {
  await initializeLiving();
  const result = await database().query("UPDATE wk_living_incidents SET payload=jsonb_set(payload,'{dismissedAt}',to_jsonb(now()::text)),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id", [tenantId, id]);
  if (!result.rowCount) throw new WorldKitError("not_found", "This equipment update is not in your workspace.", 404);
}

export async function processCommercialEvent(job: WebhookClaim, owners: EventOwners, runtime: CommercialRuntime = { mode: "live", refresh: retrieveProduct }): Promise<void> {
  await initializeLivingRepair();
  const signal = job.signal as CommercialSignal;
  const rows = await database().query("SELECT w.*,i.payload AS item FROM wk_offer_watches w JOIN wk_inventory_items i ON i.id=w.item_id JOIN wk_sessions s ON s.id=w.tenant_id WHERE w.id=ANY($1::text[]) AND w.stopped_at IS NULL AND s.expires_at>now() AND (i.payload->>'version')::int=w.item_version AND i.payload->>'status'='active'", [owners.watchIds]);
  if (!rows.rowCount) { await finishWebhook(job, "ignored", { reason: "The matching equipment watches have ended." }); return; }
  const response = await runtime.refresh(signal.productId, rows.rows[0].tenant_id, Object.fromEntries(signal.selection.map(option => [option.name, option.label])));
  const current = response.value.snapshot;
  if (!Number.isFinite(Date.parse(current.observedAt)) || Date.now() - Date.parse(current.observedAt) > 120_000 || Date.parse(current.observedAt) > Date.now() + 5_000) throw new WorldKitError("provider_unavailable", "The refreshed catalog response did not establish current availability.", 503);
  const observedAt = new Date().toISOString();
  await finishWebhook(job, "completed", { productId: current.productId, responseHash: current.responseHash, snapshotHash: hash(current), observedAt, catalogSource: runtime.mode, financialWrites: 0 }, null, 0, async db => {
    const stored = new Map<string, CatalogSnapshot>();
    for (const watch of rows.rows) {
      const active = (await db.query("SELECT w.id,i.payload AS item FROM wk_offer_watches w JOIN wk_inventory_items i ON i.id=w.item_id JOIN wk_sessions s ON s.id=w.tenant_id WHERE w.id=$1 AND w.stopped_at IS NULL AND s.expires_at>now() AND i.payload->>'status'='active' AND (i.payload->>'version')::int=w.item_version FOR UPDATE OF w", [watch.id])).rows[0];
      if (!active) continue;
      let snapshot = stored.get(watch.tenant_id);
      if (!snapshot) {
        snapshot = { ...current, id: randomUUID() }; stored.set(watch.tenant_id, snapshot);
        if (runtime.mode === "live") await saveCatalogResultInTransaction(db, watch.tenant_id, [snapshot], { ...response.receipt, id: randomUUID() });
      }
      const profile = active.item.profile as DeviceProfile;
      const impact = catalogIdentityMatches(snapshot, profile) ? assessOfferImpact(signal, snapshot) : { state: "needs_evidence" as const, title: "The exact model needs review", reason: "The refreshed catalog title or variant no longer matches the confirmed equipment profile. Review its identity before accepting a replacement.", currentPriceMinor: null };
      const revision = (await db.query("SELECT current_revision_id FROM wk_kits WHERE tenant_id=$1 LIMIT 1", [watch.tenant_id])).rows[0]?.current_revision_id ?? null;
      const incident: LivingIncident = { id: randomUUID(), webhookId: job.id, watchId: watch.id, itemId: watch.item_id, model: watch.payload.model, sourceMode: job.source_mode, catalogSource: runtime.mode, signal, impact, refreshed: snapshot, snapshotHash: hash(snapshot), observedAt, revisionId: revision, createdAt: observedAt, dismissedAt: null };
      const inserted = await db.query("INSERT INTO wk_living_incidents(id,tenant_id,webhook_id,watch_id,state,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(webhook_id,watch_id) DO NOTHING RETURNING id", [incident.id, watch.tenant_id, job.id, watch.id, impact.state, incident]);
      if (!inserted.rowCount) continue;
      if (impact.state === "needs_repair_review") await enqueueIncidentRepair(db, watch.tenant_id, incident);
      await appendEvent(db, watch.tenant_id, "offer.observed", impact.title, impact.reason, revision, job.source_mode);
      await publishNotification(db, watch.tenant_id, `webhook:${job.id}:watch:${watch.id}`, { kind: "equipment-update", title: impact.title, detail: `${watch.payload.model}: ${impact.reason}`, sourceMode: job.source_mode, incidentId: incident.id, orderId: null });
    }
  });
}
