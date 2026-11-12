import type { PoolClient } from "pg";
import { WorldKitError } from "../../packages/contracts/index";
import { database, initialize, transaction } from "./db";
const state = globalThis as unknown as { worldkitSessionLimits1?: Promise<void> };
export class SessionLimitError extends WorldKitError {
  constructor(readonly retryAfter: number) { super("rate_limited", "New private workspaces are temporarily limited. Existing saved workspaces remain usable; return shortly to open another one.", 429, "Reopen your existing workbench"); }
}
export function initializeSessionLimits() { return state.worldkitSessionLimits1 ??= initialize().then(async () => { await database().query("CREATE TABLE IF NOT EXISTS wk_session_windows(namespace text NOT NULL,period text NOT NULL,window_start timestamptz NOT NULL,count integer NOT NULL DEFAULT 0,PRIMARY KEY(namespace,period,window_start))"); }).catch(error => { state.worldkitSessionLimits1 = undefined; throw error; }); }
/** Deployment-wide counters prevent deleting cookies from resetting all public
 * provider allowances. Existing session reads never pass through this gate. */
export async function claimSessionCreation(namespace = "public-worldkit", limits = { hour: 30, day: 200 }, client?: PoolClient) {
  await initializeSessionLimits();
  const claim = async (db: PoolClient) => {
    const periods = ["hour", "day"] as const;
    for (const period of periods) await db.query("INSERT INTO wk_session_windows(namespace,period,window_start) VALUES($1,$2,date_trunc($2,now())) ON CONFLICT DO NOTHING", [namespace, period]);
    for (const period of periods) {
      const row = (await db.query("SELECT count,ceil(extract(epoch FROM (window_start + CASE WHEN period='hour' THEN interval '1 hour' ELSE interval '1 day' END)-now()))::int AS retry_after FROM wk_session_windows WHERE namespace=$1 AND period=$2 AND window_start=date_trunc($2,now()) FOR UPDATE", [namespace, period])).rows[0];
      if (row.count >= limits[period]) throw new SessionLimitError(Math.max(1, row.retry_after));
    }
    for (const period of periods) await db.query("UPDATE wk_session_windows SET count=count+1 WHERE namespace=$1 AND period=$2 AND window_start=date_trunc($2,now())", [namespace, period]);
  };
  if (client) await claim(client); else await transaction(claim);
}
