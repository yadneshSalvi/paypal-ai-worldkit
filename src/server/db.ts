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
    ALTER TABLE wk_jobs ADD COLUMN IF NOT EXISTS managed boolean NOT NULL DEFAULT false;
    ALTER TABLE wk_jobs ADD COLUMN IF NOT EXISTS idempotency_key text;
    ALTER TABLE wk_jobs ADD COLUMN IF NOT EXISTS input_hash text;
    ALTER TABLE wk_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
    ALTER TABLE wk_jobs ADD COLUMN IF NOT EXISTS continuations integer NOT NULL DEFAULT 0;
    ALTER TABLE wk_jobs ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3;
    ALTER TABLE wk_jobs ADD COLUMN IF NOT EXISTS lease_token text;
    ALTER TABLE wk_jobs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
    ALTER TABLE wk_jobs ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE wk_jobs ADD COLUMN IF NOT EXISTS progress text;
    CREATE UNIQUE INDEX IF NOT EXISTS wk_jobs_idempotency ON wk_jobs(tenant_id,kind,idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS wk_jobs_recovery ON wk_jobs(status,next_attempt_at) WHERE managed=true;
    CREATE TABLE IF NOT EXISTS wk_job_attempts (
      job_id text NOT NULL REFERENCES wk_jobs(id), attempt integer NOT NULL, lease_token text NOT NULL,
      status text NOT NULL, receipt jsonb, error text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
      PRIMARY KEY(job_id,attempt)
    );
    CREATE TABLE IF NOT EXISTS wk_source_model_requests (
      operation_id text PRIMARY KEY, job_id text NOT NULL REFERENCES wk_jobs(id), tenant_id text NOT NULL REFERENCES wk_sessions(id),
      provider text NOT NULL, model text NOT NULL, request_hash text NOT NULL, phase text NOT NULL,
      response_id text, payload jsonb NOT NULL, cleanup_token text, cleanup_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job_id)
    );
    CREATE INDEX IF NOT EXISTS wk_source_model_active ON wk_source_model_requests(tenant_id,phase);
    CREATE TABLE IF NOT EXISTS wk_source_model_observations (
      sequence bigserial PRIMARY KEY, operation_id text NOT NULL REFERENCES wk_source_model_requests(operation_id),
      payload_hash text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(operation_id,payload_hash)
    );
    CREATE TABLE IF NOT EXISTS wk_source_documents (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), profile_id text NOT NULL,
      job_id text NOT NULL REFERENCES wk_jobs(id), source_url text NOT NULL, blob_path text NOT NULL,
      content_hash text, text_hash text, media_type text, bytes integer, payload jsonb,
      status text NOT NULL DEFAULT 'retrieving', created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, UNIQUE(job_id)
    );
    CREATE INDEX IF NOT EXISTS wk_source_documents_tenant ON wk_source_documents(tenant_id,profile_id,created_at);
    ALTER TABLE wk_source_documents ADD COLUMN IF NOT EXISTS write_until timestamptz;
    CREATE TABLE IF NOT EXISTS wk_source_heads (
      tenant_id text NOT NULL REFERENCES wk_sessions(id), profile_id text NOT NULL, document_id text NOT NULL REFERENCES wk_source_documents(id),
      version integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,profile_id)
    );
    CREATE TABLE IF NOT EXISTS wk_source_drafts (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), document_id text NOT NULL REFERENCES wk_source_documents(id),
      profile_id text NOT NULL, job_id text NOT NULL REFERENCES wk_jobs(id), payload jsonb NOT NULL, receipt jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job_id)
    );
    CREATE TABLE IF NOT EXISTS wk_source_review_requests (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), draft_id text NOT NULL REFERENCES wk_source_drafts(id),
      request_id text NOT NULL, input_hash text NOT NULL, assertion_ids jsonb NOT NULL, question text NOT NULL,
      status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS wk_source_profile_versions (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), profile_id text NOT NULL,
      draft_id text NOT NULL REFERENCES wk_source_drafts(id), source_document_id text NOT NULL REFERENCES wk_source_documents(id),
      payload jsonb NOT NULL, source jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,draft_id)
    );
    CREATE TABLE IF NOT EXISTS wk_catalog_categories (
      tenant_id text NOT NULL REFERENCES wk_sessions(id), id text NOT NULL, payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
    );
    CREATE TABLE IF NOT EXISTS wk_inventory_photos (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), blob_path text NOT NULL,
      blob_url text, content_hash text NOT NULL, mime text NOT NULL, width integer NOT NULL, height integer NOT NULL,
      bytes integer NOT NULL, source_mode text NOT NULL DEFAULT 'live', status text NOT NULL DEFAULT 'uploading',
      created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS wk_inventory_regions (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), photo_id text NOT NULL REFERENCES wk_inventory_photos(id),
      payload jsonb NOT NULL, job_id text, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wk_inventory_items (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), version integer NOT NULL,
      request_id text NOT NULL, request_hash text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(tenant_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS wk_inventory_history (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), item_id text NOT NULL REFERENCES wk_inventory_items(id),
      version integer NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(item_id,version)
    );
    CREATE TABLE IF NOT EXISTS wk_inventory_proposals (
      id text NOT NULL, tenant_id text NOT NULL REFERENCES wk_sessions(id), input_hash text NOT NULL,
      payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
      PRIMARY KEY(tenant_id,id)
    );
    CREATE TABLE IF NOT EXISTS wk_inventory_confirmations (
      tenant_id text NOT NULL REFERENCES wk_sessions(id), request_id text NOT NULL, input_hash text NOT NULL,
      preview_hash text NOT NULL, item_id text NOT NULL REFERENCES wk_inventory_items(id), payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,request_id)
    );
  `).then(() => undefined).catch(error => { globalDb.worldkitSchema = undefined; throw error; });
}
export async function closeDatabase() { const pool = globalDb.worldkitPool; globalDb.worldkitPool = undefined; globalDb.worldkitSchema = undefined; if (pool) await pool.end(); }
