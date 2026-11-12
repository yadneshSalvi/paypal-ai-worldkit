import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { manifestFor, packManifests } from "../packages/domain-packs/catalog";
import { makePackEdition, packChanges, packGuide, packRequirements } from "../packages/domain-packs/compiler";
import { PackCommandSchema, type PackCommand, type PackEdition, type PackHome, type PackPreview, type PackProject, type PackState } from "../packages/domain-packs/contracts";

// Real React components and DOM events, with synthetic HTTP responses only. This
// process cannot reach a running WorldKit server or an external provider.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://worldkit.test/" });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { DomainPacks } = await import("../src/components/domain-packs");

const projectId = "pack_synthetic_dom_controls";
const projectTitle = "Synthetic desk controls";
const at = "2026-11-12T05:00:00.000Z";
const expiresAt = "2099-01-01T00:00:00.000Z";
const grantId = "grant_synthetic_dom_controls";
const token = "synthetic-dom-fixture-not-a-real-bearer-secret";
const first = makeEdition(manifestFor("desk-displays").defaultState, 1, null);
const changedState: PackState = { ...structuredClone(first.graph.state), config: { ...first.graph.state.config, displays: 1 } as PackState["config"] };
const second = makeEdition(changedState, 2, first.id);

function makeEdition(state: PackState, number: number, parentEditionId: string | null): PackEdition {
  return makePackEdition(structuredClone(state), { id: `packrev_synthetic_dom_${number}`, projectId, edition: number, parentEditionId, title: projectTitle, at }, `Synthetic interaction fixture ${number}`);
}
function home(edition: PackEdition | null = first, current: PackEdition = edition ?? first, grants: NonNullable<PackHome["selected"]>["grants"] = []): PackHome {
  if (!edition) return { manifests: structuredClone(packManifests), projects: [], selected: null };
  const project: PackProject = { id: projectId, packId: "desk-displays", title: projectTitle, currentEditionId: current.id, version: current.number, createdAt: at, archivedAt: null };
  return { manifests: structuredClone(packManifests), projects: [project], selected: { project, edition, currentGraphHash: current.certificate.graphHash, history: [current, ...(current.id !== first.id ? [first] : [])].map(item => ({ id: item.id, number: item.number, hash: item.hash, createdAt: item.createdAt, reason: item.reason })), freshness: { current: true, issues: [] }, requirements: packRequirements(edition.graph.state), guide: packGuide(edition), inventory: [], grants } };
}
function preview(): PackPreview {
  return { id: "preview_synthetic_dom", hash: "a".repeat(64), expectedEditionId: first.id, expectedVersion: 1, expectedGraphHash: first.certificate.graphHash, packHash: second.packHash, state: second.graph.state, edition: second, changes: packChanges(first.graph.state, second.graph.state), expiresAt, reason: "Synthetic display-goal review", freshness: { current: true, issues: [] } };
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type RecordedRequest = { method: string; url: URL; body?: unknown };
class HttpFixture {
  readonly calls: RecordedRequest[] = [];
  readonly unexpected: string[] = [];
  private readonly responses: { method: string; response: Response | Promise<Response> }[] = [];
  get(value: PackHome | Promise<Response>) { this.responses.push({ method: "GET", response: value instanceof Promise ? value : json(value) }); return this; }
  post(value: unknown | Promise<Response>, status = 200) { this.responses.push({ method: "POST", response: value instanceof Promise ? value : json(value, status) }); return this; }
  readonly fetch: typeof fetch = async (input, init) => {
    const request: RecordedRequest = { method: init?.method ?? "GET", url: new URL(String(input), "https://worldkit.test"), ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) };
    this.calls.push(request);
    const next = this.responses.shift();
    if (request.url.origin !== "https://worldkit.test" || request.url.pathname !== "/api/domain-packs" || !next || next.method !== request.method) {
      const message = `Unexpected synthetic request: ${request.method} ${request.url.href}`;
      this.unexpected.push(message);
      throw new Error(message);
    }
    return next.response;
  };
  command(index: number): PackCommand { return PackCommandSchema.parse(this.calls.filter(call => call.method === "POST")[index]?.body); }
  complete() { assert.deepEqual(this.unexpected, []); assert.equal(this.responses.length, 0, "Every expected HTTP response was consumed"); }
}
async function mount(t: TestContext, http: HttpFixture) {
  dom.window.history.replaceState(null, "", "/");
  document.body.innerHTML = "<div id='test-root'></div>";
  const root = createRoot(document.getElementById("test-root")!);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = http.fetch;
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; document.body.innerHTML = ""; http.complete(); });
  await act(async () => root.render(createElement(DomainPacks, { onEquipment() {}, onExplore() {} })));
}
const text = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "";
function one<T extends Element>(selector: string, scope: ParentNode = document): T {
  const found = scope.querySelectorAll<T>(selector);
  assert.equal(found.length, 1, `Expected one ${selector}, found ${found.length}`);
  return found[0]!;
}
function button(name: string, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).filter(element => (element.getAttribute("aria-label") ?? text(element)) === name);
  assert.equal(found.length, 1, `Expected one button named ${JSON.stringify(name)}, found ${found.length}`);
  return found[0]!;
}
function field<T extends HTMLInputElement | HTMLSelectElement>(label: string, scope: ParentNode = document): T {
  const found = Array.from(scope.querySelectorAll("label")).filter(element => text(element).startsWith(label));
  assert.equal(found.length, 1, `Expected one field labelled ${JSON.stringify(label)}`);
  return one<T>("input,select", found[0]!);
}
function dialog(): HTMLDivElement { return one<HTMLDivElement>("[role='dialog']"); }
function noDialog() { assert.equal(document.querySelector("[role='dialog']"), null); }
function disabled(element: HTMLElement) { return element.matches(":disabled"); }
async function click(element: HTMLElement) {
  assert.equal(disabled(element), false, `Cannot activate disabled control ${text(element)}`);
  await act(async () => { element.focus(); element.click(); });
}
async function escape() { await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); }
async function select(element: HTMLSelectElement, value: string) { await act(async () => { element.value = value; element.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); }
async function type(element: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
}
async function resolve(response: ReturnType<typeof deferred<Response>>, value: unknown) { await act(async () => response.resolve(json(value))); }
function assertEditionFocus(number: number, historical = false) {
  const heading = one<HTMLHeadingElement>("h2[aria-describedby='domain-edition-status']");
  assert.equal(document.activeElement, heading, "Navigation should focus the meaningful edition heading");
  assert.equal(text(heading), projectTitle);
  const description = document.getElementById(heading.getAttribute("aria-describedby")!)!;
  assert.match(text(description), new RegExp(`Edition ${number} .* ${historical ? "Historical edition" : "Current saved edition"}`));
}

test("a fresh gallery retains both pack choices and has no empty New system toggle", async t => {
  const http = new HttpFixture().get(home(null));
  await mount(t, http);
  assert.equal(document.querySelectorAll("article").length, 2);
  assert.equal(document.querySelectorAll("button").length, 2);
  assert.equal(Array.from(document.querySelectorAll("button")).some(element => text(element) === "New system"), false);
  assert.match(document.body.textContent!, /A desk for two views/);
  assert.match(document.body.textContent!, /Every voice, its own track/);
  assert.equal(http.calls.length, 1);
});

for (const [index, packName] of [[0, "A desk for two views"], [1, "Every voice, its own track"]] as const) {
  test(`${packName} opens a real dialog and restores its initiating button on close and Escape`, async t => {
    const http = new HttpFixture().get(home(null));
    await mount(t, http);
    const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(element => text(element) === "Build this system")[index]!;
    for (const close of ["button", "escape"] as const) {
      await click(trigger);
      assert.equal(dialog().getAttribute("aria-modal"), "true");
      assert.equal(text(document.getElementById(dialog().getAttribute("aria-labelledby")!)!), "Give this system a place.");
      assert.equal(field<HTMLInputElement>("System name", dialog()).value, packName);
      assert.equal(document.activeElement, button("Close new system", dialog()));
      assert.equal(document.body.style.overflow, "hidden");
      if (close === "button") await click(button("Close new system", dialog())); else await escape();
      noDialog();
      assert.equal(document.activeElement, trigger);
      assert.equal(document.body.style.overflow, "");
      assert.equal(document.querySelectorAll("article").length, 2);
    }
    assert.equal(http.calls.length, 1, "Opening and closing pack choices issues no mutation");
  });
}

test("creation requires a name, blocks duplicate actions while pending, and focuses the saved edition", async t => {
  const creating = deferred<Response>();
  const http = new HttpFixture().get(home(null)).post(creating.promise).get(home());
  await mount(t, http);
  await click(Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(element => text(element) === "Build this system")!);
  const name = field<HTMLInputElement>("System name", dialog());
  await type(name, "   ");
  assert.equal(disabled(button("Create saved system", dialog())), true);
  await type(name, `  ${projectTitle}  `);
  await click(button("Create saved system", dialog()));
  assert.equal(disabled(button("Create saved system", dialog())), true);
  assert.equal(disabled(button("Close new system", dialog())), true);
  await escape();
  assert.ok(dialog());
  const command = http.command(0);
  assert.equal(command.kind, "create");
  assert.deepEqual({ ...command, requestId: "identity" }, { kind: "create", requestId: "identity", packId: "desk-displays", title: projectTitle });
  await resolve(creating, { projectId, editionId: first.id });
  noDialog();
  assertEditionFocus(1);
  assert.equal(new URL(window.location.href).searchParams.get("system"), projectId);
});

for (const closing of ["Keep editing", "Escape"] as const) {
  test(`a delayed preview restores the original trigger with ${closing} even if focus moved while waiting`, async t => {
    const preparing = deferred<Response>();
    const http = new HttpFixture().get(home()).post(preparing.promise);
    await mount(t, http);
    const trigger = button("Preview this change");
    assert.equal(disabled(trigger), true);
    await select(field<HTMLSelectElement>("Display goal"), "1");
    assert.equal(disabled(trigger), false);
    await click(trigger);
    assert.equal(disabled(trigger), true, "The pending preview disables its configuration fieldset");
    assert.equal(disabled(field<HTMLSelectElement>("Display goal")), true);
    await click(button("Versions"));
    assert.equal(document.activeElement, button("Versions"));
    const command = http.command(0);
    assert.equal(command.kind, "preview");
    if (command.kind !== "preview") throw new Error("Expected preview command");
    assert.equal(command.expectedEditionId, first.id);
    assert.equal(command.expectedGraphHash, first.certificate.graphHash);
    assert.deepEqual(command.state, changedState);
    await resolve(preparing, { projectId, preview: preview() });
    assert.equal(document.activeElement, button("Close change preview", dialog()));
    assert.equal(disabled(button("Save new goal & edition", dialog())), false);
    if (closing === "Escape") await escape(); else await click(button(closing, dialog()));
    noDialog();
    assert.equal(document.activeElement, trigger);
    assert.equal(disabled(trigger), false);
    assert.equal(field<HTMLSelectElement>("Display goal").value, "1");
  });
}

test("applying a preview and opening history focus the edition heading and expose the exact edition state", async t => {
  const applying = deferred<Response>();
  const historical = deferred<Response>();
  const http = new HttpFixture().get(home()).post({ projectId, preview: preview() }).post(applying.promise).get(home(second)).get(historical.promise).get(home(second));
  await mount(t, http);
  await select(field<HTMLSelectElement>("Display goal"), "1");
  await click(button("Preview this change"));
  await click(button("Save new goal & edition", dialog()));
  assert.equal(disabled(button("Save new goal & edition", dialog())), true);
  assert.equal(disabled(button("Keep editing", dialog())), true);
  assert.equal(disabled(button("Close change preview", dialog())), true);
  await escape();
  assert.ok(dialog());
  const command = http.command(1);
  assert.equal(command.kind, "apply");
  if (command.kind !== "apply") throw new Error("Expected apply command");
  assert.equal(command.previewId, "preview_synthetic_dom");
  assert.equal(command.previewHash, "a".repeat(64));
  assert.equal(command.expectedEditionId, first.id);
  await resolve(applying, { projectId, editionId: second.id });
  noDialog();
  assertEditionFocus(2);
  assert.equal(field<HTMLSelectElement>("Display goal").value, "1");
  assert.equal(disabled(button("Preview this change")), true);
  assert.equal(new URL(window.location.href).searchParams.get("edition"), second.id);

  await click(button("Versions"));
  const rows = Array.from(one<HTMLElement>("[role='tabpanel']").querySelectorAll("li"));
  assert.equal(rows.length, 2);
  assert.equal(disabled(button("Open", rows[0]!)), true, "The currently open edition cannot be reopened");
  await click(button("Open", rows[1]!));
  assert.equal(disabled(one<HTMLSelectElement>("select[aria-label='Open a saved system']")), true);
  const request = http.calls.at(-1)!;
  assert.equal(request.method, "GET");
  assert.equal(request.url.searchParams.get("projectId"), projectId);
  assert.equal(request.url.searchParams.get("editionId"), first.id);
  await resolve(historical, home(first, second));
  assertEditionFocus(1, true);
  assert.equal(field<HTMLSelectElement>("Display goal").value, "2");
  assert.equal(disabled(field<HTMLSelectElement>("Display goal")), true, "A historical edition is read-only");
  assert.equal(new URL(window.location.href).searchParams.get("edition"), first.id);
  await click(button("Current edition"));
  assertEditionFocus(2);
  assert.equal(disabled(field<HTMLSelectElement>("Display goal")), false);
});

test("a read-only grant displays its one-time secret; explicit close then revoke reloads revoked access", async t => {
  const granting = deferred<Response>();
  const revoking = deferred<Response>();
  const active = [{ id: grantId, expiresAt, revokedAt: null }];
  const revoked = [{ ...active[0]!, revokedAt: at }];
  const http = new HttpFixture().get(home()).post(granting.promise).get(home(first, first, active)).post(revoking.promise).get(home(first, first, revoked));
  await mount(t, http);
  await click(button("Agent access"));
  const trigger = button("Create read-only grant");
  await click(trigger);
  await click(button("Create read-only grant", dialog()));
  assert.equal(disabled(button("Create read-only grant", dialog())), true);
  assert.equal(disabled(button("Close agent access", dialog())), true);
  await escape();
  assert.ok(dialog());
  assert.equal(http.command(0).kind, "grant");
  assert.equal((http.command(0) as Extract<PackCommand, { kind: "grant" }>).confirmedReadOnly, true);
  await resolve(granting, { projectId, editionId: first.id, grant: { id: grantId, token, expiresAt } });
  const secret = one<HTMLInputElement>("input[aria-label='One-time bearer token']", dialog());
  assert.equal(secret.value, token);
  assert.equal(secret.type, "password");
  assert.equal(secret.readOnly, true);
  assert.match(text(dialog()), /Scope: kit:verify/);
  assert.match(text(one("[role='status']")), /secret is shown once/);
  await click(button("Close agent access", dialog()));
  noDialog();
  assert.equal(document.activeElement, trigger);
  assert.equal(document.querySelector("input[aria-label='One-time bearer token']"), null);

  await click(button("Revoke"));
  assert.equal(disabled(button("Revoke")), true);
  assert.equal(disabled(button("Create read-only grant")), true);
  assert.deepEqual({ ...http.command(1), requestId: "identity" }, { kind: "revoke_grant", requestId: "identity", projectId, grantId });
  await resolve(revoking, { projectId, editionId: first.id, revoked: true });
  assert.match(text(one("[role='tabpanel']")), /Revoked/);
  assert.equal(Array.from(document.querySelectorAll("button")).some(element => text(element) === "Revoke"), false);
  assert.match(text(one("[role='status']")), /agent grant has been revoked/);
  assert.equal(disabled(button("Create read-only grant")), false);
  assert.equal(document.querySelector("input[aria-label='One-time bearer token']"), null);
});

test("an unknown grant response retries the exact command and explains an unrecoverable one-time secret", async t => {
  const firstAttempt = deferred<Response>();
  const retry = deferred<Response>();
  const active = [{ id: grantId, expiresAt, revokedAt: null }];
  const http = new HttpFixture().get(home()).post(firstAttempt.promise).post(retry.promise).get(home(first, first, active));
  await mount(t, http);
  await click(button("Agent access"));
  const trigger = button("Create read-only grant");
  await click(trigger);
  await click(button("Create read-only grant", dialog()));
  await act(async () => firstAttempt.reject(new TypeError("Synthetic response lost after dispatch")));
  assert.match(text(one("[role='alert']", dialog())), /Synthetic response lost/);
  assert.equal(disabled(button("Retry the same action", dialog())), false);
  const original = http.command(0);
  await click(button("Create read-only grant", dialog()));
  assert.equal(http.calls.filter(call => call.method === "POST").length, 1, "A fresh operation is blocked while the previous outcome is unknown");
  assert.match(text(one("[role='alert']", dialog())), /previous response is unknown/);
  await click(button("Retry the same action", dialog()));
  assert.deepEqual(http.command(1), original, "Retry retains the request ID and every authority field");
  assert.equal(dialog().querySelector("[role='alert']"), null, "The retry action is removed while its response is pending");
  assert.equal(disabled(button("Create read-only grant", dialog())), true);
  assert.equal(disabled(button("Close agent access", dialog())), true);
  await resolve(retry, { projectId, editionId: first.id, grant: { id: grantId, expiresAt } });
  assert.equal(document.querySelector("input[aria-label='One-time bearer token']"), null);
  assert.match(text(dialog()), /secret is not stored for recovery/);
  assert.match(text(one("[role='status']")), /secret cannot be recovered/);
  assert.equal(document.querySelector("[role='alert']"), null);
  await escape();
  noDialog();
  assert.equal(document.activeElement, trigger);
  assert.equal(disabled(button("Revoke")), false);
});

test("an uncertain revoke response retains the same request ID and resolves from the reloaded grant record", async t => {
  const retry = deferred<Response>();
  const active = [{ id: grantId, expiresAt, revokedAt: null }];
  const http = new HttpFixture().get(home(first, first, active)).post({ error: { message: "Synthetic revoke outcome unavailable" } }, 503).post(retry.promise).get(home(first, first, [{ ...active[0]!, revokedAt: at }]));
  await mount(t, http);
  await click(button("Agent access"));
  await click(button("Revoke"));
  assert.match(text(one("[role='alert']")), /Synthetic revoke outcome unavailable/);
  const original = http.command(0);
  await click(button("Retry the same action"));
  assert.deepEqual(http.command(1), original);
  assert.equal(document.querySelector("[role='alert']"), null, "The retry action is removed while its response is pending");
  assert.equal(disabled(button("Revoke")), true);
  await resolve(retry, { projectId, editionId: first.id, revoked: true });
  assert.equal(document.querySelector("[role='alert']"), null);
  assert.match(text(one("[role='tabpanel']")), /Revoked/);
  assert.match(text(one("[role='status']")), /agent grant has been revoked/);
  assert.equal(Array.from(document.querySelectorAll("button")).some(element => text(element) === "Revoke"), false);
});
