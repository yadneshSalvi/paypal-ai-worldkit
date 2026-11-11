import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import sharp from "sharp";
import jsQR from "jsqr";
import type { PublicRecordDesk, PublicRecordSnapshot, PublicRecordView } from "../packages/public-record";

const args = process.argv.slice(2), arg = (name: string) => args[args.indexOf(name) + 1];
if (!args.includes("--origin")) throw new Error("Supply --origin with the exact stable origin. This creates two new Sample workspaces and withdraws its own publications.");
const target = new URL(arg("--origin")!);
const local = ["localhost", "127.0.0.1"].includes(target.hostname);
if (target.username || target.password || target.search || target.hash || target.pathname !== "/" || (!local && (target.protocol !== "https:" || target.port))) throw new Error("Use a bare stable HTTPS origin, or an isolated loopback QA origin.");
if (local && target.origin !== "http://127.0.0.1:4508") throw new Error("Local rehearsal is restricted to the isolated certificate runtime on port 4508.");
if (local && !args.includes("--evidence")) throw new Error("A local rehearsal requires its own --evidence path; do not overwrite hosted evidence.");
const origin = target.origin;
const publicTarget = new URL(args.includes("--public-origin") ? arg("--public-origin")! : origin);
const sameLocalOrigin = local && publicTarget.origin === origin;
if (publicTarget.username || publicTarget.password || publicTarget.search || publicTarget.hash || publicTarget.pathname !== "/" || (!sameLocalOrigin && (publicTarget.protocol !== "https:" || publicTarget.port))) throw new Error("Use a bare stable HTTPS --public-origin. Only an identical isolated loopback origin is allowed for local rehearsal.");
const publicOrigin = publicTarget.origin;
const evidencePath = args.includes("--evidence") ? arg("--evidence")! : "docs/evidence/certificate-hosted-qualification.json";
const recoveryPath = `.local/certificate-qualification/${randomUUID()}.json`;
const checks: Record<string, boolean> = {};
let cookie = "", grantId: string | undefined, cleanupRequired = false;
let slug: string | undefined;
async function recovery() {
  await mkdir(dirname(recoveryPath), { recursive: true, mode: 0o700 });
  await writeFile(recoveryPath, JSON.stringify({ origin, cookie, grantId, slug, cleanupRequired, updatedAt: new Date().toISOString(), mode: "Sample qualification only" }, null, 2) + "\n", { mode: 0o600 });
}
async function request(path: string, method = "GET", body?: unknown, auth = true, expected = 200, requestCookie = cookie, requestOrigin = origin) {
  const response = await fetch(`${origin}${path}`, { method, headers: { ...(auth && requestCookie ? { Cookie: requestCookie } : {}), ...(body === undefined ? {} : { Origin: requestOrigin, "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, expected, `${method} ${path}`);
  return response;
}
async function json<T>(path: string, method = "GET", body?: unknown, auth = true, expected = 200, requestCookie = cookie): Promise<T> { return (await request(path, method, body, auth, expected, requestCookie)).json() as Promise<T>; }
async function action(body: Record<string, unknown>, requestId = randomUUID()) { return json<{ record: PublicRecordSnapshot; replayed: boolean }>("/api/records", "POST", { requestId, ...body }); }
function exact(record: PublicRecordSnapshot) { return { recordId: record.id, expectedVersion: record.version, expectedContentHash: record.contentHash, expectedRevisionId: record.payload.revisionId, expectedGraphHash: record.payload.graphHash, expectedShareVersion: record.shareVersion }; }
async function prepare(title: string) { const desk = await json<PublicRecordDesk>("/api/records"); return (await action({ action: "prepare", title, expectedRevisionId: desk.revisionId, expectedGraphHash: desk.graphHash, expectedShareVersion: desk.share?.version ?? 0 })).record; }
async function review(record: PublicRecordSnapshot) { return (await action({ action: "review", ...exact(record), reviewedDisplayFields: true, understoodScope: true })).record; }
function noStore(response: Response) { assert.match(response.headers.get("cache-control") ?? "", /no-store/); assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/); assert.equal(response.headers.get("referrer-policy"), "no-referrer"); }
async function withdraw() { const desk = await json<PublicRecordDesk>("/api/records"); if (desk.share && desk.records.some(record => record.state === "published")) await action({ action: "withdraw", expectedShareVersion: desk.share.version }); }

try {
  const created = await request("/api/workspace", "POST", {}, false, 201);
  cookie = created.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(cookie, local ? /^wk_certificate_qa=/ : /^wk_session=/);
  await recovery();
  await request("/api/records", "GET", undefined, false, 401);
  await request("/api/records", "POST", { action: "prepare" }, true, 403, cookie, "https://foreign.invalid");
  const second = await request("/api/workspace", "POST", {}, false, 201), foreignCookie = second.headers.get("set-cookie")!.split(";")[0]!;
  checks.newPrivateWorkspacesAndOriginBoundary = true;

  const first = await prepare("Sample certificate deployment qualification");
  slug = first.slug; await recovery();
  const base = `/api/public-records/${first.slug}`, page = `/record/${first.slug}`;
  noStore(await request(`${base}/e/${first.edition}`, "GET", undefined, false, 404));
  await json("/api/records", "POST", { action: "publish", requestId: randomUUID(), ...exact(first), confirmPublicAccess: true }, true, 403);
  await json("/api/records", "POST", { action: "review", requestId: randomUUID(), ...exact(first), reviewedDisplayFields: false, understoodScope: true }, true, 400);
  const foreignDesk = await json<PublicRecordDesk>("/api/records", "GET", undefined, true, 200, foreignCookie);
  assert.equal(foreignDesk.records.length, 0);
  await json("/api/records", "POST", { action: "review", requestId: randomUUID(), ...exact(first), reviewedDisplayFields: true, understoodScope: true }, true, 404, foreignCookie);
  const reviewed = await review(first);
  await request(`${base}/e/${first.edition}`, "GET", undefined, false, 404);
  checks.privateDraftReviewAndTenantIsolation = true;

  const publishInput = { action: "publish", ...exact(reviewed), confirmPublicAccess: true }, publishId = randomUUID();
  cleanupRequired = true;
  await recovery();
  const pair = await Promise.all([action(publishInput, publishId), action(publishInput, publishId)]);
  assert.equal(pair.filter(result => result.replayed).length, 1); assert.equal(pair[0]!.record.id, pair[1]!.record.id);
  checks.concurrentPublishIdempotence = true;
  const current = await json<PublicRecordView>(base, "GET", undefined, false);
  assert.equal(current.record?.contentHash, first.contentHash); assert.deepEqual(current.record?.payload, first.payload);
  assert.equal(current.editionUrl, `${publicOrigin}${page}/e/1`);
  assert.equal(current.record?.payload.physicalTest, "not_performed"); assert.ok(first.payload.counts.unknown > 0);
  for (const path of [page, `${page}/e/1`, `${page}/e/1/guide`, `${page}/e/1/print`]) {
    const response = await request(path, "GET", undefined, false); noStore(response);
    const html = await response.text(); assert.ok(html.includes(first.payload.title)); assert.ok(html.includes(first.payload.graphHash));
  }
  for (const path of [base, `${base}/e/1`, `${base}/e/1/guide`]) noStore(await request(path, "GET", undefined, false));
  checks.exactPublicProjectionAndServerRenderedNoStore = true;

  const qr = await request(`${base}/e/1/qr`, "GET", undefined, false); noStore(qr); assert.match(qr.headers.get("content-type") ?? "", /image\/png/);
  const pixels = await sharp(Buffer.from(await qr.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(jsQR(new Uint8ClampedArray(pixels.data), pixels.info.width, pixels.info.height)?.data, `${publicOrigin}${page}/e/1`);
  checks.qrDecodesToStableImmutableEdition = true;
  noStore(await request(`${base}/e/999999`, "GET", undefined, false, 404));
  await request("/record/unknown", "GET", undefined, false, 404); checks.unknownLinksDenied = true;

  const grant = await json<{ token: string; id: string }>("/api/access", "POST", { scopes: ["kit:verify"] }); grantId = grant.id;
  await recovery();
  const client = new Client({ name: "worldkit-certificate-deployment-qualification", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }));
  try {
    const resources = await client.listResources(); assert.equal(resources.resources.length, 2);
    for (const resource of resources.resources) {
      const response = await client.readResource({ uri: resource.uri }), data = JSON.parse((response.contents[0] as { text: string }).text);
      assert.equal(data.graphHash, first.payload.graphHash); assert.equal(data.contentHash, first.contentHash);
    }
    await json("/api/access", "DELETE", { id: grant.id }); grantId = undefined;
    await recovery();
    await assert.rejects(() => client.readResource({ uri: resources.resources[0]!.uri }));
    checks.mcpTransportIdentityAndRevocation = true;
  } finally { await client.close().catch(() => {}); }

  await json("/api/kit", "PATCH", { expectedRevisionId: first.payload.revisionId, expectedGraphHash: first.payload.graphHash, edit: { kind: "connection", connectionId: "mic2-audio", enabled: false } });
  const next = (await action({ action: "publish", ...exact(await review(await prepare("Sample deployment qualification · disabled path"))), confirmPublicAccess: true })).record;
  const history = await json<PublicRecordView>(`${base}/e/1`, "GET", undefined, false);
  assert.equal(history.revisionState, "superseded"); assert.equal(history.record?.contentHash, first.contentHash);
  assert.equal((await json<PublicRecordView>(base, "GET", undefined, false)).record?.id, next.id);
  assert.equal(next.payload.assembly.find(step => step.connectionId === "mic2-audio")?.enabled, false);
  checks.immutableHistoryCurrentEditionAndDisabledGuide = true;

  await withdraw(); cleanupRequired = false;
  await recovery();
  for (const path of [base, `${base}/e/1`, `${base}/e/1/guide`, `${base}/e/1/qr`, `${base}/e/2`, `${base}/e/2/guide`, `${base}/e/2/qr`]) {
    const response = await request(path, "GET", undefined, false, 410); noStore(response); assert.equal((await response.json()).record, null);
  }
  for (const path of [page, `${page}/e/1`, `${page}/e/1/guide`, `${page}/e/1/print`, `${page}/e/2`, `${page}/e/2/guide`, `${page}/e/2/print`]) {
    const response = await request(path, "GET", undefined, false); noStore(response); const html = await response.text();
    assert.equal(html.includes(first.payload.title), false); assert.equal(html.includes(next.payload.title), false); assert.equal(html.includes(first.contentHash), false); assert.ok(html.includes("no longer shared"));
  }
  const replay = await action(publishInput, publishId); assert.equal(replay.replayed, true); assert.equal(replay.record.state, "withdrawn");
  checks.withdrawalClosesAllHistoricalAndCurrentSurfaces = true;
  checks.oldPublishRetryCannotResurrectWithdrawal = true;

  const evidence = { observedAt: new Date().toISOString(), environment: local ? "isolated local rehearsal of deployment qualification" : "hosted HTTP qualification", requestOrigin: origin, publicOrigin, transport: "Actual HTTP and MCP SDK Streamable HTTP", checks, checkCount: Object.keys(checks).length, providerCalls: 0, physicalTests: 0, independentHumanReviews: 0, fixtures: "Two new Sample workspaces; automated privacy review; all created public editions withdrawn and MCP grant revoked", sourceAvailabilityAndSessionExpiry: "Covered by isolated PostgreSQL and local HTTP suites; this script does not change deployed source documents or session expiry", nativePrintReview: "Separate native browser evidence required" };
  await mkdir(dirname(evidencePath), { recursive: true }); await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ status: "passed", requestOrigin: origin, publicOrigin, checks: Object.keys(checks).length, evidencePath, recoveryPath, createdPublicEditionsWithdrawn: true, providerCalls: 0 }));
} finally {
  if (cookie && grantId) await json("/api/access", "DELETE", { id: grantId }).then(() => { grantId = undefined; }).catch(() => { console.error(`Qualification MCP grant cleanup needs a retry; private recovery is saved at ${recoveryPath}.`); });
  if (cookie && cleanupRequired) await withdraw().then(() => { cleanupRequired = false; }).catch(() => { console.error(`Qualification publication cleanup needs a retry; private recovery is saved at ${recoveryPath}.`); });
  if (cookie) await recovery();
}
