import { database, initialize } from "./db";

const state = globalThis as unknown as { worldkitPublicRecords?: Promise<void> };

/** Additive only. Never rewrites a saved graph, payment or source record. */
export function initializePublicRecords(): Promise<void> {
  return state.worldkitPublicRecords ??= initialize().then(async () => {
    await database().query(`
      CREATE TABLE IF NOT EXISTS wk_record_shares (
        kit_id text PRIMARY KEY REFERENCES wk_kits(id), tenant_id text NOT NULL REFERENCES wk_sessions(id),
        slug text UNIQUE NOT NULL, version integer NOT NULL DEFAULT 0, current_record_id text,
        withdrawn_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_record_editions (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id),
        kit_id text NOT NULL REFERENCES wk_record_shares(kit_id), revision_id text NOT NULL REFERENCES wk_revisions(id),
        edition integer NOT NULL CHECK(edition>0), version integer NOT NULL DEFAULT 1,
        share_version integer NOT NULL, state text NOT NULL CHECK(state IN ('draft','reviewed','published','withdrawn')),
        content_hash text NOT NULL, payload jsonb NOT NULL, source_binding jsonb NOT NULL,
        reviewed_at timestamptz, published_at timestamptz, withdrawn_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(kit_id,edition)
      );
      CREATE INDEX IF NOT EXISTS wk_record_editions_tenant ON wk_record_editions(tenant_id,kit_id,edition DESC);
      CREATE OR REPLACE FUNCTION wk_preserve_record_edition() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF ROW(NEW.id,NEW.tenant_id,NEW.kit_id,NEW.revision_id,NEW.edition,NEW.share_version,NEW.content_hash,NEW.payload,NEW.source_binding,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.kit_id,OLD.revision_id,OLD.edition,OLD.share_version,OLD.content_hash,OLD.payload,OLD.source_binding,OLD.created_at) THEN
          RAISE EXCEPTION 'A certificate edition is immutable' USING ERRCODE='23514';
        END IF;
        IF NOT ((OLD.state='draft' AND NEW.state='reviewed') OR (OLD.state='reviewed' AND NEW.state='published') OR (OLD.state='published' AND NEW.state='withdrawn')) OR NEW.version<>OLD.version+1 THEN
          RAISE EXCEPTION 'Invalid certificate lifecycle transition' USING ERRCODE='23514';
        END IF;
        IF (OLD.reviewed_at IS NOT NULL AND NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at) OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at) OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
          RAISE EXCEPTION 'Certificate history cannot be rewritten' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $body$;
      DO $body$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='wk_record_editions_immutable' AND tgrelid='wk_record_editions'::regclass) THEN
          CREATE TRIGGER wk_record_editions_immutable BEFORE UPDATE ON wk_record_editions FOR EACH ROW EXECUTE FUNCTION wk_preserve_record_edition();
        END IF;
      END $body$;
      CREATE TABLE IF NOT EXISTS wk_record_intents (
        tenant_id text NOT NULL REFERENCES wk_sessions(id), request_id text NOT NULL,
        action text NOT NULL, input_hash text NOT NULL, record_id text REFERENCES wk_record_editions(id),
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS wk_record_events (
        sequence bigserial PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id),
        kit_id text NOT NULL REFERENCES wk_kits(id), record_id text REFERENCES wk_record_editions(id),
        action text NOT NULL, input_hash text NOT NULL, content_hash text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }).catch(error => { state.worldkitPublicRecords = undefined; throw error; });
}
