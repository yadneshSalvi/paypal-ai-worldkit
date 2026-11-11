import test from "node:test";
import assert from "node:assert/strict";
import { Channel3EventSchema, PayPalEventSchema, commercialSignal, paymentSignal, sandboxParent } from "../packages/webhooks/contracts";
import { rawWebhookBody, verifyChannel3, webhookBodyLimit } from "../packages/webhooks/signatures";
import { canonicalizationDelay, matchesScope, signalMatchesScope, watchScopes } from "../packages/living-kit/subscriptions";
import { assessOfferImpact } from "../packages/living-kit/impact";
import { catalog } from "./support/inventory-fixtures";
import { catalogEvent, fixtureScope, fixtureSecret, providerSubscription, signedHeaders } from "./support/webhook-fixtures";

test("actual Svix verification binds raw bytes, transmission time and a configured rotating key", () => {
  const raw = '{ "a": 1, "text": "café" }'; const headers = signedHeaders(raw, "fixture-same-transmission");
  assert.equal(verifyChannel3(raw, headers, [fixtureSecret]).transmissionId, "fixture-same-transmission");
  assert.throws(() => verifyChannel3(JSON.stringify(JSON.parse(raw)), headers, [fixtureSecret]), /signature/);
  assert.throws(() => verifyChannel3(raw, signedHeaders(raw, "old", fixtureSecret, new Date(Date.now() - 360_000)), [fixtureSecret]), /signature/);
  assert.throws(() => verifyChannel3(raw, signedHeaders(raw, "future", fixtureSecret, new Date(Date.now() + 360_000)), [fixtureSecret]), /signature/);
  const other = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
  assert.equal(verifyChannel3(raw, headers, [other, fixtureSecret]).transmissionId, "fixture-same-transmission");
  assert.throws(() => verifyChannel3(raw, headers, [other]), /signature/);
  assert.throws(() => verifyChannel3(raw, headers, []), /not configured/);
});
test("raw intake preserves Unicode/BOM bytes and rejects oversized or malformed transport", async () => {
  const raw = '\ufeff{ "value": "音🎙️" }';
  assert.equal(await rawWebhookBody(new Request("https://fixture.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: raw })), raw);
  await assert.rejects(rawWebhookBody(new Request("https://fixture.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0xc3, 0x28]) })), /UTF-8/);
  await assert.rejects(rawWebhookBody(new Request("https://fixture.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(webhookBodyLimit + 1) })), /intake limit/);
  await assert.rejects(rawWebhookBody(new Request("https://fixture.invalid", { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: "{}" })), /Encoded/);
});
test("all four documented offer envelopes validate without retaining reusable offer links in the signal", () => {
  const event = catalogEvent(providerSubscription(fixtureScope()));
  const common = { subscription_id: event.data.subscription_id, subject: event.data.subject };
  const price = { price: 99, compare_at_price: null, currency: "USD" };
  for (const type of ["offer.created", "offer.deleted"] as const) {
    const parsed = Channel3EventSchema.parse({ ...event, type, data: { ...common, offer: { domain: common.subject.domain, url: "https://merchant.example/private?ephemeral=true", price, availability: "InStock", condition: "new" } } });
    assert.equal(JSON.stringify(commercialSignal(parsed)).includes("ephemeral"), false);
  }
  assert.equal(Channel3EventSchema.safeParse(event).success, true);
  assert.equal(Channel3EventSchema.safeParse({ ...event, type: "offer.price.changed", data: { ...common, previous: price, current: { ...price, price: 109 } } }).success, true);
  assert.equal(Channel3EventSchema.safeParse({ ...event, data: { ...event.data, current: "unknown" } }).success, false);
});
test("subscription scope never widens variants, merchants, locale or event families", () => {
  const scope = fixtureScope(); const provider = providerSubscription(scope); const signal = commercialSignal(catalogEvent(provider));
  assert.equal(matchesScope(provider, scope), true); assert.equal(signalMatchesScope(signal, provider.id, scope), true);
  for (const changed of [{ ...provider, scope: { ...scope, domains: null } }, { ...provider, scope: { ...scope, productId: "different" } }, { ...provider, scope: { ...scope, selection: [{ name: "Color", label: "White" }] } }]) assert.equal(matchesScope(changed, scope), false);
  assert.equal(signalMatchesScope({ ...signal, domain: "foreign.example" }, provider.id, scope), false);
  assert.equal(signalMatchesScope({ ...signal, locale: { ...signal.locale, country: "GB" } }, provider.id, scope), false);
});
test("watching a complete current variant splits merchant scopes at 25 and rejects stale or missing identities", () => {
  const snapshot = catalog(); snapshot.offers = Array.from({ length: 26 }, (_, index) => ({ ...snapshot.offers[0]!, domain: `merchant${index}.example` }));
  const domains = snapshot.offers.map(offer => offer.domain); const scopes = watchScopes(snapshot, domains);
  assert.deepEqual(scopes.map(scope => scope.domains.length), [25, 1]); assert.ok(scopes.every(scope => scope.selection[0]!.label === "Black"));
  assert.throws(() => watchScopes({ ...snapshot, selectedOptions: [] }, domains), /every variant/);
  assert.throws(() => watchScopes({ ...snapshot, observedAt: new Date(Date.now() - 121_000).toISOString() }, domains), /Refresh/);
  assert.throws(() => watchScopes({ ...snapshot, observedAt: "invalid" }, domains), /Refresh/);
  assert.throws(() => watchScopes(snapshot, ["unlisted.example"]), /current exact/);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(attempt => canonicalizationDelay(attempt, 0).seconds), [2, 4, 8, 16, 30, 30]);
  assert.deepEqual(canonicalizationDelay(20, 600_000), { seconds: 300, background: true });
});
test("a fresh in-stock offer resolves an old shortage and uncertain identity cannot force a repair", () => {
  const snapshot = catalog(); const provider = providerSubscription({ ...fixtureScope(snapshot.productId), selection: snapshot.selectedOptions.map(option => ({ name: option.name, label: option.value })) });
  const signal = commercialSignal(catalogEvent(provider));
  assert.equal(assessOfferImpact(signal, snapshot).state, "resolved");
  assert.equal(assessOfferImpact(signal, { ...snapshot, offers: snapshot.offers.map(offer => ({ ...offer, availability: "OutOfStock" })) }).state, "needs_repair_review");
  assert.equal(assessOfferImpact(signal, { ...snapshot, variantExact: false }).state, "needs_evidence");
  assert.equal(assessOfferImpact(signal, { ...snapshot, offers: [] }).state, "needs_evidence");
});
test("PayPal relationship hints accept exact sandbox paths and reject foreign origins or disagreeing identities", () => {
  const links = [{ rel: "up", method: "GET", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE1" }];
  assert.equal(sandboxParent(links, "capture"), "CAPTURE1");
  for (const href of ["https://api-m.sandbox.paypal.com.evil.example/v2/payments/captures/CAPTURE1", "https://api.paypal.com/v2/payments/captures/CAPTURE1", "https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE1?extra=true", "https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE1%2Fother"]) assert.equal(sandboxParent([{ ...links[0]!, href }], "capture"), null);
  const signal = paymentSignal(PayPalEventSchema.parse({ id: "fixture-event", event_type: "PAYMENT.CAPTURE.REFUNDED", create_time: new Date().toISOString(), resource: { id: "REFUND1", links, supplementary_data: { related_ids: { capture_id: "OTHER1" } } } }));
  assert.equal(signal.resourceKind, "refund"); assert.equal(signal.identityConflict, true);
});
