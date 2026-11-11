import test from "node:test";
import assert from "node:assert/strict";
import { ScopedPayPalToolkit } from "../src/server/paypal-toolkit";
import { ToolkitReadInput, type ToolkitOwnedOrder } from "../packages/commerce/toolkit-contracts";

const owned: ToolkitOwnedOrder = { orderId: "app-order-1", kitId: "kit-1", revisionId: "revision-1", graphHash: "a".repeat(64), providerOrderId: "PROVIDER-ORDER-1", captureId: "CAPTURE-1", customId: "app-order-1", amountMinor: 1200 };
const orderBody = () => ({ id: owned.providerOrderId, status: "COMPLETED", payer: { email_address: "must-never-escape@example.invalid" }, purchase_units: [{ custom_id: owned.customId, payments: { captures: [{ id: owned.captureId, status: "REFUNDED", amount: { currency_code: "USD", value: "12.00" }, create_time: "2026-11-10T12:00:00Z" }] } }] });
const reportBody = () => ({ page: 1, total_items: 1, total_pages: 1, last_refreshed_datetime: "2026-11-10T12:00:00Z", transaction_details: [{ transaction_info: { transaction_id: owned.captureId, transaction_status: "S", transaction_amount: { currency_code: "USD", value: "12.00" }, transaction_initiation_date: "2026-11-10T10:00:00Z" }, payer_info: { email_address: "must-never-escape@example.invalid" } }] });
function harness(body: unknown, status = 200) {
  const calls: { url: URL; init: RequestInit }[] = []; let gates = 0;
  const fetcher: typeof fetch = async (input, init = {}) => { const url = new URL(String(input)); calls.push({ url, init }); return Response.json(url.pathname === "/v1/oauth2/token" ? { access_token: "synthetic-token", token_type: "Bearer", expires_in: 300 } : body, { status: url.pathname === "/v1/oauth2/token" ? 200 : status }); };
  return { reader: new ScopedPayPalToolkit("synthetic-id", "synthetic-secret", "synthetic_transport", fetcher), calls, gate: async () => { gates++; }, gates: () => gates };
}
test("installed official Toolkit uses exactly OAuth and owned GET, with safe observation", async () => {
  const h = harness(orderBody()); const result = await h.reader.read("get_order", owned, h.gate);
  assert.equal(result.source, "synthetic_transport"); assert.equal(result.order?.captureStatus, "REFUNDED"); assert.equal(result.httpStatus, 200); assert.equal(h.gates(), 3);
  assert.deepEqual(h.calls.map(c => [c.init.method, c.url.origin, c.url.pathname]), [["POST", "https://api.sandbox.paypal.com", "/v1/oauth2/token"], ["GET", "https://api.sandbox.paypal.com", `/v2/checkout/orders/${owned.providerOrderId}`]]);
  assert.ok(h.calls.every(c => c.init.redirect === "error" && c.init.signal)); assert.equal(h.calls[0]!.init.body, "grant_type=client_credentials"); assert.equal(h.calls[1]!.init.body, undefined);
  assert.equal(JSON.stringify(result).includes("must-never-escape"), false); assert.equal(JSON.stringify(result).includes("synthetic-secret"), false); assert.match(result.bodyHash, /^[a-f0-9]{64}$/);
});
test("reporting is bounded to exact capture and one page; raw payer data stays private", async () => {
  const h = harness(reportBody()); const result = await h.reader.read("list_transactions", owned, h.gate); const query = h.calls[1]!.url.searchParams;
  assert.ok(query.getAll("transaction_id").every(id => id === owned.captureId)); assert.equal(query.get("page"), "1"); assert.equal(query.get("page_size"), "100");
  assert.ok(Date.parse(query.get("end_date")!) - Date.parse(query.get("start_date")!) <= 31 * 86400000 + 1000);
  assert.equal(result.reporting?.complete, false); assert.equal(result.reporting?.observed, true); assert.equal(result.reporting?.status, "S"); assert.ok(!JSON.stringify(result).includes("must-never-escape"));
});
test("empty bounded reporting is inconclusive, never a false missing capture", async () => {
  const h = harness({ page: 1, total_items: 0, total_pages: 0 }); const result = await h.reader.read("list_transactions", owned, h.gate);
  assert.equal(result.reporting?.observed, false); assert.equal(result.reporting?.complete, false); assert.match(result.disclosure, /absence does not prove/);
});
for (const [name, change] of [
  ["foreign order", (b: ReturnType<typeof orderBody>) => { b.id = "FOREIGN"; }],
  ["foreign capture", (b: ReturnType<typeof orderBody>) => { b.purchase_units[0]!.payments.captures[0]!.id = "FOREIGN"; }],
  ["wrong custom identity", (b: ReturnType<typeof orderBody>) => { b.purchase_units[0]!.custom_id = "FOREIGN"; }],
  ["wrong amount", (b: ReturnType<typeof orderBody>) => { b.purchase_units[0]!.payments.captures[0]!.amount.value = "11.99"; }],
  ["fractional minor units", (b: ReturnType<typeof orderBody>) => { b.purchase_units[0]!.payments.captures[0]!.amount.value = "12.001"; }],
  ["foreign currency", (b: ReturnType<typeof orderBody>) => { b.purchase_units[0]!.payments.captures[0]!.amount.currency_code = "EUR"; }],
] as const) test(`rejects ${name} before disclosure`, async () => { const body = orderBody(); change(body); const h = harness(body); await assert.rejects(h.reader.read("get_order", owned, h.gate), /owned order and capture/); });
test("Toolkit swallowed provider reporting failure cannot become empty success", async () => { const h = harness({ error: "synthetic upstream refusal" }, 503); await assert.rejects(h.reader.read("list_transactions", owned, h.gate), /did not complete/); assert.equal(h.calls.length, 2); });
test("revocation before resource GET prevents that dispatch", async () => { const h = harness(orderBody()); let n = 0; await assert.rejects(h.reader.read("get_order", owned, async () => { if (++n === 2) throw new Error("revoked"); })); assert.equal(h.calls.length, 1); });
test("revocation after provider response withholds the observation", async () => { const h = harness(orderBody()); let n = 0; await assert.rejects(h.reader.read("get_order", owned, async () => { if (++n === 3) throw new Error("revoked"); })); assert.equal(h.calls.length, 2); });
test("unsafe provider IDs and financial operation names never enter transport", async () => { const h = harness(orderBody()); await assert.rejects(h.reader.read("get_order", { ...owned, providerOrderId: "x/../../refunds" }, h.gate)); await assert.rejects(h.reader.read("pay_order" as "get_order", owned, h.gate)); assert.equal(h.calls.length, 0); });
test("external input rejects arbitrary provider fields", () => { assert.equal(ToolkitReadInput.safeParse({ requestId: crypto.randomUUID(), orderId: "app-order-1", expectedGraphHash: owned.graphHash, operation: "get_order", providerOrderId: "FORGED" }).success, false); });
test("concurrent contexts retain distinct capture and order bindings", async () => {
  const second = { ...owned, providerOrderId: "ORDER-2", captureId: "CAPTURE-2", orderId: "app-order-2", customId: "app-order-2" }, body = orderBody(); body.id = second.providerOrderId; body.purchase_units[0]!.custom_id = second.customId; body.purchase_units[0]!.payments.captures[0]!.id = second.captureId;
  const a = harness(orderBody()), b = harness(body); const results = await Promise.all([a.reader.read("get_order", owned, a.gate), b.reader.read("get_order", second, b.gate)]);
  assert.deepEqual(results.map(r => r.binding.captureId), ["CAPTURE-1", "CAPTURE-2"]); assert.equal(a.calls.length, 2); assert.equal(b.calls.length, 2);
});
