import type { Pool } from "pg";
import { database, initialize } from "./db";

export const WORKBENCH_SQL = `
CREATE TABLE IF NOT EXISTS wk_workbench_commands (
  tenant_id text NOT NULL REFERENCES wk_sessions(id), request_id uuid NOT NULL,
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  preview_hash text NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
  base_revision_id text NOT NULL REFERENCES wk_revisions(id),
  result_revision_id text NOT NULL REFERENCES wk_revisions(id),
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,request_id)
);
CREATE OR REPLACE FUNCTION wk_workbench_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Workbench command receipts are immutable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM wk_revisions b JOIN wk_revisions r ON r.kit_id=b.kit_id AND r.tenant_id=b.tenant_id
    WHERE b.id=NEW.base_revision_id AND r.id=NEW.result_revision_id AND b.tenant_id=NEW.tenant_id
      AND r.revision=b.revision+1 AND r.kit->>'parentRevisionId'=b.id
  ) THEN RAISE EXCEPTION 'Workbench receipt must bind successive revisions of its own workspace'; END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='wk_workbench_command_immutable') THEN
    CREATE TRIGGER wk_workbench_command_immutable BEFORE INSERT OR UPDATE OR DELETE ON wk_workbench_commands
      FOR EACH ROW EXECUTE FUNCTION wk_workbench_command_guard();
  END IF;
END $$;
`;
const initialized = new WeakMap<Pool, Promise<void>>();
export async function initializeWorkbench() {
  await initialize(); const pool = database(); let pending = initialized.get(pool);
  if (!pending) { pending = pool.query(WORKBENCH_SQL).then(() => undefined).catch(error => { initialized.delete(pool); throw error; }); initialized.set(pool, pending); }
  return pending;
}
