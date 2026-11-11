/** Local UI qualification only: explicit Sample resources, no network provider. */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createSession } from "../src/server/repository";
import { closeDatabase } from "../src/server/db";
import { acceptWebhook, claimWebhook } from "../src/server/webhooks";
import { executeWebhook } from "../src/server/webhook-runner";
import { livingView } from "../src/server/living-kit";
import { advanceSubscription, FixtureSubscriptions, livingFixture } from "../tests/support/living-fixtures";
import { catalogEvent, fixtureSecret, signedHeaders } from "../tests/support/webhook-fixtures";
import { receipt } from "../tests/support/inventory-fixtures";

try {
  const { session, token } = await createSession(); const f = await livingFixture(undefined, session); const gateway = new FixtureSubscriptions();
  await advanceSubscription(f, gateway); const row = await advanceSubscription(f, gateway); const subscription = gateway.records.get(row.provider_id)!;
  const event = catalogEvent(subscription); const namespace = `ui-sample-${randomUUID()}`; const raw = JSON.stringify(event); const headers = signedHeaders(raw);
  for (let index = 0; index < 3; index++) await acceptWebhook("channel3", raw, headers, { sourceMode: "sample", namespace, channel3Secrets: [fixtureSecret] });
  const job = await claimWebhook(session.id, namespace); if (!job) throw new Error("The sample event did not become available.");
  const snapshot = { ...f.snapshot, observedAt: new Date().toISOString(), offers: f.snapshot.offers.map(offer => ({ ...offer, availability: "OutOfStock" })) };
  await executeWebhook(job, { catalog: { mode: "sample", refresh: async () => ({ value: { snapshot }, receipt: receipt(snapshot) }) } });
  const view = await livingView(session.id); await mkdir(".artifacts", { recursive: true });
  await writeFile(".artifacts/living-ui-session.json", JSON.stringify({ token, session, sourceMode: "sample" }, null, 2), { mode: 0o600 });
  const proof = { sourceMode: "sample", tenantId: session.id, watchId: f.watch.id, itemId: f.item.id, eventId: job.id, incidents: view.incidents.length, notifications: view.notifications.length, deliveries: view.events[0]?.deliveries, financialWrites: 0, externalProviderCalls: 0, createdAt: new Date().toISOString() };
  await writeFile(".artifacts/living-ui-fixture.json", JSON.stringify(proof, null, 2)); process.stdout.write(`${JSON.stringify(proof)}\n`);
} finally { await closeDatabase(); }
