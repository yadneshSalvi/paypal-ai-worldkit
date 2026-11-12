import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { act, createElement, StrictMode } from "react";
import { JSDOM } from "jsdom";
import { architectures, profiles, sources, seedKit } from "../packages/device-library";
import { generateAssembly, verifyKit } from "../packages/compatibility";
import type { Workspace } from "../packages/contracts";
import { ADMISSION_STORAGE_KEY, type AdmissionJournal } from "../packages/workspace-entry";
import { newAdmissionJournal, readAdmissionJournal, writeAdmissionJournal } from "../src/components/workspace-entry-client";

// Installed React controls only; all transport/workspace evidence is synthetic.
const cssHook = registerHooks({ load(url, context, next) { if (url.endsWith(".module.css")) return { format: "module", shortCircuit: true, source: "export default new Proxy({}, {get: (_, name) => String(name)});" }; return next(url, context); } });
after(() => cssHook.deregister());
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://worldkit.test/", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { WorkspaceEntry } = await import("../src/components/workspace-entry");
const originalFetch = globalThis.fetch;
function workspace(id = "synthetic-original") : Workspace {
  const kit = seedKit("T2", `${id}-revision`), certificate = verifyKit(kit, profiles, sources, architectures);
  return { session: { id, expiresAt: "2099-01-01T00:00:00.000Z" }, kit, certificate, profiles, sources, architectures, alternatives: [], snapshots: [], receipts: [], events: [], assembly: generateAssembly(kit, profiles), completedSteps: [], repairOptions: [], usage: { discoveryRequests: 0, maxDiscoveryRequests: 80, liveRebuilds: 0, maxLiveRebuilds: 12 } };
}
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers });
const absent = () => json({ error: { message: "Synthetic no current workspace" } }, 401);
function acknowledgement(body: any, value = workspace(), disposition = "created") { return json(value, disposition === "created" ? 201 : 200, { "X-WorldKit-Admission": disposition, "X-WorldKit-Admission-Request": body.requestId }); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class Transport {
  calls: { method: string; body: any }[] = []; reads: (() => Response | Promise<Response>)[] = []; writes: ((body: any) => Response | Promise<Response>)[] = [];
  fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "/api/workspace"); const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, body }); if (method === "GET") return (this.reads.shift() ?? absent)();
    assert.equal(method, "POST"); const next = this.writes.shift(); assert.ok(next, "No undeclared write is permitted."); return next(body);
  };
  posts() { return this.calls.filter(call => call.method === "POST"); }
}
function button(label: string) { const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label); assert.ok(value, `Expected button ${label}`); return value; }
async function click(label: string) { await act(async () => button(label).click()); }
async function mount(t: TestContext, http: Transport, { preserve = false, strict = false }: { preserve?: boolean; strict?: boolean } = {}) {
  if (!preserve) window.sessionStorage.clear(); document.body.innerHTML = "<div id='test-root'></div>";
  const opened: Workspace[] = []; globalThis.fetch = http.fetch as typeof fetch;
  const root = createRoot(document.getElementById("test-root")!); let live = true;
  const element = createElement(WorkspaceEntry, { brand: createElement("span", null, "worldkit"), onOpen: (value: Workspace) => opened.push(value) });
  await act(async () => root.render(strict ? createElement(StrictMode, null, element) : element));
  const unmount = async () => { if (live) { live = false; await act(async () => root.unmount()); } };
  t.after(async () => { await unmount(); globalThis.fetch = originalFetch; }); return { opened, unmount };
}
function journal() { return readAdmissionJournal(window.sessionStorage, window.location.origin)!; }

test("passive initial visits, StrictMode effects and read retries never admit a Sample", async t => {
  const http = new Transport(); await mount(t, http, { strict: true }); assert.ok(button("Start Sample")); assert.equal(http.posts().length, 0);
  await click("Check saved workbench"); assert.equal(http.posts().length, 0); assert.equal(window.sessionStorage.getItem(ADMISSION_STORAGE_KEY), null);
});
test("one deliberate double click sends one durable acknowledged request, then clears only that journal", async t => {
  const http = new Transport(), gate = deferred<Response>(); http.writes.push(() => gate.promise); const view = await mount(t, http);
  await act(async () => { const start = button("Start Sample"); start.click(); start.click(); }); assert.equal(http.posts().length, 1);
  const saved = journal(), body = http.posts()[0]!.body; assert.equal(body.kind, "start_sample"); assert.equal(body.acknowledgedSample, true); assert.equal(saved.command.requestId, body.requestId); assert.match(body.recoveryKey, /^[a-f0-9]{64}$/); assert.ok(!document.body.textContent!.includes(body.recoveryKey));
  await act(async () => gate.resolve(acknowledgement(body))); assert.equal(view.opened.length, 1); assert.equal(window.sessionStorage.getItem(ADMISSION_STORAGE_KEY), null);
});
test("a lost answer survives remount without POST and explicitly recovers the exact original body", async t => {
  const first = new Transport(); first.writes.push(() => { throw new Error("Synthetic lost response"); }); const a = await mount(t, first); await click("Start Sample"); const original = JSON.stringify(journal()); await a.unmount();
  const second = new Transport(); second.writes.push(body => acknowledgement(body, workspace(), "recovered")); const b = await mount(t, second, { preserve: true }); assert.equal(second.posts().length, 0); assert.equal(JSON.stringify(journal()), original);
  await click("Recover this Sample"); assert.equal(JSON.stringify(second.posts()[0]!.body), JSON.stringify(first.posts()[0]!.body)); assert.equal(b.opened.length, 1);
});
test("a malformed success acknowledgement retains the original request and never opens its DTO", async t => {
  const http = new Transport(); http.writes.push(() => json(workspace(), 201)); const view = await mount(t, http); await click("Start Sample"); assert.equal(view.opened.length, 0); assert.ok(journal()); assert.ok(button("Recover this Sample")); assert.match(document.body.textContent!, /could not be matched/);
});
test("a complete acknowledgement with an incomplete workspace cannot clear recovery", async t => {
  const http = new Transport(); http.writes.push(body => json({ session: workspace().session }, 201, { "X-WorldKit-Admission": "created", "X-WorldKit-Admission-Request": body.requestId })); const view = await mount(t, http); await click("Start Sample"); assert.equal(view.opened.length, 0); assert.ok(journal());
});
test("storage failure before dispatch holds the action with zero POST", async t => {
  const http = new Transport(); await mount(t, http); const old = dom.window.Storage.prototype.setItem; dom.window.Storage.prototype.setItem = () => { throw new Error("Synthetic quota failure"); }; t.after(() => { dom.window.Storage.prototype.setItem = old; });
  await click("Start Sample"); assert.equal(http.posts().length, 0); assert.match(document.body.textContent!, /quota failure/); assert.ok(button("Check saved workbench"));
});
test("malformed or foreign-origin journals hold new admission while allowing read-only recovery", async t => {
  const http = new Transport(); window.sessionStorage.setItem(ADMISSION_STORAGE_KEY, JSON.stringify({ ...newAdmissionJournal("https://foreign.invalid") })); await mount(t, http, { preserve: true }); assert.equal(http.posts().length, 0); assert.equal([...document.querySelectorAll("button")].some(b => b.textContent === "Start Sample"), false); await click("Check saved workbench"); assert.equal(http.posts().length, 0);
});
test("an unavailable initial read cannot be converted into a new workspace", async t => {
  const http = new Transport(); http.reads.push(() => json({ error: { message: "Synthetic temporary read outage" } }, 503)); await mount(t, http); assert.equal(http.posts().length, 0); assert.ok(![...document.querySelectorAll("button")].some(b => b.textContent?.trim() === "Start Sample"));
  await click("Check saved workbench"); assert.ok(button("Start Sample")); assert.equal(http.posts().length, 0);
});
test("an existing saved workspace is opened byte-for-byte with only GET", async t => {
  const original = workspace("synthetic-preserved"); original.usage.discoveryRequests = 7; const http = new Transport(); http.reads.push(() => json(original)); const view = await mount(t, http); assert.equal(JSON.stringify(view.opened[0]), JSON.stringify(original)); assert.equal(http.posts().length, 0);
});
test("late acknowledgement after unmount cannot overwrite a different current workspace", async t => {
  const late = deferred<Response>(), first = new Transport(); first.writes.push(() => late.promise); const a = await mount(t, first); await click("Start Sample"); const original = journal(), body = first.posts()[0]!.body; await a.unmount();
  const second = new Transport(); second.reads.push(() => json(workspace("synthetic-other"))); const b = await mount(t, second, { preserve: true }); await act(async () => late.resolve(acknowledgement(body))); assert.equal(a.opened.length, 0); assert.equal(b.opened[0]!.session.id, "synthetic-other"); assert.equal(JSON.stringify(journal()), JSON.stringify(original)); assert.equal(second.posts().length, 0);
});
test("expired original recovery offers a separate explicit action without automatic renewal", async t => {
  const http = new Transport(); http.writes.push(() => json({ error: { message: "Synthetic original expired" } }, 410), body => acknowledgement(body, workspace("synthetic-new")));
  const pending = newAdmissionJournal(window.location.origin); writeAdmissionJournal(window.sessionStorage, pending); const view = await mount(t, http, { preserve: true }); assert.equal(http.posts().length, 0);
  await click("Recover this Sample"); assert.equal(http.posts().length, 1); assert.equal(journal().command.requestId, pending.command.requestId); assert.ok(button("Start another Sample"));
  await click("Start another Sample"); assert.equal(http.posts().length, 2); assert.notEqual(http.posts()[1]!.body.requestId, pending.command.requestId); assert.equal(view.opened[0]!.session.id, "synthetic-new");
});
test("when a lost response already set its cookie, checking saved workbench only reads and preserves the original journal", async t => {
  const http = new Transport(); http.writes.push(() => { throw new Error("Synthetic lost body after cookie"); }); const view = await mount(t, http); await click("Start Sample"); const original = JSON.stringify(journal()); http.reads.push(() => json(workspace("synthetic-cookie-already-set"))); await click("Check saved workbench"); assert.equal(http.posts().length, 1); assert.equal(view.opened[0]!.session.id, "synthetic-cookie-already-set"); assert.equal(JSON.stringify(journal()), original);
});
