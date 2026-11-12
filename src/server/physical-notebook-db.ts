import type { Pool } from "pg";
import { database } from "./db";
import { initializeDomainPacks } from "./domain-packs-db";
import { initializeEngineeringReview } from "./engineering-review-db";

const initialized = new WeakMap<Pool, Promise<void>>();
/** Independent immutable reports. Never rewrites a graph, compatibility certificate or payment. */
export async function initializePhysicalNotebook(): Promise<void> {
  await initializeDomainPacks(); await initializeEngineeringReview();
  const pool = database(); let pending = initialized.get(pool);
  if (!pending) {
    pending = pool.query(`
      CREATE TABLE IF NOT EXISTS wk_bench_runs (
        id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES wk_sessions(id),creator_id text NOT NULL,
        subject_kind text NOT NULL CHECK(subject_kind IN ('creator','domain')),subject_id text NOT NULL,
        revision_id text NOT NULL,graph_hash text NOT NULL,binding_hash text NOT NULL,
        source_mode text NOT NULL CHECK(source_mode IN ('sample','operator_recorded')),
        current_edition_id text NOT NULL,version integer NOT NULL CHECK(version>0),
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_bench_editions (
        id text PRIMARY KEY,run_id text NOT NULL,tenant_id text NOT NULL,number integer NOT NULL CHECK(number>0),
        content_hash text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(run_id,tenant_id) REFERENCES wk_bench_runs(id,tenant_id),
        UNIQUE(id,run_id,tenant_id),UNIQUE(run_id,number),
        CHECK(payload->>'id'=id AND payload->>'runId'=run_id AND payload->>'hash'=content_hash AND (payload->>'number')::integer=number)
      );
      CREATE TABLE IF NOT EXISTS wk_bench_serials (
        id text PRIMARY KEY,run_id text NOT NULL,tenant_id text NOT NULL,component_id text NOT NULL,
        serial_hash text NOT NULL,sealed jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(run_id,tenant_id) REFERENCES wk_bench_runs(id,tenant_id),UNIQUE(id,run_id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_bench_uploads (
        id text PRIMARY KEY,run_id text NOT NULL,tenant_id text NOT NULL,file jsonb NOT NULL,pathname text UNIQUE NOT NULL,
        transport text NOT NULL CHECK(transport IN ('private_blob','controlled_local')),
        phase text NOT NULL CHECK(phase IN ('awaiting_upload','uploaded','queued','verifying','verified','rejected')),
        expires_at timestamptz NOT NULL,asset_id text,attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
        lease_token text,lease_expires_at timestamptz,failure text,completed_receipt jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,run_id,tenant_id),
        FOREIGN KEY(run_id,tenant_id) REFERENCES wk_bench_runs(id,tenant_id)
      );
      ALTER TABLE wk_bench_uploads ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;
      ALTER TABLE wk_bench_uploads ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;
      ALTER TABLE wk_bench_uploads ADD COLUMN IF NOT EXISTS purged_at timestamptz;
      CREATE TABLE IF NOT EXISTS wk_bench_assets (
        id text PRIMARY KEY,run_id text NOT NULL,tenant_id text NOT NULL,upload_id text UNIQUE NOT NULL,
        content_hash text NOT NULL,bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=536870912),payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,run_id,tenant_id),
        FOREIGN KEY(upload_id,run_id,tenant_id) REFERENCES wk_bench_uploads(id,run_id,tenant_id),
        CHECK(payload->>'id'=id AND payload->>'runId'=run_id AND payload->>'sha256'=content_hash AND (payload->>'bytes')::bigint=bytes)
      );
      CREATE TABLE IF NOT EXISTS wk_bench_asset_access (
        asset_id text PRIMARY KEY,run_id text NOT NULL,tenant_id text NOT NULL,
        state text NOT NULL DEFAULT 'available' CHECK(state IN ('available','withdrawn','purging','purged','retry_wait')),
        reason text,withdrawn_at timestamptz,purged_at timestamptz,attempts integer NOT NULL DEFAULT 0,
        lease_token text,lease_expires_at timestamptz,failure text,
        FOREIGN KEY(asset_id,run_id,tenant_id) REFERENCES wk_bench_assets(id,run_id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_bench_grants (
        id text PRIMARY KEY,run_id text NOT NULL,tenant_id text NOT NULL,edition_id text NOT NULL,edition_hash text NOT NULL,
        actor_id text NOT NULL,invite_hash text UNIQUE NOT NULL,invite_sealed jsonb NOT NULL,
        credential_hash text UNIQUE,credential_sealed jsonb,redeem_request_id text,redeem_input_hash text,
        version integer NOT NULL DEFAULT 1 CHECK(version>0),status text NOT NULL CHECK(status IN ('invited','active','revoked')),
        expires_at timestamptz NOT NULL,redeemed_at timestamptz,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(edition_id,run_id,tenant_id) REFERENCES wk_bench_editions(id,run_id,tenant_id),
        FOREIGN KEY(tenant_id,actor_id) REFERENCES wk_review_actors(tenant_id,id),
        UNIQUE(id,run_id,tenant_id,edition_id,actor_id)
      );
      CREATE TABLE IF NOT EXISTS wk_bench_decisions (
        id text PRIMARY KEY,run_id text NOT NULL,tenant_id text NOT NULL,edition_id text NOT NULL,actor_id text NOT NULL,
        grant_id text NOT NULL,principal_hash text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(grant_id,run_id,tenant_id,edition_id,actor_id) REFERENCES wk_bench_grants(id,run_id,tenant_id,edition_id,actor_id),
        UNIQUE(edition_id,principal_hash,grant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_bench_commands (
        tenant_id text NOT NULL REFERENCES wk_sessions(id),actor_id text NOT NULL,request_id text NOT NULL,
        kind text NOT NULL,input_hash text NOT NULL,response_sealed jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(tenant_id,actor_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS wk_bench_events (
        id text PRIMARY KEY,run_id text NOT NULL,tenant_id text NOT NULL,actor_id text NOT NULL,kind text NOT NULL,
        summary text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(run_id,tenant_id) REFERENCES wk_bench_runs(id,tenant_id)
      );
      CREATE INDEX IF NOT EXISTS wk_bench_runs_owner ON wk_bench_runs(tenant_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS wk_bench_uploads_pending ON wk_bench_uploads(tenant_id,phase,created_at);
      CREATE OR REPLACE FUNCTION wk_bench_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'Original physical report history is append-only' USING ERRCODE='23514'; END $body$;
      DO $body$ DECLARE name text; BEGIN
        FOREACH name IN ARRAY ARRAY['wk_bench_editions','wk_bench_serials','wk_bench_assets','wk_bench_decisions','wk_bench_commands','wk_bench_events'] LOOP
          IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=name||'_immutable' AND tgrelid=name::regclass) THEN
            EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wk_bench_append_only()',name||'_immutable',name);
          END IF;
        END LOOP;
        IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wk_bench_current_owned_edition') THEN
          ALTER TABLE wk_bench_runs ADD CONSTRAINT wk_bench_current_owned_edition FOREIGN KEY(current_edition_id,id,tenant_id)
            REFERENCES wk_bench_editions(id,run_id,tenant_id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_bench_run_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Physical report history is retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.tenant_id,NEW.creator_id,NEW.subject_kind,NEW.subject_id,NEW.revision_id,NEW.graph_hash,NEW.binding_hash,NEW.source_mode,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.creator_id,OLD.subject_kind,OLD.subject_id,OLD.revision_id,OLD.graph_hash,OLD.binding_hash,OLD.source_mode,OLD.created_at)
          OR NEW.version<>OLD.version+1 OR NEW.current_edition_id=OLD.current_edition_id
          OR EXISTS(SELECT 1 FROM wk_bench_editions e WHERE e.id=OLD.current_edition_id AND e.payload->>'phase'='sealed')
          OR NOT EXISTS(SELECT 1 FROM wk_bench_editions e WHERE e.id=NEW.current_edition_id AND e.run_id=NEW.id AND e.tenant_id=NEW.tenant_id
            AND e.number=NEW.version AND e.payload->>'parentId'=OLD.current_edition_id AND e.payload->'binding'->>'hash'=NEW.binding_hash
            AND e.payload->>'sourceMode'=NEW.source_mode) THEN
          RAISE EXCEPTION 'A physical report requires its next immutable edition under the same exact binding' USING ERRCODE='23514';
        END IF;RETURN NEW;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_bench_upload_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Upload intent history is retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.run_id,NEW.tenant_id,NEW.file,NEW.pathname,NEW.transport,NEW.expires_at,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.run_id,OLD.tenant_id,OLD.file,OLD.pathname,OLD.transport,OLD.expires_at,OLD.created_at)
          OR (OLD.asset_id IS NOT NULL AND NEW.asset_id IS DISTINCT FROM OLD.asset_id)
          OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at)
          OR (OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at)
          OR (NEW.purged_at IS NOT NULL AND NEW.withdrawn_at IS NULL)
          OR (NEW.token_expires_at>NEW.expires_at)
          OR (OLD.token_expires_at IS NOT NULL AND (NEW.token_expires_at IS NULL OR NEW.token_expires_at<OLD.token_expires_at))
          OR (NEW.token_expires_at IS DISTINCT FROM OLD.token_expires_at AND (OLD.phase<>'awaiting_upload' OR OLD.withdrawn_at IS NOT NULL))
          OR (OLD.phase IN ('verified','rejected') AND ROW(NEW.phase,NEW.asset_id) IS DISTINCT FROM ROW(OLD.phase,OLD.asset_id)) THEN
          RAISE EXCEPTION 'Original upload identity and completed outcome are immutable' USING ERRCODE='23514';
        END IF;RETURN NEW;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_bench_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reviewer grant history is retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.run_id,NEW.tenant_id,NEW.edition_id,NEW.edition_hash,NEW.actor_id,NEW.invite_hash,NEW.invite_sealed,NEW.expires_at,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.run_id,OLD.tenant_id,OLD.edition_id,OLD.edition_hash,OLD.actor_id,OLD.invite_hash,OLD.invite_sealed,OLD.expires_at,OLD.created_at)
          OR OLD.status='revoked' OR NEW.version<>OLD.version+1
          OR (OLD.status='active' AND NEW.status<>'revoked')
          OR (OLD.status='invited' AND NEW.status NOT IN ('active','revoked'))
          OR (NEW.status='active' AND (NEW.credential_hash IS NULL OR NEW.credential_sealed IS NULL OR NEW.redeemed_at IS NULL OR NEW.redeem_request_id IS NULL OR NEW.redeem_input_hash IS NULL))
          OR (NEW.status='revoked' AND NEW.revoked_at IS NULL)
          OR (OLD.credential_hash IS NOT NULL AND ROW(NEW.credential_hash,NEW.credential_sealed,NEW.redeemed_at,NEW.redeem_request_id,NEW.redeem_input_hash)
            IS DISTINCT FROM ROW(OLD.credential_hash,OLD.credential_sealed,OLD.redeemed_at,OLD.redeem_request_id,OLD.redeem_input_hash)) THEN
          RAISE EXCEPTION 'A reviewer grant can only be redeemed once or revoked under its original scope' USING ERRCODE='23514';
        END IF;RETURN NEW;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_bench_access_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original-file access history is retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.asset_id,NEW.run_id,NEW.tenant_id) IS DISTINCT FROM ROW(OLD.asset_id,OLD.run_id,OLD.tenant_id)
          OR OLD.state='purged' OR (OLD.state<>'available' AND NEW.state='available')
          OR (NEW.state<>'available' AND NEW.withdrawn_at IS NULL)
          OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
          RAISE EXCEPTION 'Withdrawn original evidence cannot silently regain access' USING ERRCODE='23514';
        END IF;RETURN NEW;
      END $body$;
      DO $body$ DECLARE item text[]; BEGIN
        FOREACH item SLICE 1 IN ARRAY ARRAY[['wk_bench_runs','wk_bench_run_guard'],['wk_bench_uploads','wk_bench_upload_guard'],['wk_bench_grants','wk_bench_grant_guard'],['wk_bench_asset_access','wk_bench_access_guard']] LOOP
          IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=item[2] AND tgrelid=item[1]::regclass) THEN
            EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION %I()',item[2],item[1],item[2]);
          END IF;
        END LOOP;
      END $body$;
    `).then(() => undefined).catch(error => { initialized.delete(pool); throw error; });
    initialized.set(pool, pending);
  }
  await pending;
}
