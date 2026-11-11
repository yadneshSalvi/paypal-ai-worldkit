import { initializeCommerce } from "./commerce-db";
import { database } from "./db";

const state = globalThis as unknown as { worldkitLivingSchema1?: Promise<void> };
export function initializeLiving() {
  return state.worldkitLivingSchema1 ??= initializeCommerce().then(async () => {
    await database().query(`
      CREATE TABLE IF NOT EXISTS wk_offer_subscriptions (
        id text PRIMARY KEY, scope_hash text NOT NULL, generation integer NOT NULL, scope jsonb NOT NULL, source_mode text NOT NULL DEFAULT 'live',
        provider_id text, provider_state jsonb, phase text NOT NULL DEFAULT 'queued', ownership text NOT NULL DEFAULT 'unconfirmed',
        preflight_ids jsonb NOT NULL DEFAULT '[]', preflight_cursor text, preflight_pages integer NOT NULL DEFAULT 0,
        preflight_complete boolean NOT NULL DEFAULT false, dispatch_started_at timestamptz, canonicalization_started_at timestamptz,
        canonicalization_attempts integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0,
        failures integer NOT NULL DEFAULT 0, resume_phase text, reconciliation_pages integer NOT NULL DEFAULT 0, error text,
        lease_token text, lease_expires_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(scope_hash,generation)
      );
      CREATE INDEX IF NOT EXISTS wk_offer_subscriptions_due ON wk_offer_subscriptions(next_attempt_at,phase);
      CREATE INDEX IF NOT EXISTS wk_offer_subscriptions_provider ON wk_offer_subscriptions(provider_id);
      ALTER TABLE wk_offer_subscriptions ADD COLUMN IF NOT EXISTS failures integer NOT NULL DEFAULT 0;
      ALTER TABLE wk_offer_subscriptions ADD COLUMN IF NOT EXISTS source_mode text NOT NULL DEFAULT 'live';
      ALTER TABLE wk_offer_subscriptions ADD COLUMN IF NOT EXISTS resume_phase text;
      ALTER TABLE wk_offer_subscriptions ADD COLUMN IF NOT EXISTS reconciliation_pages integer NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS wk_offer_subscription_observations (
        id bigserial PRIMARY KEY, subscription_id text NOT NULL REFERENCES wk_offer_subscriptions(id), operation text NOT NULL,
        payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_offer_subscription_ownership (
        subscription_id text PRIMARY KEY REFERENCES wk_offer_subscriptions(id), provider_id text NOT NULL,
        statement text NOT NULL, actor text NOT NULL, attested_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS wk_offer_watches (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), item_id text NOT NULL REFERENCES wk_inventory_items(id),
        item_version integer NOT NULL, request_id text NOT NULL, input_hash text NOT NULL, payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), stopped_at timestamptz, UNIQUE(tenant_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS wk_offer_watch_resources (
        watch_id text NOT NULL REFERENCES wk_offer_watches(id), subscription_id text NOT NULL REFERENCES wk_offer_subscriptions(id),
        PRIMARY KEY(watch_id,subscription_id)
      );
      CREATE TABLE IF NOT EXISTS wk_webhook_events (
        id text PRIMARY KEY, provider text NOT NULL, namespace text NOT NULL, source_mode text NOT NULL, event_id text NOT NULL,
        event_type text NOT NULL, committed_at timestamptz, body_hash text NOT NULL, raw_receipt jsonb, signal jsonb,
        state text NOT NULL, owner_key text, tenant_ids jsonb NOT NULL DEFAULT '[]', attempts integer NOT NULL DEFAULT 0,
        failures integer NOT NULL DEFAULT 0,
        deliveries integer NOT NULL DEFAULT 1, conflicts integer NOT NULL DEFAULT 0, error text, result jsonb,
        lease_token text, lease_expires_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
        received_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(provider,namespace,event_id)
      );
      CREATE INDEX IF NOT EXISTS wk_webhook_events_due ON wk_webhook_events(next_attempt_at,state);
      ALTER TABLE wk_webhook_events ADD COLUMN IF NOT EXISTS failures integer NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS wk_webhook_deliveries (
        id text PRIMARY KEY, event_id text NOT NULL REFERENCES wk_webhook_events(id), transmission_id text NOT NULL,
        body_hash text NOT NULL, disposition text NOT NULL, conflict_receipt jsonb, received_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wk_living_incidents (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), webhook_id text NOT NULL REFERENCES wk_webhook_events(id),
        watch_id text NOT NULL REFERENCES wk_offer_watches(id), state text NOT NULL, payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(webhook_id,watch_id)
      );
      CREATE TABLE IF NOT EXISTS wk_payment_observations (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), order_id text NOT NULL REFERENCES wk_commerce_orders(id),
        webhook_id text NOT NULL REFERENCES wk_webhook_events(id), payload jsonb NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(webhook_id,order_id)
      );
      ALTER TABLE wk_notifications ADD COLUMN IF NOT EXISTS cause_key text;
      CREATE UNIQUE INDEX IF NOT EXISTS wk_notifications_cause ON wk_notifications(tenant_id,cause_key) WHERE cause_key IS NOT NULL;
    `);
  }).catch(error => { state.worldkitLivingSchema1 = undefined; throw error; });
}
