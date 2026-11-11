import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import jsQR from "jsqr";
import { mutatePublicRecord, privateRecord, publicRecordDesk, readPublicRecord } from "../src/server/public-records";
import { closeDatabase, database, transaction } from "../src/server/db";
import { commitEdit, createSession, getRevision, saveRevision, type Session } from "../src/server/repository";
import { architectures } from "../packages/device-library";
import { verifyKit } from "../packages/compatibility";
import { publicRecordHash, type PublicRecordSnapshot } from "../packages/public-record";
import { publicRecordOrigin, publicRecordUrl } from "../src/server/public-record-origin";
import { GET } from "../src/app/api/public-records/[slug]/[[...asset]]/route";
import { paymentProvider } from "../src/server/payment-provider";

import { requireIsolatedDatabase } from "./support/isolated-database";
requireIsolatedDatabase();
after(closeDatabase);
const workspace = async () => (await createSession()).session;
async function prepare(session: Session, title = "A fictional Sample studio") {
  const desk = await publicRecordDesk(session);
  const input = { action: "prepare", requestId: randomUUID(), title, expectedRevisionId: desk.revisionId, expectedGraphHash: desk.graphHash, expectedShareVersion: desk.share?.version ?? 0 } as const;
  return { record: (await mutatePublicRecord(session, input)).record!, input };
}
function action(record: PublicRecordSnapshot, kind: "review" | "publish", requestId = randomUUID()) {
  const base = { action: kind, requestId, recordId: record.id, expectedRevisionId: record.payload.revisionId, expectedGraphHash: record.payload.graphHash, expectedContentHash: record.contentHash, expectedVersion: record.version, expectedShareVersion: record.shareVersion };
  return kind === "review" ? { ...base, reviewedDisplayFields: true, understoodScope: true } : { ...base, confirmPublicAccess: true };
}
async function publish(session: Session) { const { record } = await prepare(session); const reviewed = (await mutatePublicRecord(session, action(record, "review"))).record!; return (await mutatePublicRecord(session, action(reviewed, "publish"))).record!; }
async function withdraw(session: Session) { const desk = await publicRecordDesk(session); const input = { action: "withdraw", requestId: randomUUID(), expectedShareVersion: desk.share!.version } as const; await mutatePublicRecord(session, input); return input; }
async function http(slug: string, asset: string[] = []) { return GET(new Request(`http://127.0.0.1:4508/api/public-records/${slug}/${asset.join("/")}`), { params: Promise.resolve({ slug, asset }) }); }

test("prepare, exact review, and explicit publication are separate; no unchecked control grants publication", async () => {
  const session = await workspace(), { record } = await prepare(session);
  assert.equal(record.state, "draft"); assert.equal((await readPublicRecord(record.slug, record.edition)).state, "unavailable");
  await assert.rejects(() => mutatePublicRecord(session, action(record, "publish")), /Review the exact public preview/);
  await assert.rejects(() => mutatePublicRecord(session, { ...action(record, "review"), reviewedDisplayFields: false }));
  await assert.rejects(() => mutatePublicRecord(session, { ...action(record, "review"), expectedContentHash: "0".repeat(64) }), /changed/);
  const reviewed = (await mutatePublicRecord(session, action(record, "review"))).record!;
  assert.equal(reviewed.state, "reviewed"); assert.equal((await readPublicRecord(record.slug)).record, null);
  await assert.rejects(() => mutatePublicRecord(session, { ...action(reviewed, "publish"), confirmPublicAccess: false }));
  const published = (await mutatePublicRecord(session, action(reviewed, "publish"))).record!;
  const view = await readPublicRecord(record.slug);
  assert.equal(view.state, "published"); assert.deepEqual(view.record?.payload, record.payload); assert.equal(published.contentHash, publicRecordHash(record.payload));
  assert.equal(view.record!.payload.physicalTest, "not_performed"); assert.ok(view.record!.payload.counts.unknown > 0);
});

test("lost-response retries retain one edition and transition; a changed payload cannot reuse an intent", async () => {
  const session = await workspace(), desk = await publicRecordDesk(session);
  const input = { action: "prepare", requestId: randomUUID(), title: "Response loss Sample", expectedRevisionId: desk.revisionId, expectedGraphHash: desk.graphHash, expectedShareVersion: 0 };
  const results = await Promise.all([mutatePublicRecord(session, input), mutatePublicRecord(session, input)]);
  assert.equal(results[0].record!.id, results[1].record!.id); assert.equal(results.filter(result => result.replayed).length, 1);
  await assert.rejects(() => mutatePublicRecord(session, { ...input, title: "Different private title" }), /different content/);
  const reviewInput = action(results[0].record!, "review"), reviewed = (await mutatePublicRecord(session, reviewInput)).record!;
  assert.equal((await mutatePublicRecord(session, reviewInput)).replayed, true);
  const publishInput = action(reviewed, "publish"); await mutatePublicRecord(session, publishInput); assert.equal((await mutatePublicRecord(session, publishInput)).replayed, true);
  await withdraw(session); const replay = await mutatePublicRecord(session, publishInput);
  assert.equal(replay.replayed, true); assert.equal(replay.record!.state, "withdrawn"); assert.equal((await readPublicRecord(reviewed.slug)).record, null);
  assert.equal(Number((await database().query("SELECT count(*) FROM wk_record_events WHERE tenant_id=$1", [session.id])).rows[0].count), 4);
});

test("two separately reviewed drafts race against one share version and only one can publish", async () => {
  const session = await workspace(), a = (await prepare(session)).record, b = (await prepare(session)).record;
  const ra = (await mutatePublicRecord(session, action(a, "review"))).record!, rb = (await mutatePublicRecord(session, action(b, "review"))).record!;
  const outcomes = await Promise.allSettled([mutatePublicRecord(session, action(ra, "publish")), mutatePublicRecord(session, action(rb, "publish"))]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await publicRecordDesk(session)).records.filter(record => record.state === "published").length, 1);
});

test("an edit after review rejects publication and retains the immutable old preview", async () => {
  const session = await workspace(), { record } = await prepare(session);
  const reviewed = (await mutatePublicRecord(session, action(record, "review"))).record!;
  await commitEdit(session, record.payload.revisionId, record.payload.graphHash, { kind: "connection", connectionId: "mic2-audio", enabled: false });
  await assert.rejects(() => mutatePublicRecord(session, action(reviewed, "publish")), /changed/);
  assert.deepEqual((await privateRecord(session, record.id)).payload, record.payload);
  await assert.rejects(() => database().query("UPDATE wk_record_editions SET payload=jsonb_set(payload,'{title}','\"tampered\"') WHERE id=$1", [record.id]), /immutable/);
});

test("current and historical editions keep their identities; withdrawal closes both and never revives an old edition", async () => {
  const session = await workspace(), first = await publish(session);
  await commitEdit(session, first.payload.revisionId, first.payload.graphHash, { kind: "connection", connectionId: "mic2-audio", enabled: false });
  const second = await publish(session);
  assert.equal(first.slug, second.slug); assert.equal((await readPublicRecord(first.slug)).record?.id, second.id);
  const old = await readPublicRecord(first.slug, first.edition);
  assert.equal(old.revisionState, "superseded"); assert.equal(old.record?.contentHash, first.contentHash);
  assert.equal((await readPublicRecord(second.slug, second.edition)).record?.payload.assembly.find(step => step.connectionId === "mic2-audio")?.enabled, false);
  const intent = await withdraw(session); assert.equal((await mutatePublicRecord(session, intent)).replayed, true);
  assert.equal((await readPublicRecord(first.slug, first.edition)).state, "withdrawn"); assert.equal((await readPublicRecord(second.slug)).record, null);
  const third = await publish(session); assert.equal((await readPublicRecord(third.slug)).record?.id, third.id);
  assert.equal((await readPublicRecord(first.slug, first.edition)).state, "withdrawn");
});

test("cross-tenant access and expired persisted sessions fail, including stale Session objects and intent replay", async () => {
  const a = await workspace(), b = await workspace(), { record, input } = await prepare(a);
  await assert.rejects(() => privateRecord(b, record.id), /does not belong/);
  await assert.rejects(() => mutatePublicRecord(b, action(record, "review")), /Prepare a private preview|does not belong/);
  const reviewed = (await mutatePublicRecord(a, action(record, "review"))).record!;
  await mutatePublicRecord(a, action(reviewed, "publish"));
  await database().query("UPDATE wk_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [a.id]);
  await assert.rejects(() => mutatePublicRecord({ ...a, expiresAt: "2099-01-01T00:00:00Z" }, input), /expired/);
  await assert.rejects(() => publicRecordDesk(a), /expired/); assert.equal((await readPublicRecord(record.slug)).state, "withdrawn");
});

async function sourceFixture(session: Session) {
  const bundle = await getRevision(session.id), documentId = randomUUID(), jobId = randomUUID(), draftId = randomUUID();
  const sourceId = `manufacturer:fictional:${documentId}`, profileId = `research:fictional:${documentId}`, contentHash = "a".repeat(64);
  const profile = structuredClone(bundle.profiles.find(profile => profile.id === "zoom-h4essential")!); profile.id = profileId;
  for (const fact of Object.values(profile.facts)) { fact.sourceIds = [sourceId]; fact.id = `${profileId}:${fact.property}`; }
  const source = { ...bundle.sources[0]!, id: sourceId, title: "Fictional QA manufacturer source", publisher: "Sample fixture", url: "https://zoomcorp.com/fictional-test.pdf", contentHash, summary: "PRIVATE_SOURCE_CANARY", location: "PRIVATE_PATH_CANARY" };
  const kit = structuredClone(bundle.kit); kit.id = randomUUID(); kit.parentRevisionId = bundle.kit.id; kit.revision++; kit.components.find(c => c.id === "audio")!.profileId = profileId;
  const profiles = [...bundle.profiles, profile], sources = [...bundle.sources, source];
  await transaction(async db => {
    await db.query("INSERT INTO wk_jobs(id,tenant_id,kind,status,input) VALUES($1,$2,'fixture','succeeded','{}')", [jobId, session.id]);
    await db.query("INSERT INTO wk_source_documents(id,tenant_id,profile_id,job_id,source_url,blob_path,content_hash,status,payload) VALUES($1,$2,$3,$4,$5,$6,$7,'available','{}')", [documentId, session.id, profileId, jobId, source.url, `worldkit/${session.id}/sources/${documentId}.source`, contentHash]);
    await db.query("INSERT INTO wk_source_heads(tenant_id,profile_id,document_id,version) VALUES($1,$2,$3,1)", [session.id, profileId, documentId]);
    await db.query("INSERT INTO wk_source_drafts(id,tenant_id,document_id,profile_id,job_id,payload,receipt) VALUES($1,$2,$3,$4,$5,'{}','{}')", [draftId, session.id, documentId, profileId, jobId]);
    await db.query("INSERT INTO wk_source_profile_versions(id,tenant_id,profile_id,draft_id,source_document_id,payload,source) VALUES($1,$2,$3,$4,$5,$6,$7)", [profileId, session.id, profileId, draftId, documentId, profile, source]);
    await saveRevision(db, session.id, { kit, profiles, sources, certificate: verifyKit(kit, profiles, sources, architectures) });
    await db.query("UPDATE wk_kits SET current_revision_id=$1 WHERE id=$2", [kit.id, kit.kitId]);
  });
  return { documentId, profileId };
}

test("source head changes invalidate an unpublished review, label published history, and private-copy deletion withholds it", async () => {
  const session = await workspace(), fixture = await sourceFixture(session), { record } = await prepare(session);
  const reviewed = (await mutatePublicRecord(session, action(record, "review"))).record!;
  await database().query("UPDATE wk_source_heads SET version=version+1 WHERE tenant_id=$1 AND profile_id=$2", [session.id, fixture.profileId]);
  await assert.rejects(() => mutatePublicRecord(session, action(reviewed, "publish")), /Source availability/);
  const published = await publish(session); assert.equal(JSON.stringify(published.payload).includes("PRIVATE_"), false);
  await database().query("UPDATE wk_source_heads SET version=version+1 WHERE tenant_id=$1 AND profile_id=$2", [session.id, fixture.profileId]);
  const historical = await readPublicRecord(published.slug);
  assert.equal(historical.sourceState, "changed"); assert.equal(historical.record?.contentHash, published.contentHash);
  await database().query("UPDATE wk_source_documents SET status='deleting' WHERE id=$1", [fixture.documentId]);
  assert.equal((await readPublicRecord(published.slug)).state, "withdrawn");
  assert.equal((await publicRecordDesk(session)).records.find(r => r.id === published.id)?.availability, "withdrawn");
  await assert.rejects(() => prepare(session), /unavailable/);
  assert.equal((await privateRecord(session, published.id)).contentHash, published.contentHash);
});

test("public JSON, guide and decodable immutable QR use no-store; unknown and withdrawn routes disclose no payload", async () => {
  const session = await workspace(), record = await publish(session);
  for (const asset of [[], ["e", String(record.edition)], ["e", String(record.edition), "guide"]]) {
    const response = await http(record.slug, asset); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.equal((await response.json()).record.contentHash, record.contentHash);
  }
  const qr = await http(record.slug, ["e", String(record.edition), "qr"]);
  assert.equal(qr.headers.get("content-type"), "image/png"); assert.match(qr.headers.get("cache-control")!, /no-store/);
  const pixels = await sharp(Buffer.from(await qr.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.info.width, pixels.info.height);
  assert.equal(decoded?.data, publicRecordUrl(record.slug, record.edition)); assert.ok(decoded?.data.includes(`/e/${record.edition}`));
  assert.equal((await http(record.slug, ["e", "99999"])).status, 404);
  assert.equal((await http("unknown")).status, 404); assert.equal((await http(record.slug, ["private-source"])).status, 404);
  await withdraw(session);
  for (const asset of [[], ["e", String(record.edition)], ["e", String(record.edition), "guide"], ["e", String(record.edition), "qr"]]) {
    const response = await http(record.slug, asset); assert.equal(response.status, 410); assert.match(response.headers.get("cache-control")!, /no-store/); assert.equal((await response.json()).record, null);
  }
});

test("publication uses configured stable origin and isolated QA cannot obtain a payment provider", () => {
  assert.equal(publicRecordOrigin({ WORLDKIT_PUBLIC_URL: "https://paypal-ai-worldkit.vercel.app", VERCEL: "1", VERCEL_URL: "preview.vercel.app" }), "https://paypal-ai-worldkit.vercel.app");
  for (const origin of ["https://user:password@example.org", "https://example.org/?token=x", "https://example.org/private", "http://127.0.0.1:4508"]) assert.throws(() => publicRecordOrigin({ WORLDKIT_PUBLIC_URL: origin, VERCEL: "1" }));
  assert.equal(publicRecordOrigin({ WORLDKIT_PUBLIC_URL: "http://127.0.0.1:4508" }), "http://127.0.0.1:4508");
  assert.throws(() => paymentProvider(), /disabled/);
});
