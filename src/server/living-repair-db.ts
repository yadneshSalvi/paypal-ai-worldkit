import { database, transaction } from "./db";
import { initializeLiving } from "./living-db";

const shared = globalThis as unknown as { worldkitLivingRepairSchema?: Promise<void> };
/** Additive source-owned migration. It runs against the caller's configured schema;
 * hosted/original schema application remains a release action owned by the lead. */
export function initializeLivingRepair(): Promise<void> {
  return shared.worldkitLivingRepairSchema ??= initializeLiving().then(async () => {
    await database().query(`
      CREATE TABLE IF NOT EXISTS wk_living_repairs (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id) ON DELETE CASCADE,
        cause_key text NOT NULL, source_mode text NOT NULL, phase text NOT NULL, payload jsonb NOT NULL,
        lease_token text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(tenant_id,source_mode,cause_key)
      );
      CREATE INDEX IF NOT EXISTS wk_living_repairs_queue ON wk_living_repairs(phase,next_attempt_at,lease_until);
      CREATE TABLE IF NOT EXISTS wk_repair_candidates (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id) ON DELETE CASCADE,
        run_id text NOT NULL REFERENCES wk_living_repairs(id) ON DELETE CASCADE, digest text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_kit_commitments (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id) ON DELETE CASCADE,
        kit_id text NOT NULL, version integer NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_kit_commitment_versions (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id) ON DELETE CASCADE,
        commitment_id text NOT NULL REFERENCES wk_kit_commitments(id) ON DELETE CASCADE,
        version integer NOT NULL, amendment_id text, kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(commitment_id,version)
      );
      CREATE TABLE IF NOT EXISTS wk_kit_amendments (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id) ON DELETE CASCADE,
        run_id text NOT NULL REFERENCES wk_living_repairs(id) ON DELETE CASCADE, candidate_id text NOT NULL REFERENCES wk_repair_candidates(id),
        commitment_id text NOT NULL REFERENCES wk_kit_commitments(id), proposal jsonb NOT NULL, proposal_digest text NOT NULL,
        state text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(run_id,candidate_id,proposal_digest)
      );
      CREATE TABLE IF NOT EXISTS wk_kit_repair_policies (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id) ON DELETE CASCADE,
        commitment_id text NOT NULL REFERENCES wk_kit_commitments(id), payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_kit_repair_claims (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id) ON DELETE CASCADE,
        amendment_id text NOT NULL UNIQUE REFERENCES wk_kit_amendments(id), commitment_id text NOT NULL REFERENCES wk_kit_commitments(id),
        policy_id text REFERENCES wk_kit_repair_policies(id), order_id text, state text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_kit_compensations (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id) ON DELETE CASCADE,
        amendment_id text NOT NULL REFERENCES wk_kit_amendments(id), kind text NOT NULL, state text NOT NULL,
        payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(amendment_id,kind)
      );
      CREATE TABLE IF NOT EXISTS wk_kit_repair_outbox (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id) ON DELETE CASCADE,
        cause_key text NOT NULL, payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0, delivered_at timestamptz,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,cause_key)
      );
      CREATE TABLE IF NOT EXISTS wk_kit_sample_payments (
        operation_id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id) ON DELETE CASCADE,
        order_id text NOT NULL, command_digest text NOT NULL, receipt jsonb NOT NULL, response_lost boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }).catch(error => { shared.worldkitLivingRepairSchema = undefined; throw error; });
}
export async function repairTransaction<T>(work: Parameters<typeof transaction<T>>[0]): Promise<T> { await initializeLivingRepair(); return transaction(work); }
