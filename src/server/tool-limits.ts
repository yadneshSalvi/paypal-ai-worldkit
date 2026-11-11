import { randomUUID } from "node:crypto";
import { WorldKitError, type Principal, type ToolScope } from "../../packages/contracts/index";
import { database, initialize, transaction } from "./db";
export type LimitedTool = "verify_kit" | "repair_kit" | "quote_kit" | "read_payment_evidence";
const policy: Record<LimitedTool, { scope: ToolScope; count: number; seconds: number }> = {
  verify_kit: { scope: "kit:verify", count: 60, seconds: 60 },
  repair_kit: { scope: "kit:propose", count: 5, seconds: 3600 },
  quote_kit: { scope: "kit:quote", count: 2, seconds: 60 },
  read_payment_evidence: { scope: "payment:read", count: 4, seconds: 60 },
};
const state = globalThis as unknown as { worldkitMcpLimits1?: Promise<void> };
function init() { return state.worldkitMcpLimits1 ??= initialize().then(async () => { await database().query("CREATE TABLE IF NOT EXISTS wk_mcp_runs(id text PRIMARY KEY,token_id text NOT NULL REFERENCES wk_access_tokens(id),tenant_id text NOT NULL,tool text NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz NOT NULL,completed_at timestamptz); CREATE INDEX IF NOT EXISTS wk_mcp_runs_token_time ON wk_mcp_runs(token_id,started_at)"); }).catch(error => { state.worldkitMcpLimits1 = undefined; throw error; }); }
export async function claimTool(principal: Principal, tool: LimitedTool): Promise<string> {
  await init(); const rule = policy[tool];
  return transaction(async db => {
    const row = (await db.query("SELECT scopes FROM wk_access_tokens WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE", [principal.id, principal.tenantId])).rows[0];
    if (!row || !row.scopes.includes(rule.scope)) throw new WorldKitError("forbidden", "This scoped grant was revoked, expired, or does not allow the tool.", 403);
    const active = await db.query("SELECT count(*)::int AS count FROM wk_mcp_runs WHERE token_id=$1 AND completed_at IS NULL AND lease_until>now()", [principal.id]);
    if (active.rows[0].count >= 2) throw new WorldKitError("rate_limited", "Two tools are already running for this grant. Wait for one to finish.", 429);
    const rate = await db.query("SELECT count(*)::int AS count FROM wk_mcp_runs WHERE token_id=$1 AND tool=$2 AND started_at>now()-($3*interval '1 second')", [principal.id, tool, rule.seconds]);
    if (rate.rows[0].count >= rule.count) throw new WorldKitError("rate_limited", `${tool} permits ${rule.count} calls per ${rule.seconds === 3600 ? "hour" : "minute"} for this grant. Your saved kit is unchanged.`, 429);
    const id = randomUUID(); await db.query("INSERT INTO wk_mcp_runs(id,token_id,tenant_id,tool,lease_until) VALUES($1,$2,$3,$4,now()+interval '45 seconds')", [id, principal.id, principal.tenantId, tool]); return id;
  });
}
export async function releaseTool(principal: Principal, id: string) { await database().query("UPDATE wk_mcp_runs SET completed_at=now() WHERE id=$1 AND token_id=$2 AND tenant_id=$3", [id, principal.id, principal.tenantId]); }
