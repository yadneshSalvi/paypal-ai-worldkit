import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { writeFile } from "node:fs/promises";
import { CART_SPEC, CartCommandSchema, type CartCatalogueLine, type CartCommand, type CartHome, type CartInput, type CartRevision } from "../packages/cart-interop/contracts";
import { cartHash, evaluateCart } from "../packages/cart-interop/evaluate";
import { pendingCartCommand } from "../packages/cart-interop/recovery";

// Mounted production component; responses here are synthetic and carry no real
// merchant, provider, buyer authority, database or integration credential.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://worldkit.independent.test/?section=cart" });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { CartInterop } = await import("../src/components/cart-interop");
const aKey = "7".repeat(64); const bKey = "8".repeat(64); const at = "2026-11-12T07:00:00.000Z"; const expiresAt = "2099-01-01T00:00:00.000Z";
const line: CartCatalogueLine = { id: "wksku_independent_ui", parentId: "wksystem_independent_ui", merchantId: "wkmerchant_independent_ui", title: "Sample · Independent considered system", description: "Synthetic bundle, no equipment order.", productKind: "physical", sourceMode: "sample", priceMinor: 12345, stock: 3, stockVersion: 1, projectId: "pack_independent_ui", editionId: "packrev_independent_ui", graphHash: "9".repeat(64), currentEditionId: "packrev_independent_ui", currentGraphHash: "9".repeat(64), packId: "podcast-classroom", editionNumber: 1, componentCount: 4, modelConflicts: 0, actualHumanReviews: 0, physicalTests: 0, active: true, evidenceCurrent: true };
const cartId = "wkcart_independent_ui";
function home(workspaceKey = aKey, quantity = 1): CartHome {
  const input: CartInput = { items: [{ variant_id: line.id, parent_id: line.parentId, quantity }], customer: { email_address: "independent.scope.a@example.invalid" }, shipping_address: { country_code: "US", address_line_1: "42 Independent Fixture Street", admin_area_2: "Sample City", admin_area_1: "NY", postal_code: "10001" } };
  const evaluation = evaluateCart(input, [line], line.merchantId, cartId);
  const data = { id: `wkcartrev_independent_${quantity}`, number: quantity, input, response: { ...evaluation.cart, payment_method: { type: "paypal" as const, token: `WK-SAMPLE-INDEPENDENT-TOKEN-${quantity}` } }, evaluationHash: evaluation.digest, totalMinor: evaluation.totalMinor, createdAt: at };
  const revision: CartRevision = { ...data, hash: cartHash(data) };
  return { workspaceKey, sourceMode: "sample", spec: CART_SPEC, merchant: { id: line.merchantId, audience: "worldkit.independent.test", createdAt: at }, systems: [{ id: line.projectId, title: "Independent considered system", packId: line.packId, editionId: line.editionId, editionNumber: line.editionNumber, graphHash: line.graphHash, modelConflicts: 0, modelQuestions: 1, componentCount: 4, evidenceCurrent: true }], catalogue: [structuredClone(line)], credentials: [], carts: [{ id: cartId, version: quantity, state: "open", totalMinor: evaluation.totalMinor, createdAt: at, expiresAt }], selected: { record: { id: cartId, merchantId: line.merchantId, tenantId: "synthetic_independent_workspace", sourceMode: "sample", version: quantity, state: "open", current: structuredClone(revision), completedAt: null, createdAt: at, expiresAt }, displayedRevision: structuredClone(revision), response: structuredClone(revision.response), reviewRequired: false, historical: false, history: [{ id: revision.id, number: revision.number, hash: revision.hash, evaluationHash: revision.evaluationHash, totalMinor: revision.totalMinor, createdAt: at }], approval: null }, events: [] };
}
function emptyForeign(): CartHome { return { ...home(bKey), merchant: null, catalogue: [], carts: [], selected: null, systems: [], events: [] }; }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type Call = { method: string; url: URL; body?: CartCommand };
class Transport {
  readonly calls: Call[] = []; readonly unexpected: string[] = [];
  readonly queue: { method: string; response: Response | Promise<Response> | Error }[] = [];
  get(value: CartHome | Promise<Response> | Error) { this.queue.push({ method: "GET", response: value instanceof Promise || value instanceof Error ? value : json(value) }); return this; }
  post(value: unknown | Promise<Response> | Error) { this.queue.push({ method: "POST", response: value instanceof Promise || value instanceof Error ? value : json(value) }); return this; }
  readonly fetch: typeof fetch = async (input, init) => {
    const call: Call = { method: init?.method ?? "GET", url: new URL(String(input), dom.window.location.href), ...(typeof init?.body === "string" ? { body: CartCommandSchema.parse(JSON.parse(init.body)) } : {}) }; this.calls.push(call);
    const next = this.queue.shift();
    if (call.url.origin !== dom.window.location.origin || call.url.pathname !== "/api/cart-interop" || !next || next.method !== call.method) { const message = `Unexpected independent synthetic transport ${call.method} ${call.url.pathname}`; this.unexpected.push(message); throw new Error(message); }
    if (next.response instanceof Error) throw next.response;
    return next.response;
  };
  posts() { return this.calls.filter(call => call.method === "POST"); }
}
async function mount(t: TestContext, http: Transport) {
  window.sessionStorage.clear(); window.history.replaceState({}, "", "/?section=cart"); document.body.innerHTML = "<div id='independent-root'></div>";
  let root = createRoot(document.getElementById("independent-root")!); const original = globalThis.fetch; globalThis.fetch = http.fetch;
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = original; document.body.innerHTML = ""; window.sessionStorage.clear(); window.history.replaceState({}, "", "/?section=cart"); assert.deepEqual(http.unexpected, []); assert.equal(http.queue.length, 0, "All declared synthetic responses must be observed"); });
  await act(async () => root.render(createElement(CartInterop, { onSystems() {} })));
  return { async remount() { await act(async () => root.unmount()); document.body.innerHTML = "<div id='independent-root'></div>"; window.history.replaceState({}, "", "/?section=cart"); root = createRoot(document.getElementById("independent-root")!); await act(async () => root.render(createElement(CartInterop, { onSystems() {} }))); } };
}
const text = (value: Element) => value.textContent?.replace(/\s+/g, " ").trim() ?? "";
function button(name: string, scope: ParentNode = document): HTMLButtonElement { const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).filter(value => (value.getAttribute("aria-label") ?? text(value)) === name); assert.equal(found.length, 1, `Expected one ${name}`); return found[0]!; }
const modal = () => document.querySelector<HTMLElement>("[role=dialog]");
const disabled = (value: HTMLElement) => value.matches(":disabled");
async function click(value: HTMLElement) { assert.equal(disabled(value), false); await act(async () => { value.focus(); value.click(); }); }
async function resolve(value: ReturnType<typeof deferred<Response>>, body: unknown) { await act(async () => value.resolve(json(body))); }

test("independent refreshed cart revision cannot inherit a buyer checkbox selected for the earlier version", async t => {
  const pending = deferred<Response>(); const http = new Transport().get(home()).get(pending.promise); await mount(t, http);
  await click(button("Refresh the current merchant and cart"));
  const trigger = button("Review buyer approval"); let originalConsent = false;
  if (!disabled(trigger)) {
    await click(trigger); const checkbox = modal()!.querySelector<HTMLInputElement>("input[type=checkbox]")!; await click(checkbox); originalConsent = checkbox.checked;
  }
  await resolve(pending, home(aKey, 2));
  const checkbox = modal()?.querySelector<HTMLInputElement>("input[type=checkbox]");
  const approve = modal() && Array.from(modal()!.querySelectorAll<HTMLButtonElement>("button")).find(value => text(value) === "Approve this version");
  const reusedConsent = !!checkbox?.checked && !!approve && !disabled(approve);
  await writeFile(`.local/cart-interop-unit/independent/ui-revision-consent-${process.pid}.private.json`, JSON.stringify({ source: "Actual mounted CartInterop / synthetic HTTP responses", priorVersion: 1, incomingVersion: 2, priorConsentChecked: originalConsent, dialogRetained: !!modal(), displayedApproval: modal()?.querySelector(".cart-approval-total")?.textContent, reusedConsent, mutationRequests: http.posts().length }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  assert.equal(reusedConsent, false, "Consent to version one must never leave an enabled approval for the newly arriving version two");
  assert.equal(http.posts().length, 0);
});
test("independent refreshed foreign workspace cannot keep the earlier workspace's unsaved editor details", async t => {
  const pending = deferred<Response>(); const http = new Transport().get(home()).get(pending.promise); await mount(t, http);
  await click(button("Refresh the current merchant and cart")); const edit = button("Edit the complete cart");
  if (!disabled(edit)) await click(edit);
  await resolve(pending, emptyForeign());
  const retainedPriorBuyer = Array.from(document.querySelectorAll<HTMLInputElement>("input")).some(input => input.value === "independent.scope.a@example.invalid");
  await writeFile(`.local/cart-interop-unit/independent/ui-foreign-editor-${process.pid}.private.json`, JSON.stringify({ source: "Actual mounted CartInterop / synthetic foreign-workspace read", beforeWorkspace: aKey, currentWorkspace: bKey, priorBuyerStillInEditor: retainedPriorBuyer, dialogRetained: !!modal(), currentWelcomeVisible: document.body.textContent?.includes("Open the Sample merchant"), mutationRequests: http.posts().length }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  assert.equal(retainedPriorBuyer, false, "A new workspace identity must not inherit unsaved buyer fields from the earlier scope");
  assert.equal(http.posts().length, 0);
});

test("independent unresolved command survives a late failure, foreign remount and explicit original-scope recovery with exact focus", async t => {
  const pending = deferred<Response>();
  const http = new Transport().get(home()).post(pending.promise).get(emptyForeign()).get(home()).post({ cartId, message: "Original Sample replacement recovered." }).get(home());
  const app = await mount(t, http); await click(button("Edit the complete cart")); await click(button("Save reviewed replacement", modal()!));
  const original = http.posts()[0]!.body!; assert.deepEqual(pendingCartCommand(window.sessionStorage, aKey), original);
  await app.remount(); assert.match(document.body.textContent!, /Open the Sample merchant/); assert.equal(http.posts().length, 1);
  await act(async () => pending.reject(new Error("Independent controlled late response loss")));
  assert.deepEqual(pendingCartCommand(window.sessionStorage, aKey), original); assert.equal(pendingCartCommand(window.sessionStorage, bKey), null);
  assert.equal(document.body.textContent!.includes("Retry the same action"), false); assert.equal(disabled(button("Open the Sample merchant")), false);
  // Reopening the original synthetic unexpired scope is a read, not renewal or reseeding.
  await app.remount(); assert.equal(http.posts().length, 1); assert.equal(disabled(button("Edit the complete cart")), true);
  await click(button("Retry the same action")); assert.deepEqual(http.posts()[1]!.body, original);
  assert.equal(pendingCartCommand(window.sessionStorage, aKey), null); assert.equal(http.posts().length, 2);
  const heading = document.querySelector<HTMLHeadingElement>("h2[aria-describedby=cart-edition-status]")!; assert.equal(document.activeElement, heading);
  assert.match(document.getElementById("cart-edition-status")!.textContent!, /Current saved cart/);
});
test("independent late initial read cannot overwrite an already remounted foreign workspace", async t => {
  const pending = deferred<Response>(); const http = new Transport().get(pending.promise).get(emptyForeign()); const app = await mount(t, http);
  assert.match(document.body.textContent!, /Opening your private cart lab/);
  await app.remount(); assert.match(document.body.textContent!, /Open the Sample merchant/);
  await resolve(pending, home());
  assert.match(document.body.textContent!, /Open the Sample merchant/); assert.equal(document.body.textContent!.includes("independent.scope.a@example.invalid"), false);
  assert.equal(document.body.textContent!.includes("Your next considered step"), false); assert.equal(http.posts().length, 0);
});
test("independent expired initial scope performs read-only recovery and never starts or renews a merchant", async t => {
  const denied = Promise.resolve(json({ error: { message: "The original private workspace expired." } }, 401));
  const http = new Transport().get(denied).get(emptyForeign()); await mount(t, http);
  assert.match(document.body.textContent!, /original private workspace expired/); assert.equal(http.posts().length, 0);
  await click(button("Try again")); assert.match(document.body.textContent!, /Open the Sample merchant/);
  assert.equal(http.posts().length, 0); assert.equal(window.sessionStorage.length, 0);
});
