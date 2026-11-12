import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createCart, getCart, updateCart, completeCheckout, businessErrorSchema, errorSchema, payPalCartSchema, type PayPalCart, type PayPalCartWritable } from "@paypal/agentic-commerce-spec";
import { CartProblem, type CartCatalogueLine, type CartHome, type CartScope } from "../packages/cart-interop/contracts";
import { packSources } from "../packages/domain-packs/catalog";
import { cartHome, cartWorkbenchCommand } from "../src/server/cart-interop-workbench";
import { approveSampleCart, completeMerchantCheckout, createMerchantCart, getMerchantCart } from "../src/server/cart-interop";
import { authenticateCartRequest, type CartActor } from "../src/server/cart-interop-store";
import { initializeCartInterop } from "../src/server/cart-interop-db";
import { handleCartProtocol, readCartJson } from "../src/server/cart-interop-http";
import { createSession, getRevision, type Session } from "../src/server/repository";
import { domainCommand, domainHome } from "../src/server/domain-packs";
import { closeDatabase, database } from "../src/server/db";
import { requireIsolatedDatabase } from "./support/isolated-database";

requireIsolatedDatabase();
assert.equal(process.env.WORLDKIT_QA_MODE, "cart-interop");
let server: Server; let baseURL: string;
const transport: { operation: string; status: number; milliseconds: number }[] = [];
before(async () => {
  await initializeCartInterop();
  server = createServer(async (incoming, outgoing) => {
    const started = performance.now();
    try {
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
      const path = incoming.url ?? ""; const match = /^\/api\/paypal\/v1\/merchant-cart(?:\/([^/?]+))?(\/checkout)?$/.exec(path);
      if (!match) { outgoing.writeHead(404); outgoing.end(); return; }
      const operation = match[2] ? "checkout" : match[1] ? incoming.method === "PUT" ? "replace" : "get" : "create";
      const response = await handleCartProtocol(new Request(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: incoming.method, headers, ...(body.length ? { body: new Uint8Array(body) } : {}) }), operation, match[1]);
      transport.push({ operation, status: response.status, milliseconds: Math.round((performance.now() - started) * 100) / 100 });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end('{"name":"TEST_TRANSPORT_FAILURE","message":"Local transport failed."}'); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/paypal/v1`;
});
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await mkdir(".local/cart-interop-unit", { recursive: true });
  await writeFile(".local/cart-interop-unit/transport-measurements.private.json", JSON.stringify({ source: "official generated Axios client and fetch over real loopback HTTP", providerCalls: 0, financialCalls: 0, observations: transport }, null, 2) + "\n", { mode: 0o600 });
  await closeDatabase();
});
type Fixture = { session: Session; actor: CartActor; line: CartCatalogueLine; token: string; credentialId: string; projectId: string };
const refuses = (status: number, code?: string) => (error: unknown) => error instanceof CartProblem && error.status === status && (!code || error.code === code);
const key = () => randomUUID();
function headers(f: Fixture, requestId = key()) { return { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json", "Idempotency-Key": requestId }; }
/** Never let an Axios error print its private Authorization config into a test log. */
async function official<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const failure = error as { response?: { status?: number; data?: { name?: string; message?: string } } };
    throw new CartProblem(failure.response?.status ?? 500, failure.response?.data?.name ?? "CLIENT_FAILURE", failure.response?.data?.message ?? "The controlled client operation failed.");
  }
}
async function fixture(options: { conflict?: boolean; stock?: number; scopes?: CartScope[] } = {}): Promise<Fixture> {
  const { session } = await createSession();
  const created = await domainCommand(session, { kind: "create", requestId: key(), packId: "podcast-classroom", title: "Sample cart protocol system" });
  let selected = (await domainHome(session, created.projectId)).selected!;
  if (!options.conflict) {
    const state = structuredClone(selected.edition.graph.state); assert.equal(state.config.packId, "podcast-classroom");
    if (state.config.packId === "podcast-classroom") Object.assign(state.config, { recorder: "podtrak-p8", storageConfirmed: true, powerConfirmed: true, keepTrackFiles: true, destination: "sd_card" });
    const current = { projectId: selected.project.id, expectedEditionId: selected.edition.id, expectedVersion: selected.project.version, expectedGraphHash: selected.currentGraphHash };
    const prepared = await domainCommand(session, { kind: "preview", requestId: key(), ...current, state, reason: "Controlled cart proof fixture" }); assert.ok(prepared.preview);
    await domainCommand(session, { kind: "apply", requestId: key(), ...current, previewId: prepared.preview.id, previewHash: prepared.preview.hash });
    selected = (await domainHome(session, created.projectId)).selected!; assert.equal(selected.edition.certificate.counts.violated, 0);
  }
  await cartWorkbenchCommand(session, { kind: "start_sample", requestId: key(), acknowledgedSample: true });
  await cartWorkbenchCommand(session, { kind: "catalogue_add", requestId: key(), projectId: created.projectId, expectedEditionId: selected.edition.id, expectedGraphHash: selected.currentGraphHash, priceMinor: 42000, stock: options.stock ?? 4, acknowledgedSample: true });
  const issued = await cartWorkbenchCommand(session, { kind: "credential_issue", requestId: key(), scopes: options.scopes ?? ["cart", "checkout"], acknowledgedSample: true }); assert.ok(issued.token && issued.credential);
  const home = await cartHome(session); const line = home.catalogue[0]!;
  return { session, actor: { kind: "workspace", session }, line, token: issued.token, credentialId: issued.credential.id, projectId: created.projectId };
}
function document(f: Fixture, quantity = 1): PayPalCartWritable {
  return { items: [{ variant_id: f.line.id, parent_id: f.line.parentId, quantity }], customer: { email_address: `sample-${f.session.id}@example.invalid` }, shipping_address: { country_code: "US", address_line_1: "1 Sample Street", admin_area_2: "Sample City", admin_area_1: "CA", postal_code: "90001" } };
}
async function create(f: Fixture, body = document(f), requestId = key()) {
  const response = await official(() => createCart({ baseURL, headers: headers(f, requestId), body, throwOnError: true }));
  assert.equal(response.status, 201); payPalCartSchema.parse(response.data); return response.data;
}
async function read(f: Fixture, cartId: string) { return (await official(() => getCart({ baseURL, headers: headers(f), path: { cartId }, throwOnError: true }))).data; }
async function replace(f: Fixture, cartId: string, body: PayPalCartWritable, requestId = key()) { return (await official(() => updateCart({ baseURL, headers: headers(f, requestId), path: { cartId }, body, throwOnError: true }))).data; }
async function selected(f: Fixture, cartId: string) { const home = await cartHome(f.session, cartId); assert.ok(home.selected); return home.selected; }
async function approve(f: Fixture, cartId: string) {
  const value = await selected(f, cartId); const token = value.record.current.response.payment_method?.token; assert.ok(token);
  return approveSampleCart(f.actor, { cartId, expectedVersion: value.record.version, evaluationHash: value.record.current.evaluationHash, token, acknowledgedSample: true }, key());
}
async function complete(f: Fixture, cartId: string, approval: Awaited<ReturnType<typeof approve>>, requestId = key()) {
  return (await official(() => completeCheckout({ baseURL, headers: headers(f, requestId), path: { cartId }, body: { payment_method: { type: "paypal", token: approval.token, payer_id: approval.payerId } }, throwOnError: true }))).data;
}
async function changeCatalogue(f: Fixture, priceMinor: number, stock: number) {
  const line = (await cartHome(f.session)).catalogue.find(value => value.id === f.line.id)!;
  await cartWorkbenchCommand(f.session, { kind: "catalogue_change", requestId: key(), catalogueId: line.id, expectedStockVersion: line.stockVersion, priceMinor, stock, acknowledgedSample: true });
}

test("reading a fresh workspace creates no merchant/cart and preserves its creator graph and fixed expiry", async () => {
  const { session } = await createSession(); const original = await getRevision(session.id); const home = await cartHome(session);
  assert.equal(home.merchant, null); assert.deepEqual(home.catalogue, []); assert.deepEqual(home.carts, []);
  assert.deepEqual(await getRevision(session.id), original);
  assert.equal((await database().query("SELECT expires_at FROM wk_sessions WHERE id=$1", [session.id])).rows[0].expires_at.toISOString(), session.expiresAt);
});
test("official create/get over HTTP produces exact merchant totals, Sample identity and no-store boundaries", async () => {
  const f = await fixture(); const original = await getRevision(f.session.id); const input = document(f);
  const response = await official(() => createCart({ baseURL, headers: headers(f), body: input, throwOnError: true }));
  assert.equal(response.status, 201); assert.equal(response.headers["x-worldkit-execution"], "sample"); assert.match(String(response.headers["cache-control"]), /no-store/);
  const cart = payPalCartSchema.parse(response.data); assert.equal(cart.status, "CREATED"); assert.equal(cart.validation_status, "VALID");
  assert.equal(cart.totals?.total?.value, "427.00"); assert.match(cart.payment_method?.token ?? "", /^WK-SAMPLE-TOKEN-/);
  assert.deepEqual(await read(f, cart.id!), cart); assert.deepEqual(await getRevision(f.session.id), original);
  assert.equal(f.line.actualHumanReviews, 0); assert.equal(f.line.physicalTests, 0);
});
test("a fresh foreign workspace cannot open a requested cart or revision before starting its own merchant", async () => {
  const f = await fixture(); const cart = await create(f); const owner = await selected(f, cart.id!); const { session } = await createSession();
  await assert.rejects(() => cartHome(session, cart.id!), refuses(404, "RESOURCE_NOT_FOUND"));
  await assert.rejects(() => cartHome(session, undefined, owner.record.current.id), refuses(404, "RESOURCE_NOT_FOUND"));
  assert.equal((await cartHome(session)).merchant, null);
  assert.equal((await database().query("SELECT count(*)::integer AS n FROM wk_cart_merchants WHERE tenant_id=$1", [session.id])).rows[0].n, 0);
});
test("HTTP authentication, scope, foreign browser origin and strict calculated-field validation refuse cleanly", async () => {
  const f = await fixture({ scopes: ["cart"] }); const cart = await create(f);
  const anonymous = await fetch(`${baseURL}/merchant-cart/${cart.id}`); assert.equal(anonymous.status, 401); errorSchema.parse(await anonymous.json());
  const foreign = await fetch(`${baseURL}/merchant-cart/${cart.id}`, { headers: { Authorization: `Bearer ${f.token}`, Origin: "https://foreign.invalid" } }); assert.equal(foreign.status, 403);
  const invalid = await fetch(`${baseURL}/merchant-cart`, { method: "POST", headers: headers(f), body: JSON.stringify({ ...document(f), totals: { total: { currency_code: "USD", value: "0.01" } } }) }); assert.equal(invalid.status, 400); errorSchema.parse(await invalid.json());
  await assert.rejects(() => official(() => completeCheckout({ baseURL, headers: headers(f), path: { cartId: cart.id! }, body: { payment_method: { type: "paypal", token: "foreign-token", payer_id: "fake-payer" } }, throwOnError: true })), refuses(403, "INSUFFICIENT_SCOPE"));
  const actor = await authenticateCartRequest(new Request(baseURL, { headers: { Authorization: `Bearer ${f.token}` } }), "cart");
  await assert.rejects(() => approveSampleCart(actor, {}, key()), refuses(403, "BUYER_APPROVAL_REQUIRED"));
});
test("full PUT replacement removes omitted customer/address and retains its prior immutable version", async () => {
  const f = await fixture(); const cart = await create(f); const prior = await selected(f, cart.id!);
  const updated = await replace(f, cart.id!, { items: document(f).items });
  assert.equal(updated.status, "INCOMPLETE"); assert.equal(updated.customer, undefined); assert.equal(updated.shipping_address, undefined);
  assert.equal(updated.payment_method?.token, undefined); assert.equal(updated.validation_status, "REQUIRES_ADDITIONAL_INFORMATION");
  const current = await selected(f, cart.id!); assert.equal(current.record.version, 2); assert.equal(current.history.length, 2);
  const historical = await cartHome(f.session, cart.id!, prior.record.current.id); assert.equal(historical.selected?.historical, true); assert.deepEqual(historical.selected?.displayedRevision, prior.record.current);
});
test("same request identities recover durable receipts while changed payloads cannot reuse them", async () => {
  const f = await fixture(); const requestId = key(); const first = await create(f, document(f), requestId);
  assert.deepEqual(await create(f, document(f), requestId), first);
  await assert.rejects(() => create(f, document(f, 2), requestId), refuses(409, "IDEMPOTENCY_CONFLICT"));
  const updateId = key(); const update = await replace(f, first.id!, { items: document(f).items }, updateId);
  assert.deepEqual(await replace(f, first.id!, { items: document(f).items }, updateId), update);
  assert.equal((await selected(f, first.id!)).history.length, 2); assert.equal((await cartHome(f.session)).carts.length, 1);
});
test("tenant, merchant, catalogue, cart, approval and historical revision identities stay isolated", async () => {
  const a = await fixture(); const b = await fixture(); const ca = await create(a); const cb = await create(b);
  await assert.rejects(() => read(b, ca.id!), refuses(404)); await assert.rejects(() => replace(b, ca.id!, document(b)), refuses(404));
  const foreign = await create(b, { ...document(b), items: document(a).items }); assert.equal(foreign.validation_status, "INVALID"); assert.equal(foreign.payment_method?.token, undefined);
  const aa = await approve(a, ca.id!);
  await assert.rejects(() => complete(b, cb.id!, aa), refuses(422, "BUYER_APPROVAL_REQUIRED"));
  const ar = await selected(a, ca.id!); await assert.rejects(() => cartHome(b.session, cb.id!, ar.record.current.id), refuses(409, "REVISION_UNAVAILABLE"));
  const foreignSystem = (await cartHome(a.session)).systems[0]!;
  await assert.rejects(() => cartWorkbenchCommand(b.session, { kind: "catalogue_add", requestId: key(), projectId: foreignSystem.id, expectedEditionId: foreignSystem.editionId, expectedGraphHash: foreignSystem.graphHash, priceMinor: 100, stock: 1, acknowledgedSample: true }), refuses(404));
});
test("unresolved modeled system conflicts cannot receive a payment identity or buyer approval", async () => {
  const f = await fixture({ conflict: true }); const cart = await create(f);
  assert.equal(cart.validation_status, "INVALID"); assert.equal(cart.payment_method?.token, undefined); assert.ok(cart.validation_issues?.some(issue => /conflict/.test(issue.message)));
  const view = await selected(f, cart.id!);
  await assert.rejects(() => approveSampleCart(f.actor, { cartId: cart.id, expectedVersion: view.record.version, evaluationHash: view.record.current.evaluationHash, token: "invented-token", acknowledgedSample: true }, key()), refuses(422, "CART_REVIEW_REQUIRED"));
});
test("buyer approval binds exact version, quote and token and cannot be inferred from the integration credential", async () => {
  const f = await fixture(); const cart = await create(f); const view = await selected(f, cart.id!);
  const approval = { cartId: cart.id, expectedVersion: view.record.version, evaluationHash: view.record.current.evaluationHash, token: cart.payment_method!.token!, acknowledgedSample: true };
  await assert.rejects(() => approveSampleCart(f.actor, { ...approval, expectedVersion: 99 }, key()), refuses(409));
  await assert.rejects(() => approveSampleCart(f.actor, { ...approval, evaluationHash: "a".repeat(64) }, key()), refuses(422));
  await assert.rejects(() => approveSampleCart(f.actor, { ...approval, token: "foreign-payment-token" }, key()), refuses(422));
  await assert.rejects(() => approveSampleCart(f.actor, { ...approval, acknowledgedSample: false }, key()));
  const noApproval = await fetch(`${baseURL}/merchant-cart/${cart.id}/checkout`, { method: "POST", headers: headers(f), body: JSON.stringify({ payment_method: { type: "paypal", token: cart.payment_method!.token, payer_id: "invented-payer" } }) });
  assert.equal(noApproval.status, 422); businessErrorSchema.parse(await noApproval.json());
  assert.equal((await selected(f, cart.id!)).approval, null);
});
test("one exact approval produces one retained Sample settlement and no real provider/financial rows", async () => {
  const f = await fixture(); const cart = await create(f); const approval = await approve(f, cart.id!); const requestId = key();
  const approvedRead = await read(f, cart.id!); assert.equal(approvedRead.payment_method?.payer_id, approval.payerId);
  assert.equal((await selected(f, cart.id!)).reviewRequired, false, "Approved read-through is current authority, not a changed quote");
  const completed = await complete(f, cart.id!, approval, requestId);
  assert.equal(completed.status, "COMPLETED"); assert.match(completed.payment_confirmation?.merchant_order_number ?? "", /^WK-SAMPLE-SETTLEMENT-/);
  assert.deepEqual(await complete(f, cart.id!, approval, requestId), completed); assert.deepEqual(await complete(f, cart.id!, approval), completed);
  const home = await cartHome(f.session, cart.id!); assert.equal(home.selected?.record.version, 2); assert.equal(home.catalogue[0]?.stock, 3);
  assert.equal((await database().query("SELECT count(*)::integer AS n FROM wk_cart_settlements WHERE tenant_id=$1", [f.session.id])).rows[0].n, 1);
  for (const table of ["wk_provider_receipts", "wk_source_model_requests", "wk_quotes"]) assert.equal((await database().query(`SELECT count(*)::integer AS n FROM ${table} WHERE tenant_id=$1`, [f.session.id])).rows[0].n, 0);
  assert.equal((await database().query("SELECT count(*)::integer AS n FROM wk_source_model_observations o JOIN wk_source_model_requests r ON r.operation_id=o.operation_id WHERE r.tenant_id=$1", [f.session.id])).rows[0].n, 0);
  await assert.rejects(() => replace(f, cart.id!, document(f, 2)), refuses(422, "CART_COMPLETED"));
});
test("simultaneous completion requests with equal and distinct identities cannot duplicate settlement or stock use", async () => {
  const f = await fixture(); const cart = await create(f); const approval = await approve(f, cart.id!); const same = key();
  const responses = await Promise.all([complete(f, cart.id!, approval, same), complete(f, cart.id!, approval, same), complete(f, cart.id!, approval), complete(f, cart.id!, approval)]);
  for (const response of responses) assert.deepEqual(response, responses[0]);
  const home = await cartHome(f.session, cart.id!); assert.equal(home.selected?.history.length, 2); assert.equal(home.catalogue[0]?.stock, 3);
  assert.equal(home.events.filter(event => event.kind === "cart.sample_completed").length, 1);
});
test("competing approved carts cannot oversell the same Sample stock", async () => {
  const f = await fixture({ stock: 4 }); const one = await create(f, document(f, 3)); const two = await create(f, document(f, 3));
  const approvalOne = await approve(f, one.id!); const approvalTwo = await approve(f, two.id!);
  const outcomes = await Promise.allSettled([complete(f, one.id!, approvalOne), complete(f, two.id!, approvalTwo)]);
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  const refusal = outcomes.find(value => value.status === "rejected"); assert.ok(refusal?.status === "rejected" && refuses(422, "CART_REVIEW_REQUIRED")(refusal.reason));
  assert.equal((await cartHome(f.session)).catalogue[0]?.stock, 1);
});
test("a changed merchant price preserves the quote, removes current approval and requires an explicit reviewed replacement", async () => {
  const f = await fixture(); const cart = await create(f); const old = await selected(f, cart.id!); const approval = await approve(f, cart.id!);
  await changeCatalogue(f, 43000, 4);
  const changed = await read(f, cart.id!); assert.equal(changed.status, "INCOMPLETE"); assert.equal(changed.payment_method?.token, undefined); assert.equal(changed.totals?.total?.value, "437.00");
  const refusedId = key(); await assert.rejects(() => complete(f, cart.id!, approval, refusedId), refuses(422, "CART_REVIEW_REQUIRED"));
  const unchanged = await selected(f, cart.id!); assert.deepEqual(unchanged.record.current, old.record.current); assert.equal(unchanged.reviewRequired, true); assert.equal(unchanged.approval?.current, false);
  const refreshed = await replace(f, cart.id!, document(f)); assert.notEqual(refreshed.payment_method?.token, approval.token);
  const freshApproval = await approve(f, cart.id!); assert.equal(freshApproval.totalMinor, 43700);
  await assert.rejects(() => complete(f, cart.id!, approval, refusedId), refuses(422, "CART_REVIEW_REQUIRED"));
  await assert.rejects(() => complete(f, cart.id!, freshApproval, refusedId), refuses(409, "IDEMPOTENCY_CONFLICT"));
  assert.equal((await complete(f, cart.id!, freshApproval)).status, "COMPLETED");
});
test("zero stock and a changed quantity invalidate prior approval without changing a completed historical receipt", async () => {
  const f = await fixture(); const cart = await create(f); const approval = await approve(f, cart.id!);
  await changeCatalogue(f, 42000, 0); assert.equal((await read(f, cart.id!)).validation_status, "INVALID"); await assert.rejects(() => complete(f, cart.id!, approval), refuses(422));
  await changeCatalogue(f, 42000, 5); const changed = await replace(f, cart.id!, document(f, 2)); assert.notEqual(changed.payment_method?.token, approval.token);
  await assert.rejects(() => complete(f, cart.id!, approval), refuses(422, "BUYER_APPROVAL_REQUIRED"));
  const next = await approve(f, cart.id!); const completed = await complete(f, cart.id!, next);
  await changeCatalogue(f, 50000, 0); assert.deepEqual(await read(f, cart.id!), completed);
});
test("a newer system edition requires its exact new catalogue identity before the cart can be approved again", async () => {
  const f = await fixture(); const cart = await create(f); const approval = await approve(f, cart.id!);
  const saved = (await domainHome(f.session, f.projectId)).selected!; const state = structuredClone(saved.edition.graph.state); state.budgetMinor += 1000;
  const current = { projectId: saved.project.id, expectedEditionId: saved.edition.id, expectedVersion: saved.project.version, expectedGraphHash: saved.currentGraphHash };
  const preview = await domainCommand(f.session, { kind: "preview", requestId: key(), ...current, state, reason: "Controlled changed system requirement" }); assert.ok(preview.preview);
  await domainCommand(f.session, { kind: "apply", requestId: key(), ...current, previewId: preview.preview.id, previewHash: preview.preview.hash });
  assert.equal((await read(f, cart.id!)).status, "INCOMPLETE"); await assert.rejects(() => complete(f, cart.id!, approval), refuses(422));
  const next = (await cartHome(f.session)).systems[0]!;
  await cartWorkbenchCommand(f.session, { kind: "catalogue_add", requestId: key(), projectId: next.id, expectedEditionId: next.editionId, expectedGraphHash: next.graphHash, priceMinor: 42000, stock: 4, acknowledgedSample: true });
  const line = (await cartHome(f.session)).catalogue.find(value => value.editionId === next.editionId)!;
  const body = document(f); body.items = [{ variant_id: line.id, parent_id: line.parentId, quantity: 1 }];
  assert.equal((await replace(f, cart.id!, body)).validation_status, "VALID"); assert.equal((await approve(f, cart.id!)).version, 2);
});
test("archived systems and changed source fingerprints fail current checkout without rewriting prior proof", async () => {
  const f = await fixture(); const cart = await create(f); const approval = await approve(f, cart.id!); const prior = await selected(f, cart.id!);
  const source = packSources.find(value => prior.record.current.response.items?.length && value.id.includes("p8")) ?? packSources[0]!;
  const originalHash = source.contentHash;
  try {
    source.contentHash = "f".repeat(64);
    const changed = await read(f, cart.id!); assert.equal(changed.validation_status, "INVALID"); await assert.rejects(() => complete(f, cart.id!, approval), refuses(422));
    assert.deepEqual((await selected(f, cart.id!)).record.current, prior.record.current);
  } finally { source.contentHash = originalHash; }
  const saved = (await domainHome(f.session, f.projectId)).selected!;
  await domainCommand(f.session, { kind: "archive", requestId: key(), projectId: saved.project.id, expectedEditionId: saved.edition.id, expectedVersion: saved.project.version, expectedGraphHash: saved.currentGraphHash });
  assert.equal((await read(f, cart.id!)).validation_status, "INVALID"); await assert.rejects(() => complete(f, cart.id!, approval), refuses(422));
});
test("checkout cannot silently change shipping/customer data or adopt an unrelated payment identity", async () => {
  const f = await fixture(); const cart = await create(f); const approval = await approve(f, cart.id!);
  const payment_method = { type: "paypal" as const, token: approval.token, payer_id: approval.payerId };
  await assert.rejects(() => completeMerchantCheckout(f.actor, cart.id!, { payment_method, customer: { email_address: "different@example.invalid" } }, key()), refuses(422, "CHECKOUT_DETAILS_CHANGED"));
  await assert.rejects(() => completeMerchantCheckout(f.actor, cart.id!, { payment_method, coupons: [{ code: "unknown", is_applied: true }] }, key()));
  await assert.rejects(() => create(f, { ...document(f), payment_method: { type: "paypal", token: "outside-cart-token" } }), refuses(422, "PAYMENT_IDENTITY_MISMATCH"));
  assert.equal((await selected(f, cart.id!)).record.state, "open");
});
test("revocation stops HTTP and already-authenticated actors, including receipt replay", async () => {
  const f = await fixture(); const requestId = key(); const body = document(f); const cart = await create(f, body, requestId);
  const actor = await authenticateCartRequest(new Request(baseURL, { headers: { Authorization: `Bearer ${f.token}` } }), "cart");
  await cartWorkbenchCommand(f.session, { kind: "credential_revoke", requestId: key(), credentialId: f.credentialId });
  await assert.rejects(() => read(f, cart.id!), refuses(401)); await assert.rejects(() => create(f, body, requestId), refuses(401));
  await assert.rejects(() => getMerchantCart(actor, cart.id!), refuses(401));
  assert.equal((await cartHome(f.session)).credentials.find(value => value.id === f.credentialId)?.revokedAt === null, false);
});
test("credential issuance retry never stores or reveals its one-time signed bearer again", async () => {
  const f = await fixture(); const command = { kind: "credential_issue", requestId: key(), scopes: ["cart"], acknowledgedSample: true };
  const first = await cartWorkbenchCommand(f.session, command); assert.ok(first.token && first.credential);
  const retry = await cartWorkbenchCommand(f.session, command); assert.equal(retry.token, undefined); assert.equal(retry.secretUnavailable, true); assert.equal(retry.credential?.id, first.credential.id);
  const rows = (await database().query("SELECT payload FROM wk_cart_credentials WHERE tenant_id=$1", [f.session.id])).rows;
  assert.equal(JSON.stringify(rows).includes(first.token), false); assert.equal(JSON.stringify(rows).includes("PRIVATE KEY"), false);
});
test("expired current sessions and disabled merchants cannot retain authority through stale objects", async () => {
  const f = await fixture(); const cart = await create(f);
  await database().query("UPDATE wk_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.session.id]);
  await assert.rejects(() => read(f, cart.id!), refuses(401)); await assert.rejects(() => getMerchantCart(f.actor, cart.id!), refuses(401));
  const other = await fixture(); const second = await create(other);
  await database().query("UPDATE wk_cart_merchants SET disabled_at=clock_timestamp() WHERE tenant_id=$1", [other.session.id]);
  await assert.rejects(() => read(other, second.id!), refuses(401));
});
test("an expired immutable Sample approval requires a new revision and token even when cart contents are unchanged", async () => {
  const f = await fixture(); const cart = await create(f); const view = await selected(f, cart.id!); const row = view.record;
  // Deliberately expired controlled fixture; no genuine buyer/provider approval is claimed.
  await database().query("INSERT INTO wk_cart_approvals(id,cart_id,merchant_id,tenant_id,token_id,quote_hash,total_minor,payer_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()-interval '1 second')", [`expired_${key()}`, row.id, row.merchantId, f.session.id, cart.payment_method!.token, row.current.evaluationHash, row.current.totalMinor, `WK-SAMPLE-EXPIRED-${key()}`]);
  const expired = await read(f, cart.id!); assert.equal(expired.status, "INCOMPLETE"); assert.equal(expired.payment_method?.token, undefined);
  const replacement = await replace(f, cart.id!, document(f)); assert.notEqual(replacement.payment_method?.token, cart.payment_method?.token);
  assert.equal((await selected(f, cart.id!)).record.version, 2); const approval = await approve(f, cart.id!); assert.equal((await read(f, cart.id!)).payment_method?.payer_id, approval.payerId);
});
test("cart expiry refuses new effects without renewing the saved cart or original workspace expiry", async t => {
  const f = await fixture(); const cart = await create(f); const approval = await approve(f, cart.id!); const saved = await selected(f, cart.id!);
  const future = Date.now() + 31 * 60_000; t.mock.method(Date, "now", () => future);
  assert.equal((await read(f, cart.id!)).status, "INCOMPLETE"); await assert.rejects(() => complete(f, cart.id!, approval), refuses(422, "CART_EXPIRED"));
  const after = await selected(f, cart.id!); assert.equal(after.record.expiresAt, saved.record.expiresAt); assert.equal(after.record.version, 1);
  assert.equal((await database().query("SELECT expires_at FROM wk_sessions WHERE id=$1", [f.session.id])).rows[0].expires_at.toISOString(), f.session.expiresAt);
});
test("a queued integration command rechecks credential expiry after obtaining the merchant lock", async t => {
  const f = await fixture(); const actor = await authenticateCartRequest(new Request(baseURL, { headers: { Authorization: `Bearer ${f.token}` } }), "cart");
  const home = await cartHome(f.session); assert.ok(home.merchant); const locker = await database().connect();
  await locker.query("BEGIN"); await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`worldkit:cart:${home.merchant.id}`]);
  const pending = createMerchantCart(actor, document(f), key()); const refusal = assert.rejects(() => pending, refuses(401));
  try {
    let observed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      observed = (await database().query("SELECT count(*)::integer AS n FROM pg_locks WHERE locktype='advisory' AND granted=false AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n > 0;
      if (observed) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(observed, true, "The original command must actually be waiting on its merchant lock");
    const future = Date.now() + 61 * 60_000; t.mock.method(Date, "now", () => future);
    await locker.query("COMMIT"); await refusal;
    assert.equal((await database().query("SELECT count(*)::integer AS n FROM wk_cart_carts WHERE tenant_id=$1", [f.session.id])).rows[0].n, 0);
  } finally { await locker.query("ROLLBACK"); locker.release(); }
});
test("buyer approval that expires while current system proof is locked cannot produce a settlement", async t => {
  const f = await fixture(); const cart = await create(f); const approval = await approve(f, cart.id!);
  const locker = await database().connect(); await locker.query("BEGIN");
  await locker.query("SELECT id FROM wk_domain_projects WHERE id=$1 FOR UPDATE", [f.projectId]);
  const pending = completeMerchantCheckout(f.actor, cart.id!, { payment_method: { type: "paypal", token: approval.token, payer_id: approval.payerId } }, key());
  const refusal = assert.rejects(() => pending, refuses(422, "APPROVAL_EXPIRED"));
  try {
    let observed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      observed = (await database().query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%JOIN wk_domain_projects p%'")).rows[0].n > 0;
      if (observed) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(observed, true, "Checkout must actually be waiting on current system proof after reading the approval");
    const future = Date.now() + 11 * 60_000; t.mock.method(Date, "now", () => future);
    await locker.query("COMMIT"); await refusal;
    assert.equal((await database().query("SELECT count(*)::integer AS n FROM wk_cart_settlements WHERE tenant_id=$1", [f.session.id])).rows[0].n, 0);
    assert.equal((await database().query("SELECT stock FROM wk_cart_catalogue WHERE id=$1", [f.line.id])).rows[0].stock, 4);
    assert.equal((await database().query("SELECT version,state FROM wk_cart_carts WHERE id=$1", [cart.id])).rows[0].version, 1);
  } finally { await locker.query("ROLLBACK"); locker.release(); }
});
test("database constraints preserve cart/catalogue identity and append-only authority, approvals and receipts", async () => {
  const f = await fixture(); const cart = await create(f); const approval = await approve(f, cart.id!); await complete(f, cart.id!, approval);
  for (const table of ["wk_cart_revisions", "wk_cart_payment_tokens", "wk_cart_approvals", "wk_cart_settlements", "wk_cart_commands", "wk_cart_events"])
    await assert.rejects(() => database().query(`DELETE FROM ${table} WHERE tenant_id=$1`, [f.session.id]), (error: unknown) => (error as { code?: string }).code === "23514");
  for (const [sql, args] of [
    ["UPDATE wk_cart_carts SET expires_at=expires_at+interval '1 hour' WHERE id=$1", [cart.id]],
    ["UPDATE wk_cart_catalogue SET payload=payload||'{\"productKind\":\"digital\"}'::jsonb,stock_version=stock_version+1 WHERE id=$1", [f.line.id]],
    ["UPDATE wk_cart_credentials SET expires_at=expires_at+interval '1 hour' WHERE id=$1", [f.credentialId]],
  ] as [string, unknown[]][]) await assert.rejects(() => database().query(sql, args), (error: unknown) => (error as { code?: string }).code === "23514");
});
test("private customer/cart bodies and command receipts are encrypted and events contain no buyer data", async () => {
  const f = await fixture(); const body = document(f); const cart = await create(f, body); await approve(f, cart.id!);
  for (const table of ["wk_cart_revisions", "wk_cart_commands", "wk_cart_events"]) {
    const rows = (await database().query(`SELECT row_to_json(t) AS value FROM ${table} t WHERE tenant_id=$1`, [f.session.id])).rows;
    const stored = JSON.stringify(rows); assert.equal(stored.includes(body.customer!.email_address!), false); assert.equal(stored.includes("1 Sample Street"), false); assert.equal(stored.includes(f.token), false);
  }
});
test("a separate process recovers the same saved cart and idempotent create receipt", async () => {
  const f = await fixture(); const requestId = key(); const cart = await create(f, document(f), requestId);
  const code = `import { authenticateCartRequest } from './src/server/cart-interop-store.ts'; import { createMerchantCart,getMerchantCart } from './src/server/cart-interop.ts'; import { closeDatabase } from './src/server/db.ts';
    try { const actor=await authenticateCartRequest(new Request('http://127.0.0.1:4577/api/paypal/v1',{headers:{Authorization:'Bearer '+process.env.WK_TEST_TOKEN}}),'cart');
    const cart=await getMerchantCart(actor,process.env.WK_TEST_CART); const retry=await createMerchantCart(actor,JSON.parse(process.env.WK_TEST_BODY),process.env.WK_TEST_REQUEST);
    console.log(JSON.stringify({id:cart.id,status:cart.status,retriedId:retry.id})); } catch(e) { console.log(JSON.stringify({error:e.name,status:e.status}));process.exitCode=1; } finally { await closeDatabase(); }`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 20000,
    env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: process.env.DATABASE_URL, AUTH_SECRET: process.env.AUTH_SECRET, WORLDKIT_QA_MODE: "cart-interop", WORLDKIT_DISABLE_PROVIDERS: "true", WORLDKIT_PUBLIC_URL: process.env.WORLDKIT_PUBLIC_URL, WK_TEST_TOKEN: f.token, WK_TEST_CART: cart.id, WK_TEST_BODY: JSON.stringify(document(f)), WK_TEST_REQUEST: requestId } });
  assert.equal(result.status, 0, "The isolated restart reader must exit successfully without printing private request data");
  assert.deepEqual(JSON.parse(result.stdout.trim()), { id: cart.id, status: cart.status, retriedId: cart.id });
});
test("streamed requests are bounded even without a declared Content-Length", async () => {
  const request = new Request("http://127.0.0.1/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ignored: "a".repeat(70_000) }) });
  await assert.rejects(() => readCartJson(request), refuses(413));
  const invalid = new Request("http://127.0.0.1/cart", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0xff, 0xfe]) });
  await assert.rejects(() => readCartJson(invalid), refuses(400));
});
