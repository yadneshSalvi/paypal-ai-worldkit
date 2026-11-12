import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { randomUUID, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { act, createElement, StrictMode, useCallback, useRef, useState } from "react";
import { JSDOM } from "jsdom";
import type { Certificate, Workspace } from "../packages/contracts";
import { architectures, profiles, seedKit, sources } from "../packages/device-library";
import { canonical, generateAssembly, hash, suggestRepairs, verifyKit } from "../packages/compatibility";
import { editKit } from "../packages/workbench";
import { routingState } from "../packages/soundcheck";
import { WorkbenchApplyInputSchema, type Edit, type WorkbenchApplyInput, type WorkbenchPreview, type WorkbenchReceipt } from "../packages/workbench/contracts";
import { guidedDigest, guidedScope, guidedWorkspaceKey, readGuidedPending } from "../src/components/guided-journey-client";

// Installed React, actual shared modal and Soundcheck controls. Every transport
// response is explicitly synthetic. The Web Audio boundary is controlled; these
// tests do not establish native playback, audible quality, people or equipment.
const css = readFileSync(new URL("../src/components/guided-journey.module.css", import.meta.url), "utf8");
const hook = registerHooks({ load(url, context, next) { return url.endsWith(".module.css") ? { format: "module", shortCircuit: true, source: "export default new Proxy({}, {get:(_target,name)=>String(name)});" } : next(url, context); } });
after(() => hook.deregister());
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://worldkit.test/?section=workbench", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", { configurable: true, value() { return this.closest("[hidden]") ? [] : [{ x: 0, y: 0, width: 100, height: 44 }]; } });
const { createRoot } = await import("react-dom/client"), { GuidedJourney } = await import("../src/components/guided-journey"), { Soundcheck } = await import("../src/components/soundcheck");
const expiry = "2099-01-01T00:00:00.000Z";
function workspace(owner: string = randomUUID(), kit = seedKit("T2", randomUUID())): Workspace {
  const certificate = verifyKit(kit, profiles, sources, architectures);
  return { session: { id: owner, expiresAt: expiry }, kit, certificate, profiles, sources, architectures, snapshots: [], receipts: [], events: [], completedSteps: [], assembly: generateAssembly(kit, profiles), repairOptions: suggestRepairs(kit, certificate, profiles),
    alternatives: architectures.map(template => { const alternative = { ...editKit(kit, certificate, { kind: "template", templateId: template.id }, profiles), id: `${kit.id}:${template.id}` }; return { kit: alternative, certificate: verifyKit(alternative, profiles, sources, architectures) }; }), usage: { discoveryRequests: 0, maxDiscoveryRequests: 80, liveRebuilds: 0, maxLiveRebuilds: 12 } };
}
function changed(w: Workspace, edit: Edit) {
  const draft = editKit(w.kit, w.certificate, edit, w.profiles), kit = { ...draft, id: randomUUID(), parentRevisionId: w.kit.id, revision: w.kit.revision + 1, sourceMode: "modelled" as const, createdAt: new Date().toISOString() };
  return { ...workspace(w.session.id, kit), session: { ...w.session } };
}
const head = (w: Workspace) => ({ kitId: w.kit.kitId, revisionId: w.kit.id, revision: w.kit.revision, graphHash: w.certificate.graphHash });
function evaluation(certificate: Certificate) { const { id: _id, revisionId: _rev, issuedAt: _time, sourceMode: _mode, ...rest } = certificate; return rest; }
async function preview(w: Workspace, edit: Edit): Promise<WorkbenchPreview> {
  const draft = editKit(w.kit, w.certificate, edit, w.profiles), at = new Date().toISOString();
  const before = evaluation(verifyKit(w.kit, w.profiles, w.sources, architectures, [], at)), after = evaluation(verifyKit(draft, w.profiles, w.sources, architectures, [], at));
  const content = { schema: "worldkit.workbench-preview.v1" as const, kind: "preview" as const, workspaceKey: await guidedWorkspaceKey(w), expiresAt: w.session.expiresAt, base: head(w), edit, changed: canonical(draft) !== canonical(w.kit), before, after, beforeRouting: routingState(w.kit), afterRouting: routingState(draft), changes: after.results.flatMap(result => { const old = before.results.find(r => r.requirementId === result.requirementId) ?? null; return canonical(old) === canonical(result) ? [] : [{ before: old, after: result }]; }) };
  return { ...content, evaluatedAt: at, previewHash: await guidedDigest(content) };
}
function receipt(w: Workspace, p: WorkbenchPreview, command: WorkbenchApplyInput, saved: Workspace, current = saved, replayed = false): WorkbenchReceipt {
  return { schema: "worldkit.workbench-receipt.v1", kind: "applied", requestId: command.requestId, inputHash: hash(command), previewHash: p.previewHash, workspaceKey: p.workspaceKey, expiresAt: w.session.expiresAt, base: head(w), saved: head(saved), current: head(current), savedAt: saved.kit.createdAt, replayed };
}
type Call = { method: string; path: string; body: any };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
class Transport {
  calls: Call[] = []; unexpected: string[] = [];
  queue: { method: string; path: string; answer: Response | Error | ((call: Call) => Promise<Response> | Response) }[] = [];
  add(method: string, path: string, answer: Response | Error | ((call: Call) => Promise<Response> | Response)) { this.queue.push({ method, path, answer }); }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin), call: Call = { method: init?.method ?? "GET", path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : null }; this.calls.push(call);
    const next = this.queue.shift(); if (!next || next.method !== call.method || next.path !== call.path || url.origin !== window.location.origin) { const message = `Unexpected synthetic transport ${call.method} ${call.path}`; this.unexpected.push(message); throw new Error(message); }
    assert.equal(init?.credentials, "same-origin"); assert.equal(init?.cache, "no-store"); assert.ok(init?.signal);
    if (call.body?.kind === "apply") {
      WorkbenchApplyInputSchema.parse(call.body); let found = 0;
      for (let index = 0; index < window.sessionStorage.length; index++) { const key = window.sessionStorage.key(index)!; if (!key.startsWith("worldkit.guided.pending.v1:")) continue; const value = JSON.parse(window.sessionStorage.getItem(key)!); if (value.command.requestId === call.body.requestId) { assert.deepEqual(value.command, call.body); assert.equal(value.inputHash, hash(call.body)); found++; } }
      assert.equal(found, 1, "The original exact action is retained before dispatch");
    }
    if (next.answer instanceof Error) throw next.answer; return typeof next.answer === "function" ? next.answer(call) : next.answer;
  };
  complete() { assert.deepEqual(this.unexpected, []); assert.equal(this.queue.length, 0, "All scheduled synthetic responses were consumed"); }
}
const copy = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "";
function one<T extends Element>(selector: string, parent: ParentNode = document): T { const values = parent.querySelectorAll<T>(selector); assert.equal(values.length, 1, `Expected one ${selector}, got ${values.length}`); return values[0]!; }
function button(label: string, parent: ParentNode = document): HTMLButtonElement { const values = [...parent.querySelectorAll<HTMLButtonElement>("button")].filter(value => (value.getAttribute("aria-label") ?? copy(value)) === label); assert.equal(values.length, 1, `Expected button ${label}, got ${values.length}`); return values[0]!; }
const dialog = () => one<HTMLElement>("[role=dialog]");
const selectedTab = (index: number) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')][index]!;
async function waitFor(check: () => boolean, message = "Expected mounted state") { for (let i = 0; i < 50; i++) { if (check()) return; await act(async () => { await delay(10); }); } assert.ok(check(), message); }
async function click(element: HTMLElement) { assert.equal(element.matches(":disabled"), false, `Cannot click disabled ${copy(element)}`); await act(async () => { element.focus(); element.click(); await delay(5); }); }
async function key(element: HTMLElement, value: string, shiftKey = false) { await act(async () => { element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); await delay(2); }); }
const applyCalls = (http: Transport) => http.calls.filter(call => call.body?.kind === "apply");
async function mount(t: TestContext, http: Transport, first = workspace(), strict = false) {
  window.sessionStorage.clear(); document.body.innerHTML = '<button id="outside">Outside workbench control</button><div id="root"></div>'; const style = document.createElement("style"); style.textContent = css; document.head.append(style);
  const originalFetch = globalThis.fetch; globalThis.fetch = http.fetch; let current = first, replace: (next: Workspace) => void = () => {}, section = "workbench", locks: boolean[] = [], inspected: string[] = [];
  function Host({ initial }: { initial: Workspace }) {
    const [w, setW] = useState(initial), [activeSection, setSection] = useState("workbench"), ref = useRef(w); ref.current = w; current = w; replace = setW;
    const accept = useCallback((next: Workspace) => { if (guidedScope(next) !== guidedScope(ref.current) || next.kit.revision < ref.current.kit.revision) return false; ref.current = next; setW(next); return true; }, []);
    const busy = useCallback((value: boolean) => { locks.push(value); }, []);
    return createElement(GuidedJourney, { key: guidedScope(w), workspace: w, activeSection, onWorkspace: accept, onBusy: busy, onNavigate: value => { section = value; setSection(value); }, onInspect: value => inspected.push(value) });
  }
  let root = createRoot(document.getElementById("root")!);
  const render = (initial: Workspace) => strict ? createElement(StrictMode, null, createElement(Host, { initial })) : createElement(Host, { initial });
  await act(async () => { root.render(render(first)); await delay(5); });
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; style.remove(); window.sessionStorage.clear(); document.body.innerHTML = ""; http.complete(); });
  return { get current() { return current; }, get section() { return section; }, locks, inspected,
    async set(next: Workspace) { await act(async () => { replace(next); await delay(5); }); },
    async remount(next = current) { await act(async () => root.unmount()); document.getElementById("root")!.replaceChildren(); root = createRoot(document.getElementById("root")!); await act(async () => { root.render(render(next)); await delay(5); }); },
  };
}
async function openChange(http: Transport, w: Workspace) {
  await click(button("Guide me")); await click(selectedTab(1)); const p = await preview(w, { kind: "microphone", componentId: "mic-2", profileId: "at2020-xlr" }); http.add("POST", "/api/workbench", response(p)); await click(button("Preview a condenser")); await waitFor(() => !!document.querySelector("[role=dialog]")); return p;
}
async function approve() { await click(one<HTMLInputElement>('input[type="checkbox"]', dialog())); assert.equal(button("Save this edition", dialog()).disabled, false); }

test("mount, StrictMode, guide navigation and close are inert; keyboard tabs and heading focus work", async t => {
  const http = new Transport(); await mount(t, http, workspace(), true); assert.equal(http.calls.length, 0); await click(button("Guide me")); assert.equal(document.activeElement?.tagName, "H2");
  selectedTab(0).focus(); await key(selectedTab(0), "ArrowRight"); assert.equal(document.activeElement, selectedTab(1)); assert.equal(selectedTab(1).getAttribute("aria-selected"), "true"); await key(selectedTab(1), "End"); assert.equal(document.activeElement, selectedTab(5)); await key(selectedTab(5), "Home"); assert.equal(document.activeElement, selectedTab(0));
  await click(button("Close guided journey")); assert.equal(document.activeElement, button("Guide me")); assert.equal(http.calls.length, 0);
});
test("the complete mounted condenser conflict and repair use exact preview consent and retain the hub unknown", async t => {
  const http = new Transport(), initial = workspace(), ui = await mount(t, http, initial), p = await openChange(http, initial);
  assert.equal(ui.current.kit.id, initial.kit.id); assert.equal(button("Save this edition", dialog()).disabled, true); assert.match(copy(dialog()), /AT2020 needs phantom power/); assert.ok(dialog().querySelectorAll('a[target="_blank"]').length >= 2); assert.equal(applyCalls(http).length, 0);
  await approve(); const broken = changed(initial, p.edit); http.add("POST", "/api/workbench", call => response(receipt(initial, p, call.body, broken))); http.add("GET", "/api/workspace", response(broken)); await click(button("Save this edition", dialog())); await waitFor(() => ui.current.kit.id === broken.kit.id && !document.querySelector("[role=dialog]"));
  assert.match(copy(document.activeElement!), /Repair the reason/); assert.equal(ui.current.certificate.results.find(r => r.requirementId === "R4")?.status, "violated"); assert.equal(readGuidedPending(window.sessionStorage, initial), null);
  const repair = await preview(broken, { kind: "repair", repairId: "phantom" }); http.add("POST", "/api/workbench", response(repair)); const card = [...document.querySelectorAll("article")].find(article => copy(article).includes("Use the recorder’s documented 48 V mode"))!; assert.ok(card); await click(button("Preview this repair", card)); await waitFor(() => !!document.querySelector("[role=dialog]"));
  assert.equal(one<HTMLInputElement>('input[type="checkbox"]').checked, false); assert.match(copy(dialog()), /Finish the hub’s power budget/); assert.match(copy(dialog()), /Source the exact power supply/); await approve();
  const fixed = changed(broken, repair.edit); http.add("POST", "/api/workbench", call => response(receipt(broken, repair, call.body, fixed))); http.add("GET", "/api/workspace", response(fixed)); await click(button("Save this edition", dialog())); await waitFor(() => ui.current.kit.id === fixed.kit.id && !document.querySelector("[role=dialog]"));
  assert.equal(applyCalls(http).length, 2); assert.equal(ui.current.certificate.results.find(r => r.requirementId === "R4")?.status, "unknown"); assert.equal(ui.current.certificate.physicalTest, "not_performed"); assert.ok(ui.current.certificate.counts.unknown > 0); assert.match(document.body.textContent ?? "", /0 conflicts and 4 evidence questions/); assert.equal(document.activeElement?.tagName, "H2");
});
test("Escape discards only an unsaved preview and restores its actual trigger", async t => {
  const http = new Transport(), w = workspace(), ui = await mount(t, http, w); await openChange(http, w); await approve(); await key(one<HTMLElement>("[role=dialog]"), "Escape"); assert.equal(document.querySelector("[role=dialog]"), null); assert.equal(document.activeElement, button("Preview a condenser")); assert.equal(ui.current.kit.id, w.kit.id); assert.equal(applyCalls(http).length, 0);
});
test("a new graph invalidates checked preview consent and does not send a stale save", async t => {
  const http = new Transport(), w = workspace(), ui = await mount(t, http, w); await openChange(http, w); await approve(); const newer = changed(w, { kind: "connection", connectionId: "mic2-audio", enabled: false }); await ui.set(newer); assert.equal(document.querySelector("[role=dialog]"), null); assert.equal(applyCalls(http).length, 0); assert.equal(readGuidedPending(window.sessionStorage, newer), null);
});
test("a genuinely pending read cannot open its old preview over a foreign workspace", async t => {
  const http = new Transport(), a = workspace(), b = workspace(), ui = await mount(t, http, a); await click(button("Guide me")); await click(selectedTab(1)); const p = await preview(a, { kind: "microphone", componentId: "mic-2", profileId: "at2020-xlr" }); let release!: (value: Response) => void; const waiting = new Promise<Response>(resolve => { release = resolve; }); http.add("POST", "/api/workbench", () => waiting); await click(button("Preview a condenser")); assert.equal(http.calls.length, 1); await ui.set(b); await act(async () => { release(response(p)); await delay(10); }); assert.equal(document.querySelector("[role=dialog]"), null); assert.equal(ui.current.session.id, b.session.id); assert.equal(applyCalls(http).length, 0);
});
test("lost save answers survive remount and recover only the same UUID/body on an explicit click", async t => {
  const http = new Transport(), w = workspace(), ui = await mount(t, http, w), p = await openChange(http, w); await approve(); http.add("POST", "/api/workbench", new Error("Synthetic lost response after hypothetical commit")); await click(button("Save this edition", dialog())); await waitFor(() => applyCalls(http).length === 1 && !button("Recover original save").disabled); const command = structuredClone(applyCalls(http)[0]!.body); const pending = readGuidedPending(window.sessionStorage, w); assert.ok(pending); assert.deepEqual(pending.command, command);
  await ui.remount(w); assert.equal(applyCalls(http).length, 1); const saved = changed(w, p.edit); http.add("POST", "/api/workbench", call => { assert.deepEqual(call.body, command); return response(receipt(w, p, call.body, saved, saved, true)); }); http.add("GET", "/api/workspace", response(saved)); await click(button("Recover original save")); await waitFor(() => ui.current.kit.id === saved.kit.id && readGuidedPending(window.sessionStorage, w) === null); assert.equal(applyCalls(http).length, 2); assert.equal(document.activeElement?.tagName, "H2");
});
test("a late unknown answer after foreign remount retains A's journal without sending into B", async t => {
  const http = new Transport(), a = workspace(), b = workspace(), ui = await mount(t, http, a); await openChange(http, a); await approve(); let fail!: (error: Error) => void; const waiting = new Promise<Response>((_resolve, reject) => { fail = reject; }); http.add("POST", "/api/workbench", () => waiting); await click(button("Save this edition", dialog())); await waitFor(() => applyCalls(http).length === 1); const original = readGuidedPending(window.sessionStorage, a); assert.ok(original);
  await ui.set(b); await act(async () => { fail(new Error("Synthetic original response lost")); await delay(5); }); assert.equal(ui.current.session.id, b.session.id); assert.equal(readGuidedPending(window.sessionStorage, b), null); assert.deepEqual(readGuidedPending(window.sessionStorage, a), original); assert.equal(http.calls.length, 2); assert.doesNotMatch(document.body.textContent ?? "", /Recover original save/);
});
test("an acknowledged save with a failed current read recovers through GET only", async t => {
  const http = new Transport(), w = workspace(), ui = await mount(t, http, w), p = await openChange(http, w), saved = changed(w, p.edit); await approve(); http.add("POST", "/api/workbench", call => response(receipt(w, p, call.body, saved))); http.add("GET", "/api/workspace", new Error("Synthetic failed read after known acknowledgement")); await click(button("Save this edition", dialog())); await waitFor(() => !!readGuidedPending(window.sessionStorage, w)?.receipt && !button("Read acknowledged save").disabled); await ui.remount(w); http.add("GET", "/api/workspace", response(saved)); await click(button("Read acknowledged save")); await waitFor(() => readGuidedPending(window.sessionStorage, w) === null); assert.equal(applyCalls(http).length, 1); assert.equal(ui.current.kit.id, saved.kit.id);
});
test("malformed acknowledgement keeps the original request and never reports a saved edition", async t => {
  const http = new Transport(), w = workspace(); await mount(t, http, w); const p = await openChange(http, w); await approve(); const saved = changed(w, p.edit); http.add("POST", "/api/workbench", call => response({ ...receipt(w, p, call.body, saved), inputHash: "f".repeat(64) })); await click(button("Save this edition", dialog())); await waitFor(() => !!readGuidedPending(window.sessionStorage, w) && !button("Recover original save").disabled); assert.equal(readGuidedPending(window.sessionStorage, w)?.receipt, null); assert.doesNotMatch(document.body.textContent ?? "", /Revision 2 saved and checked/); assert.equal(http.calls.length, 2);
});
test("a known refusal is retained until deliberately dismissed and does not trigger a replacement request", async t => {
  const http = new Transport(), w = workspace(); await mount(t, http, w); await openChange(http, w); await approve(); http.add("POST", "/api/workbench", response({ error: { code: "stale_revision", message: "Synthetic evidence changed; review a fresh preview." } }, 409)); await click(button("Save this edition", dialog())); await waitFor(() => !!readGuidedPending(window.sessionStorage, w)?.refusal && !button("Dismiss refused request").disabled); await key(dialog(), "Escape"); await click(button("Dismiss refused request")); assert.equal(readGuidedPending(window.sessionStorage, w), null); assert.equal(applyCalls(http).length, 1); assert.match(document.body.textContent ?? "", /refused request is closed/);
});
test("storage refusal prevents a save before any mutating transport", async t => {
  const http = new Transport(), w = workspace(); await mount(t, http, w); await openChange(http, w); await approve(); const original = dom.window.Storage.prototype.setItem;
  dom.window.Storage.prototype.setItem = function (key, value) { if (key.startsWith("worldkit.guided.pending.v1:")) throw new Error("Synthetic storage refusal before dispatch"); return original.call(this, key, value); };
  try { await click(button("Save this edition", dialog())); await waitFor(() => (document.body.textContent ?? "").includes("Synthetic storage refusal")); assert.equal(applyCalls(http).length, 0); assert.equal(readGuidedPending(window.sessionStorage, w), null); }
  finally { dom.window.Storage.prototype.setItem = original; }
});
test("two synchronous Save clicks retain and dispatch only one exact request", async t => {
  const http = new Transport(), w = workspace(), ui = await mount(t, http, w), p = await openChange(http, w), saved = changed(w, p.edit); await approve(); let release!: (value: Response) => void; let sent: WorkbenchApplyInput | null = null;
  http.add("POST", "/api/workbench", call => { sent = call.body; return new Promise<Response>(resolve => { release = resolve; }); }); http.add("GET", "/api/workspace", response(saved));
  const save = button("Save this edition"); await act(async () => { save.click(); save.click(); await delay(5); }); await waitFor(() => !!sent); assert.equal(applyCalls(http).length, 1); assert.equal(button("Keep the current edition").disabled, true);
  await act(async () => { release(response(receipt(w, p, sent!, saved))); await delay(10); }); await waitFor(() => ui.current.kit.id === saved.kit.id && readGuidedPending(window.sessionStorage, w) === null); assert.equal(applyCalls(http).length, 1);
});
test("a tampered retained body is held before recovery transport rather than silently replaced", async t => {
  const http = new Transport(), w = workspace(), ui = await mount(t, http, w); await openChange(http, w); await approve(); http.add("POST", "/api/workbench", new Error("Synthetic original answer unavailable")); await click(button("Save this edition")); await waitFor(() => !button("Recover original save").disabled);
  const storageKey = [...Array(window.sessionStorage.length)].map((_, i) => window.sessionStorage.key(i)!).find(key => key.startsWith("worldkit.guided.pending.v1:"))!; const record = JSON.parse(window.sessionStorage.getItem(storageKey)!); record.command.edit = { kind: "connection", connectionId: "mic2-audio", enabled: false }; window.sessionStorage.setItem(storageKey, JSON.stringify(record));
  await ui.remount(w); await click(button("Recover original save")); await waitFor(() => (document.body.textContent ?? "").includes("browser action fingerprint changed")); assert.equal(applyCalls(http).length, 1); assert.equal(readGuidedPending(window.sessionStorage, w)?.command.requestId, record.command.requestId);
});
test("an old current-plan read cannot overwrite a newer edition accepted while it was pending", async t => {
  const http = new Transport(), w = workspace(), ui = await mount(t, http, w), p = await openChange(http, w), saved = changed(w, p.edit), newer = changed(saved, { kind: "repair", repairId: "phantom" }); await approve(); let release!: (value: Response) => void;
  http.add("POST", "/api/workbench", call => response(receipt(w, p, call.body, saved))); http.add("GET", "/api/workspace", () => new Promise<Response>(resolve => { release = resolve; })); await click(button("Save this edition")); await waitFor(() => !!release); await ui.set(newer); await act(async () => { release(response(saved)); await delay(10); });
  assert.equal(ui.current.kit.id, newer.kit.id); assert.ok(readGuidedPending(window.sessionStorage, w)?.receipt); assert.equal(applyCalls(http).length, 1); await waitFor(() => !button("Read acknowledged save").disabled); http.add("GET", "/api/workspace", response(newer)); await click(button("Read acknowledged save")); await waitFor(() => readGuidedPending(window.sessionStorage, w) === null); assert.equal(ui.current.kit.id, newer.kit.id); assert.equal(applyCalls(http).length, 1);
});
test("the original fixed expiry closes preview consent and prevents a late save without renewal", async t => {
  const http = new Transport(), w = workspace(); w.session.expiresAt = new Date(Date.now() + 500).toISOString(); await mount(t, http, w); await openChange(http, w); await approve(); await act(async () => { await delay(1020); }); assert.equal(document.querySelector("[role=dialog]"), null); assert.match(document.body.textContent ?? "", /This workspace has expired/); assert.equal(button("Refresh guided saved plan").disabled, true); assert.equal(applyCalls(http).length, 0); assert.equal(http.calls.length, 1);
});
test("a late-expiry response is unknown rather than a false refused-save claim", async t => {
  const http = new Transport(), w = workspace(); await mount(t, http, w); await openChange(http, w); await approve(); http.add("POST", "/api/workbench", response({ error: { code: "forbidden", message: "The original workspace expired before the answer was ready." } }, 410)); await click(button("Save this edition")); await waitFor(() => !button("Recover original save").disabled); assert.equal(readGuidedPending(window.sessionStorage, w)?.refusal, null); assert.doesNotMatch(document.body.textContent ?? "", /This change was refused/); assert.equal(applyCalls(http).length, 1);
});
test("checked consent is cleared by an explicit refresh even when the saved edition is unchanged", async t => {
  const http = new Transport(), w = workspace(); await mount(t, http, w); await openChange(http, w); await approve(); await key(dialog(), "Escape"); http.add("GET", "/api/workspace", response(w)); await click(button("Refresh guided saved plan")); await waitFor(() => !button("Refresh guided saved plan").disabled); const p = await preview(w, { kind: "microphone", componentId: "mic-2", profileId: "at2020-xlr" }); http.add("POST", "/api/workbench", response(p)); await click(button("Preview a condenser")); await waitFor(() => !!document.querySelector("[role=dialog]")); assert.equal(one<HTMLInputElement>('input[type="checkbox"]').checked, false); assert.equal(button("Save this edition").disabled, true); assert.equal(applyCalls(http).length, 0);
});
test("a later current revision is retained when recovering an older acknowledged save", async t => {
  const http = new Transport(), w = workspace(), ui = await mount(t, http, w), p = await openChange(http, w), saved = changed(w, p.edit), newer = changed(saved, { kind: "repair", repairId: "phantom" }); await approve(); http.add("POST", "/api/workbench", call => response(receipt(w, p, call.body, saved, newer, true))); http.add("GET", "/api/workspace", response(newer)); await click(button("Save this edition", dialog())); await waitFor(() => ui.current.kit.id === newer.kit.id && !document.querySelector("[role=dialog]")); assert.match(document.body.textContent ?? "", /current plan is already revision 3; it was preserved/); assert.equal(applyCalls(http).length, 1);
});
test("confirmed equipment is not offered as the guide's replacement or dynamic-mic repair", async t => {
  const http = new Transport(), initial = workspace(), candidate = changed(initial, { kind: "microphone", componentId: "mic-2", profileId: "at2020-xlr" }); const component = candidate.kit.components.find(c => c.id === "mic-2")!; component.ownershipSource = "user_confirmed"; component.inventoryItemId = "synthetic-confirmed-identity"; candidate.certificate = verifyKit(candidate.kit, candidate.profiles, candidate.sources, architectures); candidate.repairOptions = suggestRepairs(candidate.kit, candidate.certificate, candidate.profiles);
  await mount(t, http, candidate); await click(button("Guide me")); await click(selectedTab(1)); assert.doesNotMatch(document.body.textContent ?? "", /Preview a condenser/); assert.match(document.body.textContent ?? "", /guide will not replace/); await click(selectedTab(2)); const card = [...document.querySelectorAll("article")].find(article => copy(article).includes("confirmed equipment identity"))!; assert.ok(card); assert.equal(button("Preview this repair", card).disabled, true); assert.equal(http.calls.length, 0);
});
test("the comparison, cart, Studio, Living kit and evidence handoffs navigate without starting provider work", async t => {
  const http = new Transport(), ui = await mount(t, http); await click(button("Guide me")); await click(selectedTab(3)); assert.equal(document.querySelectorAll("article").length, 4); await click(button("Compare complete systems")); assert.equal(ui.section, "compare"); await click(selectedTab(4)); for (const [label, section] of [["Open Cart lab", "cart"], ["Open Studio", "studio"], ["Open Living kit", "living"]]) { await click(button(label!)); assert.equal(ui.section, section); }
  await click(selectedTab(5)); assert.equal(one<HTMLAnchorElement>('a[href="/bench"]').textContent?.includes("Test notebook"), true); assert.equal(one<HTMLAnchorElement>('a[href="/research"]').textContent?.includes("Research notebook"), true); await click(button("Open the setup guide")); assert.equal(ui.section, "assembly"); await click(button("Follow the source evidence")); assert.equal(ui.section, "evidence"); assert.equal(http.calls.length, 0);
});
class FakeAudioContext {
  static instances: FakeAudioContext[] = []; static resumeAnswer: (() => Promise<void>) | null = null; static failBuffer = false;
  state = "suspended"; currentTime = 0; destination = {}; stopped = 0; closed = 0;
  constructor() { FakeAudioContext.instances.push(this); }
  createGain() { return { gain: { value: 0, setTargetAtTime() {} }, connect() {} }; }
  createBuffer() { if (FakeAudioContext.failBuffer) throw new Error("Synthetic browser buffer allocation refusal"); return { copyToChannel() {} }; }
  createBufferSource() { return { buffer: null, loop: false, connect() {}, start() {}, stop: () => { this.stopped++; } }; }
  createAnalyser() { return { fftSize: 1024, connect() {}, getFloatTimeDomainData: (array: Float32Array) => array.fill(.02) }; }
  async resume() { await FakeAudioContext.resumeAnswer?.(); if (this.state !== "closed") this.state = "running"; }
  async close() { this.closed++; this.state = "closed"; }
}
function fakeAudio(t: TestContext) { FakeAudioContext.instances = []; FakeAudioContext.resumeAnswer = null; FakeAudioContext.failBuffer = false; const old = Object.getOwnPropertyDescriptor(globalThis, "AudioContext"); Object.defineProperty(globalThis, "AudioContext", { configurable: true, writable: true, value: FakeAudioContext }); t.after(() => { if (old) Object.defineProperty(globalThis, "AudioContext", old); else delete (globalThis as any).AudioContext; }); }
test("audio opens silently, starts only on Play and reports browser start rather than physical success", async t => {
  fakeAudio(t); const http = new Transport(); await mount(t, http); await click(button("Guide me")); await click(button("Open soundcheck")); assert.equal(FakeAudioContext.instances.length, 0); await click(button("Play soundcheck")); await waitFor(() => [...document.querySelectorAll("button")].some(e => copy(e) === "Pause soundcheck")); assert.equal(FakeAudioContext.instances.length, 1); assert.equal(FakeAudioContext.instances[0]!.state, "running"); await click(button("Close soundcheck")); assert.equal(FakeAudioContext.instances[0]!.closed, 1); assert.equal(FakeAudioContext.instances[0]!.stopped, 3); assert.match(document.body.textContent ?? "", /Browser playback started.*not a hardware or listening-quality result/); assert.equal(http.calls.length, 0);
});
test("duplicate Play while resume is pending creates one audio session and a closed dialog cannot report late playback", async t => {
  fakeAudio(t); const http = new Transport(); await mount(t, http); await click(button("Guide me")); await click(button("Open soundcheck")); let release!: () => void; FakeAudioContext.resumeAnswer = () => new Promise<void>(resolve => { release = resolve; }); const play = button("Play soundcheck"); await act(async () => { play.click(); play.click(); await delay(2); }); assert.equal(FakeAudioContext.instances.length, 1); assert.equal(button("Preparing audio…").disabled, true); await click(button("Close soundcheck")); await act(async () => { release(); await delay(5); }); assert.equal(FakeAudioContext.instances[0]!.closed, 1); assert.doesNotMatch(document.body.textContent ?? "", /Browser playback started/); assert.equal(http.calls.length, 0);
});
test("a refused browser resume leaves no success claim and closes the failed audio resources", async t => {
  fakeAudio(t); FakeAudioContext.resumeAnswer = async () => { throw new Error("Synthetic permission refusal"); }; const http = new Transport(); await mount(t, http); await click(button("Guide me")); await click(button("Open soundcheck")); await click(button("Play soundcheck")); await waitFor(() => (document.body.textContent ?? "").includes("Audio could not start")); assert.equal(FakeAudioContext.instances[0]!.closed, 1); assert.doesNotMatch(document.body.textContent ?? "", /Browser playback started/); assert.equal(button("Play soundcheck").disabled, false);
});
test("a refused browser buffer allocation closes the partly constructed audio context", async t => {
  fakeAudio(t); FakeAudioContext.failBuffer = true; const http = new Transport(); await mount(t, http); await click(button("Guide me")); await click(button("Open soundcheck")); await click(button("Play soundcheck"));
  await waitFor(() => (document.body.textContent ?? "").includes("Audio could not start")); assert.equal(FakeAudioContext.instances.length, 1); assert.equal(FakeAudioContext.instances[0]!.closed, 1); assert.doesNotMatch(document.body.textContent ?? "", /Browser playback started/); assert.equal(button("Play soundcheck").disabled, false);
});
test("a changed graph closes pending audio and never credits its late start to the new revision", async t => {
  fakeAudio(t); const http = new Transport(), w = workspace(), ui = await mount(t, http, w); await click(button("Guide me")); await click(button("Open soundcheck")); let release!: () => void; FakeAudioContext.resumeAnswer = () => new Promise<void>(resolve => { release = resolve; });
  await click(button("Play soundcheck")); await waitFor(() => !!release); const next = changed(w, { kind: "connection", connectionId: "mic2-audio", enabled: false }); await ui.set(next); await act(async () => { release(); await delay(5); });
  assert.equal(ui.current.kit.id, next.kit.id); assert.equal(FakeAudioContext.instances[0]!.closed, 1); assert.doesNotMatch(document.body.textContent ?? "", /Browser playback started/); assert.equal(http.calls.length, 0);
});
test("the new component references only defined CSS module classes", () => {
  const files = ["guided-journey.tsx", "guided-journey-views.tsx"], names = new Set<string>();
  for (const file of files) for (const match of readFileSync(new URL(`../src/components/${file}`, import.meta.url), "utf8").matchAll(/styles\.([A-Za-z][A-Za-z0-9]*)/g)) names.add(match[1]!);
  const defined = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9]*)/g)].map(match => match[1])); assert.deepEqual([...names].filter(name => !defined.has(name)), []); assert.ok(names.size > 45); assert.match(css, /prefers-reduced-motion/);
});
