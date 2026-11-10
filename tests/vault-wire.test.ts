import assert from "node:assert/strict";
import test from "node:test";
import { PaypalClient } from "paypal";
import { assertOwnedToken, VaultAdapter, VaultFault } from "../packages/commerce/vault";
type Seen = { method: string; path: string; headers: Headers; body: Record<string, unknown> | null };
function harness(reply: (request: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const client = new PaypalClient({ serverOptions: { baseUrl: "https://api-m.sandbox.paypal.com" }, oauth2: { clientId: "fixture-client", clientSecret: "fixture-secret" }, retry: { maxRetries: 0, timeout: 1000 }, logging: { level: "off" }, fetch: async request => {
    const value = request as Request; const path = new URL(value.url).pathname;
    if (path === "/v1/oauth2/token") return Response.json({ access_token: "fixture-oauth-token", token_type: "Bearer", expires_in: 3600 });
    const body = await value.clone().text(); const captured = { method: value.method, path, headers: value.headers, body: body ? JSON.parse(body) : null }; seen.push(captured); return reply(captured);
  } }); return { adapter: new VaultAdapter(client), seen };
}
const setup = { id: "SETUP-TEST-1", status: "PAYER_ACTION_REQUIRED", customer: { id: "CUSTOMER-TEST-1", merchant_customer_id: "tenant-fixture" }, links: [{ rel: "approve", method: "GET", href: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=SETUP-TEST-1" }] };
const token = { id: "TOKEN-TEST-1", customer: { id: "CUSTOMER-TEST-1", merchant_customer_id: "tenant-fixture" }, payment_source: { paypal: { payer_id: "PAYER-TEST-1", description: "test-consent" } } };
test("actual SDK encodes consent-bound setup with exact request ID and snake_case fields", async () => {
  const { adapter, seen } = harness(() => Response.json(setup, { status: 201, headers: { "paypal-debug-id": "fixture-debug" } }));
  const body = adapter.setupBody({ merchantCustomerId: "tenant-fixture", description: "test-consent", returnUrl: "http://localhost:4106/paypal/return", cancelUrl: "http://localhost:4106/paypal/cancel" });
  const result = await adapter.createSetup(body, "stable-setup-request");
  assert.equal(seen.length, 1); assert.equal(seen[0]!.path, "/v3/vault/setup-tokens"); assert.equal(seen[0]!.headers.get("paypal-request-id"), "stable-setup-request");
  assert.deepEqual(seen[0]!.body, { customer: { merchant_customer_id: "tenant-fixture" }, payment_source: { paypal: { description: "test-consent", usage_pattern: "IMMEDIATE", usage_type: "MERCHANT", customer_type: "CONSUMER", permit_multiple_payment_tokens: false, experience_context: { brand_name: "WorldKit Studio", locale: "en-US", return_url: "http://localhost:4106/paypal/return", cancel_url: "http://localhost:4106/paypal/cancel", shipping_preference: "NO_SHIPPING", user_action: "CONTINUE" } } } });
  assert.equal(result.value.id, setup.id); assert.equal(result.debugId, "fixture-debug"); assert.match(result.bodyHash, /^[a-f0-9]{64}$/);
});
test("actual SDK exchanges a setup token and independently reads token identity", async () => {
  const { adapter, seen } = harness(() => Response.json(token, { status: 200 }));
  await adapter.exchange("SETUP-TEST-1", "stable-exchange-request"); const result = await adapter.readToken("TOKEN-TEST-1");
  assert.deepEqual(seen[0]!.body, { payment_source: { token: { id: "SETUP-TEST-1", type: "SETUP_TOKEN" } } }); assert.equal(seen[0]!.headers.get("paypal-request-id"), "stable-exchange-request"); assert.equal(seen[1]!.method, "GET"); assert.equal(seen[1]!.path, "/v3/vault/payment-tokens/TOKEN-TEST-1");
  assertOwnedToken(result.value, { id: "TOKEN-TEST-1", customerId: "CUSTOMER-TEST-1", merchantCustomerId: "tenant-fixture", payerId: "PAYER-TEST-1" });
  assert.throws(() => assertOwnedToken(result.value, { id: "TOKEN-TEST-1", customerId: "OTHER-CUSTOMER", merchantCustomerId: "tenant-fixture", payerId: "PAYER-TEST-1" }), /did not match/);
});
test("no-content deletion is accepted only at the declared 204 response", async () => {
  const { adapter, seen } = harness(() => new Response(null, { status: 204 })); const result = await adapter.deleteToken("TOKEN-TEST-1");
  assert.equal(result.value.deleted, true); assert.equal(seen[0]!.method, "DELETE"); assert.equal(seen[0]!.body, null); assert.equal(seen[0]!.headers.get("content-type"), null);
});
test("thin success is unknown and does not fabricate an active saved wallet", async () => {
  const { adapter } = harness(() => Response.json({ id: "TOKEN-TEST-1" }, { status: 200 })); await assert.rejects(adapter.readToken("TOKEN-TEST-1"), error => error instanceof VaultFault && error.outcome === "unknown");
});
test("HTTP403 cannot be mistaken for a deleted token; HTTP404 is distinct", async () => {
  for (const status of [403, 404]) { const { adapter } = harness(() => Response.json({ name: "RESOURCE_NOT_FOUND", message: "unsafe provider details fixture-secret", debug_id: "fixture" }, { status })); await assert.rejects(adapter.readToken("TOKEN-TEST-1"), error => error instanceof VaultFault && error.status === (status === 403 ? 502 : 404) && !error.message.includes("fixture-secret")); }
});
test("a dropped SDK write is never automatically retried", async () => {
  const { adapter, seen } = harness(() => { throw new TypeError("fixture network interruption"); });
  await assert.rejects(adapter.exchange("SETUP-TEST-1", "stable-exchange-request"), error => error instanceof VaultFault && error.outcome === "unknown"); assert.equal(seen.length, 1);
});
test("only a matching completed owned order can reveal first-purchase wallet data", async () => {
  const response = { id: "ORDER-TEST-1", status: "COMPLETED", purchase_units: [{ custom_id: "worldkit-order", amount: { currency_code: "USD", value: "12.00" } }], payment_source: { paypal: { account_id: "PAYER-TEST-1", attributes: { vault: { id: "TOKEN-TEST-1", status: "VAULTED", customer: { id: "CUSTOMER-TEST-1" } } } } } };
  const { adapter } = harness(() => Response.json(response));
  assert.equal((await adapter.readOrderWallet({ id: "ORDER-TEST-1", customId: "worldkit-order", totalMinor: 1200, currency: "USD" })).value?.id, "TOKEN-TEST-1");
  await assert.rejects(adapter.readOrderWallet({ id: "ORDER-TEST-1", customId: "another-domain-order", totalMinor: 1200, currency: "USD" }), /does not match/);
});
