import type { Pool } from "pg";
import { database } from "./db";
import { initializeEngineeringReview } from "./engineering-review-db";
import { initializeLivingRepair } from "./living-repair-db";

const initialized = new WeakMap<Pool, Promise<void>>();
/** Additive tables only. Original graphs, source editions, certificates and
 * financial history are never rewritten by this migration. */
export async function initializeSynthesis() {
  await initializeEngineeringReview(); await initializeLivingRepair();
  const pool = database(); let pending = initialized.get(pool);
  if (!pending) {
    pending = pool.query(`
      CREATE TABLE IF NOT EXISTS wk_synthesis_editions (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), kit_id text NOT NULL REFERENCES wk_kits(id),
        sequence integer NOT NULL CHECK(sequence>0), previous_edition_id text REFERENCES wk_synthesis_editions(id),
        content_hash text NOT NULL, payload jsonb NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(kit_id,sequence), UNIQUE(tenant_id,id)
      );
      CREATE TABLE IF NOT EXISTS wk_synthesis_choices (
        edition_id text PRIMARY KEY REFERENCES wk_synthesis_editions(id), tenant_id text NOT NULL REFERENCES wk_sessions(id),
        version integer NOT NULL DEFAULT 1 CHECK(version>0), candidate_id text, applied_revision_id text REFERENCES wk_revisions(id),
        applied_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_synthesis_commands (
        tenant_id text NOT NULL REFERENCES wk_sessions(id), actor_id text NOT NULL, request_id text NOT NULL,
        kind text NOT NULL, input_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(tenant_id,actor_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS wk_synthesis_choice_events (
        tenant_id text NOT NULL REFERENCES wk_sessions(id), edition_id text NOT NULL REFERENCES wk_synthesis_editions(id),
        version integer NOT NULL CHECK(version>0), candidate_id text, applied_revision_id text REFERENCES wk_revisions(id),
        kind text NOT NULL CHECK(kind IN ('opened','preferred','applied')), created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(edition_id,version)
      );
      CREATE TABLE IF NOT EXISTS wk_synthesis_journeys (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), kit_id text NOT NULL REFERENCES wk_kits(id),
        edition_id text NOT NULL REFERENCES wk_synthesis_editions(id), content_hash text NOT NULL, payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_synthesis_observations (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_synthesis_sample_catalogs (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS wk_synthesis_editions_tenant ON wk_synthesis_editions(tenant_id,created_at DESC);
      CREATE OR REPLACE FUNCTION wk_synthesis_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'System comparison evidence is append-only' USING ERRCODE='23514'; END $body$;
      DO $body$ DECLARE name text; BEGIN
        FOREACH name IN ARRAY ARRAY['wk_synthesis_editions','wk_synthesis_commands','wk_synthesis_choice_events','wk_synthesis_journeys','wk_synthesis_observations','wk_synthesis_sample_catalogs'] LOOP
          IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=name||'_immutable' AND tgrelid=name::regclass) THEN
            EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wk_synthesis_append_only()',name||'_immutable',name);
          END IF;
        END LOOP;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_synthesis_choice_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'System choices retain their history' USING ERRCODE='23514'; END IF;
        IF TG_OP='UPDATE' AND (ROW(NEW.edition_id,NEW.tenant_id) IS DISTINCT FROM ROW(OLD.edition_id,OLD.tenant_id)
          OR NEW.version<>OLD.version+1 OR OLD.applied_revision_id IS NOT NULL) THEN
          RAISE EXCEPTION 'Review a new comparison edition before changing an applied choice' USING ERRCODE='23514'; END IF;
        IF NOT EXISTS(SELECT 1 FROM wk_synthesis_editions e WHERE e.id=NEW.edition_id AND e.tenant_id=NEW.tenant_id
          AND (NEW.candidate_id IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(e.payload->'candidates') candidate WHERE candidate->>'id'=NEW.candidate_id))) THEN
          RAISE EXCEPTION 'Choice is outside its exact comparison scope' USING ERRCODE='23514'; END IF;
        IF NEW.applied_revision_id IS NOT NULL AND (NEW.candidate_id IS NULL OR NEW.applied_at IS NULL OR NOT EXISTS(
          SELECT 1 FROM wk_revisions r JOIN wk_synthesis_editions e ON e.kit_id=r.kit_id AND e.tenant_id=r.tenant_id
          WHERE r.id=NEW.applied_revision_id AND r.tenant_id=NEW.tenant_id AND e.id=NEW.edition_id)) THEN
          RAISE EXCEPTION 'Applied choice must name an owned saved revision' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $body$;
      DO $body$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='wk_synthesis_choice_guard' AND tgrelid='wk_synthesis_choices'::regclass) THEN
          CREATE TRIGGER wk_synthesis_choice_guard BEFORE INSERT OR UPDATE OR DELETE ON wk_synthesis_choices FOR EACH ROW EXECUTE FUNCTION wk_synthesis_choice_guard();
        END IF;
      END $body$;
    `).then(() => undefined).catch(error => { initialized.delete(pool); throw error; });
    initialized.set(pool, pending);
  }
  await pending;
}
