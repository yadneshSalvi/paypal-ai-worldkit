import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database, closeDatabase, transaction } from "../src/server/db";
import { createSession, getRevision, saveRevision, type Session } from "../src/server/repository";
import { sourceImpact } from "../src/server/source-impact";
import { enqueueJob } from "../src/server/jobs";
import { hash } from "../packages/compatibility";
import { impactFixture } from "./support/source-impact-fixture";
import { requireIsolatedDatabase } from "./support/isolated-database";
requireIsolatedDatabase();
after(closeDatabase);

async function fixture() {
  const { session } = await createSession(), original = await getRevision(session.id);
  const { bundle, source } = impactFixture();
  bundle.kit.id = randomUUID(); bundle.kit.kitId = original.kit.kitId; bundle.kit.revision = 2; bundle.kit.parentRevisionId = original.kit.id;
  const documentId = randomUUID();
  const job = await enqueueJob(session, "source_retrieve", { profileId: source.profileId, synthetic: true }, documentId, "Synthetic source-impact persistence fixture");
  await transaction(async db => {
    await db.query("UPDATE wk_jobs SET status='succeeded' WHERE id=$1", [job.id]);
    await saveRevision(db, session.id, bundle);
    await db.query("UPDATE wk_kits SET current_revision_id=$1 WHERE id=$2 AND tenant_id=$3", [bundle.kit.id, bundle.kit.kitId, session.id]);
    await db.query("INSERT INTO wk_source_documents(id,tenant_id,profile_id,source_url,blob_path,content_hash,status,job_id) VALUES($1,$2,$3,$4,$5,$6,'available',$7)", [documentId, session.id, source.profileId, source.url, `synthetic/${documentId}`, source.contentHash, job.id]);
    await db.query("INSERT INTO wk_source_heads(tenant_id,profile_id,document_id,version) VALUES($1,$2,$3,1)", [session.id, source.profileId, documentId]);
  });
  return { session, documentId, bundle, source };
}
async function preserved(session: Session) {
  const rows = await database().query("SELECT * FROM (SELECT 'revision' kind,to_jsonb(r) payload FROM wk_revisions r WHERE tenant_id=$1 UNION ALL SELECT 'source',to_jsonb(d) FROM wk_source_documents d WHERE tenant_id=$1 UNION ALL SELECT 'head',to_jsonb(h) FROM wk_source_heads h WHERE tenant_id=$1 UNION ALL SELECT 'event',to_jsonb(e) FROM wk_events e WHERE tenant_id=$1) records ORDER BY kind,payload::text", [session.id]);
  return hash(rows.rows);
}
test("tenant-scoped current and historical traces leave every saved revision, certificate and source unchanged", async () => {
  const f = await fixture(), before = await preserved(f.session);
  const current = await sourceImpact(f.session, f.source.profileId);
  assert.equal(current.source.documentId, f.documentId); assert.equal(current.source.current, true);
  assert.equal(current.coverage.totalSavedRevisions, 2); assert.equal(current.coverage.complete, true);
  assert.equal(current.impacts[0]!.revisionId, f.bundle.kit.id); assert.equal(current.impacts[0]!.state, "changed_document");
  const explicit = await sourceImpact(f.session, f.source.profileId, f.documentId);
  assert.equal(explicit.digest, current.digest); assert.equal(await preserved(f.session), before);
});
test("foreign source versions and mismatched model scopes disclose nothing", async () => {
  const f = await fixture(), other = await createSession();
  await assert.rejects(() => sourceImpact(other.session, f.source.profileId, f.documentId), /does not belong/);
  await assert.rejects(() => sourceImpact(f.session, "zoom-f3", f.documentId), /does not belong/);
  await assert.rejects(() => sourceImpact(f.session, "not-a-library-model"), /not in the library/);
  const report = await sourceImpact(other.session, f.source.profileId);
  assert.equal(report.source.documentId, null); assert.equal(report.coverage.totalSavedRevisions, 1);
  assert.ok(!report.impacts.some(impact => impact.revisionId === f.bundle.kit.id));
});
test("expired access is revalidated against the database rather than the caller's old session object", async () => {
  const f = await fixture(); await database().query("UPDATE wk_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [f.session.id]);
  await assert.rejects(() => sourceImpact(f.session, f.source.profileId), /access has ended/);
});
test("withdrawn copies retain their old fingerprint and explicit unavailability without rewriting history", async () => {
  const f = await fixture(); await database().query("UPDATE wk_source_documents SET status='deleted' WHERE id=$1 AND tenant_id=$2", [f.documentId, f.session.id]);
  const before = await preserved(f.session), report = await sourceImpact(f.session, f.source.profileId, f.documentId);
  assert.equal(report.source.status, "unavailable"); assert.equal(report.source.contentHash, f.source.contentHash);
  assert.ok(report.impacts.every(impact => impact.state === "unavailable_document"));
  assert.equal(await preserved(f.session), before);
});
