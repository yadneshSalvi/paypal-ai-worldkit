import type { Pool } from "pg";
import { database } from "./db";
import { initializeDomainPacks } from "./domain-packs-db";
import { initializeEngineeringReview } from "./engineering-review-db";

const initialized = new WeakMap<Pool, Promise<void>>();
/** Independent study records never modify saved systems, certificates or payments. */
export async function initializeResearchNotebook(): Promise<void> {
  await initializeDomainPacks(); await initializeEngineeringReview();
  const pool = database(); let pending = initialized.get(pool);
  if (!pending) {
    pending = pool.query(`
      CREATE TABLE IF NOT EXISTS wk_research_studies (
        id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES wk_sessions(id),creator_id text NOT NULL,
        title text NOT NULL,objective text NOT NULL,source_mode text NOT NULL CHECK(source_mode IN ('sample','operator_recorded')),
        binding jsonb NOT NULL,binding_hash text NOT NULL,current_protocol_id text NOT NULL,
        version integer NOT NULL CHECK(version>0),content_hash text NOT NULL,
        phase text NOT NULL CHECK(phase IN ('open','sealed')),sealed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(id,tenant_id),CHECK((phase='sealed')=(sealed_at IS NOT NULL)),CHECK(binding->>'hash'=binding_hash)
      );
      CREATE TABLE IF NOT EXISTS wk_research_protocols (
        id text PRIMARY KEY,study_id text NOT NULL,tenant_id text NOT NULL,number integer NOT NULL CHECK(number>0),
        content_hash text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(study_id,tenant_id) REFERENCES wk_research_studies(id,tenant_id),
        UNIQUE(id,study_id,tenant_id),UNIQUE(study_id,number),
        CHECK(payload->>'id'=id AND payload->>'hash'=content_hash AND (payload->>'number')::integer=number)
      );
      CREATE TABLE IF NOT EXISTS wk_research_revisions (
        id text PRIMARY KEY,study_id text NOT NULL,tenant_id text NOT NULL,number integer NOT NULL CHECK(number>0),
        content_hash text NOT NULL,payload jsonb NOT NULL,reason text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(study_id,tenant_id) REFERENCES wk_research_studies(id,tenant_id),
        UNIQUE(study_id,tenant_id,number,content_hash),UNIQUE(study_id,number),
        CHECK(payload->'study'->>'id'=study_id AND payload->'study'->>'hash'=content_hash AND (payload->'study'->>'version')::integer=number)
      );
      CREATE TABLE IF NOT EXISTS wk_research_participants (
        id text PRIMARY KEY,study_id text NOT NULL,tenant_id text NOT NULL,
        source_mode text NOT NULL CHECK(source_mode IN ('sample','operator_recorded')),
        identity_hash text NOT NULL,identity_sealed jsonb NOT NULL,
        experience text NOT NULL CHECK(experience IN ('novice','experienced','not_recorded')),
        current_consent_id text NOT NULL,withdrawn_at timestamptz,withdrawal_sealed jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(study_id,tenant_id) REFERENCES wk_research_studies(id,tenant_id),
        UNIQUE(id,study_id,tenant_id),CHECK((withdrawn_at IS NULL)=(withdrawal_sealed IS NULL))
      );
      CREATE TABLE IF NOT EXISTS wk_research_consents (
        id text PRIMARY KEY,participant_id text NOT NULL,study_id text NOT NULL,tenant_id text NOT NULL,
        number integer NOT NULL CHECK(number>0),content_hash text NOT NULL,payload_sealed jsonb NOT NULL,
        private_research boolean NOT NULL,public_aggregate boolean NOT NULL,granted_at timestamptz NOT NULL,
        expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(participant_id,study_id,tenant_id) REFERENCES wk_research_participants(id,study_id,tenant_id),
        UNIQUE(id,participant_id,study_id,tenant_id),UNIQUE(participant_id,number),
        CHECK(NOT public_aggregate OR private_research),CHECK(expires_at IS NULL OR expires_at>granted_at)
      );
      CREATE TABLE IF NOT EXISTS wk_research_attempts (
        id text PRIMARY KEY,study_id text NOT NULL,tenant_id text NOT NULL,participant_id text NOT NULL,
        protocol_id text NOT NULL,protocol_hash text NOT NULL,task_id text NOT NULL,
        consent_id text NOT NULL,consent_hash text NOT NULL,number integer NOT NULL CHECK(number>0),retry_of text,
        content_hash text NOT NULL,payload jsonb NOT NULL,started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(participant_id,study_id,tenant_id) REFERENCES wk_research_participants(id,study_id,tenant_id),
        FOREIGN KEY(protocol_id,study_id,tenant_id) REFERENCES wk_research_protocols(id,study_id,tenant_id),
        FOREIGN KEY(consent_id,participant_id,study_id,tenant_id) REFERENCES wk_research_consents(id,participant_id,study_id,tenant_id),
        UNIQUE(id,study_id,tenant_id),UNIQUE(id,participant_id,protocol_id,task_id,study_id,tenant_id),
        UNIQUE(participant_id,protocol_id,task_id,number),
        FOREIGN KEY(retry_of,participant_id,protocol_id,task_id,study_id,tenant_id) REFERENCES wk_research_attempts(id,participant_id,protocol_id,task_id,study_id,tenant_id),
        CHECK((number=1 AND retry_of IS NULL) OR (number>1 AND retry_of IS NOT NULL)),
        CHECK(payload->>'id'=id AND payload->>'hash'=content_hash AND payload->>'participantId'=participant_id
          AND payload->>'protocolId'=protocol_id AND payload->>'protocolHash'=protocol_hash
          AND payload->>'consentId'=consent_id AND payload->>'consentHash'=consent_hash AND payload->'task'->>'id'=task_id)
      );
      CREATE TABLE IF NOT EXISTS wk_research_outcomes (
        attempt_id text PRIMARY KEY,study_id text NOT NULL,tenant_id text NOT NULL,
        content_hash text NOT NULL,payload_sealed jsonb NOT NULL,finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(attempt_id,study_id,tenant_id) REFERENCES wk_research_attempts(id,study_id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_research_commands (
        tenant_id text NOT NULL REFERENCES wk_sessions(id),actor_id text NOT NULL,request_id text NOT NULL,
        kind text NOT NULL,input_hash text NOT NULL,response_sealed jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(tenant_id,actor_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS wk_research_events (
        id text PRIMARY KEY,study_id text NOT NULL,tenant_id text NOT NULL,actor_id text NOT NULL,
        kind text NOT NULL,summary text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(study_id,tenant_id) REFERENCES wk_research_studies(id,tenant_id)
      );
      CREATE INDEX IF NOT EXISTS wk_research_owner ON wk_research_studies(tenant_id,updated_at DESC);
      CREATE INDEX IF NOT EXISTS wk_research_participants_study ON wk_research_participants(tenant_id,study_id,created_at);
      CREATE INDEX IF NOT EXISTS wk_research_attempts_study ON wk_research_attempts(tenant_id,study_id,started_at);
      CREATE OR REPLACE FUNCTION wk_research_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'Research protocol, consent and observation history is append-only' USING ERRCODE='23514'; END $body$;
      DO $body$ DECLARE item text; BEGIN
        FOREACH item IN ARRAY ARRAY['wk_research_protocols','wk_research_revisions','wk_research_consents','wk_research_attempts','wk_research_outcomes','wk_research_commands','wk_research_events'] LOOP
          IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=item||'_immutable' AND tgrelid=item::regclass) THEN
            EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wk_research_append_only()',item||'_immutable',item);
          END IF;
        END LOOP;
        IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wk_research_current_protocol') THEN
          ALTER TABLE wk_research_studies ADD CONSTRAINT wk_research_current_protocol FOREIGN KEY(current_protocol_id,id,tenant_id)
            REFERENCES wk_research_protocols(id,study_id,tenant_id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wk_research_current_revision') THEN
          ALTER TABLE wk_research_studies ADD CONSTRAINT wk_research_current_revision FOREIGN KEY(id,tenant_id,version,content_hash)
            REFERENCES wk_research_revisions(study_id,tenant_id,number,content_hash) DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wk_research_current_consent') THEN
          ALTER TABLE wk_research_participants ADD CONSTRAINT wk_research_current_consent FOREIGN KEY(current_consent_id,id,study_id,tenant_id)
            REFERENCES wk_research_consents(id,participant_id,study_id,tenant_id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_research_study_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Research study history is retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.tenant_id,NEW.creator_id,NEW.title,NEW.objective,NEW.source_mode,NEW.binding,NEW.binding_hash,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.creator_id,OLD.title,OLD.objective,OLD.source_mode,OLD.binding,OLD.binding_hash,OLD.created_at)
          OR NEW.version<>OLD.version+1 OR NEW.content_hash=OLD.content_hash
          OR (OLD.phase='sealed' AND ROW(NEW.phase,NEW.sealed_at,NEW.current_protocol_id) IS DISTINCT FROM ROW(OLD.phase,OLD.sealed_at,OLD.current_protocol_id))
          OR NOT EXISTS(SELECT 1 FROM wk_research_revisions r WHERE r.study_id=NEW.id AND r.tenant_id=NEW.tenant_id
            AND r.number=NEW.version AND r.content_hash=NEW.content_hash AND r.payload->>'parentHash'=OLD.content_hash) THEN
          RAISE EXCEPTION 'Research studies require their next exact immutable revision' USING ERRCODE='23514';
        END IF;RETURN NEW;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_research_participant_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Participant audit fingerprints are retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.study_id,NEW.tenant_id,NEW.source_mode,NEW.identity_hash,NEW.identity_sealed,NEW.experience,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.study_id,OLD.tenant_id,OLD.source_mode,OLD.identity_hash,OLD.identity_sealed,OLD.experience,OLD.created_at)
          OR OLD.withdrawn_at IS NOT NULL
          OR (NEW.current_consent_id<>OLD.current_consent_id AND NOT EXISTS(SELECT 1 FROM wk_research_consents c JOIN wk_research_consents p ON p.id=OLD.current_consent_id
             WHERE c.id=NEW.current_consent_id AND c.participant_id=NEW.id AND c.study_id=NEW.study_id AND c.tenant_id=NEW.tenant_id AND c.number=p.number+1)) THEN
          RAISE EXCEPTION 'A participant identity cannot change or regain withdrawn access' USING ERRCODE='23514';
        END IF;RETURN NEW;
      END $body$;
      DO $body$ DECLARE item text[]; BEGIN
        FOREACH item SLICE 1 IN ARRAY ARRAY[['wk_research_studies','wk_research_study_guard'],['wk_research_participants','wk_research_participant_guard']] LOOP
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
