import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SubscriptionFailure, type SubscriptionGateway } from "../../packages/channel3/subscriptions";
import type { CatalogSnapshot } from "../../packages/contracts";
import type { ProviderSubscription, SubscriptionScope } from "../../packages/living-kit/subscriptions";
import { createSession, getRevision, saveCatalogResult, type Session } from "../../src/server/repository";
import { confirmInventory, previewInventory } from "../../src/server/inventory";
import { database } from "../../src/server/db";
import { claimSubscription, executeSubscription, requestOfferWatch } from "../../src/server/subscriptions";
import { catalog, confirmation, receipt } from "./inventory-fixtures";
import { providerSubscription } from "./webhook-fixtures";

export class FixtureSubscriptions implements SubscriptionGateway {
  records = new Map<string, ProviderSubscription>(); calls: { kind: string; id: string }[] = [];
  createFailure: "none" | "canonicalizing" | "quota" | "lost" = "none"; cancelLost = false;
  async list(_cursor: string | null) { this.calls.push({ kind: "list", id: _cursor ?? "first" }); return { items: [...this.records.values()].filter(row => row.state === "active"), nextCursor: null }; }
  async create(scope: SubscriptionScope) {
    const row = (await database().query("SELECT phase,dispatch_started_at FROM wk_offer_subscriptions WHERE source_mode='sample' AND scope->>'productId'=$1 ORDER BY created_at DESC LIMIT 1", [scope.productId])).rows[0];
    assert.equal(row.phase, "creating"); assert.ok(row.dispatch_started_at);
    this.calls.push({ kind: "create", id: scope.productId });
    if (this.createFailure === "canonicalizing") throw new SubscriptionFailure("canonicalizing", "rejected", 409);
    if (this.createFailure === "quota") throw new SubscriptionFailure("unavailable", "rejected", 429);
    const result = providerSubscription(scope); this.records.set(result.id, result);
    if (this.createFailure === "lost") throw new SubscriptionFailure("unavailable", "unknown", 502);
    return result;
  }
  async retrieve(id: string) { this.calls.push({ kind: "retrieve", id }); const row = this.records.get(id); if (!row) throw new SubscriptionFailure("not_found", "rejected", 404); return row; }
  async cancel(id: string) {
    this.calls.push({ kind: "cancel", id }); const row = this.records.get(id); if (!row) throw new SubscriptionFailure("not_found", "rejected", 404);
    const result: ProviderSubscription = { ...row, state: "cancelled" }; this.records.set(id, result);
    if (this.cancelLost) throw new SubscriptionFailure("unavailable", "unknown", 502);
    return result;
  }
}
export async function livingFixture(snapshot: CatalogSnapshot = catalog(), suppliedSession?: Session) {
  const session = suppliedSession ?? (await createSession()).session;
  const previous = await getRevision(session.id);
  await saveCatalogResult(session.id, [snapshot], receipt(snapshot));
  const input = confirmation(previous, undefined, snapshot); const preview = await previewInventory(session, input);
  const item = await confirmInventory(session, input, preview.previewHash);
  const request = { itemId: item.id, expectedVersion: item.version, requestId: randomUUID(), domains: [snapshot.offers[0]!.domain] };
  const refresh = async () => ({ value: { snapshot: { ...snapshot, observedAt: new Date().toISOString() } }, receipt: receipt(snapshot) });
  const watch = await requestOfferWatch(session, request, refresh, "sample");
  const subscriptionId = watch.resources[0]!.id;
  return { session, previous, item, snapshot, request, watch, refresh, subscriptionId };
}
export async function subscriptionRow(id: string) { return (await database().query("SELECT * FROM wk_offer_subscriptions WHERE id=$1", [id])).rows[0]; }
export async function advanceSubscription(fixture: { session: Session; subscriptionId: string }, provider: SubscriptionGateway, makeDue = false) {
  if (makeDue) await database().query("UPDATE wk_offer_subscriptions SET next_attempt_at=now() WHERE id=$1", [fixture.subscriptionId]);
  const job = await claimSubscription(fixture.session.id, "sample"); assert.ok(job); assert.equal(job.id, fixture.subscriptionId);
  await executeSubscription(job, provider); return subscriptionRow(job.id);
}
