import { Pool, type PoolClient } from "pg";

const globalDb = globalThis as unknown as { worldkitPool?: Pool; worldkitSchema?: Promise<void> };
export function database(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("WorldKit database is not configured.");
  return globalDb.worldkitPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 6, connectionTimeoutMillis: 8000, statement_timeout: 12000, idleTimeoutMillis: 20000 });
}
export async function transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  await initialize(); const db = await database().connect();
  try { await db.query("BEGIN"); const value = await work(db); await db.query("COMMIT"); return value; }
  catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
export function initialize(): Promise<void> {
  return globalDb.worldkitSchema ??= database().query(`
    CREATE TABLE IF NOT EXISTS wk_sessions (
      id text PRIMARY KEY, token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), discovery_requests integer NOT NULL DEFAULT 0,
      live_rebuilds integer NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS wk_kits (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), current_revision_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wk_revisions (
      id text PRIMARY KEY, kit_id text NOT NULL REFERENCES wk_kits(id), tenant_id text NOT NULL REFERENCES wk_sessions(id),
      revision integer NOT NULL, kit jsonb NOT NULL, certificate jsonb NOT NULL, profiles jsonb NOT NULL,
      sources jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(kit_id, revision)
    );
    CREATE TABLE IF NOT EXISTS wk_events (
      sequence bigserial PRIMARY KEY, id text UNIQUE NOT NULL, tenant_id text NOT NULL REFERENCES wk_sessions(id),
      payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS wk_events_tenant_sequence ON wk_events(tenant_id, sequence);
    CREATE TABLE IF NOT EXISTS wk_catalog (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), product_id text NOT NULL,
      snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wk_provider_receipts (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), provider text NOT NULL,
      payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wk_step_checks (
      tenant_id text NOT NULL REFERENCES wk_sessions(id), revision_id text NOT NULL REFERENCES wk_revisions(id),
      step_id text NOT NULL, completed boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(tenant_id, revision_id, step_id)
    );
    CREATE TABLE IF NOT EXISTS wk_access_tokens (
      id text PRIMARY KEY, token_hash text UNIQUE NOT NULL, tenant_id text NOT NULL REFERENCES wk_sessions(id),
      scopes jsonb NOT NULL, kit_ids jsonb NOT NULL, expires_at timestamptz NOT NULL,
      revoked_at timestamptz, request_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wk_quotes (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wk_jobs (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), kind text NOT NULL,
      status text NOT NULL, input jsonb NOT NULL, output jsonb, error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `).then(() => undefined).catch(error => { globalDb.worldkitSchema = undefined; throw error; });
}
export async function closeDatabase() { const pool = globalDb.worldkitPool; globalDb.worldkitPool = undefined; globalDb.worldkitSchema = undefined; if (pool) await pool.end(); }
