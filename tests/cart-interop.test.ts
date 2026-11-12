import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { payPalCartSchema } from "@paypal/agentic-commerce-spec";
import { cartCredentialLocator, issueCartCredential, verifyCartCredential } from "../packages/cart-interop/auth";
import { CartInputSchema, CartProblem, type CartCatalogueLine, type CartInput } from "../packages/cart-interop/contracts";
import { cartHash, evaluateCart } from "../packages/cart-interop/evaluate";

const now = Date.parse("2026-11-12T06:00:00.000Z");
const issuance = { merchantId: "sample-merchant-a", tenantId: "sample-tenant-a", audience: "worldkit.test", accountId: "SAMPLE-ACCOUNT-A", scopes: ["cart", "checkout"] as ("cart" | "checkout")[], sessionExpiresAt: new Date(now + 7200_000).toISOString() };
const grant = issueCartCredential(issuance, now);
const line: CartCatalogueLine = { id: "sample-bundle-a", parentId: "sample-system-a", merchantId: "sample-merchant-a", title: "Sample physical system", description: "Controlled test catalogue: no equipment is ordered or shipped.", productKind: "physical", sourceMode: "sample", priceMinor: 42000, stock: 4, stockVersion: 1, projectId: "sample-project-a", editionId: "sample-edition-a", graphHash: "a".repeat(64), currentEditionId: "sample-edition-a", currentGraphHash: "a".repeat(64), packId: "podcast-classroom", editionNumber: 2, componentCount: 13, modelConflicts: 0, actualHumanReviews: 0, physicalTests: 0, active: true, evidenceCurrent: true };
function input(): CartInput { return { items: [{ variant_id: line.id, parent_id: line.parentId, quantity: 1 }], customer: { email_address: "sample.buyer@example.invalid" }, shipping_address: { country_code: "US", address_line_1: "1 Sample Street", admin_area_2: "Sample City", admin_area_1: "CA", postal_code: "90001" } }; }
const evaluate = (body = input(), catalog = [line]) => evaluateCart(body, catalog, line.merchantId, "sample-cart-a");
const refuses = (work: () => unknown, status: number) => assert.throws(work, (error: unknown) => error instanceof CartProblem && error.status === status);

test("a self-signed lower-environment token binds the exact merchant, client, current authority and scopes", () => {
  const locator = cartCredentialLocator(`bearer ${grant.token}`); assert.equal(locator.id, grant.credential.id);
  const principal = verifyCartCredential(locator.token, grant.credential, "checkout", now);
  assert.equal(principal.tenantId, issuance.tenantId); assert.equal(principal.merchantId, issuance.merchantId); assert.equal(principal.sourceMode, "sample");
  assert.equal(Date.parse(grant.credential.expiresAt), now + 3600_000);
  assert.equal("privateKey" in grant, false); assert.equal("privateKey" in grant.credential, false);
});
test("one-time token authority ends on revocation or original session expiry", () => {
  refuses(() => verifyCartCredential(grant.token, { ...grant.credential, revokedAt: new Date(now).toISOString() }, "cart", now), 401);
  refuses(() => verifyCartCredential(grant.token, { ...grant.credential, sessionExpiresAt: new Date(now).toISOString() }, "cart", now), 401);
  refuses(() => verifyCartCredential(grant.token, grant.credential, "cart", now + 3600_000), 401);
  const short = issueCartCredential({ ...issuance, sessionExpiresAt: new Date(now + 71_500).toISOString() }, now);
  assert.equal(Date.parse(short.credential.expiresAt), now + 71_000);
});
test("merchant, audience, external account and integration client identities cannot be swapped", () => {
  for (const changed of [{ merchantId: "sample-merchant-b" }, { audience: "foreign.test" }, { accountId: "SAMPLE-ACCOUNT-B" }, { clientId: "another-client" }]) refuses(() => verifyCartCredential(grant.token, { ...grant.credential, ...changed }, "cart", now), 401);
});
test("cart scope cannot complete checkout or manufacture the missing scope", () => {
  const read = issueCartCredential({ ...issuance, scopes: ["cart"] }, now);
  verifyCartCredential(read.token, read.credential, "cart", now);
  refuses(() => verifyCartCredential(read.token, read.credential, "checkout", now), 403);
  refuses(() => verifyCartCredential(grant.token, { ...grant.credential, scopes: ["cart"] }, "cart", now), 401);
});
test("changed signatures, foreign pinned keys, remote key selectors and unsigned algorithms are refused", () => {
  const other = issueCartCredential(issuance, now);
  refuses(() => verifyCartCredential(grant.token, { ...grant.credential, publicKey: other.credential.publicKey }, "cart", now), 401);
  const pieces = grant.token.split(".");
  for (const header of [{ alg: "none", typ: "JWT", kid: grant.credential.id }, { alg: "HS256", typ: "JWT", kid: grant.credential.id }, { alg: "RS256", typ: "JWT", kid: grant.credential.id, jku: "https://attacker.invalid/keys" }]) {
    const token = [Buffer.from(JSON.stringify(header)).toString("base64url"), pieces[1], pieces[2]].join(".");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    refuses(() => verifyCartCredential(token, { ...grant.credential, tokenHash }, "cart", now), 401);
  }
  refuses(() => verifyCartCredential(grant.token.slice(0, -8) + "AAAAAAAA", grant.credential, "cart", now), 401);
});
test("oversized, malformed and ambiguous authorization fails before any merchant lookup", () => {
  for (const value of [null, "Basic ignored", "Bearer a.b", "Bearer a.b.c.d", `Bearer ${"a".repeat(9000)}`, `Bearer ${grant.token} trailing`]) refuses(() => cartCredentialLocator(value), 401);
});
test("official request validation rejects calculated fields and unbounded quantities", () => {
  assert.equal(CartInputSchema.safeParse({ ...input(), totals: { total: { currency_code: "USD", value: "0.01" } } }).success, false);
  for (const quantity of [0, -1, 1.5, 100]) assert.equal(CartInputSchema.safeParse({ items: [{ variant_id: line.id, quantity }] }).success, false);
});
test("a complete Sample cart validates against the official response schema and merchant-calculated totals", () => {
  const result = evaluate(); payPalCartSchema.parse(result.cart);
  assert.equal(result.cart.status, "READY"); assert.equal(result.cart.validation_status, "VALID"); assert.equal(result.totalMinor, 42700);
  assert.deepEqual(result.cart.totals?.total, { currency_code: "USD", value: "427.00" });
  assert.deepEqual(result.graphHashes, [line.graphHash]); assert.equal(result.cart.items?.[0]?.name, line.title);
  assert.equal(result.cart.payment_method?.token, undefined, "Evaluation cannot manufacture a payment identity");
});
test("missing customer and address stay incomplete without inheriting prior replacement fields", () => {
  const complete = evaluate(); assert.equal(complete.issues.length, 0);
  const next = evaluate({ items: input().items });
  assert.equal(next.cart.customer, undefined); assert.equal(next.cart.shipping_address, undefined);
  assert.equal(next.cart.validation_status, "REQUIRES_ADDITIONAL_INFORMATION"); assert.equal(next.cart.status, "INCOMPLETE");
});
test("current source and passport drift refuses a previously modeled system without changing its saved identity", () => {
  const result = evaluate(input(), [{ ...line, evidenceCurrent: false }]); payPalCartSchema.parse(result.cart);
  assert.equal(result.cart.validation_status, "INVALID"); assert.ok(result.issues.some(value => /passport changed/.test(value.message)));
  assert.equal(result.graphHashes[0], line.graphHash); assert.equal(result.cart.payment_method?.token, undefined);
});
test("foreign and unknown catalogue identities cannot become a merchant's goods", () => {
  for (const catalog of [[], [{ ...line, merchantId: "foreign-merchant" }]]) {
    const result = evaluate(input(), catalog); assert.equal(result.totalMinor, null); assert.equal(result.issues[0]?.code, "INVENTORY_ISSUE"); payPalCartSchema.parse(result.cart);
  }
  const result = evaluate({ ...input(), items: [{ variant_id: line.id, parent_id: "wrong-parent", quantity: 1 }] });
  assert.ok(result.issues.some(issue => issue.code === "DATA_ERROR"));
});
test("digital service and non-US destination never qualify as Store Sync physical commerce", () => {
  assert.ok(evaluate(input(), [{ ...line, productKind: "digital" }]).issues.some(issue => issue.code === "BUSINESS_RULE_ERROR"));
  const body = input(); body.shipping_address!.country_code = "GB";
  assert.ok(evaluate(body).issues.some(issue => issue.code === "SHIPPING_ERROR"));
});
test("current price is authoritative while equivalent decimal representations remain valid", () => {
  const body = input(); body.items![0]!.price = { currency_code: "USD", value: "420" };
  assert.equal(evaluate(body).issues.length, 0);
  for (const price of [{ currency_code: "USD", value: "0.01" }, { currency_code: "EUR", value: "420.00" }]) {
    body.items![0]!.price = price;
    const result = evaluate(body); assert.equal(result.totalMinor, 42700); assert.ok(result.issues.some(issue => issue.code === "PRICING_ERROR"));
  }
  body.items![0]!.price = { currency_code: "USD", value: "4.2e2" };
  assert.equal(CartInputSchema.safeParse(body).success, false, "Malformed money is refused by the official schema before merchant evaluation");
});
test("stock, current graph and modeled conflicts can each prevent checkout", () => {
  for (const change of [{ stock: 0 }, { currentEditionId: "new-edition" }, { currentGraphHash: "b".repeat(64) }, { modelConflicts: 1 }, { active: false }]) {
    const result = evaluate(input(), [{ ...line, ...change }]); assert.equal(result.cart.status, "INCOMPLETE"); assert.ok(result.issues.length > 0);
  }
});
test("caller-supplied names, descriptions and shipping prices do not replace merchant records", () => {
  const body = input(); body.items![0]!.name = "Actual PayPal purchase"; body.items![0]!.description = "Ships today";
  body.available_shipping_options = [{ id: "sample-standard", name: "Free", price: { currency_code: "USD", value: "0.00" }, is_selected: true }];
  const result = evaluate(body); assert.equal(result.cart.items![0]!.name, line.title); assert.equal(result.cart.items![0]!.description, line.description);
  assert.equal(result.cart.available_shipping_options![0]!.price.value, "7.00"); assert.ok(result.issues.some(issue => issue.code === "PRICING_ERROR"));
});
test("duplicate lines and unsupported options are explicit recoverable issues", () => {
  const body = input(); body.items!.push({ ...body.items![0]! }); body.coupons = [{ code: "FAKE", action: "APPLY" }];
  const result = evaluate(body); assert.ok(result.issues.some(issue => issue.field === "items[1].variant_id")); assert.ok(result.issues.some(issue => issue.field === "coupons"));
});
test("evaluation digest binds quantity, graph and current stock version with stable object-key ordering", () => {
  const before = evaluate(); const body = input(); body.items![0]!.quantity = 2;
  assert.notEqual(evaluate(body).digest, before.digest);
  assert.notEqual(evaluate(input(), [{ ...line, stockVersion: 2 }]).digest, before.digest);
  assert.equal(cartHash({ a: 1, b: { d: 4, c: 3 } }), cartHash({ b: { c: 3, d: 4 }, a: 1 }));
});
