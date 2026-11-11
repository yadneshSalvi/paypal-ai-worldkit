import type { PoolClient } from "pg";
import type { CommerceOrder } from "../../packages/commerce/contracts";
import { database } from "./db";

/** Authenticated callbacks are a reason to reconcile before granting fresh
 * authority. An older core receipt cannot clear an unfinished event. */
export async function unresolvedPaymentEvents(orders: Pick<CommerceOrder, "id" | "sourceMode">[], db: Pick<PoolClient, "query"> = database()): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!orders.length || !(await db.query("SELECT to_regclass('wk_webhook_events') AS present")).rows[0]?.present) return result;
  const rows = await db.query("SELECT owner_key,source_mode,count(*)::int AS count FROM wk_webhook_events WHERE provider='paypal' AND owner_key=ANY($1::text[]) AND state IN ('queued','processing','retry_wait','dead_letter') AND signal IS NOT NULL AND event_type LIKE 'PAYMENT.%' GROUP BY owner_key,source_mode", [orders.map(order => `payment:${order.id}`)]);
  for (const order of orders) {
    const source = order.sourceMode === "live_sandbox" ? "live" : order.sourceMode;
    const row = rows.rows.find(row => row.owner_key === `payment:${order.id}` && row.source_mode === source);
    if (row) result.set(order.id, row.count);
  }
  return result;
}
