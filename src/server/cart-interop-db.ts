import type { Pool } from "pg";
import { database } from "./db";
import { initializeDomainPacks } from "./domain-packs-db";

const initialized = new WeakMap<Pool, Promise<void>>();
export async function initializeCartInterop() {
  await initializeDomainPacks(); const pool = database(); let pending = initialized.get(pool);
  if (!pending) {
    pending = pool.query(`
      CREATE TABLE IF NOT EXISTS wk_cart_merchants (
        id text PRIMARY KEY,tenant_id text UNIQUE NOT NULL REFERENCES wk_sessions(id),account_id text NOT NULL,
        audience text NOT NULL,source_mode text NOT NULL CHECK(source_mode='sample'),disabled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_cart_catalogue (
        id text PRIMARY KEY,merchant_id text NOT NULL,tenant_id text NOT NULL,project_id text NOT NULL,edition_id text NOT NULL,
        payload jsonb NOT NULL,price_minor integer NOT NULL CHECK(price_minor>=0 AND price_minor<=1000000),
        stock integer NOT NULL CHECK(stock>=0 AND stock<=1000),stock_version integer NOT NULL DEFAULT 1 CHECK(stock_version>0),
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(merchant_id,edition_id),UNIQUE(id,merchant_id,tenant_id),
        FOREIGN KEY(merchant_id,tenant_id) REFERENCES wk_cart_merchants(id,tenant_id),
        FOREIGN KEY(tenant_id,project_id,edition_id) REFERENCES wk_domain_editions(tenant_id,project_id,id)
      );
      CREATE TABLE IF NOT EXISTS wk_cart_credentials (
        id text PRIMARY KEY,merchant_id text NOT NULL,tenant_id text NOT NULL,payload jsonb NOT NULL,
        expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(merchant_id,tenant_id) REFERENCES wk_cart_merchants(id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_cart_carts (
        id text PRIMARY KEY,merchant_id text NOT NULL,tenant_id text NOT NULL,version integer NOT NULL CHECK(version>0),
        state text NOT NULL CHECK(state IN ('open','completed')),current_revision_id text NOT NULL,
        expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
        FOREIGN KEY(merchant_id,tenant_id) REFERENCES wk_cart_merchants(id,tenant_id),UNIQUE(id,merchant_id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_cart_revisions (
        id text PRIMARY KEY,cart_id text NOT NULL,merchant_id text NOT NULL,tenant_id text NOT NULL,
        number integer NOT NULL CHECK(number>0),content_hash text NOT NULL,evaluation_hash text NOT NULL,payload jsonb NOT NULL,
        total_minor integer,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(cart_id,number),UNIQUE(id,cart_id,merchant_id,tenant_id),
        FOREIGN KEY(cart_id,merchant_id,tenant_id) REFERENCES wk_cart_carts(id,merchant_id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_cart_payment_tokens (
        id text PRIMARY KEY,cart_id text NOT NULL,merchant_id text NOT NULL,tenant_id text NOT NULL,revision_id text NOT NULL,
        quote_hash text NOT NULL,total_minor integer NOT NULL CHECK(total_minor>=0),expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(cart_id,revision_id),UNIQUE(id,cart_id,merchant_id,tenant_id),
        FOREIGN KEY(revision_id,cart_id,merchant_id,tenant_id) REFERENCES wk_cart_revisions(id,cart_id,merchant_id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_cart_approvals (
        id text PRIMARY KEY,cart_id text NOT NULL,merchant_id text NOT NULL,tenant_id text NOT NULL,token_id text UNIQUE NOT NULL,
        quote_hash text NOT NULL,total_minor integer NOT NULL,payer_id text NOT NULL,expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(token_id,cart_id,merchant_id,tenant_id) REFERENCES wk_cart_payment_tokens(id,cart_id,merchant_id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_cart_settlements (
        id text PRIMARY KEY,cart_id text UNIQUE NOT NULL,merchant_id text NOT NULL,tenant_id text NOT NULL,token_id text UNIQUE NOT NULL,
        payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(token_id,cart_id,merchant_id,tenant_id) REFERENCES wk_cart_payment_tokens(id,cart_id,merchant_id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_cart_commands (
        merchant_id text NOT NULL,tenant_id text NOT NULL,actor_id text NOT NULL,request_id text NOT NULL,
        operation text NOT NULL,input_hash text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(merchant_id,actor_id,request_id),FOREIGN KEY(merchant_id,tenant_id) REFERENCES wk_cart_merchants(id,tenant_id)
      );
      CREATE TABLE IF NOT EXISTS wk_cart_events (
        id text PRIMARY KEY,merchant_id text NOT NULL,tenant_id text NOT NULL,cart_id text,kind text NOT NULL,
        payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(merchant_id,tenant_id) REFERENCES wk_cart_merchants(id,tenant_id),
        FOREIGN KEY(cart_id,merchant_id,tenant_id) REFERENCES wk_cart_carts(id,merchant_id,tenant_id)
      );
      CREATE INDEX IF NOT EXISTS wk_cart_carts_owner ON wk_cart_carts(tenant_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS wk_cart_events_owner ON wk_cart_events(tenant_id,created_at DESC);
      CREATE OR REPLACE FUNCTION wk_cart_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'Cart revisions and receipts are append-only' USING ERRCODE='23514'; END $body$;
      DO $body$ DECLARE name text; BEGIN
        FOREACH name IN ARRAY ARRAY['wk_cart_revisions','wk_cart_payment_tokens','wk_cart_approvals','wk_cart_settlements','wk_cart_commands','wk_cart_events'] LOOP
          IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=name||'_immutable' AND tgrelid=name::regclass) THEN
            EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wk_cart_append_only()',name||'_immutable',name);
          END IF;
        END LOOP;
        IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wk_cart_current_owned_revision') THEN
          ALTER TABLE wk_cart_carts ADD CONSTRAINT wk_cart_current_owned_revision
            FOREIGN KEY(current_revision_id,id,merchant_id,tenant_id) REFERENCES wk_cart_revisions(id,cart_id,merchant_id,tenant_id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_cart_current_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cart history is retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.tenant_id,NEW.merchant_id,NEW.created_at,NEW.expires_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.merchant_id,OLD.created_at,OLD.expires_at)
          OR OLD.state='completed' OR NEW.version<>OLD.version+1 OR NEW.current_revision_id=OLD.current_revision_id
          OR NOT EXISTS(SELECT 1 FROM wk_cart_revisions r WHERE r.id=NEW.current_revision_id AND r.cart_id=NEW.id
            AND r.merchant_id=NEW.merchant_id AND r.tenant_id=NEW.tenant_id AND r.number=NEW.version)
          OR (NEW.state='open' AND NEW.completed_at IS NOT NULL) OR (NEW.state='completed' AND NEW.completed_at IS NULL) THEN
          RAISE EXCEPTION 'Cart changes require the next owned immutable revision' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_cart_catalogue_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Catalogue identity is retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.merchant_id,NEW.tenant_id,NEW.project_id,NEW.edition_id,NEW.payload,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.merchant_id,OLD.tenant_id,OLD.project_id,OLD.edition_id,OLD.payload,OLD.created_at)
          OR NEW.stock_version<>OLD.stock_version+1 THEN
          RAISE EXCEPTION 'Catalogue identity is immutable and stock changes are versioned' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_cart_credential_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Integration credential history is retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.merchant_id,NEW.tenant_id,NEW.payload,NEW.expires_at,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.merchant_id,OLD.tenant_id,OLD.payload,OLD.expires_at,OLD.created_at)
          OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
          RAISE EXCEPTION 'Integration credentials can only be revoked once' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $body$;
      CREATE OR REPLACE FUNCTION wk_cart_merchant_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Merchant history is retained' USING ERRCODE='23514'; END IF;
        IF ROW(NEW.id,NEW.tenant_id,NEW.account_id,NEW.audience,NEW.source_mode,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.account_id,OLD.audience,OLD.source_mode,OLD.created_at)
          OR OLD.disabled_at IS NOT NULL OR NEW.disabled_at IS NULL THEN
          RAISE EXCEPTION 'Merchant identity is immutable and can only be disabled' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $body$;
      DO $body$ DECLARE item text[]; BEGIN
        FOREACH item SLICE 1 IN ARRAY ARRAY[
          ['wk_cart_carts','wk_cart_current_guard'], ['wk_cart_catalogue','wk_cart_catalogue_guard'],
          ['wk_cart_credentials','wk_cart_credential_guard'], ['wk_cart_merchants','wk_cart_merchant_guard']
        ] LOOP
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
