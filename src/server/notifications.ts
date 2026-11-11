import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { InAppNotification } from "../../packages/living-kit/contracts";
import { WorldKitError } from "../../packages/contracts";
import { database } from "./db";
import { initializeLiving } from "./living-db";

/** Availability in the private workbench is the delivery channel. No email,
 * device push, external support delivery or human recipient is inferred. */
export async function publishNotification(db: PoolClient, tenantId: string, causeKey: string, message: Omit<InAppNotification, "id" | "createdAt" | "readAt" | "delivery">) {
  const id = randomUUID();
  const payload = { ...message, channel: "in_app", createdAt: new Date().toISOString() };
  await db.query("INSERT INTO wk_notifications(id,tenant_id,kind,cause_key,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,cause_key) WHERE cause_key IS NOT NULL DO NOTHING", [id, tenantId, message.kind, causeKey, payload]);
}
export async function notifications(tenantId: string): Promise<InAppNotification[]> {
  await initializeLiving();
  const rows = await database().query("SELECT * FROM wk_notifications WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100", [tenantId]);
  return rows.rows.map(row => ({ id: row.id, kind: row.kind, title: row.payload.title ?? (row.kind === "support-request" ? "Your support request is saved" : "Your Studio order has an update"), detail: row.payload.detail ?? (row.kind === "support-request" ? "The request is retained in this private workbench. No external support delivery is claimed." : "Open Studio to review the retained payment record."), sourceMode: ["live", "sample", "replay", "modelled"].includes(row.payload.sourceMode) ? row.payload.sourceMode : row.payload.source === "live_sandbox" ? "live" : "sample", createdAt: new Date(row.created_at).toISOString(), readAt: row.read_at ? new Date(row.read_at).toISOString() : null, incidentId: row.payload.incidentId ?? null, orderId: row.payload.orderId ?? null, delivery: "available_in_workbench" }));
}
export async function readNotification(tenantId: string, id: string): Promise<void> {
  await initializeLiving();
  const result = await database().query("UPDATE wk_notifications SET read_at=coalesce(read_at,now()) WHERE tenant_id=$1 AND id=$2 RETURNING id", [tenantId, id]);
  if (!result.rowCount) throw new WorldKitError("not_found", "That notification is not in this workspace.", 404);
}
