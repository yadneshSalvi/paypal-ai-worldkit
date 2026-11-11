import type { Pool } from "pg";
import { database, initialize } from "./db";

const initialized = new WeakMap<Pool, Promise<void>>();
/** Additive migration. Existing source, extraction, kit, certificate and money tables are never rewritten. */
export async function initializeEngineeringReview(): Promise<void> {
  await initialize(); const pool = database();
  let pending = initialized.get(pool);
  if (!pending) {
    pending = pool.query(`
      CREATE TABLE IF NOT EXISTS wk_review_actors (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), name text NOT NULL,
        kind text NOT NULL CHECK(kind IN ('owner','specialist')), provenance text NOT NULL CHECK(provenance IN ('human','sample')),
        version integer NOT NULL DEFAULT 1 CHECK(version>0), qualification_id text, revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS wk_review_owner ON wk_review_actors(tenant_id) WHERE kind='owner';
      CREATE TABLE IF NOT EXISTS wk_review_qualifications (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), actor_id text NOT NULL REFERENCES wk_review_actors(id),
        identity_hash text NOT NULL, evidence_hash text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_review_identities (
        tenant_id text NOT NULL REFERENCES wk_sessions(id), identity_hash text NOT NULL, actor_id text NOT NULL REFERENCES wk_review_actors(id),
        PRIMARY KEY(tenant_id,identity_hash), UNIQUE(tenant_id,actor_id)
      );
      CREATE TABLE IF NOT EXISTS wk_review_capabilities (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), actor_id text NOT NULL REFERENCES wk_review_actors(id),
        kit_id text NOT NULL REFERENCES wk_kits(id), profile_id text NOT NULL, document_id text NOT NULL REFERENCES wk_source_documents(id),
        role text NOT NULL CHECK(role IN ('reader','editor','reviewer','adjudicator')),
        invite_hash text UNIQUE NOT NULL, invite_sealed jsonb NOT NULL, credential_hash text UNIQUE,
        status text NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','active','revoked')),
        version integer NOT NULL DEFAULT 1 CHECK(version>0), expires_at timestamptz NOT NULL,
        redeemed_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS wk_review_capability_actor ON wk_review_capabilities(tenant_id,actor_id);
      CREATE TABLE IF NOT EXISTS wk_review_assets (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), profile_id text NOT NULL,
        photo_id text REFERENCES wk_inventory_photos(id), image_hash text NOT NULL, crop_hash text NOT NULL,
        payload jsonb NOT NULL, approved_by text NOT NULL REFERENCES wk_review_actors(id), created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_review_asset_heads (
        tenant_id text NOT NULL REFERENCES wk_sessions(id), profile_id text NOT NULL, asset_id text NOT NULL REFERENCES wk_review_assets(id),
        version integer NOT NULL DEFAULT 1 CHECK(version>0), PRIMARY KEY(tenant_id,profile_id)
      );
      CREATE TABLE IF NOT EXISTS wk_review_proposals (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), kit_id text NOT NULL REFERENCES wk_kits(id),
        profile_id text NOT NULL, document_id text NOT NULL REFERENCES wk_source_documents(id), candidate_id text NOT NULL,
        provenance text NOT NULL CHECK(provenance IN ('human','sample')),
        current_edition_id text, version integer NOT NULL DEFAULT 0 CHECK(version>=0), created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE wk_review_proposals ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'sample' CHECK(provenance IN ('human','sample'));
      DROP INDEX IF EXISTS wk_review_one_source_chain;
      CREATE UNIQUE INDEX IF NOT EXISTS wk_review_source_chain ON wk_review_proposals(tenant_id,profile_id,document_id,provenance);
      CREATE TABLE IF NOT EXISTS wk_review_editions (
        id text PRIMARY KEY, proposal_id text NOT NULL REFERENCES wk_review_proposals(id), tenant_id text NOT NULL REFERENCES wk_sessions(id),
        version integer NOT NULL CHECK(version>0), content_hash text NOT NULL, author_id text NOT NULL REFERENCES wk_review_actors(id),
        payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(proposal_id,version)
      );
      CREATE TABLE IF NOT EXISTS wk_review_decisions (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), edition_id text NOT NULL REFERENCES wk_review_editions(id),
        actor_id text NOT NULL REFERENCES wk_review_actors(id), principal_hash text NOT NULL, target_id text NOT NULL,
        kind text NOT NULL CHECK(kind IN ('review','adjudication')), payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(edition_id,actor_id,target_id,kind), UNIQUE(edition_id,principal_hash,target_id,kind)
      );
      CREATE TABLE IF NOT EXISTS wk_review_profiles (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), profile_id text NOT NULL,
        edition_id text NOT NULL REFERENCES wk_review_editions(id), source_document_id text NOT NULL REFERENCES wk_source_documents(id),
        payload jsonb NOT NULL, source jsonb NOT NULL, promotion jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,edition_id)
      );
      CREATE TABLE IF NOT EXISTS wk_review_profile_heads (
        tenant_id text NOT NULL REFERENCES wk_sessions(id), profile_id text NOT NULL, promotion_id text REFERENCES wk_review_profiles(id),
        version integer NOT NULL DEFAULT 1 CHECK(version>0), PRIMARY KEY(tenant_id,profile_id)
      );
      CREATE TABLE IF NOT EXISTS wk_review_withdrawals (
        promotion_id text PRIMARY KEY REFERENCES wk_review_profiles(id), tenant_id text NOT NULL REFERENCES wk_sessions(id),
        actor_id text NOT NULL REFERENCES wk_review_actors(id), reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_review_impacts (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), promotion_id text NOT NULL REFERENCES wk_review_profiles(id),
        revision_id text NOT NULL REFERENCES wk_revisions(id), payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(promotion_id,revision_id)
      );
      CREATE TABLE IF NOT EXISTS wk_review_intents (
        tenant_id text NOT NULL REFERENCES wk_sessions(id), actor_id text NOT NULL REFERENCES wk_review_actors(id),
        request_id text NOT NULL, input_hash text NOT NULL, response_sealed jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(tenant_id,actor_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS wk_review_events (
        sequence bigserial PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), actor_id text NOT NULL REFERENCES wk_review_actors(id),
        kind text NOT NULL, object_id text, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS wk_review_events_tenant ON wk_review_events(tenant_id,sequence);
      CREATE OR REPLACE FUNCTION wk_review_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'Engineering evidence is append-only' USING ERRCODE='23514'; END $body$;
      DO $body$ DECLARE name text; BEGIN
        FOREACH name IN ARRAY ARRAY['wk_review_qualifications','wk_review_identities','wk_review_assets','wk_review_editions','wk_review_decisions','wk_review_profiles','wk_review_withdrawals','wk_review_impacts','wk_review_intents','wk_review_events'] LOOP
          IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=name||'_immutable' AND tgrelid=name::regclass) THEN
            EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wk_review_append_only()', name||'_immutable',name);
          END IF;
        END LOOP;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_review_capability_transition() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Capabilities retain their audit identity' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.tenant_id,NEW.actor_id,NEW.kit_id,NEW.profile_id,NEW.document_id,NEW.role,NEW.invite_hash,NEW.invite_sealed,NEW.expires_at,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.actor_id,OLD.kit_id,OLD.profile_id,OLD.document_id,OLD.role,OLD.invite_hash,OLD.invite_sealed,OLD.expires_at,OLD.created_at)
          OR NEW.version<>OLD.version+1 OR NOT ((OLD.status='invited' AND NEW.status IN ('active','revoked')) OR (OLD.status='active' AND NEW.status='revoked'))
          OR (OLD.credential_hash IS NOT NULL AND NEW.credential_hash IS DISTINCT FROM OLD.credential_hash)
          OR (OLD.redeemed_at IS NOT NULL AND NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at)
          OR (NEW.status='active' AND (NEW.credential_hash IS NULL OR NEW.redeemed_at IS NULL))
          OR (NEW.status='revoked' AND NEW.revoked_at IS NULL) THEN
          RAISE EXCEPTION 'Invalid capability transition' USING ERRCODE='23514';
        END IF; RETURN NEW;
      END $body$;
      DO $body$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='wk_review_capability_guard' AND tgrelid='wk_review_capabilities'::regclass) THEN
          CREATE TRIGGER wk_review_capability_guard BEFORE UPDATE OR DELETE ON wk_review_capabilities FOR EACH ROW EXECUTE FUNCTION wk_review_capability_transition();
        END IF;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_review_actor_transition() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'A review principal retains its identity' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.tenant_id,NEW.name,NEW.kind,NEW.provenance,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.name,OLD.kind,OLD.provenance,OLD.created_at)
          OR NEW.version<>OLD.version+1 OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
          OR (NEW.qualification_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM wk_review_qualifications q WHERE q.id=NEW.qualification_id AND q.actor_id=NEW.id AND q.tenant_id=NEW.tenant_id)) THEN
          RAISE EXCEPTION 'Invalid principal authority transition' USING ERRCODE='23514';
        END IF; RETURN NEW;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_review_proposal_transition() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Review chains are retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.tenant_id,NEW.kit_id,NEW.profile_id,NEW.document_id,NEW.candidate_id,NEW.provenance,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.kit_id,OLD.profile_id,OLD.document_id,OLD.candidate_id,OLD.provenance,OLD.created_at)
          OR NEW.version<>OLD.version+1 OR NOT EXISTS(SELECT 1 FROM wk_review_editions e WHERE e.id=NEW.current_edition_id AND e.proposal_id=NEW.id AND e.tenant_id=NEW.tenant_id AND e.version=NEW.version) THEN
          RAISE EXCEPTION 'Invalid immutable review edition advance' USING ERRCODE='23514';
        END IF; RETURN NEW;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_review_head_transition() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Review heads retain their version history' USING ERRCODE='23514'; END IF;
        IF TG_OP='UPDATE' AND (ROW(NEW.tenant_id,NEW.profile_id) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.profile_id) OR NEW.version<>OLD.version+1) THEN
          RAISE EXCEPTION 'Invalid review head version' USING ERRCODE='23514';
        END IF;
        IF TG_TABLE_NAME='wk_review_profile_heads' THEN
          IF NEW.promotion_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM wk_review_profiles p WHERE p.id=NEW.promotion_id AND p.tenant_id=NEW.tenant_id AND p.profile_id=NEW.profile_id) THEN
            RAISE EXCEPTION 'Profile head is outside its exact scope' USING ERRCODE='23514'; END IF;
        ELSE
          IF NOT EXISTS(SELECT 1 FROM wk_review_assets a WHERE a.id=NEW.asset_id AND a.tenant_id=NEW.tenant_id AND a.profile_id=NEW.profile_id) THEN
            RAISE EXCEPTION 'Image head is outside its exact scope' USING ERRCODE='23514'; END IF;
        END IF; RETURN NEW;
      END $body$;
      DO $body$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='wk_review_actor_guard' AND tgrelid='wk_review_actors'::regclass) THEN
          CREATE TRIGGER wk_review_actor_guard BEFORE UPDATE OR DELETE ON wk_review_actors FOR EACH ROW EXECUTE FUNCTION wk_review_actor_transition(); END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='wk_review_proposal_guard' AND tgrelid='wk_review_proposals'::regclass) THEN
          CREATE TRIGGER wk_review_proposal_guard BEFORE UPDATE OR DELETE ON wk_review_proposals FOR EACH ROW EXECUTE FUNCTION wk_review_proposal_transition(); END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='wk_review_profile_head_guard' AND tgrelid='wk_review_profile_heads'::regclass) THEN
          CREATE TRIGGER wk_review_profile_head_guard BEFORE INSERT OR UPDATE OR DELETE ON wk_review_profile_heads FOR EACH ROW EXECUTE FUNCTION wk_review_head_transition(); END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='wk_review_asset_head_guard' AND tgrelid='wk_review_asset_heads'::regclass) THEN
          CREATE TRIGGER wk_review_asset_head_guard BEFORE INSERT OR UPDATE OR DELETE ON wk_review_asset_heads FOR EACH ROW EXECUTE FUNCTION wk_review_head_transition(); END IF;
      END $body$;
    `).then(() => undefined).catch(error => { initialized.delete(pool); throw error; });
    initialized.set(pool, pending);
  }
  await pending;
}
