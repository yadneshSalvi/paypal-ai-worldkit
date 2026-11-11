import type { ProviderResource } from "@fracture/paypal-core";
import type { PoolClient } from "pg";
import type { CommerceOrder } from "../../packages/commerce/contracts";
import { WorldKitError } from "../../packages/contracts";

/** The canonical projection keeps the newest observation. Original receipts
 * remain immutable in the core, including observations this projection rejects. */
export async function storeOwnedPaymentResource(db: Pick<PoolClient, "query">, order: CommerceOrder, resource: ProviderResource): Promise<boolean> {
  if (resource.source !== order.sourceMode || !Number.isFinite(Date.parse(resource.observedAt)) || resource.money && (!Number.isSafeInteger(resource.money.minor) || resource.money.minor < 0)) throw new WorldKitError("needs_evidence", "This payment observation has an inconsistent source, amount or time.", 409);
  const updated = await db.query(`INSERT INTO wk_payment_resources(provider_id,tenant_id,order_id,kind,payload) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(provider_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()
    WHERE wk_payment_resources.tenant_id=EXCLUDED.tenant_id AND wk_payment_resources.order_id=EXCLUDED.order_id
      AND wk_payment_resources.kind=EXCLUDED.kind AND wk_payment_resources.payload->>'source'=EXCLUDED.payload->>'source'
      AND (wk_payment_resources.payload->>'observedAt')::timestamptz<=(EXCLUDED.payload->>'observedAt')::timestamptz RETURNING provider_id`, [resource.id, order.tenantId, order.id, resource.kind, resource]);
  if (updated.rowCount) return true;
  const previous = (await db.query("SELECT tenant_id,order_id,kind,payload FROM wk_payment_resources WHERE provider_id=$1", [resource.id])).rows[0];
  if (!previous || previous.tenant_id !== order.tenantId || previous.order_id !== order.id || previous.kind !== resource.kind || previous.payload.source !== resource.source) throw new WorldKitError("forbidden", "This payment resource belongs to a different order or evidence source.", 403);
  return false;
}

export async function orderResources(db: Pick<PoolClient, "query">, order: Pick<CommerceOrder, "id" | "tenantId">): Promise<ProviderResource[]> {
  return (await db.query("SELECT payload FROM wk_payment_resources WHERE tenant_id=$1 AND order_id=$2", [order.tenantId, order.id])).rows.map(row => row.payload as ProviderResource);
}
