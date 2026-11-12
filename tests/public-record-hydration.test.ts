import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { JSDOM } from "jsdom";
import { architectures, profiles, seedKit, sources } from "../packages/device-library";
import { verifyKit } from "../packages/compatibility";
import { projectPublicRecord, publicRecordHash, type PublicRecordView } from "../packages/public-record";
import { RecordReader } from "../src/components/record-reader";

// Parse actual server HTML before hydrating installed React, so browser repair
// and text-node differences are observable. No application or external requests.
function fixture(): PublicRecordView {
  const kit = seedKit(), certificate = verifyKit(kit, profiles, sources, architectures);
  const payload = projectPublicRecord({ kit, profiles, sources, certificate }, "A Sample studio & its open questions", "2026-11-11T09:00:00.000Z");
  return {
    state: "published", revisionState: "current", sourceState: "recorded",
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    editionUrl: "https://worldkit.test/record/synthetic-public-record/e/1",
    record: { id: "synthetic-record", slug: "synthetic-public-record", edition: 1, version: 1, shareVersion: 1, state: "published", contentHash: publicRecordHash(payload), payload, reviewedAt: "2026-11-11T09:01:00.000Z", publishedAt: "2026-11-11T09:02:00.000Z", withdrawnAt: null },
  };
}

for (const mode of ["certificate", "guide", "print"] as const) {
  test(`public ${mode} hydrates parsed server HTML without replacement or warnings`, async () => {
    const view = fixture(), record = view.record!;
    const props = { initialView: view, slug: record.slug, edition: 1, mode };
    const errors: string[] = [], warnings: string[] = [];
    const originalError = console.error, originalWarn = console.warn, originalFetch = globalThis.fetch;
    const previous = new Map<string, PropertyDescriptor | undefined>();
    let dom: JSDOM | undefined, root: ReturnType<(typeof import("react-dom/client"))["hydrateRoot"]> | undefined, requests = 0;
    console.error = (...args) => { warnings.push(args.map(String).join(" ")); };
    console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
    try {
      const html = renderToString(createElement(RecordReader, props));
      dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`, { url: "https://worldkit.test/", pretendToBeVisual: true });
      for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
        previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
      }
      globalThis.fetch = async () => { requests++; throw new Error("Hydration must not issue a request"); };
      await new Promise<void>(resolve => setImmediate(resolve));
      const container = document.getElementById("root")!, originalArticle = container.querySelector(".record-paper"), originalSvg = container.querySelector(".record-diagram svg");
      const { hydrateRoot } = await import("react-dom/client");
      await act(async () => { root = hydrateRoot(container, createElement(RecordReader, props), { onRecoverableError(error) { errors.push(String(error)); } }); });
      assert.deepEqual(errors, [], "No recoverable hydration error");
      assert.deepEqual(warnings, [], "Server and browser rendering are warning-free");
      assert.equal(container.querySelector(".record-paper"), originalArticle, "Retain the server-rendered article");
      assert.equal(container.querySelector(".record-diagram svg"), originalSvg, "Retain the server-rendered diagram");
      assert.equal(originalSvg?.querySelector("title")?.textContent, `Schematic of ${record.payload.title}`);
      for (const id of originalSvg!.getAttribute("aria-labelledby")!.split(" ")) assert.ok(document.getElementById(id), `Diagram description ${id} exists`);
      assert.match(container.textContent!, /PHYSICAL TESTNOT PERFORMED/);
      assert.ok(container.textContent!.includes(record.payload.graphHash));
      assert.equal(requests, 0);
    } finally {
      if (root) await act(async () => root!.unmount());
      dom?.window.close();
      for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
      globalThis.fetch = originalFetch; console.error = originalError; console.warn = originalWarn;
    }
  });
}
