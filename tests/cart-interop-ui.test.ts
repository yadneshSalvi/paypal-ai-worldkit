import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { CART_SPEC, CartCommandSchema, type CartCatalogueLine, type CartCommand, type CartHome, type CartInput, type CartRevision } from "../packages/cart-interop/contracts";
import { cartHash, evaluateCart } from "../packages/cart-interop/evaluate";
import { pendingCartCommand } from "../packages/cart-interop/recovery";

// Real React controls and DOM events, with an entirely synthetic transport. No
// running database, provider, merchant or real bearer credential is accessible.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://worldkit.test/?section=cart" });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { CartInterop } = await import("../src/components/cart-interop");
const at = "2026-11-12T06:00:00.000Z";
const expiresAt = "2099-01-01T00:00:00.000Z";
const workspaceKey = "1".repeat(64);
const line: CartCatalogueLine = { id: "wksku_synthetic_ui", parentId: "wksystem_synthetic_ui", merchantId: "wkmerchant_synthetic_ui", title: "Sample · Six voices, carefully connected", description: "Synthetic physical bundle; no fulfillment.", productKind: "physical", sourceMode: "sample", priceMinor: 42000, stock: 4, stockVersion: 1, projectId: "pack_synthetic_ui", editionId: "packrev_synthetic_ui", graphHash: "a".repeat(64), currentEditionId: "packrev_synthetic_ui", currentGraphHash: "a".repeat(64), packId: "podcast-classroom", editionNumber: 2, componentCount: 13, modelConflicts: 0, actualHumanReviews: 0, physicalTests: 0, active: true, evidenceCurrent: true };
const cartId = "wkcart_synthetic_ui";
const input: CartInput = { items: [{ variant_id: line.id, parent_id: line.parentId, quantity: 1 }], customer: { email_address: "sample.buyer@example.invalid" }, shipping_address: { country_code: "US", address_line_1: "1 Sample Street", admin_area_2: "Sample City", admin_area_1: "CA", postal_code: "90001" } };
const evaluation = evaluateCart(input, [line], line.merchantId, cartId);
const first: CartRevision = { id: "wkcartrev_synthetic_1", number: 1, hash: "b".repeat(64), input: structuredClone(input), response: { ...evaluation.cart, payment_method: { type: "paypal", token: "WK-SAMPLE-TOKEN-UI-1" } }, evaluationHash: evaluation.digest, totalMinor: 42700, createdAt: at };
const second: CartRevision = { ...structuredClone(first), id: "wkcartrev_synthetic_2", number: 2, hash: "c".repeat(64), response: { ...structuredClone(first.response), status: "COMPLETED", payment_confirmation: { merchant_order_number: "WK-SAMPLE-SETTLEMENT-UI-1" } } };
function home({ merchant = true, catalogue = true, cart = false, approved = false, completed = false, historical = false, changed = false } = {}): CartHome {
  const current = completed ? second : first;
  const displayed = historical ? first : current;
  return {
    workspaceKey, sourceMode: "sample", spec: CART_SPEC, merchant: merchant ? { id: line.merchantId, audience: "worldkit.test", createdAt: at } : null,
    systems: [{ id: "pack_synthetic_desk", title: "Two views at the desk", packId: "desk-displays", editionId: "packrev_synthetic_desk", editionNumber: 1, graphHash: "d".repeat(64), modelConflicts: 1, modelQuestions: 2, componentCount: 5, evidenceCurrent: true }, { id: line.projectId, title: "Six voices, carefully connected", packId: line.packId, editionId: line.editionId, editionNumber: line.editionNumber, graphHash: line.graphHash, modelConflicts: 0, modelQuestions: 2, componentCount: 13, evidenceCurrent: true }],
    catalogue: catalogue ? [structuredClone(line)] : [], credentials: [],
    carts: cart ? [{ id: cartId, version: current.number, state: completed ? "completed" : "open", totalMinor: current.totalMinor, createdAt: at, expiresAt }] : [],
    selected: cart ? { record: { id: cartId, merchantId: line.merchantId, tenantId: "synthetic_ui_workspace", sourceMode: "sample", version: current.number, state: completed ? "completed" : "open", current: structuredClone(current), completedAt: completed ? at : null, createdAt: at, expiresAt }, displayedRevision: structuredClone(displayed), response: structuredClone(displayed.response), reviewRequired: changed, historical,
      history: (completed ? [second, first] : [first]).map(value => ({ id: value.id, number: value.number, hash: value.hash, evaluationHash: value.evaluationHash, totalMinor: value.totalMinor, createdAt: at })),
      approval: approved ? { id: "wkapproval_synthetic_ui", token: "WK-SAMPLE-TOKEN-UI-1", payerId: "WK-SAMPLE-PAYER-UI", expiresAt, current: !historical && !completed && !changed } : null } : null,
    events: [{ id: "wkevent_synthetic_ui", kind: "merchant.sample_started", cartId: null, version: null, detail: "A separate Sample merchant opened; no provider was called.", at, sourceMode: "sample" }],
  };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type RequestCall = { method: string; url: URL; body?: unknown };
class HttpFixture {
  readonly calls: RequestCall[] = [];
  readonly unexpected: string[] = [];
  private readonly queue: { method: string; response: Response | Promise<Response> | Error }[] = [];
  get(value: CartHome | Promise<Response> | Error) { this.queue.push({ method: "GET", response: value instanceof Promise || value instanceof Error ? value : json(value) }); return this; }
  post(value: unknown | Promise<Response> | Error, status = 200) { this.queue.push({ method: "POST", response: value instanceof Promise || value instanceof Error ? value : json(value, status) }); return this; }
  readonly fetch: typeof fetch = async (input, init) => {
    const call: RequestCall = { method: init?.method ?? "GET", url: new URL(String(input), "https://worldkit.test"), ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) };
    this.calls.push(call);
    const next = this.queue.shift();
    if (call.url.origin !== "https://worldkit.test" || call.url.pathname !== "/api/cart-interop" || !next || next.method !== call.method) {
      const message = `Unexpected synthetic request: ${call.method} ${call.url.href}`; this.unexpected.push(message); throw new Error(message);
    }
    if (call.method === "POST") assert.deepEqual(pendingCartCommand(window.sessionStorage, workspaceKey), call.body, "Exact command is retained before transport dispatch");
    if (next.response instanceof Error) throw next.response;
    return next.response;
  };
  command(index = 0): CartCommand { return CartCommandSchema.parse(this.calls.filter(call => call.method === "POST")[index]?.body); }
  complete() { assert.deepEqual(this.unexpected, []); assert.equal(this.queue.length, 0, "Every expected synthetic response was consumed"); }
}
async function mount(t: TestContext, http: HttpFixture) {
  window.sessionStorage.clear(); window.history.replaceState({}, "", "/?section=cart"); document.body.innerHTML = "<div id='root'></div>";
  let root = createRoot(document.getElementById("root")!);
  const originalFetch = globalThis.fetch; globalThis.fetch = http.fetch;
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; document.body.innerHTML = ""; window.sessionStorage.clear(); http.complete(); });
  await act(async () => root.render(createElement(CartInterop, { onSystems() {} })));
  return { async remount() { await act(async () => root.unmount()); document.body.innerHTML = "<div id='root'></div>"; root = createRoot(document.getElementById("root")!); await act(async () => root.render(createElement(CartInterop, { onSystems() {} }))); } };
}
const text = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "";
function one<T extends Element>(selector: string, scope: ParentNode = document): T { const found = scope.querySelectorAll<T>(selector); assert.equal(found.length, 1, `Expected one ${selector}, found ${found.length}`); return found[0]!; }
function button(name: string, scope: ParentNode = document): HTMLButtonElement { const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).filter(value => (value.getAttribute("aria-label") ?? text(value)) === name); assert.equal(found.length, 1, `Expected one button ${JSON.stringify(name)}, found ${found.length}`); return found[0]!; }
function field<T extends HTMLInputElement | HTMLSelectElement>(label: string, scope: ParentNode = document): T { const labels = Array.from(scope.querySelectorAll("label")).filter(value => text(value).startsWith(label)); assert.equal(labels.length, 1, `Expected field ${JSON.stringify(label)}`); return one<T>("input,select", labels[0]!); }
const dialog = () => one<HTMLDivElement>("[role=dialog]");
const disabled = (element: HTMLElement) => element.matches(":disabled");
async function click(element: HTMLElement) { assert.equal(disabled(element), false, `Cannot click disabled ${text(element)}`); await act(async () => { element.focus(); element.click(); }); }
async function key(element: HTMLElement | Document, value: string) { await act(async () => element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }))); }
async function type(element: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); }
async function resolve(response: ReturnType<typeof deferred<Response>>, value: unknown) { await act(async () => response.resolve(json(value))); }
function assertCartFocus(number: number, historical = false) { const heading = one<HTMLHeadingElement>("h2[aria-describedby=cart-edition-status]"); assert.equal(document.activeElement, heading); assert.match(document.getElementById("cart-edition-status")!.textContent!, new RegExp(`Version ${number}.*${historical ? "Historical version.*read only" : "Current"}`)); }

test("opening the lab is read only; starting its distinct Sample merchant is one explicit action", async t => {
  const pending = deferred<Response>(); const http = new HttpFixture().get(home({ merchant: false, catalogue: false })).post(pending.promise).get(home({ catalogue: false }));
  await mount(t, http); assert.equal(http.calls.length, 1); assert.match(document.body.textContent!, /No funds move or equipment ships/);
  const trigger = button("Open the Sample merchant"); await click(trigger); assert.equal(disabled(trigger), true);
  assert.deepEqual({ ...http.command(), requestId: "id" }, { kind: "start_sample", requestId: "id", acknowledgedSample: true });
  await resolve(pending, { message: "The Sample merchant is ready." }); assert.equal(document.activeElement, one(".cart-notice"));
  assert.equal(pendingCartCommand(window.sessionStorage, workspaceKey), null); assert.equal(document.querySelectorAll(".cart-system-choices>button").length, 2);
});

test("choosing the second saved system retains its exact edition and preserves focus on cancellation", async t => {
  const http = new HttpFixture().get(home({ catalogue: false })).post({ message: "Sample bundle saved." }).get(home());
  await mount(t, http); const choices = document.querySelectorAll<HTMLButtonElement>(".cart-system-choices>button"); const trigger = choices[1]!;
  await click(trigger); assert.equal(field<HTMLSelectElement>("Saved system", dialog()).value, line.projectId); await key(document, "Escape");
  assert.equal(document.querySelector("[role=dialog]"), null); assert.equal(document.activeElement, trigger);
  await click(trigger); await type(field<HTMLInputElement>("Sample unit price", dialog()), "420.01"); await type(field<HTMLInputElement>("Sample stock", dialog()), "3"); await click(button("Add this Sample bundle", dialog()));
  assert.deepEqual({ ...http.command(), requestId: "id" }, { kind: "catalogue_add", requestId: "id", projectId: line.projectId, expectedEditionId: line.editionId, expectedGraphHash: line.graphHash, priceMinor: 42001, stock: 3, acknowledgedSample: true });
  assert.equal(document.activeElement, one(".cart-notice"));
});

test("saving a cart blocks repeat submission and dismissal, then focuses the retained current version", async t => {
  const saving = deferred<Response>(); const http = new HttpFixture().get(home()).post(saving.promise).get(home({ cart: true }));
  await mount(t, http); await click(button("Create a Sample cart")); await click(button("Save Sample cart", dialog()));
  assert.equal(disabled(button("Close dialog", dialog())), true); assert.equal(disabled(button("Keep editing later", dialog())), true); await key(document, "Escape"); assert.ok(dialog());
  const command = http.command(); assert.equal(command.kind, "cart_create"); if (command.kind !== "cart_create") throw new Error("Expected create"); assert.deepEqual(command.body, input);
  await resolve(saving, { cartId, message: "Sample cart saved." }); assert.equal(document.querySelector("[role=dialog]"), null); assertCartFocus(1);
  assert.equal(pendingCartCommand(window.sessionStorage, workspaceKey), null);
});

test("an uncertain response survives remount without redispatch and recovers the identical command", async t => {
  const http = new HttpFixture().get(home()).post(new Error("Synthetic connection closed after dispatch")).get(home()).post({ cartId, message: "Original saved cart recovered." }).get(home({ cart: true }));
  const app = await mount(t, http); await click(button("Create a Sample cart")); await click(button("Save Sample cart", dialog()));
  const command = http.command(); assert.deepEqual(pendingCartCommand(window.sessionStorage, workspaceKey), command); assert.equal(disabled(button("Save Sample cart", dialog())), true);
  await key(document, "Escape"); assert.equal(document.querySelector("[role=dialog]"), null); await app.remount();
  assert.equal(http.calls.filter(value => value.method === "POST").length, 1, "Mounting never automatically repeats a mutation"); assert.equal(disabled(button("Create a Sample cart")), true);
  await click(button("Retry the same action")); assert.deepEqual(http.command(1), command); assert.equal(pendingCartCommand(window.sessionStorage, workspaceKey), null); assertCartFocus(1);
});

test("a known validation refusal leaves editable fields and does not retain an uncertain command", async t => {
  const http = new HttpFixture().get(home()).post({ error: { message: "Sample quantity exceeds stock." } }, 422);
  await mount(t, http); await click(button("Create a Sample cart")); await type(field<HTMLInputElement>("Quantity", dialog()), "5"); await click(button("Save Sample cart", dialog()));
  assert.equal(pendingCartCommand(window.sessionStorage, workspaceKey), null); assert.equal(disabled(button("Save Sample cart", dialog())), false); assert.equal(field<HTMLInputElement>("Quantity", dialog()).value, "5");
  assert.match(text(one(".cart-dialog-error", dialog())), /exceeds stock/); assert.equal(dialog().querySelectorAll("[role=alert]").length, 1);
});

test("a confirmed save with a failed refresh only rereads the saved cart, without a second mutation", async t => {
  const http = new HttpFixture().get(home()).post({ cartId, message: "Sample cart saved." }).get(new Error("Synthetic read failed")).get(home({ cart: true }));
  await mount(t, http); await click(button("Create a Sample cart")); await click(button("Save Sample cart", dialog()));
  assert.equal(pendingCartCommand(window.sessionStorage, workspaceKey), null); assert.match(text(one(".cart-notice")), /action was saved/);
  await click(button("Refresh saved view")); assert.equal(http.calls.filter(value => value.method === "POST").length, 1); assert.match(document.body.textContent!, /Current saved cart/);
});

test("buyer approval requires explicit consent and binds the current version, quote and token", async t => {
  const approving = deferred<Response>(); const http = new HttpFixture().get(home({ cart: true })).post(approving.promise).get(home({ cart: true, approved: true }));
  await mount(t, http); const trigger = button("Review buyer approval"); await click(trigger);
  assert.equal(disabled(button("Approve this version", dialog())), true); await click(button("Keep reviewing", dialog())); assert.equal(document.activeElement, trigger);
  await click(trigger); await click(one<HTMLInputElement>("input[type=checkbox]", dialog())); await click(button("Approve this version", dialog()));
  assert.equal(disabled(button("Close dialog", dialog())), true); await key(document, "Escape"); assert.ok(dialog());
  assert.deepEqual({ ...http.command(), requestId: "id" }, { kind: "cart_approve", requestId: "id", cartId, expectedVersion: 1, evaluationHash: first.evaluationHash, token: first.response.payment_method!.token, acknowledgedSample: true });
  await resolve(approving, { cartId, message: "Exact Sample cart approved." }); assertCartFocus(1); assert.equal(disabled(button("Complete Sample checkout")), false);
});

test("a merchant change invalidates completion and keeps the new price separate from the retained quote", async t => {
  const changed = home({ cart: true, approved: true, changed: true }); changed.catalogue[0]!.priceMinor = 45000; changed.catalogue[0]!.stockVersion = 2;
  changed.selected!.response = { ...evaluateCart(input, changed.catalogue, line.merchantId, cartId).cart, status: "INCOMPLETE", validation_status: "INVALID", validation_issues: [{ code: "BUSINESS_RULE_ERROR", type: "BUSINESS_RULE", message: "The merchant changed. Review current details.", field: "cart" }] };
  const http = new HttpFixture().get(home({ cart: true, approved: true })).post({ message: "Sample merchant changed; review required." }).get(changed);
  await mount(t, http); await click(button("Try a merchant change")); await type(field<HTMLInputElement>("Sample unit price", dialog()), "450.00"); await click(button("Save Sample merchant change", dialog()));
  assert.equal(http.command().kind, "catalogue_change"); assert.equal(document.body.textContent!.includes("Complete Sample checkout"), false); assert.equal(disabled(button("Review buyer approval")), true);
  assert.match(text(one(".cart-grand-total")), /427\.00/); assert.match(document.body.textContent!, /Something changed/); assert.equal(disabled(button("Review changed cart")), false);
  assert.match(text(one(".cart-quote-change")), /Saved quote \$427\.00.*Current merchant total \$457\.00.*not saved/);
  assert.equal(document.querySelectorAll(".cart-steps>li.done").length, 0); assert.match(text(one(".cart-issues")), /merchant changed/);
});

test("a complete replacement removes cleared buyer details and never silently changes an unsupported country", async t => {
  const current = home({ cart: true }); current.selected!.record.current.input.shipping_address!.country_code = "GB";
  current.selected!.record.current.input.shipping_address!.address_line_2 = "An earlier optional field outside this replacement form";
  const http = new HttpFixture().get(current).post({ cartId, message: "Incomplete replacement saved." }).get(current);
  await mount(t, http); await click(button("Edit the complete cart")); assert.equal(field<HTMLSelectElement>("Country", dialog()).value, "GB");
  await type(field<HTMLInputElement>("Sample email", dialog()), ""); await click(button("Save reviewed replacement", dialog()));
  const command = http.command(); assert.equal(command.kind, "cart_replace"); if (command.kind !== "cart_replace") throw new Error("Expected replacement");
  assert.equal(command.body.customer, undefined); assert.equal(command.body.shipping_address?.country_code, "GB"); assert.equal(command.expectedVersion, 1);
  assert.equal(command.body.shipping_address?.address_line_2, undefined, "Fields outside the complete replacement form must not be silently inherited");
});

test("historical cart navigation reads the retained version and cannot reuse current completion controls", async t => {
  const http = new HttpFixture().get(home({ cart: true, approved: true, completed: true })).get(home({ cart: true, approved: true, completed: true, historical: true })).get(home({ cart: true, approved: true, completed: true }));
  await mount(t, http); await click(button("Every version stays in the story.2 versions")); await click(button("Open", one(".cart-version-list")));
  assert.equal(http.calls[1]!.url.searchParams.get("revisionId"), first.id); assertCartFocus(1, true); assert.equal(text(one("h2[aria-describedby=cart-edition-status]")), "An earlier decision.");
  assert.equal(document.querySelectorAll(".cart-completion-stamp").length, 0); assert.equal(document.querySelectorAll(".cart-steps>li.done").length, 1); assert.equal(document.body.textContent!.includes("Review buyer approval"), false);
  await click(button("Return to current cart")); assertCartFocus(2); assert.equal(document.querySelectorAll(".cart-completion-stamp").length, 1); assert.equal(http.calls.filter(value => value.method === "POST").length, 0);
});

test("reloading an exact historical cart keeps its selected version and private reading view", async t => {
  const historical = home({ cart: true, approved: true, completed: true, historical: true });
  const http = new HttpFixture().get(home({ cart: true, approved: true, completed: true })).get(historical).get(historical).get(historical);
  const app = await mount(t, http); await click(button("Every version stays in the story.2 versions")); await click(button("Open", one(".cart-version-list")));
  let address = new URL(window.location.href); assert.equal(address.searchParams.get("cart"), cartId); assert.equal(address.searchParams.get("cartRevision"), first.id);
  await app.remount(); assert.equal(http.calls[2]!.url.searchParams.get("cartId"), cartId); assert.equal(http.calls[2]!.url.searchParams.get("revisionId"), first.id);
  assert.match(document.getElementById("cart-edition-status")!.textContent!, /Version 1.*Historical version.*read only/);
  await click(button("Agent interface")); await app.remount(); address = new URL(window.location.href);
  assert.equal(address.searchParams.get("cartView"), "agent"); assert.equal(address.searchParams.get("cartRevision"), first.id);
  assert.equal(button("Agent interface").getAttribute("aria-selected"), "true"); assert.equal(http.calls[3]!.url.searchParams.get("revisionId"), first.id);
  assert.equal(http.calls.filter(value => value.method === "POST").length, 0);
});

test("scoped credential creation is deliberate, masks the one-time token and returns focus on Escape", async t => {
  const grant = { id: "wkcredential_synthetic_ui", scopes: ["cart", "checkout"] as ("cart" | "checkout")[], expiresAt, revokedAt: null, createdAt: at };
  const withGrant = home(); withGrant.credentials = [grant];
  const http = new HttpFixture().get(home()).post({ message: "Copy the Sample credential once.", token: "synthetic-ui-value-not-a-real-signed-token", credential: grant }).get(withGrant);
  await mount(t, http); await click(button("Agent interface")); await click(one<HTMLInputElement>(".cart-agent-permissions input")); const trigger = button("Issue Sample credential"); await click(trigger);
  assert.deepEqual({ ...http.command(), requestId: "id" }, { kind: "credential_issue", requestId: "id", scopes: ["cart", "checkout"], acknowledgedSample: true });
  const secret = one<HTMLInputElement>("input[type=password]", dialog()); assert.equal(secret.value, "synthetic-ui-value-not-a-real-signed-token"); assert.equal(document.body.textContent!.includes(secret.value), false); assert.equal(window.sessionStorage.length, 0);
  await key(document, "Escape"); assert.equal(document.querySelector("input[type=password]"), null); assert.equal(document.activeElement, trigger); assert.match(document.body.textContent!, /Cart \+ approved Sample checkout/);
});

test("revocation sends one command and renders its confirmed retained state", async t => {
  const active = home(); active.credentials = [{ id: "wkcredential_synthetic_ui", scopes: ["cart"], expiresAt, revokedAt: null, createdAt: at }]; const revoked = structuredClone(active); revoked.credentials[0]!.revokedAt = at;
  const revoking = deferred<Response>(); const http = new HttpFixture().get(active).post(revoking.promise).get(revoked);
  await mount(t, http); await click(button("Agent interface")); await click(button("Revoke")); assert.equal(disabled(button("Revoke")), true); assert.equal(http.command().kind, "credential_revoke");
  await resolve(revoking, { message: "The Sample integration credential is revoked." }); assert.equal(document.body.textContent!.includes("RevokeRevoked"), false); assert.match(text(one(".cart-credential-list")), /Revoked/); assert.equal(document.querySelectorAll(".cart-credential-list button").length, 0); assert.equal(document.activeElement, one(".cart-notice"));
});

test("cart view tabs provide one tab stop with arrow, Home and End navigation", async t => {
  const http = new HttpFixture().get(home()); await mount(t, http);
  const tabs = document.querySelectorAll<HTMLButtonElement>("[role=tab]"); assert.equal(Array.from(tabs).filter(value => value.tabIndex === 0).length, 1);
  const catalogue = button("Sample catalogue"); catalogue.focus(); await key(catalogue, "ArrowRight"); assert.equal(document.activeElement, button("Agent interface")); assert.equal(button("Agent interface").getAttribute("aria-selected"), "true");
  await key(button("Agent interface"), "Home"); assert.equal(document.activeElement, button("Your cart")); await key(button("Your cart"), "End"); assert.equal(document.activeElement, button("Agent interface"));
  assert.equal(one("[role=tabpanel]").getAttribute("aria-labelledby"), "cart-tab-agent"); assert.equal(http.calls.length, 1);
});

test("a prior workspace's recovery journal cannot dispatch into another workspace", async t => {
  const http = new HttpFixture().get(home()).get({ ...home(), workspaceKey: "2".repeat(64) }); const app = await mount(t, http);
  const command = { kind: "start_sample", requestId: "synthetic-prior-workspace-request", acknowledgedSample: true } as const;
  window.sessionStorage.setItem(`worldkit.cart.pending.v1:${workspaceKey}`, JSON.stringify({ workspaceKey, command }));
  await app.remount(); assert.equal(document.body.textContent!.includes("Retry the same action"), false); assert.equal(http.calls.filter(value => value.method === "POST").length, 0); assert.equal(disabled(button("Create a Sample cart")), false);
  assert.equal(cartHash(command), cartHash(pendingCartCommand(window.sessionStorage, workspaceKey)), "The original unresolved command remains retained for its own workspace");
});

test("unavailable recovery storage refuses transport before a mutation can be sent", async t => {
  const http = new HttpFixture().get(home()); await mount(t, http);
  const prototype = Object.getPrototypeOf(window.sessionStorage) as Storage; const original = prototype.setItem;
  prototype.setItem = () => { throw new dom.window.DOMException("Synthetic storage quota reached", "QuotaExceededError"); };
  t.after(() => { prototype.setItem = original; });
  await click(button("Create a Sample cart")); await click(button("Save Sample cart", dialog()));
  assert.equal(http.calls.filter(value => value.method === "POST").length, 0); assert.match(text(one(".cart-dialog-error", dialog())), /No new request was sent/);
  assert.equal(disabled(button("Save Sample cart", dialog())), false); assert.equal(field<HTMLInputElement>("Sample email", dialog()).value, "sample.buyer@example.invalid");
});

test("an unreadable saved action cannot be silently replaced by a different mutation", async t => {
  const http = new HttpFixture().get(home()).get(home()); const app = await mount(t, http);
  window.sessionStorage.setItem(`worldkit.cart.pending.v1:${workspaceKey}`, "null"); await app.remount();
  assert.match(text(one(".cart-notice")), /outcome must be resolved/); await click(button("Create a Sample cart")); await click(button("Save Sample cart", dialog()));
  assert.equal(http.calls.filter(value => value.method === "POST").length, 0); assert.equal(window.sessionStorage.getItem(`worldkit.cart.pending.v1:${workspaceKey}`), "null");
  assert.match(text(one(".cart-dialog-error", dialog())), /No new request was sent/);
});
