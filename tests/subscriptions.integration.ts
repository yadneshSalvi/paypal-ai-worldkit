import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, database } from "../src/server/db";
import { attestSubscriptionOwnership, claimSubscription, executeSubscription, getOfferWatches, requestOfferWatch, retryOfferWatch, stopOfferWatch } from "../src/server/subscriptions";
import { catalog } from "./support/inventory-fixtures";
import { advanceSubscription, FixtureSubscriptions, livingFixture, subscriptionRow } from "./support/living-fixtures";
import { providerSubscription } from "./support/webhook-fixtures";
after(async () => { await closeDatabase(); });

test("duplicate alert requests share one scope and a provider write has a durable intent first", async () => {
  const f = await livingFixture(); const gateway = new FixtureSubscriptions();
  const duplicate = await requestOfferWatch(f.session, f.request, f.refresh, "sample"); assert.equal(duplicate.id, f.watch.id);
  const reopened = await requestOfferWatch(f.session, { ...f.request, requestId: randomUUID() }, f.refresh, "sample"); assert.equal(reopened.id, f.watch.id, "reopening the dialog must not create another identical active alert");
  await assert.rejects(requestOfferWatch(f.session, { ...f.request, domains: ["other.example"] }, f.refresh, "sample"), /already belongs/);
  assert.equal(await claimSubscription(f.session.id), null, "the live worker must never claim a sample subscription");
  assert.equal((await advanceSubscription(f, gateway)).phase, "ready_to_create");
  const active = await advanceSubscription(f, gateway); assert.equal(active.phase, "active"); assert.equal(active.ownership, "unconfirmed");
  assert.equal(gateway.calls.filter(call => call.kind === "create").length, 1);
});
test("an existing account subscription is adopted read-only and stopping its local watch cannot cancel it", async () => {
  const f = await livingFixture(); const gateway = new FixtureSubscriptions(); const row = await subscriptionRow(f.subscriptionId); const prior = providerSubscription(row.scope); gateway.records.set(prior.id, prior);
  assert.equal((await advanceSubscription(f, gateway)).ownership, "adopted_read_only");
  const stopped = await stopOfferWatch(f.session, f.watch.id); assert.equal(stopped.state, "stopped");
  assert.equal((await subscriptionRow(f.subscriptionId)).phase, "active"); assert.equal(gateway.calls.filter(call => ["create", "cancel"].includes(call.kind)).length, 0);
});
test("a lost create response is recovered by the same scope without a second write", async () => {
  const f = await livingFixture(); const gateway = new FixtureSubscriptions(); gateway.createFailure = "lost";
  await advanceSubscription(f, gateway); assert.equal((await advanceSubscription(f, gateway)).phase, "create_unknown");
  await closeDatabase(); const recovered = await advanceSubscription(f, gateway, true);
  assert.equal(recovered.phase, "active"); assert.equal(recovered.ownership, "adopted_read_only");
  assert.equal(gateway.calls.filter(call => call.kind === "create").length, 1);
});
test("409 saves bounded backoff and a quota refusal does not become an uncertain duplicate create", async () => {
  const f = await livingFixture(); const gateway = new FixtureSubscriptions(); gateway.createFailure = "canonicalizing";
  await advanceSubscription(f, gateway); const first = await advanceSubscription(f, gateway);
  assert.equal(first.phase, "pending_canonicalization"); assert.equal(first.canonicalization_attempts, 1); assert.ok(new Date(first.next_attempt_at).getTime() > Date.now());
  const second = await advanceSubscription(f, gateway, true); assert.equal(second.canonicalization_attempts, 2);
  gateway.createFailure = "quota"; const quota = await advanceSubscription(f, gateway, true); assert.equal(quota.phase, "ready_to_create"); assert.equal(quota.failures, 1);
  gateway.createFailure = "none"; assert.equal((await advanceSubscription(f, gateway, true)).phase, "active");
});
test("shared watches require confirmed ownership and zero active consumers before one cancellation", async () => {
  const first = await livingFixture(); const otherSnapshot = { ...first.snapshot, id: randomUUID() }; const second = await livingFixture(otherSnapshot);
  assert.equal(first.subscriptionId, second.subscriptionId); const gateway = new FixtureSubscriptions();
  await advanceSubscription(first, gateway); const active = await advanceSubscription(first, gateway);
  await attestSubscriptionOwnership({ subscriptionId: active.id, providerId: active.provider_id, expectedScopeHash: active.scope_hash, actor: "synthetic-test-operator", statement: "Synthetic ownership assertion for a fixture only; no real provider resource or human review exists." });
  await stopOfferWatch(first.session, first.watch.id); assert.equal((await subscriptionRow(active.id)).phase, "active");
  await assert.rejects(stopOfferWatch(first.session, second.watch.id), /does not belong/);
  await stopOfferWatch(second.session, second.watch.id); assert.equal((await subscriptionRow(active.id)).phase, "cancel_pending");
  gateway.cancelLost = true; assert.equal((await advanceSubscription(second, gateway)).phase, "cancel_unknown");
  assert.equal((await advanceSubscription(second, gateway, true)).phase, "cancelled");
  assert.equal(gateway.calls.filter(call => call.kind === "cancel").length, 1); assert.equal((await getOfferWatches(first.session.id))[0]!.state, "stopped");
});
test("expired leases retain a late create observation without allowing it to overwrite recovery", async () => {
  const f = await livingFixture(); const gateway = new FixtureSubscriptions(); await advanceSubscription(f, gateway);
  let release!: () => void; let dispatched!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }); const called = new Promise<void>(resolve => { dispatched = resolve; });
  const create = gateway.create.bind(gateway); gateway.create = async scope => { const value = await create(scope); dispatched(); await waiting; return value; };
  const job = await claimSubscription(f.session.id, "sample"); assert.ok(job); const running = executeSubscription(job, gateway); await called;
  await database().query("UPDATE wk_offer_subscriptions SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [f.subscriptionId]);
  const recovered = await advanceSubscription(f, gateway); assert.equal(recovered.phase, "active");
  release(); await running; const current = await subscriptionRow(f.subscriptionId); assert.equal(current.provider_id, recovered.provider_id); assert.equal(current.ownership, "adopted_read_only");
  assert.equal(gateway.calls.filter(call => call.kind === "create").length, 1);
  const observations = await database().query("SELECT operation FROM wk_offer_subscription_observations WHERE subscription_id=$1", [f.subscriptionId]); assert.ok(observations.rows.some(row => row.operation === "observed"));
});
test("repeated provider-read failures become a retryable saved check without inventing a new resource", async () => {
  const f = await livingFixture(catalog()); const gateway = new FixtureSubscriptions(); gateway.list = async () => { throw new Error("Synthetic network outage"); };
  for (let count = 0; count < 6; count++) await advanceSubscription(f, gateway, true);
  assert.equal((await subscriptionRow(f.subscriptionId)).phase, "review_needed");
  await retryOfferWatch(f.session, f.watch.id); assert.equal((await subscriptionRow(f.subscriptionId)).phase, "queued"); assert.equal(gateway.calls.filter(call => call.kind === "create").length, 0);
  await stopOfferWatch(f.session, f.watch.id);
});
