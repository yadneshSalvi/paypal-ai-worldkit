import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import type { InventoryPhoto, InventoryWorkspace } from "../packages/inventory/contracts";
import type { Workspace } from "../packages/contracts";
import { architectures, profiles, seedKit, sources } from "../packages/device-library";
import { generateAssembly, verifyKit } from "../packages/compatibility";

// Installed React and shared Modal controls only. Every image/HTTP response is
// synthetic; no server, storage, model, catalog or real workspace is available.
const css = registerHooks({ load(url, context, next) { if (url.endsWith(".module.css")) return { format: "module", shortCircuit: true, source: "export default new Proxy({}, {get: (_, name) => String(name)});" }; return next(url, context); } });
after(() => css.deregister());
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://worldkit.test/?section=inventory", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { InventoryPhotoUpload } = await import("../src/components/inventory-photo-upload");
const { Inventory } = await import("../src/components/inventory");
const originalFetch = globalThis.fetch, originalBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
const originalContext = Object.getOwnPropertyDescriptor(dom.window.HTMLCanvasElement.prototype, "getContext"), originalBlob = Object.getOwnPropertyDescriptor(dom.window.HTMLCanvasElement.prototype, "toBlob");
const normalized = new Blob(["synthetic normalized WebP bytes"], { type: "image/webp" });
const imageFile = () => new File(["synthetic original image"], "original-sample.png", { type: "image/png" });
const photo = (sourceMode: "live" | "sample", id = `synthetic-${sourceMode}`): InventoryPhoto => ({ id, width: 2200, height: 1100, bytes: normalized.size, contentHash: "a".repeat(64), createdAt: "2026-11-12T12:00:00.000Z", sourceMode, status: "active", imageUrl: `/api/inventory/photos/${id}` });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(a => { resolve = a; }); return { promise, resolve }; }
const text = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "";
function one<T extends Element>(selector: string, parent: ParentNode = document): T { const values = parent.querySelectorAll<T>(selector); assert.equal(values.length, 1, `Expected one ${selector}`); return values[0]!; }
function button(label: string): HTMLButtonElement { const values = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(b => b.getAttribute("aria-label") === label || text(b) === label || b.querySelector("b")?.textContent === label); assert.equal(values.length, 1, `Expected button ${label}`); return values[0]!; }
const dialog = () => one<HTMLDivElement>("[role=dialog]");
const radio = (source: "live" | "sample") => one<HTMLInputElement>(`input[type=radio][value=${source}]`, dialog());
async function click(value: HTMLElement) { assert.equal(value.matches(":disabled"), false); await act(async () => { value.focus(); value.click(); }); }
async function chooseFile(file = imageFile()) {
  const trigger = button("Start with a photo"); trigger.focus();
  const input = one<HTMLInputElement>("input[type=file]"); Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  return trigger;
}
function neutral() { assert.equal(radio("live").checked, false); assert.equal(radio("sample").checked, false); assert.equal(button("Upload image").disabled, true); }
function imageHarness(t: TestContext, pending?: ReturnType<typeof deferred<ImageBitmap>>) {
  const calls: { file: File; options?: ImageBitmapOptions }[] = [], draws: { width: number; height: number; args: unknown[] }[] = [], encodes: { type: string; quality: number }[] = [];
  let closed = 0;
  const bitmap = { width: 4400, height: 2200, close() { closed++; } } as ImageBitmap;
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, writable: true, value: async (file: File, options?: ImageBitmapOptions) => { calls.push({ file, options }); return pending ? pending.promise : bitmap; } });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: function(this: HTMLCanvasElement) { const canvas = this; return { drawImage(...args: unknown[]) { draws.push({ width: canvas.width, height: canvas.height, args }); } }; } });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "toBlob", { configurable: true, value: function(callback: BlobCallback, type: string, quality: number) { encodes.push({ type, quality }); callback(normalized); } });
  t.after(() => { if (originalBitmap) Object.defineProperty(globalThis, "createImageBitmap", originalBitmap); else Reflect.deleteProperty(globalThis, "createImageBitmap"); if (originalContext) Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", originalContext); if (originalBlob) Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "toBlob", originalBlob); });
  return { bitmap, calls, draws, encodes, closed: () => closed };
}
type Call = { path: string; init: RequestInit };
async function mount(t: TestContext, response: Response | Promise<Response> | Error, { bitmap }: { bitmap?: ReturnType<typeof deferred<ImageBitmap>> } = {}) {
  document.body.innerHTML = "<div id='root'></div>";
  const images = imageHarness(t, bitmap), calls: Call[] = [], saved: InventoryPhoto[] = [], notices: string[] = [];
  globalThis.fetch = async (input, init = {}) => { const url = String(input); calls.push({ path: url, init }); assert.equal(url, "/api/inventory/photos"); assert.equal(init.method, "POST"); if (response instanceof Error) throw response; return response; };
  const root = createRoot(document.getElementById("root")!); let actor = "synthetic-actor-a";
  const render = () => createElement(InventoryPhotoUpload, { actorKey: actor, disabled: false, onSaved: (value: InventoryPhoto) => saved.push(value), onNotice: (value: string) => notices.push(value) });
  await act(async () => root.render(render()));
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; document.body.innerHTML = ""; });
  return { calls, saved, notices, images, async actor(value: string) { actor = value; await act(async () => root.render(render())); } };
}

test("file/source selection is neutral and dismissible without preparing or uploading, with focus returned", async t => {
  const h = await mount(t, new Error("No upload is expected"));
  assert.equal(document.querySelector("[role=dialog]"), null);
  const trigger = await chooseFile(); neutral(); assert.equal(document.activeElement, button("Close image source"));
  await click(radio("sample")); assert.equal(h.calls.length, 0); assert.equal(h.images.calls.length, 0);
  await click(button("Cancel")); assert.equal(document.querySelector("[role=dialog]"), null); assert.equal(document.activeElement, trigger);
  await chooseFile(); neutral(); await click(radio("live")); await chooseFile(new File(["another"], "another.jpg", { type: "image/jpeg" })); neutral();
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(document.querySelector("[role=dialog]"), null); assert.equal(document.activeElement, trigger); assert.equal(h.calls.length, 0); assert.equal(h.images.calls.length, 0);
});

for (const source of ["live", "sample"] as const) test(`${source} choice sends one binary normalized image with its exact source header`, async t => {
  const h = await mount(t, Response.json({ photo: photo(source) }, { status: 201 })); const trigger = await chooseFile();
  await click(radio(source)); assert.equal(h.calls.length, 0); await click(button("Upload image"));
  assert.equal(h.calls.length, 1); const request = h.calls[0]!.init;
  assert.deepEqual(request.headers, { "Content-Type": "image/webp", "X-WorldKit-Image-Source": source }); assert.equal(request.body, normalized);
  assert.deepEqual(h.images.calls[0]!.options, { imageOrientation: "from-image" }); assert.deepEqual(h.images.draws.map(x => [x.width, x.height]), [[2200, 1100]]); assert.deepEqual(h.images.encodes, [{ type: "image/webp", quality: .88 }]); assert.equal(h.images.closed(), 1);
  assert.deepEqual(h.saved, [photo(source)]); assert.equal(document.querySelector("[role=dialog]"), null); assert.equal(document.activeElement, trigger);
});

test("duplicate clicks and direct duplicate submits dispatch once across image preparation and pending transport", async t => {
  const prepared = deferred<ImageBitmap>(), response = deferred<Response>(); const h = await mount(t, response.promise, { bitmap: prepared });
  await chooseFile(); await click(radio("sample")); const submit = button("Upload image");
  await act(async () => { submit.click(); submit.click(); }); assert.equal(h.images.calls.length, 1); assert.equal(h.calls.length, 0);
  await act(async () => prepared.resolve(h.images.bitmap)); assert.equal(h.calls.length, 1);
  const form = one<HTMLFormElement>("form", dialog()); await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal(h.calls.length, 1); assert.equal(radio("sample").matches(":disabled"), true);
  await act(async () => response.resolve(Response.json({ photo: photo("sample") }, { status: 201 }))); assert.equal(h.saved.length, 1); assert.equal(h.calls.length, 1);
});

test("an actor change during preparation resets choice and stops the old image before transport", async t => {
  const prepared = deferred<ImageBitmap>(); const h = await mount(t, Response.json({ photo: photo("sample") }), { bitmap: prepared });
  await chooseFile(); await click(radio("sample")); await click(button("Upload image")); await h.actor("synthetic-actor-b");
  assert.equal(document.querySelector("[role=dialog]"), null); await chooseFile(); neutral();
  await act(async () => prepared.resolve(h.images.bitmap)); assert.equal(h.calls.length, 0); assert.equal(h.saved.length, 0); neutral();
});

test("a late foreign-workspace acknowledgement cannot select a photo, close the new choice or steal its focus", async t => {
  const response = deferred<Response>(); const h = await mount(t, response.promise);
  await chooseFile(); await click(radio("sample")); await click(button("Upload image")); assert.equal(h.calls.length, 1);
  await h.actor("synthetic-actor-b"); await chooseFile(); neutral(); const focus = document.activeElement;
  await act(async () => response.resolve(Response.json({ photo: photo("sample") }, { status: 201 })));
  assert.equal(h.saved.length, 0); assert.equal(h.notices.length, 0); assert.equal(document.activeElement, focus); neutral(); assert.equal(dialog().querySelector("[role=alert]"), null);
});

for (const [name, response] of [
  ["lost response", new Error("Synthetic connection lost after dispatch")],
  ["server error", Response.json({ error: { message: "Do not trust an assertion of guaranteed absence" } }, { status: 503 })],
  ["mismatched source acknowledgement", Response.json({ photo: photo("live") }, { status: 201 })],
] as const) test(`${name} holds another submit and explains the unknown outcome without a retry`, async t => {
  const h = await mount(t, response); const trigger = await chooseFile(); await click(radio("sample")); await click(button("Upload image"));
  assert.match(text(one("[role=alert]", dialog())), /outcome is unknown\. Inspect your saved photos before another upload/); assert.equal(button("Upload image").disabled, true); assert.equal(h.saved.length, 0);
  await act(async () => one<HTMLFormElement>("form", dialog()).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(h.calls.length, 1); await click(button("Close and inspect saved photos")); assert.equal(document.activeElement, trigger); assert.equal(h.notices.length, 1); assert.match(h.notices[0]!, /outcome is unknown/); assert.equal(h.notices[0]!.includes("guaranteed absence"), false);
  await chooseFile(); neutral(); assert.equal(h.calls.length, 1);
});

test("a refused conflicting source is disclosed without changing the saved image or resubmitting", async t => {
  const h = await mount(t, Response.json({ error: { message: "Those bytes already have an immutable Photograph source." } }, { status: 409 }));
  await chooseFile(); await click(radio("sample")); await click(button("Upload image"));
  assert.match(text(one("[role=alert]", dialog())), /immutable Photograph source/); assert.equal(h.saved.length, 0); assert.equal(h.calls.length, 1); assert.equal(button("Upload image").disabled, true);
});

function workspace(id: string): Workspace {
  const kit = seedKit("T2", `${id}-revision`), certificate = verifyKit(kit, profiles, sources, architectures);
  return { session: { id, expiresAt: "2099-01-01T00:00:00.000Z" }, kit, certificate, profiles, sources, architectures, alternatives: [], snapshots: [], receipts: [], events: [], assembly: generateAssembly(kit, profiles), completedSteps: [], repairOptions: [], usage: { discoveryRequests: 0, maxDiscoveryRequests: 80, liveRebuilds: 0, maxLiveRebuilds: 12 } };
}
test("the mounted passport retains Sample input after later workspace activity and clears it for another actor", async t => {
  document.body.innerHTML = "<div id='root'></div>"; imageHarness(t); const calls: Call[] = [], inventory: InventoryWorkspace = { items: [], photos: [], regions: [], history: [], library: [], storageReady: true };
  globalThis.fetch = async (input, init = {}) => { const url = String(input), method = init.method ?? "GET"; calls.push({ path: url, init }); if (url === "/api/inventory" && method === "GET") return Response.json(inventory); if (url === "/api/jobs" && method === "GET") return Response.json({ jobs: [] }); assert.equal(url, "/api/inventory/photos"); assert.equal(method, "POST"); return Response.json({ photo: photo("sample") }, { status: 201 }); };
  const root = createRoot(document.getElementById("root")!); let w = workspace("synthetic-inventory-a"); const refresh = async () => {};
  await act(async () => root.render(createElement(Inventory, { workspace: w, onRefresh: refresh })));
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; document.body.innerHTML = ""; });
  await chooseFile(); await click(radio("sample")); await click(button("Upload image"));
  assert.match(text(one(".photo-strip")), /Sample image/); assert.equal(one<HTMLImageElement>(".photo-strip img").getAttribute("src"), photo("sample").imageUrl); assert.equal(calls.filter(c => c.init.method === "POST").length, 1);
  w = { ...w, usage: { ...w.usage, discoveryRequests: 1, liveRebuilds: 1 } }; await act(async () => root.render(createElement(Inventory, { workspace: w, onRefresh: refresh })));
  assert.match(text(one(".photo-strip")), /Sample image/); assert.equal(calls.length, 3, "Upload creates no job, model/catalog request or automatic retry.");
  await act(async () => root.render(createElement(Inventory, { workspace: workspace("synthetic-inventory-b"), onRefresh: refresh })));
  assert.equal(document.querySelector(".photo-strip"), null); assert.equal(document.querySelector("[role=dialog]"), null);
});
