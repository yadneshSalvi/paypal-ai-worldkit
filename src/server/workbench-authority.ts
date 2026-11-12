import type { PoolClient } from "pg";
import { WorldKitError } from "../../packages/contracts";
import { hash } from "../../packages/compatibility";
import type { Session } from "./repository";

export function workbenchLive(expiresAt: string) {
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())
    throw new WorldKitError("forbidden", "This saved workspace has expired. Its original work and deadline are retained.", 401);
}
/** All workbench writers lock the same owner before locking the current graph. */
export async function authorizeWorkbench(db: PoolClient, session: Session) {
  const row = (await db.query("SELECT id,expires_at FROM wk_sessions WHERE id=$1 FOR UPDATE", [session.id])).rows[0];
  if (!row) throw new WorldKitError("forbidden", "Open the original private workspace to continue.", 401);
  const expiresAt = new Date(row.expires_at).toISOString();
  workbenchLive(expiresAt);
  return { expiresAt, workspaceKey: hash({ scope: "worldkit.workbench.v1", actorId: row.id, tenantId: row.id, expiresAt }) };
}
