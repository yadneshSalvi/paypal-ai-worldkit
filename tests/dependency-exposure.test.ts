import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { AxiosStatic, InternalAxiosRequestConfig } from "axios";
import type { HumanMessage as LangChainHumanMessage } from "@langchain/core/messages";
import { ScopedPayPalToolkit } from "../src/server/paypal-toolkit";
import { ToolkitReadInput, type ToolkitOwnedOrder } from "../packages/commerce/toolkit-contracts";

const native = createRequire(import.meta.url);
const axios = native("axios") as AxiosStatic;
const root = fileURLToPath(new URL("../", import.meta.url));
const owned: ToolkitOwnedOrder = { orderId: "app-order-exposure", kitId: "kit-1", revisionId: "revision-1", graphHash: "a".repeat(64), providerOrderId: "PROVIDER-ORDER-1", captureId: "CAPTURE-1", customId: "app-order-exposure", amountMinor: 1200 };
const orderBody = () => ({ id: owned.providerOrderId, status: "COMPLETED", purchase_units: [{ custom_id: owned.customId, payments: { captures: [{ id: owned.captureId, status: "COMPLETED", amount: { currency_code: "USD", value: "12.00" } }] } }] });
const reportBody = () => ({ page: 1, total_items: 0, total_pages: 0, transaction_details: [] });

function transport(responder: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    return responder(url, init);
  };
  return { calls, reader: new ScopedPayPalToolkit("synthetic-id", "synthetic-secret", "synthetic_transport", fetcher) };
}

test("the pinned OpenAI entrypoint constructs only the two reads without loading the other vulnerable adapters", () => {
  // A fresh process keeps unrelated test imports out of this module-load receipt.
  // Both available HTTP seams reject before dispatch, and the child inherits no credentials.
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    const { createRequire } = require('node:module');
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
    req('axios').defaults.adapter = async () => { throw new Error('NETWORK_FORBIDDEN'); };
    const entry = req.resolve('@paypal/agent-toolkit/openai'), own = createRequire(entry);
    const { PayPalAgentToolkit } = req('@paypal/agent-toolkit/openai');
    const toolkit = new PayPalAgentToolkit({ clientId: 'synthetic-id', clientSecret: 'synthetic-secret', configuration: { actions: { orders: { get: true }, transactions: { list: true } }, context: { sandbox: true, debug: false } } });
    process.stdout.write(JSON.stringify({
      entry: path.relative(process.cwd(), entry),
      tools: toolkit.getTools().map(t => t.function.name).sort(),
      loaded: Object.keys(req.cache).map(p => path.relative(process.cwd(), p)),
      rootZod: JSON.parse(fs.readFileSync(req.resolve('zod/package.json'), 'utf8')).version,
      toolkitZod: JSON.parse(fs.readFileSync(own.resolve('zod/package.json'), 'utf8')).version
    }));
  `;
  const child = spawnSync(process.execPath, ["--eval", script], { cwd: root, env: { NODE_ENV: "test" }, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const receipt = JSON.parse(child.stdout) as { entry: string; tools: string[]; loaded: string[]; rootZod: string; toolkitZod: string };
  assert.equal(receipt.entry, "node_modules/@paypal/agent-toolkit/openai/index.js");
  assert.deepEqual(receipt.tools, ["get_order", "list_transactions"]);
  assert.equal(receipt.rootZod, "4.6.7");
  assert.equal(receipt.toolkitZod, "3.25.76"); // Explicit residual dependency, not an audit-clean assertion.
  assert.ok(receipt.loaded.some(path => path.includes("@paypal/agent-toolkit/node_modules/zod/")));
  assert.deepEqual(receipt.loaded.filter(path => /node_modules\/(?:@langchain\/core\/|langsmith\/|uuid\/|jsondiffpatch\/|@ai-sdk\/|ai\/|openai\/)/.test(path)), []);
});

test("the targeted LangChain patch keeps injected serialization metadata as data", async () => {
  const forToolkit = createRequire(native.resolve("@paypal/agent-toolkit/langchain"));
  const { HumanMessage } = forToolkit("@langchain/core/messages") as typeof import("@langchain/core/messages");
  const { load } = forToolkit("@langchain/core/load") as typeof import("@langchain/core/load");
  const injected = { lc: 1, type: "secret", id: ["synthetic_secret"] };
  const message = new HumanMessage({ content: "synthetic text", additional_kwargs: { metadata: injected } });
  const restored = await load<LangChainHumanMessage>(JSON.stringify(message), { secretsMap: { synthetic_secret: "SYNTHETIC_MARKER_MUST_NOT_REPLACE_DATA" } });
  assert.deepEqual(restored.additional_kwargs.metadata, injected);
});

test("targeted LangChain and LangSmith updates retain both structured reads and reject hostile tracing destinations", () => {
  const script = `
    const assert = require('node:assert/strict'), path = require('node:path');
    const { createRequire } = require('node:module');
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    const own = createRequire(req.resolve('@paypal/agent-toolkit/langchain'));
    const forCore = createRequire(own.resolve('@langchain/core/tools'));
    globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
    const axios = req('axios'), calls = [], orderId = 'S'.repeat(17), captureId = 'C'.repeat(17);
    axios.defaults.adapter = async config => {
      const url = new URL(axios.getUri(config)), method = config.method.toUpperCase();
      assert.equal(url.origin, 'https://api.sandbox.paypal.com');
      calls.push([method, url.pathname]);
      let data;
      if (url.pathname === '/v1/oauth2/token') {
        assert.equal(method, 'POST'); assert.equal(config.data, 'grant_type=client_credentials');
        data = { access_token: 'synthetic-token' };
      } else if (url.pathname === '/v2/checkout/orders/' + orderId) {
        assert.equal(method, 'GET'); data = { id: orderId, status: 'COMPLETED' };
      } else {
        assert.equal(method, 'GET'); assert.equal(url.pathname, '/v1/reporting/transactions');
        assert.ok(url.searchParams.getAll('transaction_id').every(value => value === captureId));
        data = { page: 1, total_items: 0, total_pages: 0, transaction_details: [] };
      }
      return { data, status: 200, statusText: 'OK', headers: {}, config };
    };
    (async () => {
      const { PayPalAgentToolkit } = req('@paypal/agent-toolkit/langchain');
      const toolkit = new PayPalAgentToolkit({ clientId: 'synthetic-id', clientSecret: 'synthetic-secret', configuration: { actions: { orders: { get: true }, transactions: { list: true } }, context: { sandbox: true, debug: false } } });
      const tools = toolkit.getTools();
      assert.deepEqual(tools.map(tool => tool.name).sort(), ['get_order', 'list_transactions']);
      await tools.find(tool => tool.name === 'get_order').invoke({ id: orderId });
      await tools.find(tool => tool.name === 'list_transactions').invoke({ transaction_id: captureId, search_months: 1, page_size: 100, page: 1 });
      assert.deepEqual(calls, [['POST', '/v1/oauth2/token'], ['GET', '/v2/checkout/orders/' + orderId], ['GET', '/v1/reporting/transactions']]);
      const { RunTree, convertToDottedOrderFormat } = forCore('langsmith/run_trees');
      const dotted = convertToDottedOrderFormat(Date.now(), 'a36c59bb-e645-4e41-a7fd-a48b1b3260af').dottedOrder;
      const hostile = [{ projectName: 'synthetic', apiUrl: 'https://foreign.invalid/', apiKey: 'synthetic-only', api_url: 'https://foreign.invalid/', api_key: 'synthetic-only' }];
      const run = RunTree.fromHeaders({ 'langsmith-trace': dotted, baggage: 'langsmith-replicas=' + encodeURIComponent(JSON.stringify(hostile)) }, { name: 'synthetic', tracingEnabled: false });
      assert.deepEqual(run.replicas, [{ projectName: 'synthetic' }]);
      process.stdout.write(JSON.stringify({ calls: calls.length, filteredReplicas: run.replicas }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ["--eval", script], { cwd: root, env: { NODE_ENV: "test" }, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.deepEqual(JSON.parse(child.stdout), { calls: 3, filteredReplicas: [{ projectName: "synthetic" }] });
});

test("external collection and schema-shaped payloads cannot become native Toolkit arguments", () => {
  const valid = { requestId: "a36c59bb-e645-4e41-a7fd-a48b1b3260af", orderId: owned.orderId, expectedGraphHash: owned.graphHash, operation: "get_order" };
  for (const field of ["orderId", "expectedGraphHash", "operation"]) {
    const result = ToolkitReadInput.safeParse({ ...valid, [field]: Array(4096).fill({ lc: 1, type: "secret" }) });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.error.issues.length <= 2);
      assert.ok(result.error.issues.every(issue => issue.path[0] === field));
    }
  }
  for (const extra of [{ arguments: { id: "FOREIGN" } }, { schema: { type: "array", items: {} } }, { providerOrderId: "FOREIGN", transaction_id: "FOREIGN" }]) {
    assert.equal(ToolkitReadInput.safeParse({ ...valid, ...extra }).success, false);
  }
  assert.equal(ToolkitReadInput.safeParse({ ...valid, orderId: "x".repeat(101) }).success, false);
});

for (const stage of ["oauth", "resource"] as const) test(`a valid JSON ${stage} response exceeding 1 MiB is cancelled and withheld`, async () => {
  let cancelled = false;
  const tooLarge = { ...(stage === "oauth" ? { access_token: "synthetic-token" } : orderBody()), padding: "x".repeat(1024 * 1024) };
  const body = new TextEncoder().encode(JSON.stringify(tooLarge));
  const h = transport(url => {
    const isToken = url.pathname === "/v1/oauth2/token";
    if ((stage === "oauth") === isToken) return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(body); },
      cancel() { cancelled = true; },
    }), { status: 200 });
    return Response.json(isToken ? { access_token: "synthetic-token" } : orderBody());
  });
  await assert.rejects(h.reader.read("get_order", owned, async () => {}), /did not complete/);
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, stage === "oauth" ? 1 : 2);
});

for (const [name, change] of [
  ["foreign origin", (config: InternalAxiosRequestConfig) => { config.url = "https://foreign.invalid/v1/reporting/transactions"; }],
  ["financial write", (config: InternalAxiosRequestConfig) => { config.method = "POST"; config.url = "https://api.sandbox.paypal.com/v2/payments/captures/CAPTURE-1/refund"; config.data = "{}"; }],
  ["foreign capture", (config: InternalAxiosRequestConfig) => { config.params = { ...config.params, transaction_id: "FOREIGN" }; }],
  ["extra query", (config: InternalAxiosRequestConfig) => { config.params = { ...config.params, arbitrary: "unapproved" }; }],
  ["unbounded page", (config: InternalAxiosRequestConfig) => { config.params = { ...config.params, page_size: 1000000 }; }],
] as const) test(`adversarial native request middleware cannot dispatch ${name}`, async () => {
  const h = transport(url => Response.json(url.pathname === "/v1/oauth2/token" ? { access_token: "synthetic-token" } : reportBody()));
  const interceptor = axios.interceptors.request.use(config => { if (config.method?.toUpperCase() === "GET") change(config); return config; });
  try {
    await assert.rejects(h.reader.read("list_transactions", owned, async () => {}), /did not complete/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.url.pathname, "/v1/oauth2/token");
  } finally { axios.interceptors.request.eject(interceptor); }
});

test("untrusted response metadata stays inert and cannot enter the disclosed observation", async () => {
  const marker = "worldkitSyntheticPrototypePollutionMarker";
  const metadata = JSON.parse(`{"__proto__":{"${marker}":true},"constructor":{"prototype":{"${marker}":true}},"lc":1,"type":"secret","id":["SYNTHETIC_ONLY"]}`) as Record<string, unknown>;
  const h = transport(url => Response.json(url.pathname === "/v1/oauth2/token" ? { access_token: "synthetic-token" } : { ...orderBody(), untrusted_metadata: metadata }));
  const result = await h.reader.read("get_order", owned, async () => {});
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, marker), false);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(JSON.stringify(result).includes("SYNTHETIC_ONLY"), false);
  assert.equal(result.order?.amountMinor, 1200);
});

for (const status of [301, 429, 503]) test(`a synthetic HTTP ${status} cannot become a successful empty reporting observation`, async () => {
  const h = transport(url => Response.json(url.pathname === "/v1/oauth2/token" ? { access_token: "synthetic-token" } : reportBody(), { status: url.pathname === "/v1/oauth2/token" ? 200 : status, headers: { location: "https://foreign.invalid/" } }));
  await assert.rejects(h.reader.read("list_transactions", owned, async () => {}), /did not complete/);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.init.redirect === "error"));
});
