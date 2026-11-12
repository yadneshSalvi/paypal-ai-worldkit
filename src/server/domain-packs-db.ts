import type { Pool } from "pg";
import { database, initialize } from "./db";

const initialized = new WeakMap<Pool, Promise<void>>();
/** Independent projects; never rewrites a creator graph, token or receipt. */
export async function initializeDomainPacks() {
  await initialize(); const pool = database(); let pending = initialized.get(pool);
  if (!pending) {
    pending = pool.query(`
      CREATE TABLE IF NOT EXISTS wk_domain_projects (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), pack_id text NOT NULL,
        title text NOT NULL, current_edition_id text NOT NULL, version integer NOT NULL CHECK(version>0),
        created_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
        UNIQUE(id,tenant_id), CHECK(pack_id IN ('desk-displays','podcast-classroom'))
      );
      CREATE TABLE IF NOT EXISTS wk_domain_editions (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), project_id text NOT NULL,
        number integer NOT NULL CHECK(number>0), content_hash text NOT NULL, graph_hash text NOT NULL,
        payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(project_id,tenant_id) REFERENCES wk_domain_projects(id,tenant_id),
        UNIQUE(tenant_id,id), UNIQUE(project_id,number),
        CHECK(payload->>'id'=id AND payload->>'projectId'=project_id AND payload->>'hash'=content_hash
          AND (payload->>'number')::integer=number AND payload->'certificate'->>'graphHash'=graph_hash)
      );
      CREATE TABLE IF NOT EXISTS wk_domain_previews (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), project_id text NOT NULL,
        content_hash text NOT NULL, payload jsonb NOT NULL, expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(project_id,tenant_id) REFERENCES wk_domain_projects(id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_domain_commands (
        tenant_id text NOT NULL REFERENCES wk_sessions(id), actor_id text NOT NULL, request_id text NOT NULL,
        kind text NOT NULL, input_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(tenant_id,actor_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS wk_domain_events (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), project_id text NOT NULL,
        kind text NOT NULL, edition_id text, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(project_id,tenant_id) REFERENCES wk_domain_projects(id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_domain_grants (
        id text PRIMARY KEY REFERENCES wk_access_tokens(id), tenant_id text NOT NULL REFERENCES wk_sessions(id),
        project_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(project_id,tenant_id) REFERENCES wk_domain_projects(id,tenant_id)
      );
      CREATE INDEX IF NOT EXISTS wk_domain_projects_tenant ON wk_domain_projects(tenant_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS wk_domain_editions_tenant ON wk_domain_editions(tenant_id,project_id,number DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS wk_domain_editions_owned_identity ON wk_domain_editions(tenant_id,project_id,id);
      CREATE OR REPLACE FUNCTION wk_domain_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'Domain pack evidence is append-only' USING ERRCODE='23514'; END $body$;
      DO $body$ DECLARE name text; BEGIN
        FOREACH name IN ARRAY ARRAY['wk_domain_editions','wk_domain_previews','wk_domain_commands','wk_domain_events','wk_domain_grants'] LOOP
          IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=name||'_immutable' AND tgrelid=name::regclass) THEN
            EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wk_domain_append_only()',name||'_immutable',name);
          END IF;
        END LOOP;
        IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wk_domain_current_edition') THEN
          ALTER TABLE wk_domain_projects ADD CONSTRAINT wk_domain_current_edition
            FOREIGN KEY(tenant_id,current_edition_id) REFERENCES wk_domain_editions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wk_domain_current_owned_edition') THEN
          ALTER TABLE wk_domain_projects ADD CONSTRAINT wk_domain_current_owned_edition
            FOREIGN KEY(tenant_id,id,current_edition_id) REFERENCES wk_domain_editions(tenant_id,project_id,id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_domain_project_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Domain project history is retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.tenant_id,NEW.pack_id,NEW.title,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.pack_id,OLD.title,OLD.created_at)
          OR OLD.archived_at IS NOT NULL OR NEW.version<>OLD.version+1 THEN
          RAISE EXCEPTION 'Domain project identity and history are immutable' USING ERRCODE='23514'; END IF;
        IF NEW.current_edition_id<>OLD.current_edition_id THEN
          IF NEW.archived_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM wk_domain_editions e WHERE e.id=NEW.current_edition_id
            AND e.tenant_id=NEW.tenant_id AND e.project_id=NEW.id AND e.number=NEW.version
            AND e.payload->'graph'->>'parentEditionId'=OLD.current_edition_id) THEN
            RAISE EXCEPTION 'Domain changes require the next reviewed edition' USING ERRCODE='23514'; END IF;
        ELSIF NEW.archived_at IS NULL THEN
          RAISE EXCEPTION 'A domain update must save a new edition or archive the project' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $body$;
      DO $body$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='wk_domain_project_guard' AND tgrelid='wk_domain_projects'::regclass) THEN
          CREATE TRIGGER wk_domain_project_guard BEFORE UPDATE OR DELETE ON wk_domain_projects FOR EACH ROW EXECUTE FUNCTION wk_domain_project_guard();
        END IF;
      END $body$;
    `).then(() => undefined).catch(error => { initialized.delete(pool); throw error; });
    initialized.set(pool, pending);
  }
  await pending;
}
