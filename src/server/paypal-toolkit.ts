import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { AxiosAdapter, AxiosStatic, InternalAxiosRequestConfig } from "axios";
import type { PayPalAgentToolkit as NativeToolkit } from "@paypal/agent-toolkit/openai";
import { WorldKitError } from "../../packages/contracts";
import type { ToolkitObservation, ToolkitOwnedOrder, ToolkitReadInput } from "../../packages/commerce/toolkit-contracts";
import { hash } from "../../packages/compatibility";

const requireNative = createRequire(import.meta.url);
// The installed Toolkit uses the public CJS Axios singleton. Keep its middleware
// scoped to this request; the ESM Axios singleton cannot intercept that transport.
const axios = requireNative("axios") as AxiosStatic;
const { PayPalAgentToolkit } = requireNative("@paypal/agent-toolkit/openai") as { PayPalAgentToolkit: typeof NativeToolkit };
const origin = "https://api.sandbox.paypal.com";
const mismatch = () => new WorldKitError("needs_evidence", "PayPal did not establish the exact owned order and capture. The observation was withheld.", 409);
const unavailable = () => new WorldKitError("provider_unavailable", "This PayPal read did not complete. No missing payment or successful payment was inferred.", 502);
type Wire = { status: number; body: unknown; hash: string; at: string; start: string; end: string };
type Context = { operation: ToolkitReadInput["operation"]; owned: ToolkitOwnedOrder; fetcher: typeof fetch; beforeSend: () => Promise<void>; deadline: AbortSignal; requests: number; failed: boolean; reads: Wire[] };
const calls = new AsyncLocalStorage<Context>();
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw mismatch(); return value as Record<string, unknown>; }
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw mismatch(); return value; }
function code(value: unknown): string { if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(value)) throw mismatch(); return value; }
function date(value: unknown): string | null { return typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function money(value: unknown): number {
  const obj = object(value); if (obj.currency_code !== "USD" || typeof obj.value !== "string" || !/^\d{1,10}(?:\.\d{1,2})?$/.test(obj.value)) throw mismatch();
  const [whole, fraction = ""] = obj.value.split("."); const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw mismatch(); return minor;
}
function query(url: URL, key: string, expected?: string): string {
  // Toolkit 1.11.0 can repeat the same query value in its URL and Axios params.
  // Conflicting values, extra values and unapproved keys are never permitted.
  const values = url.searchParams.getAll(key);
  if (!values.length || values.length > 2 || values.some(v => v !== values[0]) || expected !== undefined && values[0] !== expected) throw mismatch();
  return values[0]!;
}
function validateWire(ctx: Context, url: URL, method: string, config: InternalAxiosRequestConfig) {
  if (url.origin !== origin || url.username || url.password || url.hash || ++ctx.requests > 2) throw mismatch();
  if (ctx.requests === 1) {
    if (url.pathname !== "/v1/oauth2/token" || method !== "POST" || url.search || config.data !== "grant_type=client_credentials") throw mismatch(); return;
  }
  if (method !== "GET" || config.data !== undefined) throw mismatch();
  if (ctx.operation === "get_order") {
    if (url.pathname !== `/v2/checkout/orders/${ctx.owned.providerOrderId}` || url.search) throw mismatch(); return;
  }
  if (url.pathname !== "/v1/reporting/transactions" || [...url.searchParams.keys()].some(key => !["transaction_id", "page_size", "page", "start_date", "end_date"].includes(key))) throw mismatch();
  query(url, "transaction_id", ctx.owned.captureId); query(url, "page_size", "100"); query(url, "page", "1");
  const start = Date.parse(query(url, "start_date")), end = Date.parse(query(url, "end_date"));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 31 * 86400000 + 1000 || Math.abs(end - Date.now()) > 60000) throw mismatch();
}
async function boundedJson(response: Response, signal: AbortSignal) {
  if (!response.body) throw mismatch(); const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try { for (;;) { signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) throw mismatch(); parts.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; } catch { throw mismatch(); }
}
const adapter: AxiosAdapter = async config => {
  const ctx = calls.getStore(); if (!ctx) throw mismatch();
  try {
    const url = new URL(axios.getUri(config)), method = (config.method ?? "GET").toUpperCase(); validateWire(ctx, url, method, config);
    await ctx.beforeSend(); ctx.deadline.throwIfAborted();
    const headers = new Headers(); for (const [key, value] of Object.entries(config.headers.toJSON())) if (value !== null && value !== undefined) headers.set(key, String(value));
    const response = await ctx.fetcher(url, { method, headers, body: method === "POST" ? String(config.data) : undefined, signal: ctx.deadline, redirect: "error" });
    const body = await boundedJson(response, ctx.deadline); if (!response.ok) throw unavailable();
    if (method === "POST") { const token = object(body); if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 10000 || /\s/.test(token.access_token)) throw mismatch(); }
    else ctx.reads.push({ status: response.status, body, hash: hash(body), at: new Date().toISOString(), start: url.searchParams.get("start_date") ?? "", end: url.searchParams.get("end_date") ?? "" });
    return { data: body, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), config };
  } catch (error) { ctx.failed = true; throw error instanceof WorldKitError ? error : unavailable(); }
};
axios.interceptors.request.use(config => calls.getStore() ? { ...config, adapter, proxy: false, maxRedirects: 0, timeout: 15000 } : config);

export interface ToolkitReader { read(operation: ToolkitReadInput["operation"], owned: ToolkitOwnedOrder, beforeSend: () => Promise<void>): Promise<ToolkitObservation> }
export class ScopedPayPalToolkit implements ToolkitReader {
  constructor(private readonly clientId: string, private readonly clientSecret: string, readonly mode: "sandbox" | "synthetic_transport" = "sandbox", private readonly fetcher: typeof fetch = globalThis.fetch) {}
  async read(operation: ToolkitReadInput["operation"], owned: ToolkitOwnedOrder, beforeSend: () => Promise<void>): Promise<ToolkitObservation> {
    if (!["get_order", "list_transactions"].includes(operation) || ![owned.providerOrderId, owned.captureId, owned.customId].every(id => /^[A-Za-z0-9_-]{1,150}$/.test(id)) || !Number.isSafeInteger(owned.amountMinor) || owned.amountMinor <= 0) throw mismatch();
    if (process.env.DEBUG && /agent-toolkit|\*/.test(process.env.DEBUG)) throw new WorldKitError("provider_unavailable", "Private payment reads require Toolkit diagnostics to be disabled.", 503);
    const toolkit = new PayPalAgentToolkit({ clientId: this.clientId, clientSecret: this.clientSecret, configuration: { actions: { orders: { get: true }, transactions: { list: true } }, context: { sandbox: true, debug: false } } });
    const names = toolkit.getTools().filter(tool => tool.type === "function").map(tool => tool.function.name).sort();
    if (hash(names) !== hash(["get_order", "list_transactions"])) throw new WorldKitError("provider_unavailable", "The installed PayPal read inventory differs from the qualified contract.", 503);
    const args = operation === "get_order" ? { id: owned.providerOrderId } : { transaction_id: owned.captureId, search_months: 1, page_size: 100, page: 1 };
    const ctx: Context = { operation, owned, fetcher: this.fetcher, beforeSend, deadline: AbortSignal.timeout(20000), requests: 0, failed: false, reads: [] };
    await calls.run(ctx, async () => { try { await toolkit.handleToolCall({ id: "worldkit-owned-read", type: "function", function: { name: operation, arguments: JSON.stringify(args) } }); } catch { ctx.failed = true; } });
    // Some Toolkit reporting errors become found:false. Only an independently
    // observed successful wire response can establish a provider observation.
    if (ctx.failed || ctx.requests !== 2 || ctx.reads.length !== 1) throw unavailable();
    await beforeSend();
    const wire = ctx.reads[0]!, body = object(wire.body); let order: ToolkitObservation["order"] = null, reporting: ToolkitObservation["reporting"] = null;
    if (operation === "get_order") {
      if (body.id !== owned.providerOrderId) throw mismatch(); const units = list(body.purchase_units, 1); if (units.length !== 1) throw mismatch(); const unit = object(units[0]);
      if (unit.custom_id !== owned.customId) throw mismatch(); const captures = list(object(unit.payments).captures, 1); if (captures.length !== 1) throw mismatch(); const capture = object(captures[0]);
      if (capture.id !== owned.captureId || money(capture.amount) !== owned.amountMinor) throw mismatch();
      order = { status: code(body.status), captureStatus: code(capture.status), amountMinor: owned.amountMinor, currency: "USD", occurredAt: date(capture.create_time) };
    } else {
      if (!Array.isArray(body.transaction_details) && !(body.total_items === 0 && body.total_pages === 0)) throw mismatch();
      const rows = list(body.transaction_details ?? [], 100).map(row => object(object(row).transaction_info));
      if (body.page !== 1 || !Number.isSafeInteger(body.total_items) || !Number.isSafeInteger(body.total_pages) || Number(body.total_items) < rows.length || Number(body.total_pages) < 0 || rows.length > 1 || Number(body.total_items) > 0 && Number(body.total_pages) < 1) throw mismatch();
      const row = rows[0]; if (row && (row.transaction_id !== owned.captureId || money(row.transaction_amount) !== owned.amountMinor)) throw mismatch();
      reporting = { observed: !!row, status: row ? code(row.transaction_status) : null, amountMinor: row ? owned.amountMinor : null, occurredAt: row ? date(row.transaction_initiation_date) : null, start: wire.start, end: wire.end, page: 1, pageSize: 100, totalItems: Number(body.total_items), totalPages: Number(body.total_pages), refreshedAt: date(body.last_refreshed_datetime), complete: false };
    }
    return { source: this.mode, transport: "Toolkit", package: "@paypal/agent-toolkit@1.11.0", operation, observedAt: wire.at, bodyHash: wire.hash, httpStatus: wire.status, binding: { ...owned }, order, reporting, disclosure: operation === "get_order" ? "A current read of this exact sandbox order and owned capture. It does not change the original receipt or reconcile payment state." : "One bounded reporting page for this exact capture. Reporting can lag; absence does not prove that a capture or refund is missing. This does not reconcile payment state." };
  }
}
