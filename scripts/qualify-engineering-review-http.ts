import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { hash } from "../packages/compatibility";
import { digestText } from "../packages/engineering-review/policy";
import { SAMPLE_REVIEW_IMAGE } from "../packages/engineering-review/sample-image";
import type { ReviewDetail, ReviewHome } from "../packages/engineering-review/contracts";
import type { PublicRecordDesk, PublicRecordSnapshot, PublicRecordView } from "../packages/public-record";
import { closeDatabase, database } from "../src/server/db";
import { seedEngineeringFixture, sourceSnapshot } from "../tests/support/engineering-review-fixture";
import { requireIsolatedDatabase } from "../tests/support/isolated-database";

requireIsolatedDatabase();
assert.equal(process.env.WORLDKIT_QA_MODE, "engineering");
assert.equal(process.env.WORLDKIT_DISABLE_PROVIDERS, "true");
const origin = "http://127.0.0.1:4532";
assert.equal(process.env.WORLDKIT_PUBLIC_URL, origin);
const startedAt = new Date().toISOString(), checks: { name: string; status: "passed" | "failed"; milliseconds: number }[] = [];
async function check(name: string, operation: () => Promise<void>) {
  const start = Date.now();
  try { await operation(); checks.push({ name, status: "passed", milliseconds: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, status: "failed", milliseconds: Date.now() - start }); throw error; }
}
function privateHeaders(response: Response) {
  assert.ok(response.headers.get("cache-control")?.includes("no-store"));
  assert.ok(response.headers.get("x-robots-tag")?.includes("noindex"));
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
}
async function request<T = Record<string, any>>(path: string, cookie = "", body?: unknown, expectedStatus = 200, options: { origin?: string; raw?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(origin + path, { method: body !== undefined || options.raw !== undefined ? "POST" : "GET", redirect: "manual", headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined || options.raw !== undefined ? { "Content-Type": "application/json", Origin: options.origin ?? origin } : {}), ...options.headers }, body: options.raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  assert.equal(response.status, expectedStatus, `${path} status`);
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("json") ? JSON.parse(text) as T : null;
  return { response, text, json: json! };
}
const command = (cookie: string, body: Record<string, unknown>, status = 200) => request("/api/engineering-review", cookie, { requestId: randomUUID(), ...body }, status);
const exact = (detail: ReviewDetail) => ({ proposalId: detail.edition.proposalId, expectedVersion: detail.edition.version, expectedHash: detail.edition.hash });
const decision = (cookie: string, detail: ReviewDetail, targetId: string, outcome = "accept", status = 200) => command(cookie, { kind: "decide", ...exact(detail), targetId, outcome, reason: "Sample HTTP software decision on the exact fictional source; no actual human or physical evidence." }, status);

let certificateHash: string | null = null, editionHash: string | null = null;
try {
  const fixture = await seedEngineeringFixture(), foreign = await seedEngineeringFixture();
  const owner = `wk_engineering_qa=${fixture.token}`, otherOwner = `wk_engineering_qa=${foreign.token}`;
  const detailPath = `/api/engineering-review?proposalId=${fixture.proposalId}`;
  let detail = (await request<ReviewDetail>(detailPath, owner)).json;
  editionHash = detail.edition.hash;
  const before = await sourceSnapshot(fixture.session.id);
  await check("anonymous access, private cache policy and creator/specialist cookie separation", async () => {
    for (const path of ["/api/engineering-review", detailPath, `/api/engineering-review/assets/${fixture.asset.id}`]) privateHeaders((await request(path, "", undefined, 401)).response);
    privateHeaders((await request("/review")).response); privateHeaders((await request("/review/join")).response);
    assert.equal((await request<ReviewHome>("/api/engineering-review", owner)).json.role, "owner");
    await request(detailPath, otherOwner, undefined, 404); await request("/api/engineering-review", `wk_session=${fixture.token}`, undefined, 401);
  });
  await check("foreign origins, malformed commands and bounded transport fail closed", async () => {
    privateHeaders((await request("/api/engineering-review", owner, { kind: "register_actor", requestId: randomUUID(), name: "Sample refused", provenance: "sample" }, 403, { origin: "https://example.invalid" })).response);
    await request("/api/engineering-review", owner, undefined, 400, { raw: "{" });
    await request("/api/engineering-review", owner, { kind: "register_actor", requestId: randomUUID(), name: "Sample refused", provenance: "sample", qualification: { provenance: "human" } }, 400);
    await request("/api/engineering-review", owner, undefined, 413, { raw: "x".repeat(200001) });
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(200001))); controller.close(); } });
    const streamed = await fetch(origin + "/api/engineering-review", { method: "POST", headers: { Cookie: owner, Origin: origin, "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    assert.equal(streamed.status, 413); privateHeaders(streamed); await streamed.arrayBuffer();
  });
  async function invite(name: string, role = "adjudicator", expiresAt = new Date(Date.now() + 3600000).toISOString()) {
    const actor = (await command(owner, { kind: "register_actor", name, provenance: "sample" })).json;
    const invitation = (await command(owner, { kind: "invite", actorId: actor.actorId, role, kitId: fixture.kit.kitId, profileId: fixture.profileId, documentId: fixture.documentId, expiresAt })).json;
    const inspected = await request("/api/engineering-review/invitation", "", { kind: "inspect", token: invitation.token });
    assert.equal(inspected.json.provenance, "sample"); assert.equal(inspected.json.role, role); assert.ok(!("credential" in inspected.json));
    await request("/api/engineering-review/invitation", "", { kind: "redeem", token: invitation.token }, 400);
    const redeemed = await request("/api/engineering-review/invitation", "", { kind: "redeem", token: invitation.token, acknowledgeScope: true });
    const setCookie = redeemed.response.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.startsWith("wk_engineering_reviewer_qa=")); assert.ok(/HttpOnly/i.test(setCookie)); assert.ok(/SameSite=Strict/i.test(setCookie)); assert.ok(!("credential" in redeemed.json));
    return { actorId: actor.actorId as string, capabilityId: invitation.capabilityId as string, token: invitation.token as string, cookie: setCookie.split(";")[0]! };
  }
  let a: Awaited<ReturnType<typeof invite>>, b: Awaited<ReturnType<typeof invite>>, c: Awaited<ReturnType<typeof invite>>, reader: Awaited<ReturnType<typeof invite>>;
  await check("deliberate one-time redemption, scoped principal and HttpOnly strict cookie", async () => {
    a = await invite("Sample HTTP adjudicator A"); b = await invite("Sample HTTP adjudicator B"); c = await invite("Sample HTTP adjudicator C"); reader = await invite("Sample HTTP reader", "reader");
    await request("/api/engineering-review/invitation", "", { kind: "redeem", token: a.token, acknowledgeScope: true }, 404);
    const home = (await request<ReviewHome>("/api/engineering-review", a.cookie)).json;
    assert.equal(home.actor.id, a.actorId); assert.equal(home.actors.length, 1); assert.equal(home.candidates.length, 1); assert.equal(home.kits.length, 1); assert.equal(home.capabilities[0]!.documentId, fixture.documentId);
    for (const path of ["/api/workspace", "/api/inventory", "/api/records", "/api/payment-evidence"]) await request(path, a.cookie, undefined, 401);
    const graphEdit = await fetch(origin + "/api/kit", { method: "PATCH", headers: { Cookie: a.cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevisionId: fixture.kit.id, expectedGraphHash: fixture.certificate.graphHash, edit: {} }) });
    assert.equal(graphEdit.status, 401); await graphEdit.arrayBuffer();
    await command(`${owner}; ${reader.cookie}`, { kind: "register_actor", name: "Sample escalation refused", provenance: "sample" }, 403);
    await command(reader.cookie, { kind: "revise", ...exact(detail), content: detail.edition.content, reason: "A read-only link cannot grant editing authority." }, 403);
    await request(`/api/engineering-review?proposalId=${foreign.proposalId}`, a.cookie, undefined, 404);
  });
  await check("private source bytes, exact selection hash and approved crop stay resource-scoped", async () => {
    const page = await request("/api/engineering-review/source", a!.cookie, { proposalId: fixture.proposalId, editionId: detail.edition.id, page: 1, offset: 0, end: 75 });
    privateHeaders(page.response); assert.equal(page.json.anchor.excerptHash, digestText(fixture.text.slice(0, 75)));
    await request("/api/engineering-review/source", a!.cookie, { proposalId: foreign.proposalId, editionId: foreign.detail.edition.id, page: 1, offset: 0 }, 404);
    await request("/api/engineering-review/source", a!.cookie, { proposalId: fixture.proposalId, editionId: detail.edition.id, page: 1, offset: 0, end: 1201 }, 400);
    const asset = await request(`/api/engineering-review/assets/${fixture.asset.id}`, a!.cookie); privateHeaders(asset.response); assert.equal(digestText(asset.text), digestText(SAMPLE_REVIEW_IMAGE));
    await request(`/api/engineering-review/assets/${foreign.asset.id}`, a!.cookie, undefined, 404);
  });
  let record: PublicRecordSnapshot, publicPath = "";
  await check("publish an isolated fictional certificate before review changes", async () => {
    const desk = (await request<PublicRecordDesk>("/api/records", owner)).json;
    record = (await request<{ record: PublicRecordSnapshot }>("/api/records", owner, { action: "prepare", requestId: randomUUID(), title: "Sample engineering HTTP invariant", expectedRevisionId: desk.revisionId, expectedGraphHash: desk.graphHash, expectedShareVersion: desk.share?.version ?? 0 })).json.record;
    const binding = () => ({ recordId: record.id, expectedVersion: record.version, expectedContentHash: record.contentHash, expectedRevisionId: record.payload.revisionId, expectedGraphHash: record.payload.graphHash, expectedShareVersion: record.shareVersion });
    record = (await request<{ record: PublicRecordSnapshot }>("/api/records", owner, { action: "review", requestId: randomUUID(), ...binding(), reviewedDisplayFields: true, understoodScope: true })).json.record;
    record = (await request<{ record: PublicRecordSnapshot }>("/api/records", owner, { action: "publish", requestId: randomUUID(), ...binding(), confirmPublicAccess: true })).json.record;
    publicPath = `/api/public-records/${record.slug}/e/${record.edition}`;
    const view = (await request<PublicRecordView>(publicPath)).json;
    assert.equal(view.state, "published"); certificateHash = hash(view.record!.payload);
  });
  await check("one qualified Sample principal cannot promote a critical simultaneous claim", async () => {
    for (const target of detail.assessment.targets) await decision(a!.cookie, detail, target.id);
    await command(owner, { kind: "promote", ...exact(detail), acknowledgeScope: true }, 422);
    const samePerson = (await command(owner, { kind: "invite", actorId: a!.actorId, role: "adjudicator", kitId: fixture.kit.kitId, profileId: fixture.profileId, documentId: fixture.documentId, expiresAt: new Date(Date.now() + 60000).toISOString() })).json;
    const sameRedeemed = await request("/api/engineering-review/invitation", "", { kind: "redeem", token: samePerson.token, acknowledgeScope: true });
    await decision(sameRedeemed.response.headers.get("set-cookie")!.split(";")[0]!, detail, "claim-2", "accept", 409);
    await decision(owner, detail, "claim-2", "accept", 403);
  });
  await check("disagreement is immutable and two exact-set adjudications resolve it", async () => {
    await decision(b!.cookie, detail, "claim-2", "reject"); await decision(c!.cookie, detail, "claim-2");
    detail = (await request<ReviewDetail>(detailPath, owner)).json;
    let target = detail.assessment.targets.find(value => value.id === "claim-2")!;
    assert.equal(target.status, "conflicted"); await command(owner, { kind: "promote", ...exact(detail), acknowledgeScope: true }, 422);
    await command(c!.cookie, { kind: "adjudicate", ...exact(detail), targetId: "claim-2", outcome: "accept", decisionSetHash: "0".repeat(64), reason: "An incorrect decision-set fingerprint must fail closed." }, 409);
    await command(b!.cookie, { kind: "adjudicate", ...exact(detail), targetId: "claim-2", outcome: "accept", decisionSetHash: target.decisionSetHash, reason: "First Sample adjudicator resolves the exact fictional firmware disagreement with retained reasons." });
    detail = (await request<ReviewDetail>(detailPath, owner)).json; assert.equal(detail.assessment.eligible, false);
    const input = { kind: "adjudicate", requestId: randomUUID(), ...exact(detail), targetId: "claim-2", outcome: "accept", decisionSetHash: target.decisionSetHash, reason: "Second Sample adjudicator resolves the same exact fictional decision set without erasing dissent." };
    const duplicates = await Promise.all([request("/api/engineering-review", c!.cookie, input), request("/api/engineering-review", c!.cookie, input)]);
    assert.equal(duplicates[0]!.json.decisionId, duplicates[1]!.json.decisionId); await request("/api/engineering-review", c!.cookie, { ...input, outcome: "reject" }, 409);
    detail = (await request<ReviewDetail>(detailPath, owner)).json; target = detail.assessment.targets.find(value => value.id === "claim-2")!;
    assert.equal(target.status, "accepted"); assert.equal(detail.assessment.eligible, true); assert.equal(detail.assessment.actualReviewed, 0); assert.equal(detail.assessment.physicalTests, 0);
    assert.equal(detail.decisions.filter(value => value.targetId === "claim-2").length, 5);
  });
  let promotionId = "", adoptionPreviewHash = "";
  let adoption: Record<string, unknown> = {};
  await check("guarded promotion creates a Sample profile and preserves source, graph and public certificate bytes", async () => {
    const input = { kind: "promote", requestId: randomUUID(), ...exact(detail), acknowledgeScope: true };
    const result = await request("/api/engineering-review", owner, input); promotionId = result.json.promotionId;
    assert.equal((await request("/api/engineering-review", owner, input)).json.promotionId, promotionId);
    detail = (await request<ReviewDetail>(detailPath, owner)).json;
    assert.equal(detail.promotions[0]!.profile.reviewState, "review_pending"); assert.equal(detail.promotions[0]!.profile.engineeringReview!.physicalTest, "not_performed");
    assert.ok(Object.values(detail.promotions[0]!.profile.facts).every(value => value.review.status === "pending")); assert.ok(detail.affected.some(value => value.revisionId === fixture.kit.id));
    adoption = { requestId: randomUUID(), identity: { libraryProfileId: promotionId, manufacturer: fixture.profile.manufacturer, model: fixture.profile.model, variant: fixture.profile.variant, deviceKind: "recorder", ownership: "planned", quantity: 1, condition: "unknown", accessories: [], notes: "Sample HTTP fixture; no ownership assertion.", confirmedExactIdentity: true, confirmedOwnership: false }, snapshotId: null, selectedOptions: [], photoId: null, regionId: null, targetComponentId: null, expectedRevisionId: fixture.kit.id, expectedGraphHash: fixture.certificate.graphHash };
    adoptionPreviewHash = (await request("/api/inventory", owner, { kind: "preview", confirmation: adoption })).json.previewHash;
    assert.equal((await request("/api/evidence", owner)).json.summary.humanReviewed, 0); assert.equal(await sourceSnapshot(fixture.session.id), before);
    assert.equal(hash((await request<PublicRecordView>(publicPath)).json.record!.payload), certificateHash);
  });
  await check("capability revocation closes disclosure and preserves the published historical record", async () => {
    const home = (await request<ReviewHome>("/api/engineering-review", owner)).json, cap = home.capabilities.find(value => value.id === b!.capabilityId)!;
    await command(owner, { kind: "revoke", capabilityId: cap.id, expectedVersion: cap.version, reason: "Revoke a Sample adjudicator after its immutable rehearsal profile was saved." });
    for (const path of [detailPath, `/api/engineering-review/assets/${fixture.asset.id}`]) await request(path, b!.cookie, undefined, 401);
    await request("/api/engineering-review/source", b!.cookie, { proposalId: fixture.proposalId, editionId: detail.edition.id, page: 1, offset: 0 }, 401);
    detail = (await request<ReviewDetail>(detailPath, owner)).json; assert.equal(detail.assessment.eligible, false); assert.ok(detail.decisions.some(value => !value.active));
    await request("/api/inventory", owner, { kind: "confirm", confirmation: adoption, previewHash: adoptionPreviewHash }, 409);
    assert.equal(hash((await request<PublicRecordView>(publicPath)).json.record!.payload), certificateHash);
    await command(owner, { kind: "withdraw", promotionId, expectedHeadId: promotionId, reason: "Withdraw the isolated Sample profile and retain all editions and certificate evidence." });
    assert.equal(await sourceSnapshot(fixture.session.id), before);
  });
  await check("invitation expiry closes a redeemed HTTP cookie and private source reads", async () => {
    const expiring = await invite("Sample HTTP short-lived reader", "reader", new Date(Date.now() + 1500).toISOString());
    await request(detailPath, expiring.cookie); await delay(1600); await request(detailPath, expiring.cookie, undefined, 401);
  });
  await check("stale source binding blocks a decision while the exact past edition stays retained", async () => {
    const stale = await seedEngineeringFixture(), actor = await stale.addActor("Sample HTTP stale source");
    await database().query("UPDATE wk_source_heads SET version=version+1 WHERE tenant_id=$1", [stale.session.id]);
    await decision(`wk_engineering_reviewer_qa=${actor.credential}`, stale.detail, "claim-2", "accept", 409);
    const saved = (await request<ReviewDetail>(`/api/engineering-review?proposalId=${stale.proposalId}`, `wk_engineering_qa=${stale.token}`)).json;
    assert.equal(saved.assessment.state, "stale"); assert.equal(saved.edition.hash, stale.detail.edition.hash);
  });
  await check("withdraw only the isolated public Sample publication after immutable-byte qualification", async () => {
    const desk = (await request<PublicRecordDesk>("/api/records", owner)).json;
    await request("/api/records", owner, { action: "withdraw", requestId: randomUUID(), expectedShareVersion: desk.share!.version }); await request(publicPath, "", undefined, 410);
  });
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "HTTP qualification failed"); process.exitCode = 1;
} finally {
  const receipt = { schema: "worldkit.engineering-review-http-qualification.1", startedAt, completedAt: new Date().toISOString(), origin, provenance: "sample", providers: "disabled", actualHumanReviews: 0, physicalTests: 0, sourceEditionHash: editionHash, unchangedCertificatePayloadHash: certificateHash, checks, status: checks.some(value => value.status === "failed") || process.exitCode ? "failed" : "passed" };
  await mkdir(".local/engineering-review-qa", { recursive: true });
  await writeFile(`.local/engineering-review-qa/http-${startedAt.replaceAll(/[:.]/g, "-")}.json`, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  if (receipt.status === "passed" && !process.argv.includes("--receipt-private")) { await mkdir("docs/evidence", { recursive: true }); await writeFile("docs/evidence/engineering-review-http-qualification.json", JSON.stringify(receipt, null, 2) + "\n"); }
  await closeDatabase();
}
