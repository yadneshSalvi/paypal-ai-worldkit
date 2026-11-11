import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hash } from "../../packages/compatibility";
import { WorldKitError, type CatalogSnapshot } from "../../packages/contracts";
import { retrieveProduct } from "../../packages/channel3/client";
import { Channel3Subscriptions, SubscriptionFailure, type SubscriptionGateway } from "../../packages/channel3/subscriptions";
import { catalogIdentityMatches } from "../../packages/inventory/identity";
import { canonicalizationDelay, matchesScope, sameSelection, scopeHash, watchScopes, type OfferWatch, type ProviderSubscription, type SubscriptionOwnership, type SubscriptionPhase, type SubscriptionScope } from "../../packages/living-kit/subscriptions";
import { appendEvent, reserveUsage, type Session } from "./repository";
import { database, transaction } from "./db";
import { getInventoryItem } from "./inventory";
import { initializeLiving } from "./living-db";

type Row = { id: string; source_mode: "live" | "sample" | "replay"; scope_hash: string; scope: SubscriptionScope; provider_id: string | null; provider_state: ProviderSubscription | null; phase: SubscriptionPhase; ownership: SubscriptionOwnership; preflight_ids: string[]; preflight_cursor: string | null; preflight_pages: number; preflight_complete: boolean; dispatch_started_at: Date | null; canonicalization_started_at: Date | null; canonicalization_attempts: number; attempts: number; failures: number; resume_phase: SubscriptionPhase | null; reconciliation_pages: number; lease_token: string | null; lease_expires_at: Date | null; next_attempt_at: Date; error: string | null };
type Claimed = Row & { lease_token: string };
export type WatchInput = { itemId: string; expectedVersion: number; requestId: string; domains: string[] };
const now = () => new Date().toISOString();
const activeConsumersSql = "SELECT count(*)::int AS count FROM wk_offer_watch_resources r JOIN wk_offer_watches w ON w.id=r.watch_id JOIN wk_sessions s ON s.id=w.tenant_id WHERE r.subscription_id=$1 AND w.stopped_at IS NULL AND s.expires_at>now()";

export async function getOfferWatches(tenantId: string): Promise<OfferWatch[]> {
  await initializeLiving();
  const watches = await database().query("SELECT * FROM wk_offer_watches WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100", [tenantId]);
  if (!watches.rowCount) return [];
  const resources = await database().query("SELECT l.watch_id,s.* FROM wk_offer_watch_resources l JOIN wk_offer_subscriptions s ON s.id=l.subscription_id WHERE l.watch_id=ANY($1::text[])", [watches.rows.map(row => row.id)]);
  return watches.rows.map(row => {
    const attached = resources.rows.filter(resource => resource.watch_id === row.id) as (Row & { watch_id: string })[];
    const state: OfferWatch["state"] = row.stopped_at ? "stopped" : attached.every(resource => resource.phase === "active") ? "active" : attached.some(resource => resource.phase === "review_needed" || resource.phase === "cancelled" || resource.phase === "cancel_unknown") ? "needs_attention" : "starting";
    return { ...row.payload, state, stoppedAt: row.stopped_at ? new Date(row.stopped_at).toISOString() : null, resources: attached.map(resource => ({ id: resource.id, phase: resource.phase, ownership: resource.ownership, providerId: resource.provider_id, nextAttemptAt: new Date(resource.next_attempt_at).toISOString(), error: resource.error })) };
  });
}
async function sameRequest(tenantId: string, requestId: string, inputHash: string): Promise<OfferWatch | null> {
  const existing = (await database().query("SELECT id,input_hash FROM wk_offer_watches WHERE tenant_id=$1 AND request_id=$2", [tenantId, requestId])).rows[0];
  if (!existing) return null;
  if (existing.input_hash !== inputHash) throw new WorldKitError("stale_revision", "This alert request already belongs to different equipment or merchant choices.", 409);
  return (await getOfferWatches(tenantId)).find(watch => watch.id === existing.id) ?? null;
}
export async function requestOfferWatch(session: Session, input: WatchInput, refresh: (productId: string, userId: string, selection: Record<string, string>) => Promise<{ value: { snapshot: CatalogSnapshot } }> = retrieveProduct, sourceMode: "live" | "sample" | "replay" = "live"): Promise<OfferWatch> {
  await initializeLiving(); const inputHash = hash({ ...input, requestId: undefined, sourceMode });
  const prior = await sameRequest(session.id, input.requestId, inputHash); if (prior) return prior;
  const item = await getInventoryItem(session.id, input.itemId);
  if (item.status !== "active" || item.version !== input.expectedVersion || !item.profile.catalogBinding || !item.profile.catalogId) throw new WorldKitError("needs_evidence", "Choose a current passport entry with a confirmed exact catalog identity.", 409);
  await reserveUsage(session.id, "discovery");
  const fresh = (await refresh(item.profile.catalogId, session.id, Object.fromEntries(item.profile.selectedOptions.map(option => [option.name, option.value])))).value.snapshot;
  if (fresh.productId !== item.profile.catalogId || !catalogIdentityMatches(fresh, item.profile) || !sameSelection(fresh.selectedOptions.map(option => ({ name: option.name, label: option.value })), item.profile.selectedOptions.map(option => ({ name: option.name, label: option.value })))) throw new WorldKitError("needs_evidence", "The catalog returned a different model or variant. Review its identity before starting alerts.", 409);
  const scopes = watchScopes(fresh, input.domains);
  const id = await transaction(async db => {
    const active = await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>now() FOR UPDATE", [session.id]);
    if (!active.rowCount) throw new WorldKitError("forbidden", "This workspace has expired.", 401);
    const existing = (await db.query("SELECT id,input_hash FROM wk_offer_watches WHERE tenant_id=$1 AND request_id=$2", [session.id, input.requestId])).rows[0];
    if (existing) { if (existing.input_hash !== inputHash) throw new WorldKitError("stale_revision", "This alert request changed.", 409); return existing.id as string; }
    const current = (await db.query("SELECT payload FROM wk_inventory_items WHERE tenant_id=$1 AND id=$2 FOR SHARE", [session.id, item.id])).rows[0]?.payload;
    if (current?.version !== input.expectedVersion || current?.status !== "active") throw new WorldKitError("stale_revision", "This passport entry changed while its catalog variant was refreshed.", 409);
    const sameScope = (await db.query("SELECT id FROM wk_offer_watches WHERE tenant_id=$1 AND item_id=$2 AND item_version=$3 AND stopped_at IS NULL AND payload->>'sourceMode'=$4 AND payload->'domains'=$5::jsonb LIMIT 1", [session.id, item.id, item.version, sourceMode, JSON.stringify(scopes.flatMap(scope => scope.domains))])).rows[0];
    if (sameScope) return sameScope.id as string;
    const count = (await db.query("SELECT count(*)::int AS count FROM wk_offer_watches WHERE tenant_id=$1 AND stopped_at IS NULL", [session.id])).rows[0].count;
    if (count >= 24) throw new WorldKitError("rate_limited", "Stop an older alert before watching more than 24 equipment entries.", 429);
    const id = randomUUID(); const payload = { id, itemId: item.id, itemVersion: item.version, productId: fresh.productId, model: `${item.profile.manufacturer} ${item.profile.model}`, selection: scopes[0]!.selection, domains: scopes.flatMap(scope => scope.domains), createdAt: now(), snapshot: fresh, sourceMode };
    await db.query("INSERT INTO wk_offer_watches(id,tenant_id,item_id,item_version,request_id,input_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, session.id, item.id, item.version, input.requestId, inputHash, payload]);
    for (const scope of scopes) {
      const digest = hash({ sourceMode, scope: scopeHash(scope) }); await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`worldkit:subscription:${digest}`]);
      const latest = (await db.query("SELECT * FROM wk_offer_subscriptions WHERE scope_hash=$1 ORDER BY generation DESC LIMIT 1 FOR UPDATE", [digest])).rows[0] as (Row & { generation: number }) | undefined;
      let subscriptionId = latest?.id;
      if (!latest || ["cancelled", "cancel_pending", "cancelling", "cancel_unknown"].includes(latest.phase)) {
        subscriptionId = randomUUID();
        await db.query("INSERT INTO wk_offer_subscriptions(id,scope_hash,generation,scope,source_mode) VALUES($1,$2,$3,$4,$5)", [subscriptionId, digest, (latest?.generation ?? 0) + 1, scope, sourceMode]);
      }
      await db.query("INSERT INTO wk_offer_watch_resources(watch_id,subscription_id) VALUES($1,$2)", [id, subscriptionId]);
    }
    await appendEvent(db, session.id, "alerts.requested", `${item.profile.model} alerts requested`, "The exact variant and chosen merchants are saved. Alerts become active only after Channel3 confirms the subscription. Priority daily refresh is not an instant stock guarantee.", null, sourceMode);
    return id;
  });
  return (await getOfferWatches(session.id)).find(watch => watch.id === id)!;
}

async function retireUnused(db: PoolClient, subscriptionId: string) {
  const row = (await db.query("SELECT * FROM wk_offer_subscriptions WHERE id=$1 FOR UPDATE", [subscriptionId])).rows[0] as Row;
  if ((await db.query(activeConsumersSql, [subscriptionId])).rows[0].count > 0) return;
  if (["queued", "inspecting", "ready_to_create", "pending_canonicalization"].includes(row.phase) && !row.provider_id) {
    await db.query("UPDATE wk_offer_subscriptions SET phase='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1", [subscriptionId]);
  } else if (row.provider_id && row.ownership === "operator_confirmed" && !["cancelled", "cancelling", "cancel_unknown"].includes(row.phase)) {
    await db.query("UPDATE wk_offer_subscriptions SET phase='cancel_pending',next_attempt_at=now(),updated_at=now() WHERE id=$1", [subscriptionId]);
  }
}
export async function stopOfferWatch(session: Session, watchId: string): Promise<OfferWatch> {
  await initializeLiving();
  await transaction(async db => {
    const row = (await db.query("SELECT * FROM wk_offer_watches WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [watchId, session.id])).rows[0];
    if (!row) throw new WorldKitError("not_found", "This alert does not belong to your workspace.", 404);
    if (row.stopped_at) return;
    await db.query("UPDATE wk_offer_watches SET stopped_at=now() WHERE id=$1", [watchId]);
    const links = await db.query("SELECT subscription_id FROM wk_offer_watch_resources WHERE watch_id=$1 ORDER BY subscription_id", [watchId]);
    for (const link of links.rows) await retireUnused(db, link.subscription_id);
    await appendEvent(db, session.id, "alerts.stopped", "Equipment alerts stopped", "This workspace will no longer act on this watch. Shared or unconfirmed provider subscriptions remain intact; only confirmed WorldKit resources with no other active watchers can be cancelled.", null, row.payload.sourceMode);
  });
  return (await getOfferWatches(session.id)).find(watch => watch.id === watchId)!;
}

/** Private operator entry point. It has no browser route and accepts no user-facing ownership claim. */
export async function attestSubscriptionOwnership(input: { subscriptionId: string; providerId: string; expectedScopeHash: string; actor: string; statement: string }) {
  await initializeLiving();
  if (!input.actor.trim() || input.actor.length > 100 || input.statement.trim().length < 40 || input.statement.length > 2000) throw new WorldKitError("invalid_request", "Record a concrete operator statement establishing exclusive WorldKit ownership.");
  await transaction(async db => {
    const row = (await db.query("SELECT * FROM wk_offer_subscriptions WHERE id=$1 FOR UPDATE", [input.subscriptionId])).rows[0] as Row | undefined;
    if (!row || row.provider_id !== input.providerId || row.scope_hash !== input.expectedScopeHash || !row.provider_state || !matchesScope(row.provider_state, row.scope)) throw new WorldKitError("stale_revision", "The operator statement must match the exact recorded provider resource and scope.", 409);
    await db.query("INSERT INTO wk_offer_subscription_ownership(subscription_id,provider_id,statement,actor) VALUES($1,$2,$3,$4) ON CONFLICT(subscription_id) DO UPDATE SET provider_id=EXCLUDED.provider_id,statement=EXCLUDED.statement,actor=EXCLUDED.actor,attested_at=now(),revoked_at=NULL", [row.id, row.provider_id, input.statement, input.actor]);
    await db.query("INSERT INTO wk_offer_subscription_observations(subscription_id,operation,payload) VALUES($1,'ownership_attested',$2)", [row.id, { providerId: row.provider_id, scopeHash: row.scope_hash, actor: input.actor, statement: input.statement, at: now() }]);
    await db.query("UPDATE wk_offer_subscriptions SET ownership='operator_confirmed',updated_at=now() WHERE id=$1", [row.id]);
    await retireUnused(db, row.id);
  });
}
export async function recoverOfferWatches() {
  await initializeLiving();
  await transaction(async db => {
    const expired = await db.query("UPDATE wk_offer_watches w SET stopped_at=now() FROM wk_sessions s,wk_inventory_items i WHERE s.id=w.tenant_id AND i.id=w.item_id AND w.stopped_at IS NULL AND (s.expires_at<=now() OR (i.payload->>'version')::int<>w.item_version OR i.payload->>'status'<>'active') RETURNING w.id");
    for (const watch of expired.rows) {
      const links = await db.query("SELECT subscription_id FROM wk_offer_watch_resources WHERE watch_id=$1 ORDER BY subscription_id", [watch.id]);
      for (const link of links.rows) await retireUnused(db, link.subscription_id);
    }
  });
}

export async function claimSubscription(tenantId?: string, sourceMode: "live" | "sample" | "replay" = "live"): Promise<Claimed | null> {
  await initializeLiving();
  return transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('worldkit:subscription-claim:v1'))");
    const row = (await db.query("SELECT s.* FROM wk_offer_subscriptions s WHERE s.source_mode=$2 AND s.phase NOT IN ('active','cancelled','review_needed') AND s.next_attempt_at<=now() AND (s.lease_expires_at IS NULL OR s.lease_expires_at<now()) AND ($1::text IS NULL OR EXISTS(SELECT 1 FROM wk_offer_watch_resources r JOIN wk_offer_watches w ON w.id=r.watch_id WHERE r.subscription_id=s.id AND w.tenant_id=$1)) AND (SELECT count(*) FROM wk_offer_subscriptions WHERE lease_expires_at>now())<4 ORDER BY s.next_attempt_at,s.created_at LIMIT 1 FOR UPDATE SKIP LOCKED", [tenantId ?? null, sourceMode])).rows[0] as Row | undefined;
    if (!row) return null;
    const token = randomUUID();
    const updated = await db.query("UPDATE wk_offer_subscriptions SET lease_token=$2,lease_expires_at=now()+interval '90 seconds',attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *", [row.id, token]);
    return updated.rows[0] as Claimed;
  });
}
async function fence(db: PoolClient, job: Claimed): Promise<Row> {
  const row = (await db.query("SELECT * FROM wk_offer_subscriptions WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now() FOR UPDATE", [job.id, job.lease_token])).rows[0];
  if (!row) throw new WorldKitError("stale_revision", "The subscription worker lease ended; its observation was retained for recovery.", 409);
  return row as Row;
}
async function observation(job: Claimed, operation: string, payload: unknown) {
  await database().query("INSERT INTO wk_offer_subscription_observations(subscription_id,operation,payload) VALUES($1,$2,$3)", [job.id, operation, payload]);
}
async function schedule(job: Claimed, phase: SubscriptionPhase, error: string | null, seconds = 0, extras: { provider?: ProviderSubscription; ownership?: SubscriptionOwnership } = {}) {
  await transaction(async db => {
    const row = await fence(db, job);
    let nextPhase = phase;
    const ownership = row.ownership === "operator_confirmed" && (!extras.provider || extras.provider.id === row.provider_id) ? row.ownership : extras.ownership ?? row.ownership;
    if (phase === "active" && ownership === "operator_confirmed" && (await db.query(activeConsumersSql, [job.id])).rows[0].count === 0) nextPhase = "cancel_pending";
    await db.query("UPDATE wk_offer_subscriptions SET phase=$3,error=$4,next_attempt_at=now()+($5::int*interval '1 second'),provider_id=$6,provider_state=$7,ownership=$8,failures=CASE WHEN $4::text IS NULL THEN 0 ELSE failures END,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2", [job.id, job.lease_token, nextPhase, error, seconds, extras.provider?.id ?? row.provider_id, extras.provider ?? row.provider_state, ownership]);
  });
}
async function acceptProvider(job: Claimed, provider: ProviderSubscription, recovery = false) {
  await observation(job, recovery ? "recovered" : "observed", provider);
  if (!matchesScope(provider, job.scope)) return schedule(job, "review_needed", "Channel3 returned a different product, variant, merchant scope or locale. Review its identity before enabling alerts.");
  const ownership = job.ownership === "operator_confirmed" ? job.ownership : recovery || job.preflight_ids.includes(provider.id) ? "adopted_read_only" : "unconfirmed";
  return schedule(job, provider.state === "cancelled" ? "cancelled" : "active", null, 0, { provider, ownership });
}

export async function executeSubscription(job: Claimed, suppliedGateway?: SubscriptionGateway) {
  if (job.source_mode !== "live" && !suppliedGateway) throw new WorldKitError("invalid_request", "A scenario requires its declared subscription provider.");
  const gateway = suppliedGateway ?? new Channel3Subscriptions();
  try {
    if (["creating", "create_unknown"].includes(job.phase)) {
      const page = await gateway.list(job.preflight_cursor); await observation(job, "create_reconciliation_page", { ids: page.items.map(item => item.id), nextCursor: page.nextCursor });
      if (job.reconciliation_pages >= 100 || page.nextCursor === job.preflight_cursor && page.nextCursor !== null) return schedule(job, "review_needed", "The provider's scope inventory did not finish safely. The original create remains unresolved; no replacement create was sent.");
      const matches = page.items.filter(item => matchesScope(item, job.scope));
      if (matches.length === 1) return acceptProvider(job, matches[0]!, true);
      if (matches.length > 1) return schedule(job, "review_needed", "More than one provider subscription matches this scope; operator review is needed.");
      await transaction(async db => { await fence(db, job); await db.query("UPDATE wk_offer_subscriptions SET preflight_cursor=$3,reconciliation_pages=CASE WHEN $3::text IS NULL THEN 0 ELSE reconciliation_pages+1 END WHERE id=$1 AND lease_token=$2", [job.id, job.lease_token, page.nextCursor]); });
      return schedule(job, "create_unknown", page.nextCursor ? "Checking the saved request against the provider's complete scope list." : "The original create has no confirmed response. It will be reread; no replacement create has been sent.", page.nextCursor ? 1 : 60);
    }
    if (["queued", "inspecting"].includes(job.phase)) {
      const page = await gateway.list(job.preflight_cursor);
      await observation(job, "preflight_page", { ids: page.items.map(item => item.id), nextCursor: page.nextCursor });
      if (job.preflight_pages >= 100 || page.nextCursor === job.preflight_cursor && page.nextCursor !== null) return schedule(job, "review_needed", "The provider's scope inventory did not finish safely. No subscription was created.");
      const matches = page.items.filter(item => matchesScope(item, job.scope));
      if (matches.length > 1) return schedule(job, "review_needed", "Multiple existing provider watches match this scope.");
      await transaction(async db => {
        await fence(db, job);
        await db.query("UPDATE wk_offer_subscriptions SET preflight_ids=$3,preflight_cursor=$4,preflight_pages=preflight_pages+1,preflight_complete=$5 WHERE id=$1 AND lease_token=$2", [job.id, job.lease_token, JSON.stringify([...new Set([...job.preflight_ids, ...page.items.map(item => item.id)])]), page.nextCursor, page.nextCursor === null]);
      });
      if (matches[0]) return acceptProvider({ ...job, preflight_ids: [...job.preflight_ids, matches[0].id] }, matches[0], true);
      return schedule(job, page.nextCursor ? "inspecting" : "ready_to_create", null, 0);
    }
    if (["ready_to_create", "pending_canonicalization"].includes(job.phase)) {
      const allowed = await transaction(async db => {
        const current = await fence(db, job);
        if (!current.preflight_complete) throw new WorldKitError("needs_evidence", "The provider scope inventory is incomplete.", 409);
        if ((await db.query(activeConsumersSql, [job.id])).rows[0].count === 0) { await db.query("UPDATE wk_offer_subscriptions SET phase='cancelled',lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [job.id]); return false; }
        await db.query("UPDATE wk_offer_subscriptions SET phase='creating',dispatch_started_at=coalesce(dispatch_started_at,now()),preflight_cursor=NULL WHERE id=$1", [job.id]); return true;
      });
      if (!allowed) return;
      try { return await acceptProvider(job, await gateway.create(job.scope)); }
      catch (error) {
        if (error instanceof SubscriptionFailure && error.code === "canonicalizing") {
          const elapsed = job.canonicalization_started_at ? Date.now() - new Date(job.canonicalization_started_at).getTime() : 0;
          const delay = canonicalizationDelay(job.canonicalization_attempts + 1, elapsed);
          await transaction(async db => { await fence(db, job); await db.query("UPDATE wk_offer_subscriptions SET canonicalization_started_at=coalesce(canonicalization_started_at,now()),canonicalization_attempts=canonicalization_attempts+1 WHERE id=$1", [job.id]); });
          return schedule(job, "pending_canonicalization", delay.background ? "Stock alerts are not active yet. The catalog ID is still processing; background checks continue." : "Channel3 is still preparing this canonical product ID.", delay.seconds);
        }
        if (error instanceof SubscriptionFailure && error.status === 429) {
          await transaction(async db => { await fence(db, job); await db.query("UPDATE wk_offer_subscriptions SET phase='ready_to_create' WHERE id=$1", [job.id]); });
          throw error;
        }
        if (error instanceof SubscriptionFailure && error.outcome === "rejected") return schedule(job, "review_needed", `Channel3 refused this subscription (${error.status ?? "request"}). The chosen scope was not widened.`);
        await schedule(job, "create_unknown", "The provider response was lost. The saved scope will be reread before any further action.", 5); return;
      }
    }
    if (["cancel_pending", "cancelling", "cancel_unknown"].includes(job.phase)) {
      if (!job.provider_id) return schedule(job, "review_needed", "The provider subscription identity needs reconciliation before cancellation.");
      const permitted = await transaction(async db => {
        const row = await fence(db, job); const proof = (await db.query("SELECT provider_id FROM wk_offer_subscription_ownership WHERE subscription_id=$1 AND revoked_at IS NULL", [job.id])).rows[0];
        if (row.ownership !== "operator_confirmed" || proof?.provider_id !== row.provider_id || (await db.query(activeConsumersSql, [job.id])).rows[0].count > 0) return false;
        await db.query("UPDATE wk_offer_subscriptions SET phase='cancelling' WHERE id=$1", [job.id]); return true;
      });
      if (!permitted) return schedule(job, "active", "Remote cancellation was withheld because this provider resource is shared or lacks confirmed WorldKit ownership.");
      if (job.phase !== "cancel_pending") {
        const current = await gateway.retrieve(job.provider_id); await observation(job, "cancel_reconciliation", current);
        if (current.state === "cancelled" && current.id === job.provider_id && matchesScope(current, job.scope)) return schedule(job, "cancelled", null, 0, { provider: current });
        return schedule(job, "cancel_unknown", "The original cancellation is still being checked. No duplicate cancellation was sent.", 60);
      }
      const result = await gateway.cancel(job.provider_id); await observation(job, "cancel", result);
      if (result.id !== job.provider_id || result.state !== "cancelled" || !matchesScope(result, job.scope)) return schedule(job, "cancel_unknown", "The provider did not confirm this exact cancellation.", 5);
      return schedule(job, "cancelled", null, 0, { provider: result });
    }
  } catch (error) {
    if (error instanceof WorldKitError && error.code === "stale_revision") return;
    const current = (await database().query("SELECT * FROM wk_offer_subscriptions WHERE id=$1", [job.id])).rows[0] as Row;
    await observation(job, "error", { code: error instanceof SubscriptionFailure ? error.code : "provider_unavailable", status: error instanceof SubscriptionFailure ? error.status : null });
    const phase: SubscriptionPhase = ["cancel_pending", "cancelling", "cancel_unknown"].includes(current.phase) ? "cancel_unknown" : ["creating", "create_unknown"].includes(current.phase) ? "create_unknown" : current.phase;
    try {
      const failures = await transaction(async db => { const row = await fence(db, job); await db.query("UPDATE wk_offer_subscriptions SET failures=failures+1,resume_phase=$2 WHERE id=$1", [job.id, phase]); return row.failures + 1; });
      await schedule(job, failures >= 6 ? "review_needed" : phase, failures >= 6 ? "Provider checks repeatedly failed. Retry the saved check when Channel3 is available; uncertain writes will only be reconciled." : "The provider check did not finish. Saved ownership and scope remain unchanged.", Math.min(300, 5 * 2 ** Math.min(failures, 6)));
    }
    catch (late) { if (!(late instanceof WorldKitError && late.code === "stale_revision")) throw late; }
  }
}
export async function retryOfferWatch(session: Session, watchId: string): Promise<void> {
  await initializeLiving();
  const updated = await database().query("UPDATE wk_offer_subscriptions s SET phase=s.resume_phase,resume_phase=NULL,failures=0,error=NULL,next_attempt_at=now(),updated_at=now() FROM wk_offer_watch_resources r,wk_offer_watches w WHERE r.subscription_id=s.id AND w.id=r.watch_id AND w.id=$1 AND w.tenant_id=$2 AND w.stopped_at IS NULL AND s.phase='review_needed' AND s.resume_phase IS NOT NULL RETURNING s.id", [watchId, session.id]);
  if (!updated.rowCount) throw new WorldKitError("not_found", "This workspace has no retryable saved alert check.", 404);
}
export async function processSubscriptions(gateway?: SubscriptionGateway, tenantId?: string, sourceMode: "live" | "sample" | "replay" = "live"): Promise<number> {
  if (sourceMode !== "live" && !gateway) throw new WorldKitError("invalid_request", "A scenario needs its declared subscription provider context.");
  const provider = gateway ?? new Channel3Subscriptions();
  await recoverOfferWatches();
  const results = await Promise.all([0, 1].map(async () => { const job = await claimSubscription(tenantId, sourceMode); if (!job) return false; await executeSubscription(job, provider); return true; }));
  return results.filter(Boolean).length;
}
