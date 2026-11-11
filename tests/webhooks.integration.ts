import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, database } from "../src/server/db";
import { createSession, getRevision } from "../src/server/repository";
import { livingView } from "../src/server/living-kit";
import { readNotification } from "../src/server/notifications";
import { executeWebhook } from "../src/server/webhook-runner";
import { acceptWebhook, claimWebhook, webhookSummaries } from "../src/server/webhooks";
import { stopOfferWatch } from "../src/server/subscriptions";
import { unseal } from "../src/server/secrets";
import { sha256 } from "../packages/spec-evidence/sources";
import { catalogEvent, fixtureSecret, providerSubscription, signedHeaders } from "./support/webhook-fixtures";
import { advanceSubscription, FixtureSubscriptions, livingFixture, subscriptionRow } from "./support/living-fixtures";
import { receipt } from "./support/inventory-fixtures";
after(async () => { await closeDatabase(); });

async function activeFixture() {
  const f = await livingFixture(); const gateway = new FixtureSubscriptions();
  await advanceSubscription(f, gateway); const row = await advanceSubscription(f, gateway);
  const provider = gateway.records.get(row.provider_id)!; const event = catalogEvent(provider);
  const namespace = `fixture-${randomUUID()}`; const raw = JSON.stringify(event, null, 2); const headers = signedHeaders(raw);
  const accept = () => acceptWebhook("channel3", raw, headers, { channel3Secrets: [fixtureSecret], sourceMode: "sample", namespace });
  const runtime = { catalog: { mode: "sample" as const, refresh: f.refresh } };
  return { ...f, provider, event, namespace, raw, headers, accept, runtime };
}
async function claim(namespace: string) { const job = await claimWebhook(undefined, namespace); assert.ok(job); return job; }

test("concurrent duplicate deliveries preserve one canonical event and every receipt even with the same transmission ID", async () => {
  const f = await activeFixture(); const before = await getRevision(f.session.id);
  const accepted = await Promise.all([f.accept(), f.accept(), f.accept(), f.accept()]);
  assert.equal(accepted.filter(result => !result.duplicate).length, 1);
  const job = await claim(f.namespace); assert.equal(job.deliveries, 4);
  const deliveries = await database().query("SELECT transmission_id FROM wk_webhook_deliveries WHERE event_id=$1", [job.id]); assert.equal(deliveries.rowCount, 4); assert.equal(new Set(deliveries.rows.map(row => row.transmission_id)).size, 1);
  await executeWebhook(job, f.runtime);
  const view = await livingView(f.session.id); assert.equal(view.incidents.length, 1); assert.equal(view.notifications.length, 1); assert.equal(view.incidents[0]!.impact.state, "resolved"); assert.equal(view.events[0]!.state, "completed");
  assert.deepEqual(await getRevision(f.session.id), before); await f.accept(); assert.equal(await claimWebhook(undefined, f.namespace), null);
  const foreign = (await createSession()).session; assert.deepEqual(await webhookSummaries(foreign.id), []); assert.equal((await livingView(foreign.id)).incidents.length, 0);
});
test("changed payload for a signed duplicate is quarantined without replacing the original bytes or signal", async () => {
  const f = await activeFixture(); await f.accept(); const changed = JSON.stringify({ ...f.event, data: { ...f.event.data, current: "InStock" } });
  const conflict = await acceptWebhook("channel3", changed, signedHeaders(changed), { channel3Secrets: [fixtureSecret], sourceMode: "sample", namespace: f.namespace }); assert.equal(conflict.conflict, true);
  const row = (await database().query("SELECT * FROM wk_webhook_events WHERE namespace=$1", [f.namespace])).rows[0];
  assert.equal(row.body_hash, sha256(f.raw)); assert.equal(row.signal.current, "OutOfStock"); assert.equal(row.conflicts, 1);
  const original = unseal<{ rawBody: string }>(`webhook:channel3:${f.namespace}:${f.event.id}`, row.raw_receipt); assert.equal(original.rawBody, f.raw); assert.equal(JSON.stringify(row.raw_receipt).includes("OutOfStock"), false);
  await executeWebhook(await claim(f.namespace), f.runtime); assert.equal((await livingView(f.session.id)).incidents[0]!.impact.state, "resolved");
});
test("invalid signatures cannot poison an event ID before an authenticated delivery", async () => {
  const f = await activeFixture(); const bad = new Headers(f.headers); bad.set("svix-signature", "v1,ZmFrZQ==");
  await assert.rejects(acceptWebhook("channel3", f.raw, bad, { channel3Secrets: [fixtureSecret], sourceMode: "sample", namespace: f.namespace }), /signature/);
  assert.equal((await database().query("SELECT id FROM wk_webhook_events WHERE namespace=$1", [f.namespace])).rowCount, 0);
  assert.equal((await f.accept()).duplicate, false); await executeWebhook(await claim(f.namespace), f.runtime);
});
test("an authenticated unknown schema is retained for review while variant-mismatched events remain unowned", async () => {
  const f = await activeFixture();
  const unsupported = JSON.stringify({ id: `fixture-unsupported-${randomUUID()}`, type: "offer.future.changed", data: {} });
  const result = await acceptWebhook("channel3", unsupported, signedHeaders(unsupported), { channel3Secrets: [fixtureSecret], sourceMode: "sample", namespace: f.namespace }); assert.equal(result.state, "dead_letter");
  const wrong = JSON.stringify({ ...f.event, data: { ...f.event.data, subject: { ...f.event.data.subject, selection: [{ name: "Color", label: "White" }] } } });
  await acceptWebhook("channel3", wrong, signedHeaders(wrong), { channel3Secrets: [fixtureSecret], sourceMode: "sample", namespace: f.namespace });
  await database().query("UPDATE wk_webhook_events SET received_at=now()-interval '16 minutes' WHERE namespace=$1 AND state='queued'", [f.namespace]);
  let reads = 0; await executeWebhook(await claim(f.namespace), { catalog: { mode: "sample", refresh: async () => { reads++; return f.refresh(); } } });
  assert.equal(reads, 0); assert.equal((await webhookSummaries(f.session.id)).length, 0);
});
test("a delivery arriving before subscription persistence is matched on recovery without fabricating another event", async () => {
  const f = await livingFixture(); const row = await subscriptionRow(f.subscriptionId); const provider = providerSubscription(row.scope); const gateway = new FixtureSubscriptions(); gateway.records.set(provider.id, provider);
  const event = catalogEvent(provider); const raw = JSON.stringify(event); const namespace = `fixture-${randomUUID()}`;
  await acceptWebhook("channel3", raw, signedHeaders(raw), { channel3Secrets: [fixtureSecret], sourceMode: "sample", namespace });
  assert.equal((await webhookSummaries(f.session.id)).length, 0);
  await advanceSubscription(f, gateway); await executeWebhook(await claim(namespace), { catalog: { mode: "sample", refresh: f.refresh } });
  assert.equal((await webhookSummaries(f.session.id))[0]!.state, "completed"); assert.equal((await livingView(f.session.id)).incidents.length, 1);
});
test("stopping an alert during a provider read prevents its late result from notifying the workspace", async () => {
  const f = await activeFixture(); await f.accept(); const job = await claim(f.namespace);
  let resume!: () => void; let entered!: () => void; const waiting = new Promise<void>(resolve => { resume = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const processing = executeWebhook(job, { catalog: { mode: "sample", refresh: async () => { entered(); await waiting; return f.refresh(); } } }); await started;
  await stopOfferWatch(f.session, f.watch.id); resume(); await processing;
  const view = await livingView(f.session.id); assert.equal(view.incidents.length, 0); assert.equal(view.notifications.length, 0);
});
test("lease recovery fences a late out-of-stock result behind the newer current observation", async () => {
  const f = await activeFixture(); await f.accept(); const old = await claim(f.namespace);
  let resume!: () => void; let entered!: () => void; const waiting = new Promise<void>(resolve => { resume = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const processing = executeWebhook(old, { catalog: { mode: "sample", refresh: async () => { entered(); await waiting; const snapshot = { ...f.snapshot, offers: f.snapshot.offers.map(offer => ({ ...offer, availability: "OutOfStock" })) }; return { value: { snapshot }, receipt: receipt(snapshot) }; } } }); await started;
  await database().query("UPDATE wk_webhook_events SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [old.id]);
  await executeWebhook(await claim(f.namespace), f.runtime); resume(); await processing;
  const view = await livingView(f.session.id); assert.equal(view.incidents.length, 1); assert.equal(view.incidents[0]!.impact.state, "resolved"); assert.equal(view.notifications.length, 1);
});
test("a current shortage creates one review incident and a private notification, never a kit edit or a payment", async () => {
  const f = await activeFixture(); await f.accept(); const before = await getRevision(f.session.id);
  const snapshot = { ...f.snapshot, observedAt: new Date().toISOString(), offers: f.snapshot.offers.map(offer => ({ ...offer, availability: "OutOfStock" })) };
  await executeWebhook(await claim(f.namespace), { catalog: { mode: "sample", refresh: async () => ({ value: { snapshot }, receipt: receipt(snapshot) }) } });
  const view = await livingView(f.session.id); assert.equal(view.incidents[0]!.impact.state, "needs_repair_review"); assert.equal(view.incidents[0]!.sourceMode, "sample"); assert.equal(view.incidents[0]!.catalogSource, "sample"); assert.deepEqual(await getRevision(f.session.id), before);
  assert.equal((await database().query("SELECT id FROM wk_commerce_orders WHERE tenant_id=$1", [f.session.id])).rowCount, 0);
  const outsider = (await createSession()).session; await assert.rejects(readNotification(outsider.id, view.notifications[0]!.id), /not in/);
  await readNotification(f.session.id, view.notifications[0]!.id); const first = (await livingView(f.session.id)).notifications[0]!.readAt; await readNotification(f.session.id, view.notifications[0]!.id); assert.equal((await livingView(f.session.id)).notifications[0]!.readAt, first);
});
