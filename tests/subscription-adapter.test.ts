import test from "node:test";
import assert from "node:assert/strict";
import { Channel3 } from "@channel3/sdk";
import { Channel3Subscriptions, SubscriptionFailure } from "../packages/channel3/subscriptions";
import { fixtureScope } from "./support/webhook-fixtures";

const scope = fixtureScope("fixture-product");
const response = { subscription_id: "fixture-subscription", product_id: scope.productId, events: scope.events, domains: scope.domains, selection: [{ name: "Color", label: "Black", value_key: "provider-private-key" }], locale: scope.locale, status: "active", created_at: "2026-11-11T00:00:00Z" };
test("pinned SDK wire preserves exact create scope and never invents an idempotency header", async () => {
  const requests: Request[] = [];
  const client = new Channel3({ apiKey: "synthetic-key", country: "US", currency: "USD", language: "en", fetch: async (input, init) => { requests.push(new Request(input, init)); return Response.json(response); } });
  const result = await new Channel3Subscriptions(client).create(scope);
  assert.equal(requests.length, 1); const request = requests[0]!;
  assert.equal(request.method, "POST"); assert.equal(new URL(request.url).pathname, "/v1/product-subscriptions");
  assert.deepEqual(await request.json(), { product_id: scope.productId, selection: scope.selection, domains: scope.domains, events: scope.events });
  assert.equal(request.headers.get("idempotency-key"), null); assert.equal(request.headers.get("x-channel3-country"), "US");
  assert.deepEqual(result.scope.selection, scope.selection); assert.equal(JSON.stringify(result).includes("provider-private-key"), false);
});
test("list inventory is one explicit cursor page and exact retrieve/delete use the same resource", async () => {
  const seen: { url: URL; method: string }[] = [];
  const client = new Channel3({ apiKey: "synthetic-key", fetch: async (input, init) => {
    const request = new Request(input, init); const url = new URL(request.url); seen.push({ url, method: request.method });
    return Response.json(url.pathname.endsWith("/fixture-subscription") ? { ...response, status: request.method === "DELETE" ? "cancelled" : "active" } : { items: [response], next_cursor: "next-page" });
  } });
  const gateway = new Channel3Subscriptions(client); const page = await gateway.list("prior-page");
  assert.equal(seen.length, 1); assert.equal(page.nextCursor, "next-page"); assert.equal(page.items[0]!.id, response.subscription_id);
  assert.equal(seen[0]!.url.searchParams.get("status"), "active"); assert.equal(seen[0]!.url.searchParams.get("limit"), "100"); assert.equal(seen[0]!.url.searchParams.get("cursor"), "prior-page");
  assert.equal((await gateway.retrieve(response.subscription_id)).state, "active"); assert.equal((await gateway.cancel(response.subscription_id)).state, "cancelled");
  assert.deepEqual(seen.map(row => row.method), ["GET", "GET", "DELETE"]);
});
test("409 is a known canonicalization refusal, quota refusal is retryable, and a 500 write remains uncertain", async () => {
  for (const [status, code, outcome] of [[409, "canonicalizing", "rejected"], [429, "unavailable", "rejected"], [500, "unavailable", "unknown"], [422, "rejected", "rejected"]] as const) {
    let calls = 0;
    const client = new Channel3({ apiKey: "synthetic-key", maxRetries: 3, fetch: async () => { calls++; return Response.json({ detail: "Synthetic response" }, { status }); } });
    await assert.rejects(new Channel3Subscriptions(client).create(scope), (error: unknown) => error instanceof SubscriptionFailure && error.code === code && error.outcome === outcome && error.status === status);
    assert.equal(calls, 1, `${status} must not trigger an SDK write retry`);
  }
});
test("a malformed success is an unknown outcome rather than proof that no subscription exists", async () => {
  const client = new Channel3({ apiKey: "synthetic-key", fetch: async () => Response.json({ ...response, selection: [{ name: "Color", label: "Black" }, { name: "color", label: "White" }] }) });
  await assert.rejects(new Channel3Subscriptions(client).create(scope), (error: unknown) => error instanceof SubscriptionFailure && error.outcome === "unknown");
});
