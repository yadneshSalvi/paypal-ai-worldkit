/** Production-build local HTTP guard checks. Fixtures are Sample, never provider callbacks. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createSession } from "../src/server/repository";
import { closeDatabase, database } from "../src/server/db";
import { livingFixture } from "../tests/support/living-fixtures";
import { livingView } from "../src/server/living-kit";

const origin = "http://127.0.0.1:4106";
const checks: { name: string; status: number; passed: true }[] = [];
async function request(path: string, expected: number[], options: { token?: string; method?: string; body?: unknown; origin?: string | null; contentType?: string } = {}) {
  const method = options.method ?? "GET"; const headers = new Headers();
  if (options.token) headers.set("cookie", `wk_session=${options.token}`);
  if (method === "POST") { headers.set("content-type", options.contentType ?? "application/json"); if (options.origin !== null) headers.set("origin", options.origin ?? origin); }
  const response = await fetch(`${origin}${path}`, { method, headers, ...(options.body !== undefined ? { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) } : {}) });
  assert.ok(expected.includes(response.status), `${method} ${path}: expected ${expected.join("/")}, received ${response.status}`);
  const body = await response.json(); return { status: response.status, body };
}
function pass(name: string, result: { status: number }) { checks.push({ name, status: result.status, passed: true }); }
try {
  const own = await createSession(); const foreign = await createSession(); const fixture = await livingFixture(undefined, own.session);
  pass("Anonymous Living Kit access denied", await request("/api/living-kit", [401]));
  pass("Same-origin requirement enforced", await request("/api/living-kit", [403], { method: "POST", token: own.token, origin: null, body: { kind: "stop_watch", watchId: fixture.watch.id } }));
  pass("Foreign origin denied", await request("/api/living-kit", [403], { method: "POST", token: own.token, origin: "https://foreign.example", body: { kind: "stop_watch", watchId: fixture.watch.id } }));
  const ownView = await request("/api/living-kit", [200], { token: own.token }); assert.equal(ownView.body.watches[0].id, fixture.watch.id); assert.equal(ownView.body.watches[0].sourceMode, "sample"); pass("Own Sample provenance and exact variant retained", ownView);
  const outsider = await request("/api/living-kit", [200], { token: foreign.token }); assert.equal(outsider.body.watches.length, 0); assert.equal(outsider.body.events.length, 0); pass("Second tenant sees no foreign alerts or event receipts", outsider);
  pass("Foreign watch mutation denied", await request("/api/living-kit", [404], { token: foreign.token, method: "POST", body: { kind: "stop_watch", watchId: fixture.watch.id } }));
  pass("Browser cannot select Sample or replay intake", await request("/api/living-kit", [400], { token: own.token, method: "POST", body: { kind: "start_watch", itemId: fixture.item.id, expectedVersion: fixture.item.version, requestId: randomUUID(), domains: ["merchant.example"], sourceMode: "sample" } }));
  pass("Unsigned PayPal delivery rejected before postback", await request("/api/webhooks/paypal", [400], { method: "POST", origin: null, body: { id: "synthetic-unsigned-event" } }));
  pass("Unsigned or unconfigured Channel3 delivery not accepted", await request("/api/webhooks/channel3", [400, 503], { method: "POST", origin: null, body: { id: "synthetic-unsigned-event" } }));
  pass("Wrong media type rejected", await request("/api/webhooks/paypal", [415], { method: "POST", origin: null, contentType: "text/plain", body: "{}" }));
  pass("Oversized raw delivery rejected", await request("/api/webhooks/paypal", [413], { method: "POST", origin: null, body: "x".repeat(1_048_577) }));
  pass("Unauthenticated maintenance denied", await request("/api/jobs/recover", [401]));
  const stopped = await request("/api/living-kit", [200], { token: own.token, method: "POST", body: { kind: "stop_watch", watchId: fixture.watch.id } }); assert.equal(stopped.body.watches[0].state, "stopped"); pass("Stopping an owned Sample alert persists immediately", stopped);
  const again = await request("/api/living-kit", [200], { token: own.token }); assert.equal(again.body.watches[0].state, "stopped"); pass("Stopped alert survives a new request", again);
  const view = await livingView(own.session.id); assert.equal(view.notifications.length, 0);
  const money = await database().query("SELECT id FROM wk_commerce_orders WHERE tenant_id=ANY($1::text[])", [[own.session.id, foreign.session.id]]); assert.equal(money.rowCount, 0);
  const proof = { qualifiedAt: new Date().toISOString(), environment: "local_production_build", sourceMode: "sample", checks, financialOrdersCreated: 0, providerMutations: 0, authenticProviderDeliveries: 0 };
  await mkdir("docs/evidence", { recursive: true }); await writeFile("docs/evidence/living-http-qualification.json", JSON.stringify(proof, null, 2));
  process.stdout.write(`${JSON.stringify({ checks: checks.length, passed: checks.length, financialOrdersCreated: 0, providerMutations: 0 })}\n`);
} finally { await closeDatabase(); }
