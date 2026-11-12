import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { act, createElement, StrictMode } from "react";
import { JSDOM } from "jsdom";
import { BENCH_POLICY, BENCH_SCHEMA, BenchCommandSchema, BenchRedeemSchema, type BenchAsset, type BenchBinding, type BenchCommand, type BenchDecision, type BenchDetail, type BenchEdition, type BenchGrant, type BenchHome, type BenchObservation, type BenchUpload } from "../packages/physical-notebook/contracts";
import { assessBench, initialBenchConditions } from "../packages/physical-notebook/policy";
import { benchCurrent, readBenchPending, sendBenchOriginal } from "../src/components/physical-notebook-client";

// Actual React controls, shared Modal and DOM events. Every home, byte and
// reviewer below is explicitly synthetic. No DB/server/provider is contacted.
const cssHook = registerHooks({ load(url, context, nextLoad) { if (url.endsWith(".module.css")) return { format: "module", shortCircuit: true, source: "export default new Proxy({}, {get: (_target, name) => String(name)});" }; return nextLoad(url, context); } });
after(() => cssHook.deregister());
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://worldkit.test/bench", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node, File: dom.window.File, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
// JSDOM has no paint/layout engine. This admits visible dialog controls to the
// shared focus trap; no native viewport, zoom or physical interaction is claimed.
Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", { configurable: true, value() { return [{ x: 0, y: 0, width: 100, height: 44 }]; } });
const { createRoot } = await import("react-dom/client");
const { PhysicalNotebook } = await import("../src/components/physical-notebook");
const ownerKey = "1".repeat(64), reviewerKey = "2".repeat(64), at = "2020-01-01T10:00:00.000Z", end = "2020-01-01T10:00:30.000Z", expires = "2099-01-01T00:00:00.000Z";
const hash = (value: string | number) => String(value).padStart(64, "a").slice(-64);
const binding: BenchBinding = { kind: "creator", subjectId: "ui-synthetic-system", revisionId: "ui-synthetic-revision", graphHash: "a".repeat(64), title: "Sample isolated-recording system", hash: "b".repeat(64), certificateHash: "c".repeat(64), ruleVersion: "synthetic-ui-rules", components: [{ id: "mic-a", model: "Sample microphone A", profileId: "ui-mic-profile", profileHash: "d".repeat(64) }, { id: "recorder", model: "Sample recorder", profileId: "ui-recorder-profile", profileHash: "e".repeat(64) }], connections: [{ id: "lead", from: "mic-a:out", to: "recorder:in-1", signal: "audio", protocol: "analogue", cable: "XLR", enabled: true }], configuration: [{ componentId: "recorder", settings: { tracks: 2, mode: "Synthetic UI fixture" } }], sources: [{ id: "ui-source", hash: "f".repeat(64), title: "Synthetic source reference", url: "https://manufacturer.example.invalid/manual" }], requirements: [{ id: "req-1", label: "Independent tracks", modeledStatus: "unknown" }], graphSource: "sample", steps: [{ id: "source:mic-a", title: "Microphone A alone", instruction: "Exercise the first source alone. This UI fixture is not equipment evidence.", required: true, evidenceKinds: ["isolated_track"] }, { id: "power", title: "Power and connections", instruction: "Retain the exact connection photo and every dropout.", required: true, evidenceKinds: ["connection_photo"] }] };
const rights: BenchAsset["rights"] = { basis: "sample_generated", holder: "Synthetic UI fixture", permissionReference: "No actual rights/participant event occurred", grantedAt: at, expiresAt: null, attribution: "UI control only", privateReviewAllowed: true, publicSharingAllowed: false, identifiablePeople: false, participantConsentConfirmed: false, restrictions: "Synthetic test data" };
const asset: BenchAsset = { id: "ui-original", runId: "ui-run", uploadId: "ui-upload", filename: "sample-track.wav", bytes: 48, mediaType: "audio/wav", kind: "isolated_track", provenance: "sample_generated", expectedSha256: null, rights, sha256: "f".repeat(64), verifiedAt: at, observedMediaType: "audio/wav", originalBytesRetained: true, availability: "available", detectedModelExport: true, audio: { format: "pcm", channels: 2, sampleRate: 16000, bitsPerSample: 16, frames: 32000, durationSeconds: 2, channelPeaks: [.4, .2], channelRms: [.1, .1], envelope: [[0, .4, .2, 0], [.2, 0, .1, .2]], clippingSamples: [0, 0], scope: "Byte-derived waveform and channel statistics; neither physical origin nor microphone independence is inferred." }, inspectionNotes: ["Generated Sample marker retained."] };
const upload: BenchUpload = { id: "ui-upload", runId: "ui-run", file: { filename: "sample-track.wav", bytes: 48, mediaType: "audio/wav", kind: "isolated_track", provenance: "operator_original", expectedSha256: null, rights }, createdAt: at, expiresAt: expires, phase: "awaiting_upload", assetId: null, failure: null, transport: "controlled_local", pathname: "private/ui-run/ui-upload", attempts: 0 };
const grant: BenchGrant = { id: "ui-grant", runId: "ui-run", editionId: "ui-edition-6", editionHash: hash(6), actorId: "ui-reviewer", name: "Sample reviewer", provenance: "sample", role: "reviewer", version: 1, expiresAt: expires, status: "active", qualification: "sample" };
const failure: BenchObservation = { id: "ui-observation", stepId: "source:mic-a", outcome: "observed_failure", detail: "Synthetic observation: dropout retained; no physical test occurred.", observedAt: "2020-01-01T10:00:05.000Z", recordedAt: "2020-01-01T10:00:06.000Z", actorId: "ui-owner" };
type HomeOptions = { selected?: boolean; phase?: BenchEdition["phase"]; version?: number; prepared?: boolean; assets?: BenchAsset[]; uploads?: BenchUpload[]; observations?: BenchObservation[]; attached?: boolean; historical?: boolean; reviewer?: boolean; human?: boolean; qualified?: boolean; sourceMode?: BenchEdition["sourceMode"]; decisions?: BenchDecision[]; grants?: BenchGrant[]; workspaceKey?: string };
function home(options: HomeOptions = {}): BenchHome {
  const { selected = true, phase = "planning", version = phase === "sealed" ? 6 : 1, prepared = phase !== "planning", assets = [], uploads = [], observations = [], attached = false, historical = false, reviewer = false, human = false, qualified = false, sourceMode = "sample", decisions = [] } = options;
  const conditions = initialBenchConditions(binding);
  if (prepared) { conditions.hardware = conditions.hardware.map(h => ({ ...h, revision: "Synthetic revision", firmware: "Synthetic firmware", matchesBoundModel: true })); Object.assign(conditions, { operator: "Sample UI operator", hostOs: "Synthetic OS", appAndVersion: "Synthetic app 1", recordingSettings: "Synthetic recording", streamSettings: "Synthetic stream", storage: "No real media recorded", power: "No hardware powered", hubsAndCables: "Synthetic cable declaration", monitoring: "No actual listener" }); }
  const shown = historical ? Math.max(1, version - 1) : version;
  const edition: BenchEdition = { schema: BENCH_SCHEMA, id: `ui-edition-${shown}`, runId: "ui-run", number: shown, parentId: shown > 1 ? `ui-edition-${shown - 1}` : null, hash: hash(shown), title: "Synthetic notebook — no physical test", sourceMode, phase: historical ? "planning" : phase, binding: structuredClone(binding), conditions, observations: structuredClone(observations), attachments: attached && assets[0] ? [{ id: "ui-link", assetId: assets[0].id, assetHash: assets[0].sha256, stepId: "source:mic-a", note: "Synthetic attachment", attachedAt: at }] : [], declaredAt: prepared ? at : null, startedAt: phase === "planning" ? null : at, finishedAt: ["recorded", "sealed"].includes(phase) ? end : null, sealedAt: phase === "sealed" ? end : null, createdAt: at, reason: "Synthetic mounted UI fixture" };
  const detail: BenchDetail = { runId: "ui-run", currentEditionId: `ui-edition-${version}`, currentVersion: version, currentEditionHash: hash(version), edition, historical, subjectCurrent: true, subjectIssues: [], history: Array.from({ length: version }, (_, i) => ({ id: `ui-edition-${version - i}`, number: version - i, hash: hash(version - i), phase: i === 0 ? phase : "planning", reason: `Synthetic saved edition ${version - i}`, createdAt: at })), assets: structuredClone(assets), uploads: structuredClone(uploads), grants: structuredClone(options.grants ?? (reviewer ? [{ ...grant, provenance: human ? "human" : "sample", qualification: qualified ? "current" : human ? "unestablished" : "sample" }] : [])), decisions: structuredClone(decisions), assessment: assessBench(edition, assets, decisions), serials: [], role: reviewer ? "reviewer" : "owner", reviewer: reviewer ? { name: human ? "Synthetic human identity control" : "Sample reviewer", provenance: human ? "human" : "sample", qualified, expiresAt: expires } : null, events: [{ id: "ui-event", kind: "fixture", at, summary: "Synthetic UI event; no equipment ran." }] };
  return { workspaceKey: options.workspaceKey ?? (reviewer ? reviewerKey : ownerKey), expiresAt: expires, policy: BENCH_POLICY, storage: "controlled_local", subjects: reviewer ? [] : [{ subject: { kind: binding.kind, subjectId: binding.subjectId, revisionId: binding.revisionId, graphHash: binding.graphHash }, title: binding.title, componentCount: 2, kindLabel: "Creator system" }, { subject: { kind: "domain", subjectId: "ui-desk", revisionId: "ui-desk-rev", graphHash: "e".repeat(64) }, title: "Sample independent-display desk", componentCount: 3, kindLabel: "Desk pack" }], reviewers: reviewer ? [] : [{ id: "ui-established", name: "Synthetic existing reviewer", provenance: "human", qualification: "current" }], runs: selected ? [{ id: "ui-run", title: edition.title, sourceMode, phase, version, updatedAt: at }] : [], selected: selected ? detail : null };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type Call = { method: string; url: URL; body?: unknown; credentials?: RequestCredentials };
class Transport {
  calls: Call[] = []; unexpected: string[] = []; queue: { method: string; response: Response | Promise<Response> | Error }[] = [];
  get(value: BenchHome | Promise<Response> | Error, status = 200) { this.queue.push({ method: "GET", response: value instanceof Promise || value instanceof Error ? value : json(value, status) }); return this; }
  response(value: unknown, status = 200) { this.queue.push({ method: "POST", response: value instanceof Promise || value instanceof Error ? value : json(value, status) }); return this; }
  put(value: unknown = {}) { this.queue.push({ method: "PUT", response: value instanceof Promise || value instanceof Error ? value : json(value) }); return this; }
  readonly fetch: typeof fetch = async (input, init) => {
    const call: Call = { method: init?.method ?? "GET", url: new URL(String(input), "https://worldkit.test"), body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body, credentials: init?.credentials };
    this.calls.push(call); const expected = this.queue.shift();
    if (call.url.origin !== "https://worldkit.test" || !call.url.pathname.startsWith("/api/physical-notebook") || !expected || expected.method !== call.method) { const message = `Unexpected synthetic transport ${call.method} ${call.url.pathname}`; this.unexpected.push(message); throw new Error(message); }
    assert.equal(call.credentials, "same-origin");
    if (call.method === "POST" && !call.url.pathname.endsWith("/redeem")) {
      const role = call.url.pathname.endsWith("/review"); const saved = readBenchPending(window.sessionStorage, role ? reviewerKey : ownerKey, role);
      assert.ok(saved, "The original action is durably recorded before dispatch");
      if (saved.mode === "command") assert.deepEqual(saved.command, call.body);
      if (saved.mode === "private_serial") { const { serial, ...identity } = call.body as Extract<BenchCommand, { kind: "private_serial" }>; assert.deepEqual(saved.identity, identity); assert.ok(!Object.values(window.sessionStorage).join("").includes(serial)); }
    }
    if (expected.response instanceof Error) throw expected.response;
    return expected.response;
  };
  command(index = 0) { return BenchCommandSchema.parse(this.calls.filter(c => c.method === "POST" && !c.url.pathname.endsWith("/redeem"))[index]?.body); }
  complete() { assert.deepEqual(this.unexpected, []); assert.equal(this.queue.length, 0, "Every expected synthetic response was used"); }
}
async function mount(t: TestContext, transport: Transport, { reviewer = false, path = reviewer ? "/bench/review" : "/bench", strict = false, clearStorage = true }: { reviewer?: boolean; path?: string; strict?: boolean; clearStorage?: boolean } = {}) {
  if (clearStorage) window.sessionStorage.clear(); window.history.replaceState({}, "", path); document.body.innerHTML = "<div id='root'></div>";
  const style = document.createElement("style"); style.textContent = readFileSync(new URL("../src/components/physical-notebook.module.css", import.meta.url), "utf8"); document.head.append(style);
  let root = createRoot(document.getElementById("root")!); const original = globalThis.fetch; globalThis.fetch = transport.fetch;
  const render = () => strict ? createElement(StrictMode, null, createElement(PhysicalNotebook, { reviewer })) : createElement(PhysicalNotebook, { reviewer });
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = original; style.remove(); document.body.innerHTML = ""; window.sessionStorage.clear(); transport.complete(); });
  await act(async () => root.render(render()));
  return { async remount() { await act(async () => root.unmount()); document.body.innerHTML = "<div id='root'></div>"; root = createRoot(document.getElementById("root")!); await act(async () => root.render(render())); } };
}
const text = (node: Element) => node.textContent?.replace(/\s+/g, " ").trim() ?? "";
function one<T extends Element>(selector: string, scope: ParentNode = document): T { const matches = scope.querySelectorAll<T>(selector); assert.equal(matches.length, 1, `Expected one ${selector}, got ${matches.length}`); return matches[0]!; }
function button(name: string, scope: ParentNode = document) { const matches = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).filter(b => (b.getAttribute("aria-label") ?? text(b)) === name); assert.equal(matches.length, 1, `Expected one button ${name}; found ${matches.length}`); return matches[0]!; }
function field<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(label: string, scope: ParentNode = document) { const labels = Array.from(scope.querySelectorAll<HTMLLabelElement>("label")).filter(l => text(l).startsWith(label)); assert.equal(labels.length, 1, `Expected field ${label}`); return one<T>("input,select,textarea", labels[0]!); }
const modal = () => one<HTMLElement>("[role=dialog]");
async function click(node: HTMLElement) { assert.equal(node.matches(":disabled"), false, `Control is disabled: ${text(node)}`); await act(async () => { node.focus(); node.click(); }); }
async function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { const prototype = node instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); }
async function select(node: HTMLSelectElement, value: string) { await act(async () => { node.value = value; node.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); }
async function check(label: string, scope: ParentNode = modal()) { const checkbox = field<HTMLInputElement>(label, scope); if (!checkbox.checked) await click(checkbox); }
async function key(value: string, target: Document | HTMLElement = document) { await act(async () => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }))); }
async function tab(name: string) { const target = Array.from(document.querySelectorAll<HTMLButtonElement>("[role=tab]")).find(t => text(t).startsWith(name)); assert.ok(target); await click(target); }
async function chooseFile(file: File) { const input = one<HTMLInputElement>("input[type=file]", modal()); Object.defineProperty(input, "files", { configurable: true, value: [file] }); await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true }))); }
function assertHeadingFocus(version: number) { const h = one<HTMLHeadingElement>("h2[aria-describedby]"); assert.equal(document.activeElement, h); assert.match(text(document.getElementById(h.getAttribute("aria-describedby")!)!), new RegExp(`Edition ${version}`)); }

test("StrictMode/initial and deep-link reads create no workspace, notebook or mutation", async t => {
  const http = new Transport().get(home({ selected: false })); await mount(t, http, { strict: true, path: "/bench?runId=original-run&editionId=original-edition" });
  assert.equal(http.calls.length, 1); assert.equal(http.calls[0]!.url.searchParams.get("runId"), "original-run"); assert.equal(http.calls[0]!.url.searchParams.get("editionId"), "original-edition");
  assert.equal(http.calls.filter(c => c.method !== "GET").length, 0); assert.match(document.body.textContent!, /No notebook|Start from a saved system|Choose a saved system/); assert.equal(window.sessionStorage.length, 0);
});

test("one explicit create survives same-tick clicks, a lost answer and remount; recovery uses the exact original body", async t => {
  const lost = deferred<Response>(); const http = new Transport().get(home({ selected: false })).response(lost.promise).get(home()).response({ runId: "ui-run", editionId: "ui-edition-1" }).get(home());
  const app = await mount(t, http); await click(button("New notebook")); await select(field<HTMLSelectElement>("Saved system"), "1"); await check("A notebook records declared conditions");
  const submit = button("Open this notebook", modal()); await act(async () => { submit.click(); submit.click(); });
  assert.equal(http.calls.filter(c => c.method === "POST").length, 1); assert.equal(http.command().kind, "create"); assert.deepEqual((http.command() as Extract<BenchCommand, { kind: "create" }>).subject, { kind: "domain", subjectId: "ui-desk", revisionId: "ui-desk-rev", graphHash: "e".repeat(64) });
  await act(async () => lost.reject(new Error("Synthetic response lost after save"))); const original = http.command();
  await app.remount(); assert.equal(http.calls.filter(c => c.method === "POST").length, 1, "No automatic POST during reload recovery"); assert.equal(button("New notebook").disabled, true);
  await click(button("Recover the original action")); assert.deepEqual(http.command(1), original); assert.equal(readBenchPending(window.sessionStorage, ownerKey, false), null); assertHeadingFocus(1);
});

test("conditions, exact Start, failure observation, Finish and Seal use current edition identities", async t => {
  const prepared = home({ version: 2, prepared: true }); const running = home({ version: 3, phase: "running" }); const observed = home({ version: 4, phase: "running", observations: [failure] }); const finished = home({ version: 5, phase: "recorded", observations: [failure] }); const sealed = home({ version: 6, phase: "sealed", observations: [failure] });
  const http = new Transport().get(home()).response({ runId: "ui-run" }).get(prepared).response({ runId: "ui-run" }).get(running).response({ runId: "ui-run" }).get(observed).response({ runId: "ui-run" }).get(finished).response({ runId: "ui-run" }).get(sealed);
  await mount(t, http); assert.equal(button("Start declared interval").disabled, true); await tab("Conditions"); await click(button("Edit conditions"));
  await type(field<HTMLInputElement>("Host and operating system"), "Synthetic current OS"); await check("This is the exact bound Sample microphone A"); await check("This is the exact bound Sample recorder"); await type(field<HTMLInputElement>("Reason for this condition edition"), "Synthetic declared conditions"); await click(button("Save exact conditions", modal()));
  assert.equal(http.command().kind, "plan"); assert.equal((http.command() as Extract<BenchCommand, { kind: "plan" }>).expectedEditionId, "ui-edition-1"); assertHeadingFocus(2);
  await tab("Protocol"); await click(button("Start declared interval")); await check("I checked the exact equipment"); await check("I will retain the original observations"); await click(button("Start this interval", modal()));
  assert.deepEqual({ ...http.command(1), requestId: "id" }, { kind: "start", requestId: "id", ...benchCurrent(prepared.selected!), confirmedExactEquipment: true, acknowledgedOperatorReport: true }); assertHeadingFocus(3);
  const observations = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(b => text(b) === "Record observation"); await click(observations[0]!); await select(field<HTMLSelectElement>("Reported outcome"), "observed_failure"); await type(field<HTMLInputElement>("Observed at (UTC)"), "2020-01-01T10:00:05.000"); await type(field<HTMLTextAreaElement>("What you observed"), failure.detail); await click(button("Append this observation", modal()));
  assert.equal((http.command(2) as Extract<BenchCommand, { kind: "observe" }>).observation.outcome, "observed_failure"); assert.match(document.body.textContent!, /Operator reported failure/);
  await click(button("Finish interval")); await type(field<HTMLTextAreaElement>("Finish note"), "Ended early in this synthetic UI control"); await click(button("Finish the interval", modal()));
  assertHeadingFocus(5); await click(button("Seal exact report")); assert.match(modal().textContent!, /failures and|failure.*evidence gaps/); await check("This immutable manifest records reported evidence"); await click(button("Seal reported evidence", modal()));
  assert.equal(http.command(4).kind, "seal"); assertHeadingFocus(6); assert.match(document.body.textContent!, /Operator reported failure/); assert.match(document.body.textContent!, /Sample rehearsal/); assert.equal(sealed.selected!.assessment.actualQualifiedReviews, 0);
});

test("an accepted context/rights change closes checked consent; pending reads block new editors", async t => {
  const later = deferred<Response>(); const changed = home({ prepared: true, version: 2, assets: [{ ...asset, availability: "withdrawn" }] });
  const http = new Transport().get(home({ prepared: true, version: 2, assets: [asset] })).get(later.promise); await mount(t, http); await click(button("Start declared interval")); await check("I checked the exact equipment"); await check("I will retain the original observations");
  await act(async () => window.dispatchEvent(new dom.window.Event("focus"))); assert.equal(one<HTMLButtonElement>("button[type=submit]", modal()).disabled, true); assert.equal(button("New notebook").disabled, true);
  await act(async () => later.resolve(json(changed))); assert.equal(document.querySelector("[role=dialog]"), null); assert.equal(http.calls.filter(c => c.method === "POST").length, 0);
  await click(button("Start declared interval")); assert.equal(field<HTMLInputElement>("I checked the exact equipment").checked, false); assert.equal(field<HTMLInputElement>("I will retain the original observations").checked, false);
});

test("historical selection and return focus the exact report heading and never reenable historical commands", async t => {
  const current = home({ prepared: true, version: 3 }); const old = home({ prepared: true, version: 3, historical: true }); const http = new Transport().get(current).get(old).get(current); await mount(t, http);
  await tab("History"); await click(button("Open edition 2")); assertHeadingFocus(2); assert.match(document.body.textContent!, /Historical edition · read only/); assert.equal(document.querySelectorAll("button").length > 0, true); assert.equal(Array.from(document.querySelectorAll("button")).some(b => text(b) === "Edit conditions"), false);
  await click(button("Return to current report")); assertHeadingFocus(3); assert.equal(http.calls.filter(c => c.method !== "GET").length, 0);
});

test("Escape confirms dirty draft discard, keeps editing intact and returns to the actual opener", async t => {
  const http = new Transport().get(home({ selected: false })); await mount(t, http); const trigger = button("New notebook"); await click(trigger); await type(field<HTMLInputElement>("Notebook title"), "Retain this unsaved synthetic title");
  await key("Escape"); assert.match(modal().textContent!, /Close without saving these edits/); assert.equal(document.activeElement, button("Keep editing", modal())); await click(button("Keep editing", modal())); assert.equal(field<HTMLInputElement>("Notebook title").value, "Retain this unsaved synthetic title");
  await key("Escape"); await click(button("Discard edits and close", modal())); assert.equal(document.querySelector("[role=dialog]"), null); assert.equal(document.activeElement, trigger); assert.equal(http.calls.filter(c => c.method === "POST").length, 0);
});

test("private serial uncertainty stores only the original identity and requires deliberate same-body re-entry after reload", async t => {
  const lost = deferred<Response>(); const afterSave = home({ version: 2 }); afterSave.selected!.serials = [{ id: "ui-private-serial", componentId: "mic-a", hash: "e".repeat(64) }]; afterSave.selected!.edition.conditions.hardware[0]!.serialRecordId = "ui-private-serial";
  const http = new Transport().get(home()).response(lost.promise).get(afterSave).response({ runId: "ui-run", editionId: "ui-edition-2" }).get(afterSave); const app = await mount(t, http);
  await tab("Conditions"); const serialButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(b => text(b) === "Seal private serial"); assert.ok(serialButton); await click(serialButton); await type(field<HTMLInputElement>("Private serial"), "PRIVATE-UI-SERIAL-DO-NOT-STORE"); await click(button("Seal private serial", modal()));
  await act(async () => lost.reject(new Error("Synthetic lost serial response"))); const original = http.command(); assert.equal(original.kind, "private_serial"); assert.ok(!Object.values(window.sessionStorage).join("").includes("PRIVATE-UI-SERIAL-DO-NOT-STORE"));
  await app.remount(); assert.equal(http.calls.filter(c => c.method === "POST").length, 1); await click(button("Recover the original action")); assert.equal(field<HTMLInputElement>("Private serial").value, ""); await type(field<HTMLInputElement>("Private serial"), "PRIVATE-UI-SERIAL-DO-NOT-STORE"); await click(button("Recover the original serial save", modal()));
  assert.deepEqual(http.command(1), original); assert.ok(!document.body.textContent!.includes("PRIVATE-UI-SERIAL-DO-NOT-STORE")); assert.equal(window.sessionStorage.length, 0);
});

test("sending, byte verification and attachment remain three different explicit states", async t => {
  const sent = { ...upload, phase: "uploaded" as const }; const verified = { ...sent, phase: "verified" as const, assetId: asset.id, attempts: 1 };
  const http = new Transport().get(home({ prepared: true, version: 2, uploads: [upload] })).put().get(home({ prepared: true, version: 2, uploads: [sent] })).response({ runId: "ui-run", verifyUploadId: upload.id }).get(home({ prepared: true, version: 2, uploads: [verified], assets: [asset] })).response({ runId: "ui-run" }).get(home({ prepared: true, version: 3, uploads: [verified], assets: [asset], attached: true }));
  await mount(t, http); await tab("Original files"); assert.match(document.body.textContent!, /Not attached to any protocol step/); await click(button("Send original")); const file = new dom.window.File([new Uint8Array(48)], "sample-track.wav", { type: "audio/wav" }); await chooseFile(file); await click(button("Send this file once", modal()));
  assert.equal(http.calls.filter(c => c.method === "PUT").length, 1); assert.equal(http.calls.filter(c => c.method === "POST").length, 0); assert.match(document.body.textContent!, /not yet evidence attached|Not attached/);
  await click(button("Check original bytes")); assert.equal(http.command().kind, "verify_upload"); assert.equal(http.calls.filter(c => c.method === "POST").length, 1); assert.match(document.body.textContent!, /Not attached to a protocol step/); assert.match(document.body.textContent!, /neither physical origin nor microphone independence/);
  await click(button("Link to step")); await type(field<HTMLTextAreaElement>("What this original supports"), "Synthetic file linked explicitly to the first source"); await click(button("Link this exact original", modal()));
  const attached = http.command(1); assert.equal(attached.kind, "attach"); if (attached.kind === "attach") { assert.equal(attached.assetId, asset.id); assert.equal(attached.stepId, "source:mic-a"); assert.equal(attached.expectedEditionId, "ui-edition-2"); }
  assert.match(document.body.textContent!, /1 explicit protocol attachment/); assertHeadingFocus(3);
});

test("a lost original PUT is checked after remount without another PUT or replacement upload intent", async t => {
  const sent = { ...upload, phase: "uploaded" as const }; const checked = { ...sent, phase: "verified" as const, assetId: asset.id, attempts: 1 };
  const http = new Transport().get(home({ prepared: true, version: 2, uploads: [upload] })).put(new Error("Synthetic PUT answer lost after bytes saved")).get(home({ prepared: true, version: 2, uploads: [sent] })).response({ runId: "ui-run", verifyUploadId: upload.id }).get(home({ prepared: true, version: 2, uploads: [checked], assets: [asset] })); const app = await mount(t, http);
  await tab("Original files"); await click(button("Send original")); await chooseFile(new dom.window.File([new Uint8Array(48)], "sample-track.wav", { type: "audio/wav" })); await click(button("Send this file once", modal())); assert.equal(readBenchPending(window.sessionStorage, ownerKey, false)?.mode, "upload_check");
  await app.remount(); assert.equal(http.calls.filter(c => c.method === "PUT").length, 1); assert.equal(http.calls.filter(c => c.method === "POST").length, 0); await click(button("Check that original upload")); const command = http.command(); assert.equal(command.kind, "verify_upload"); if (command.kind === "verify_upload") assert.equal(command.uploadId, upload.id);
  assert.equal(http.calls.filter(c => c.method === "PUT").length, 1); assert.equal(readBenchPending(window.sessionStorage, ownerKey, false), null);
});

test("the installed private Blob upload boundary receives the exact private path and scoped payload", async () => {
  const intent = { ...upload, transport: "private_blob" as const };
  for (const pickedType of ["audio/x-wav", ""]) {
    const file = new dom.window.File([new Uint8Array(48)], "sample-track.wav", { type: pickedType });
    const calls: unknown[][] = [];
    await sendBenchOriginal(intent, file, "ui-run", async (...args) => { calls.push(args); return { synthetic: true }; });
    assert.equal(file.type, pickedType);
    assert.equal(calls.length, 1); assert.equal(calls[0]![0], intent.pathname); assert.equal(calls[0]![1], file);
    assert.deepEqual(calls[0]![2], { access: "private", contentType: "audio/wav", handleUploadUrl: "/api/physical-notebook/uploads", multipart: true, clientPayload: JSON.stringify({ runId: "ui-run", uploadId: upload.id }) }, "The declared intent MIME wins over macOS/empty File.type and matches the scoped upload token");
    await assert.rejects(sendBenchOriginal(intent, file, "foreign-run", async () => { throw new Error("Must not dispatch"); }), /exact file/);
  }
});

test("unverified rejected uploads have deliberate removal and cannot be checked after withdrawal", async t => {
  const rejected = { ...upload, phase: "rejected" as const, failure: "Synthetic hash mismatch", attempts: 1 }; const removed = { ...rejected, withdrawnAt: at, purgedAt: end };
  const http = new Transport().get(home({ uploads: [rejected] })).response({ runId: "ui-run", withdrawn: true }).get(home({ uploads: [removed] })); await mount(t, http); await tab("Original files"); await click(button("Remove upload")); await type(field<HTMLTextAreaElement>("Upload removal reason"), "Remove this synthetic rejected original"); await check("The original upload intent, rejection"); await click(button("Remove this upload", modal()));
  const command = http.command(); assert.equal(command.kind, "withdraw_upload"); if (command.kind === "withdraw_upload") assert.equal(command.uploadId, upload.id); assert.match(document.body.textContent!, /Removed · bytes purged/); assert.equal(button("Check original bytes").disabled, true); assert.equal(http.calls.filter(c => c.method === "PUT").length, 0);
});

test("withdrawal removes original playback/download while retaining the manifest and attachment", async t => {
  const markedOriginal = { ...asset, provenance: "operator_original" as const, detectedModelExport: true }; const withdrawn = { ...markedOriginal, availability: "withdrawn" as const }; const http = new Transport().get(home({ phase: "sealed", assets: [markedOriginal], attached: true })).response({ runId: "ui-run", withdrawn: true }).get(home({ phase: "sealed", assets: [withdrawn], attached: true })); await mount(t, http); await tab("Original files"); assert.match(document.body.textContent!, /Model or Sample evidence · cannot support physical execution/); const inspect = button("Inspect original"); await click(inspect); assert.equal(one<HTMLAudioElement>("audio", modal()).getAttribute("preload"), "none"); assert.match(modal().textContent!, /Model or Sample evidence · cannot support physical execution/); await key("Escape"); assert.equal(document.activeElement, inspect);
  await click(button("Withdraw access")); await type(field<HTMLTextAreaElement>("Withdrawal reason"), "Synthetic participant withdrew private access"); await check("The immutable manifest and fingerprint"); await click(button("Withdraw private access", modal()));
  assert.equal(http.command().kind, "withdraw_asset"); assert.match(document.body.textContent!, /Original unavailable/); assert.match(document.body.textContent!, /1 explicit protocol attachment/); assert.equal(button("Inspect original").disabled, true); assert.equal(document.querySelectorAll('a[href*="/originals/"]').length, 0);
});

test("one-time invitations stay masked and out of storage until deliberate copy/open", async t => {
  const token = `wkbi_${"A".repeat(43)}`; const invited = { ...grant, status: "invited" as const };
  const http = new Transport().get(home({ phase: "sealed", assets: [asset], attached: true })).response({ runId: "ui-run", grant: { ...invited, invitation: token } }).get(home({ phase: "sealed", assets: [asset], attached: true, grants: [invited] })); await mount(t, http); await tab("Review"); await click(button("Invite reviewer")); await type(field<HTMLInputElement>("Reviewer name"), "Fictional Sample reviewer"); await check("This is private, exact-edition review only"); await click(button("Create private invitation", modal()));
  assert.match(modal().textContent!, /invitation is masked/); assert.ok(!document.body.innerHTML.includes(token)); assert.ok(!Object.values(window.sessionStorage).join("").includes(token)); assert.equal(window.location.hash, "");
  const copied: string[] = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  await click(button("Copy private invitation", modal())); assert.deepEqual(copied, [`https://worldkit.test/bench/review#invite=${token}`]); assert.ok(!document.body.innerHTML.includes(token)); await click(button("Close private invitation", modal())); assert.equal(document.activeElement, one("h2[aria-describedby]"));
});

test("review invitation redemption is explicit, removes the fragment and retries only the same in-memory identity", async t => {
  const token = `wkbi_${"B".repeat(43)}`;
  const http = new Transport().get(Promise.resolve(json({ error: { code: "forbidden", message: "Synthetic reviewer access absent" } }, 403))).response(new Error("Synthetic redemption answer lost")).response({ runId: "ui-run", expiresAt: expires }).get(home({ reviewer: true, phase: "sealed", assets: [asset], attached: true }));
  await mount(t, http, { reviewer: true, path: `/bench/review#invite=${token}` }); assert.equal(window.location.hash, ""); assert.equal(http.calls.filter(c => c.method === "POST").length, 0); assert.ok(!document.body.innerHTML.includes(token));
  await click(button("Open the private invitation")); assert.equal(http.calls.filter(c => c.method === "POST").length, 1); const original = BenchRedeemSchema.parse(http.calls.find(c => c.method === "POST")!.body); assert.equal(original.invitation, token); assert.equal(window.sessionStorage.length, 0);
  await click(button("Recover this invitation redemption")); const posts = http.calls.filter(c => c.method === "POST"); assert.deepEqual(posts[1]!.body, original); assert.equal(document.querySelectorAll('button').length > 0, true); assert.match(document.body.textContent!, /Sample person · no actual human review/);
});

test("Sample reviewers submit an exact-version decision with zero actual human-review claims", async t => {
  const before = home({ reviewer: true, phase: "sealed", assets: [asset], attached: true });
  const decision: BenchDecision = { id: "ui-decision", editionId: "ui-edition-6", editionHash: hash(6), actorId: "ui-reviewer", actorName: "Sample reviewer", principalHash: null, qualificationId: null, grantId: grant.id, grantVersion: 1, provenance: "sample", createdAt: at, currentlyQualified: false, currentAuthority: true, outcome: "needs_evidence", finding: "Synthetic review asks for actual original evidence.", limitations: "Sample review; no human or physical test.", inspectedAssetIds: [asset.id], inspectedOriginals: true, reviewedExactConditions: true };
  const afterReview = home({ reviewer: true, phase: "sealed", assets: [asset], attached: true, decisions: [decision] }); const http = new Transport().get(before).response({ runId: "ui-run", decisionId: decision.id }).get(afterReview); await mount(t, http, { reviewer: true });
  assert.equal(document.querySelectorAll('button').length > 0, true); assert.equal(Array.from(document.querySelectorAll('button')).some(b => text(b) === "New notebook"), false); await click(button("Record Sample review")); await type(field<HTMLTextAreaElement>("Review finding"), decision.finding); await type(field<HTMLTextAreaElement>("Review limitations"), decision.limitations); await check(asset.filename); await check("I inspected the selected exact original files"); await check("I reviewed the exact equipment"); await click(button("Record Sample review", modal()));
  const command = http.command(); assert.equal(command.kind, "review"); if (command.kind === "review") { assert.equal(command.expectedEditionId, "ui-edition-6"); assert.equal(command.expectedEditionHash, hash(6)); assert.deepEqual(command.decision.inspectedAssetIds, [asset.id]); }
  assert.equal(afterReview.selected!.assessment.actualQualifiedReviews, 0); assert.equal(afterReview.selected!.assessment.sampleReviews, 1); assert.match(document.body.textContent!, /Sample review/); assert.equal(button("Record Sample review").disabled, true, "One immutable decision per original grant");
});

test("human provenance alone does not enable a genuine reviewer decision", async t => {
  const http = new Transport().get(home({ reviewer: true, phase: "sealed", sourceMode: "operator_recorded", human: true, qualified: false, assets: [asset], attached: true })); await mount(t, http, { reviewer: true }); assert.equal(button("Record review decision").disabled, true); assert.match(document.body.textContent!, /qualification not established/); assert.equal(http.calls.filter(c => c.method === "POST").length, 0);
});

test("an access denial clears private drafts, originals and the old report without any replacement authority", async t => {
  const http = new Transport().get(home({ prepared: true, version: 2, assets: [asset] })).get(Promise.resolve(json({ error: { code: "forbidden", message: "Synthetic access revoked" } }, 403))); await mount(t, http); await tab("Conditions"); await click(button("Edit conditions")); await type(field<HTMLTextAreaElement>("Conditions and limitations"), "PRIVATE_OLD_SCOPE_DRAFT"); await act(async () => window.dispatchEvent(new dom.window.Event("focus")));
  assert.equal(document.querySelector("[role=dialog]"), null); assert.ok(!document.body.textContent!.includes("PRIVATE_OLD_SCOPE_DRAFT")); assert.ok(!document.body.textContent!.includes("Synthetic notebook — no physical test")); assert.equal(document.querySelectorAll('a[href*="/originals/"]').length, 0); assert.equal(http.calls.filter(c => c.method !== "GET").length, 0); assert.equal(document.activeElement, one('[role=alert]'), "Access error receives focus after the old private editor disappears");
});

test("tabs expose keyboard navigation and contained readable evidence structure; no jsdom viewport claim", async t => {
  const http = new Transport().get(home({ assets: [asset] })); await mount(t, http); const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role=tab]')); await key("End", tabs[0]!); assert.equal(document.activeElement, tabs.at(-1)); assert.equal(tabs.at(-1)!.getAttribute("aria-selected"), "true"); await key("Home", tabs.at(-1)!); assert.equal(document.activeElement, tabs[0]); assert.equal(document.querySelectorAll('[role=tab][tabindex="0"]').length, 1);
  for (const control of document.querySelectorAll('[role=tab]')) assert.ok(document.getElementById(control.getAttribute("aria-controls")!));
  await tab("Original files"); assert.equal(document.querySelectorAll("audio,video").length, 0, "No original media is automatically played or loaded"); assert.equal(dom.window.getComputedStyle(one(".assetHash code")).overflowWrap, "anywhere");
});

test("unavailable browser recovery storage refuses dispatch and leaves an actionable editor error", async t => {
  const http = new Transport().get(home({ selected: false })); await mount(t, http); await click(button("New notebook")); await check("A notebook records declared conditions"); const descriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
  try { Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("Synthetic storage unavailable"); } }); await click(button("Open this notebook", modal())); assert.equal(http.calls.filter(c => c.method === "POST").length, 0); assert.match(modal().textContent!, /storage unavailable/); assert.equal(one<HTMLButtonElement>("button[type=submit]", modal()).disabled, true); }
  finally { Object.defineProperty(window, "sessionStorage", descriptor); }
});

test("upload intent requires dated private/participant rights and never buffers a large file for a client hash", async t => {
  const large = new dom.window.File([new Uint8Array(48)], "sample-track.wav", { type: "audio/wav" }); Object.defineProperty(large, "size", { value: 400 * 1024 * 1024 });
  let buffered = 0; Object.defineProperty(large, "arrayBuffer", { value: async () => { buffered++; throw new Error("A large original must not be buffered by this UI"); } });
  const intent = { ...upload, file: { ...upload.file, bytes: large.size, provenance: "sample_generated" as const, rights: { ...rights, identifiablePeople: true, participantConsentConfirmed: true } } };
  const http = new Transport().get(home({ prepared: true, version: 2 })).response({ runId: "ui-run", upload: intent }).get(home({ prepared: true, version: 2, uploads: [intent] })); await mount(t, http); await tab("Original files"); await click(button("Add original")); await chooseFile(large);
  await type(field<HTMLInputElement>("Rights holder"), rights.holder); await type(field<HTMLInputElement>("Permission reference"), rights.permissionReference); await type(field<HTMLInputElement>("Permission granted at (UTC)"), "2020-01-01T10:00:00.000"); await check("The file contains identifiable people"); await check("I have permission for this exact file");
  // JSDOM does not provide a native file chooser. Its internal required-file
  // validity is not updated by a synthetic FileList, so submit the real React
  // form event after the file control's actual change handler has run.
  await act(async () => one<HTMLFormElement>("form", modal()).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))); assert.equal(http.calls.filter(c => c.method === "POST").length, 0); assert.match(modal().textContent!, /Confirm permission for private review before uploading identifiable participants/);
  await check("The participants permitted this private review"); await act(async () => one<HTMLFormElement>("form", modal()).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))); const command = http.command(); assert.equal(command.kind, "upload_intent"); if (command.kind === "upload_intent") { assert.equal(command.file.bytes, large.size); assert.equal(command.file.expectedSha256, null); assert.equal(command.file.rights.grantedAt, at); assert.equal(command.file.rights.participantConsentConfirmed, true); }
  assert.equal(buffered, 0); assert.equal(http.calls.filter(c => c.method === "PUT").length, 0, "Saving metadata never sends the file automatically"); assert.match(document.body.textContent!, /Upload intent saved/);
});

test("Sample originals remain waiting intents until explicit byte checks, including after remount", async t => {
  const intents: BenchUpload[] = [upload, { ...upload, id: "ui-mix", file: { ...upload.file, filename: "sample-mix.wav", kind: "stream_mix" } }, { ...upload, id: "ui-diagram", file: { ...upload.file, filename: "sample-diagram.png", mediaType: "image/png", kind: "connection_photo" } }];
  const samples = intents.map<BenchUpload>(u => ({ ...u, file: { ...u.file, provenance: "sample_generated", rights } }));
  const saved = home({ prepared: true, version: 2, uploads: samples }); const http = new Transport().get(home({ prepared: true, version: 2 })).response({ runId: "ui-run", sampleUploadIds: samples.map(s => s.id) }).get(saved).get(saved); const app = await mount(t, http); await tab("Original files"); await click(button("Generate Sample originals")); await check("These files are generated Sample material"); await click(button("Create three Sample originals", modal()));
  assert.equal(http.command().kind, "sample_originals"); assert.equal(http.calls.filter(c => c.method === "POST").length, 1); assert.equal(Array.from(document.querySelectorAll("button")).filter(b => text(b) === "Check original bytes").length, 3); assert.match(document.body.textContent!, /No checked originals yet/); assert.equal(saved.selected!.assessment.actualQualifiedReviews, 0);
  await app.remount(); assert.equal(http.calls.filter(c => c.method === "POST").length, 1, "Remount never starts materialization or verification"); assert.equal(window.sessionStorage.length, 0);
});

test("a foreign actor/workspace read never restores or displays another scope's unresolved private draft", async t => {
  const foreign = home({ workspaceKey: "3".repeat(64) }); foreign.selected!.edition.title = "Different current actor's Sample notebook"; foreign.runs[0]!.title = foreign.selected!.edition.title;
  const http = new Transport().get(home({ selected: false })).response(new Error("Synthetic create answer lost")).get(foreign); const app = await mount(t, http); await click(button("New notebook")); await type(field<HTMLInputElement>("Notebook title"), "PRIVATE_OLD_ACTOR_DRAFT"); await check("A notebook records declared conditions"); await click(button("Open this notebook", modal()));
  assert.equal(readBenchPending(window.sessionStorage, ownerKey, false)?.mode, "command"); await app.remount(); assert.ok(!document.body.textContent!.includes("PRIVATE_OLD_ACTOR_DRAFT")); assert.equal(Array.from(document.querySelectorAll("button")).some(b => text(b) === "Recover the original action"), false); assert.equal(readBenchPending(window.sessionStorage, "3".repeat(64), false), null); assert.equal(http.calls.filter(c => c.method === "POST").length, 1);
});
