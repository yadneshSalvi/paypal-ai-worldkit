import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { WorldKitError } from "../../packages/contracts";
import { WorkspaceAdmissionSchema, type WorkspaceAdmission } from "../../packages/workspace-entry";
import { database, transaction } from "./db";
import { createSession, type Session } from "./repository";
import { seal, unseal } from "./secrets";
import { claimSessionCreation, initializeSessionLimits } from "./session-limits";

const state = globalThis as unknown as { worldkitAdmission1?: Promise<void> };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (message: string, status = 409): never => { throw new WorldKitError(status === 410 ? "forbidden" : "invalid_request", message, status); };
export function initializeWorkspaceAdmission() {
  return state.worldkitAdmission1 ??= initializeSessionLimits().then(async () => {
    await database().query(`
      CREATE TABLE IF NOT EXISTS wk_workspace_admissions (
        request_id uuid PRIMARY KEY, request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
        session_id text NOT NULL REFERENCES wk_sessions(id), original_expires_at timestamptz NOT NULL,
        result_sealed jsonb NOT NULL, admission_kind text NOT NULL CHECK (admission_kind IN ('created','existing')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX IF NOT EXISTS wk_workspace_admissions_session ON wk_workspace_admissions(session_id);
      CREATE OR REPLACE FUNCTION wk_workspace_admission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Workspace admission receipts are immutable'; END $$;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='wk_workspace_admission_immutable' AND tgrelid='wk_workspace_admissions'::regclass) THEN
          CREATE TRIGGER wk_workspace_admission_immutable BEFORE UPDATE OR DELETE ON wk_workspace_admissions FOR EACH ROW EXECUTE FUNCTION wk_workspace_admission_immutable();
        END IF;
      END $$;
    `);
  }).catch(error => { state.worldkitAdmission1 = undefined; throw error; });
}
function sessionOf(row: any): Session {
  return { id: row.id, expiresAt: new Date(row.expires_at).toISOString(), discoveryRequests: row.discovery_requests, liveRebuilds: row.live_rebuilds };
}
async function currentCookie(db: PoolClient, token: string | undefined) {
  if (!token || token.length > 200) return null;
  const row = (await db.query("SELECT id,expires_at,discovery_requests,live_rebuilds FROM wk_sessions WHERE token_hash=$1 FOR SHARE", [digest(token)])).rows[0];
  return row && new Date(row.expires_at).getTime() > Date.now() ? sessionOf(row) : null;
}
export type AdmissionResult = { session: Session; token: string; disposition: "created" | "recovered" | "existing"; setCookie: boolean };
/** An explicit, durable operation. Its recovery key can restore only its original
 * still-live session; neither a retry nor a new cookie extends that deadline. */
export async function admitWorkspace(input: WorkspaceAdmission, cookieToken?: string): Promise<AdmissionResult> {
  const command = WorkspaceAdmissionSchema.parse(input);
  const requestHash = digest(JSON.stringify(command));
  await initializeWorkspaceAdmission();
  const result = await transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`worldkit:admission:${command.requestId}`]);
    const prior = (await db.query("SELECT * FROM wk_workspace_admissions WHERE request_id=$1", [command.requestId])).rows[0];
    const existing = await currentCookie(db, cookieToken);
    if (prior) {
      if (prior.request_hash !== requestHash) fail("This Sample request has different recovery details. Keep its original saved request.");
      if (existing && existing.id !== prior.session_id) fail("A different saved workspace is already open. It has been preserved; check the saved workbench before recovering this request.");
      const row = (await db.query("SELECT id,token_hash,expires_at,discovery_requests,live_rebuilds FROM wk_sessions WHERE id=$1 FOR SHARE", [prior.session_id])).rows[0];
      if (!row || new Date(row.expires_at).getTime() <= Date.now() || new Date(prior.original_expires_at).getTime() <= Date.now()) fail("This original Sample workspace has expired. Recovery cannot extend it. Start another Sample only as a new explicit action.", 410);
      const saved = unseal<{ token: string; sessionId: string; expiresAt: string }>(`workspace-admission:${command.requestId}`, prior.result_sealed);
      const session = sessionOf(row);
      if (saved.sessionId !== session.id || saved.expiresAt !== session.expiresAt || saved.expiresAt !== new Date(prior.original_expires_at).toISOString() || digest(saved.token) !== row.token_hash) fail("The original recovery receipt could not be matched. Your existing workspace has not been changed.", 503);
      return { session, token: saved.token, disposition: "recovered" as const, setCookie: !existing };
    }
    let token: string, session: Session, disposition: "created" | "existing";
    if (existing && cookieToken) {
      // Serialize this small per-session receipt limit; no admission counter or
      // session field is written when an existing workspace is acknowledged.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`worldkit:admission-session:${existing.id}`]);
      const count = Number((await db.query("SELECT count(*) AS count FROM wk_workspace_admissions WHERE session_id=$1", [existing.id])).rows[0].count);
      if (count >= 32) fail("Your saved workspace is already open. Use Check saved workbench to continue.", 429);
      if (Date.parse(existing.expiresAt) <= Date.now()) fail("This workspace expired while the request was waiting. Its original deadline is unchanged.", 410);
      token = cookieToken; session = existing; disposition = "existing";
    } else {
      await claimSessionCreation("public-worldkit", { hour: 30, day: 200 }, db);
      ({ token, session } = await createSession(db)); disposition = "created";
    }
    const sealed = seal(`workspace-admission:${command.requestId}`, { token, sessionId: session.id, expiresAt: session.expiresAt });
    await db.query("INSERT INTO wk_workspace_admissions(request_id,request_hash,session_id,original_expires_at,result_sealed,admission_kind) VALUES($1,$2,$3,$4,$5,$6)", [command.requestId, requestHash, session.id, session.expiresAt, sealed, disposition]);
    return { token, session, disposition, setCookie: disposition === "created" };
  });
  if (Date.parse(result.session.expiresAt) <= Date.now()) fail("The original workspace expired before the response was ready. Its receipt remains available; its expiry was not renewed.", 410);
  return result;
}
