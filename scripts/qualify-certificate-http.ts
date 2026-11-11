import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import sharp from "sharp";
import jsQR from "jsqr";
import type { Workspace } from "../packages/contracts";
import type { PublicRecordDesk, PublicRecordSnapshot, PublicRecordView } from "../packages/public-record";
import { closeDatabase, database } from "../src/server/db";

if (process.env.WORLDKIT_QA_MODE !== "certificate" || process.env.WORLDKIT_PUBLIC_URL !== "http://127.0.0.1:4508") throw new Error("Use the isolated certificate QA launcher on port 4508.");
const origin = process.env.WORLDKIT_PUBLIC_URL;
const checks: Record<string, boolean> = {};
let cookie = "";
async function request(path: string, method = "GET", body?: unknown, auth = true, expected = 200, customOrigin = origin) {
  const response = await fetch(`${origin}${path}`, { method, headers: { ...(auth && cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: customOrigin }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", redirect: "manual" });
  assert.equal(response.status, expected, `${method} ${path} status`);
  return response;
}
async function json<T>(path: string, method = "GET", body?: unknown, auth = true, expected = 200): Promise<T> { return (await request(path, method, body, auth, expected)).json() as Promise<T>; }
async function action(body: Record<string, unknown>) { return json<{ record: PublicRecordSnapshot | null; replayed: boolean }>("/api/records", "POST", { requestId: randomUUID(), ...body }); }
async function prepare(title: string) {
  const desk = await json<PublicRecordDesk>("/api/records");
  return (await action({ action: "prepare", title, expectedRevisionId: desk.revisionId, expectedGraphHash: desk.graphHash, expectedShareVersion: desk.share?.version ?? 0 })).record!;
}
function exact(record: PublicRecordSnapshot) { return { recordId: record.id, expectedVersion: record.version, expectedContentHash: record.contentHash, expectedRevisionId: record.payload.revisionId, expectedGraphHash: record.payload.graphHash, expectedShareVersion: record.shareVersion }; }
async function publish(record: PublicRecordSnapshot) {
  const reviewed = (await action({ action: "review", ...exact(record), reviewedDisplayFields: true, understoodScope: true })).record!;
  return (await action({ action: "publish", ...exact(reviewed), confirmPublicAccess: true })).record!;
}

try {
  const created = await request("/api/workspace", "POST", {}, false, 201);
  cookie = created.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(cookie, /^wk_certificate_qa=/); const workspace = await created.json() as Workspace;
  checks.separateQaCookie = true;
  await request("/api/records", "GET", undefined, false, 401);
  await request("/api/records", "POST", { action: "prepare" }, true, 403, "https://foreign.invalid");
  checks.privateAuthAndForeignOriginDenied = true;
  const first = await prepare("Sample studio · immutable HTTP edition");
  const base = `/api/public-records/${first.slug}`;
  await request(`${base}/e/${first.edition}`, "GET", undefined, false, 404);
  await json("/api/records", "POST", { action: "publish", requestId: randomUUID(), ...exact(first), confirmPublicAccess: true }, true, 403);
  await json("/api/records", "POST", { action: "review", requestId: randomUUID(), ...exact(first), reviewedDisplayFields: false, understoodScope: true }, true, 400);
  checks.unreviewedAndUncheckedPublicationDenied = true;
  const reviewed = (await action({ action: "review", ...exact(first), reviewedDisplayFields: true, understoodScope: true })).record!;
  await request(`${base}/e/${first.edition}`, "GET", undefined, false, 404);
  const input = { action: "publish", requestId: randomUUID(), ...exact(reviewed), confirmPublicAccess: true };
  const duplicate = await Promise.all([json<{ record: PublicRecordSnapshot; replayed: boolean }>("/api/records", "POST", input), json<{ record: PublicRecordSnapshot; replayed: boolean }>("/api/records", "POST", input)]);
  assert.equal(duplicate.filter(value => value.replayed).length, 1); assert.equal(duplicate[0].record.id, duplicate[1].record.id);
  checks.actualHttpIdempotentPublication = true;
  const publicView = await json<PublicRecordView>(base, "GET", undefined, false);
  assert.equal(publicView.record!.contentHash, first.contentHash); assert.equal(publicView.record!.payload.graphHash, workspace.certificate.graphHash);
  assert.deepEqual(publicView.record!.payload.assembly, first.payload.assembly); assert.equal(publicView.record!.payload.physicalTest, "not_performed");
  for (const path of [`/record/${first.slug}`, `/record/${first.slug}/e/${first.edition}`, `/record/${first.slug}/e/${first.edition}/guide`, `/record/${first.slug}/e/${first.edition}/print`]) {
    const response = await request(path, "GET", undefined, false); assert.match(response.headers.get("cache-control")!, /no-store/);
    const html = await response.text(); assert.ok(html.includes(first.payload.title)); assert.ok(html.includes(first.payload.graphHash));
  }
  checks.serverRenderedCurrentHistoricalGuidePrintNoStore = true;
  const qr = await request(`${base}/e/${first.edition}/qr`, "GET", undefined, false);
  assert.match(qr.headers.get("cache-control")!, /no-store/); const pixels = await sharp(Buffer.from(await qr.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(jsQR(new Uint8ClampedArray(pixels.data), pixels.info.width, pixels.info.height)?.data, `${origin}/record/${first.slug}/e/${first.edition}`);
  checks.actualHttpQrDecodesToImmutableEdition = true;
  await request(`${base}/e/999999`, "GET", undefined, false, 404);
  await request("/record/unknown", "GET", undefined, false, 404);
  checks.unknownLinksReturn404 = true;

  const grant = await json<{ token: string; id: string }>("/api/access", "POST", { scopes: ["kit:verify"] });
  const client = new Client({ name: "worldkit-certificate-http-qa", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }));
  try {
    const resources = await client.listResources(); assert.equal(resources.resources.length, 2);
    for (const resource of resources.resources) {
      const response = await client.readResource({ uri: resource.uri });
      const data = JSON.parse((response.contents[0] as { text: string }).text);
      assert.equal(data.graphHash, first.payload.graphHash); assert.equal(data.contentHash, first.contentHash);
    }
    const verified = await client.callTool({ name: "verify_kit", arguments: { kit_revision_id: first.payload.revisionId, expected_graph_hash: first.payload.graphHash, freshness_policy: "historical" } });
    assert.equal((verified.structuredContent as { certificate: { id: string } }).certificate.id, first.payload.certificateId);
    await json("/api/access", "DELETE", { id: grant.id });
    await assert.rejects(() => client.readResource({ uri: resources.resources[0]!.uri }));
    checks.externalMcpHttpIdentityAndRevocation = true;
  } finally { await client.close().catch(() => {}); }

  await json("/api/kit", "PATCH", { expectedRevisionId: first.payload.revisionId, expectedGraphHash: first.payload.graphHash, edit: { kind: "connection", connectionId: "mic2-audio", enabled: false } });
  assert.equal((await json<PublicRecordView>(`${base}/e/${first.edition}`, "GET", undefined, false)).revisionState, "superseded");
  const second = await publish(await prepare("Sample studio · disabled second path"));
  assert.equal(second.payload.assembly.find(step => step.connectionId === "mic2-audio")!.enabled, false);
  const desk = await json<PublicRecordDesk>("/api/records");
  await action({ action: "withdraw", expectedShareVersion: desk.share!.version });
  for (const path of [base, `${base}/e/${first.edition}`, `${base}/e/${first.edition}/qr`, `${base}/e/${second.edition}/guide`, `${base}/e/${second.edition}/qr`]) {
    const response = await request(path, "GET", undefined, false, 410); assert.match(response.headers.get("cache-control")!, /no-store/); assert.equal((await response.json()).record, null);
  }
  for (const path of [`/record/${first.slug}`, `/record/${first.slug}/e/${first.edition}`, `/record/${second.slug}/e/${second.edition}/guide`, `/record/${second.slug}/e/${second.edition}/print`]) {
    const response = await request(path, "GET", undefined, false); assert.match(response.headers.get("cache-control")!, /no-store/); const html = await response.text(); assert.equal(html.includes(first.payload.title), false); assert.equal(html.includes(second.payload.title), false); assert.ok(html.includes("no longer shared"));
  }
  checks.withdrawalClosesAllCurrentHistoricalQrGuidePrintRoutes = true;
  await database().query("UPDATE wk_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [workspace.session.id]);
  await request("/api/records", "GET", undefined, true, 401); checks.expiredSessionDeniedOverHttp = true;

  // Leave a new, clearly fictional fixture for render checks; never reset a workspace.
  cookie = ""; const seeded = await request("/api/workspace", "POST", {}, false, 201); cookie = seeded.headers.get("set-cookie")!.split(";")[0]!; const seedWorkspace = await seeded.json() as Workspace;
  const seededRecord = await publish(await prepare("A Sample studio for two"));
  await mkdir(".local/certificate-qa", { recursive: true, mode: 0o700 });
  await writeFile(".local/certificate-qa/render-fixture.json", JSON.stringify({ cookie, sessionId: seedWorkspace.session.id, record: seededRecord, publicUrl: `${origin}/record/${seededRecord.slug}/e/${seededRecord.edition}`, sourceMode: "sample" }, null, 2), { mode: 0o600 });
  const evidence = { observedAt: new Date().toISOString(), environment: "isolated local certificate QA", origin, transport: "Actual HTTP against the production Next.js build; MCP SDK Streamable HTTP client", checks, checkCount: Object.keys(checks).length, providerCalls: 0, physicalTests: 0, independentHumanReviews: 0, fixtures: "Fictional Sample workspaces; separate database and cookie", nativeBrowserReview: "pending", hostedQualification: "pending" };
  await writeFile("docs/evidence/certificate-http-qualification.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ status: "passed", checks: Object.keys(checks).length, nativeReviewUrl: `${origin}/?section=evidence&proof=certificate`, samplePublicUrl: `${origin}/record/${seededRecord.slug}/e/${seededRecord.edition}`, providerCalls: 0 }));
} finally { await closeDatabase(); }
