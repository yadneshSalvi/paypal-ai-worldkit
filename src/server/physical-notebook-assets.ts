import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { PoolClient } from "pg";
import { hash } from "../../packages/compatibility";
import { BENCH_MAX_FILES, type BenchAccess, type BenchAsset, type BenchEdition, type BenchFileInput, type BenchUpload } from "../../packages/physical-notebook/contracts";
import { BenchInspectionError, inspectBenchOriginal, sampleBenchWave } from "../../packages/physical-notebook/inspect";
import { database, transaction } from "./db";
import { initializePhysicalNotebook } from "./physical-notebook-db";
import { authorizeBench, benchDigest, benchEvent, benchFail, benchIso, benchRun, type BenchRow } from "./physical-notebook-authority";
import { benchStorageMode, deleteBenchObject, readBenchObject, writeBenchGeneratedObject, writeControlledBenchObject } from "./physical-notebook-storage";

const suffix: Record<BenchFileInput["mediaType"], string> = { "audio/wav": "wav", "audio/mpeg": "mp3", "video/mp4": "mp4", "video/webm": "webm", "image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf" };
export const benchUploadDto = (row: BenchRow): BenchUpload => ({ id: row.id, runId: row.run_id, file: row.file, createdAt: benchIso(row.created_at), expiresAt: benchIso(row.expires_at), phase: row.phase, assetId: row.asset_id, failure: row.failure, transport: row.transport, pathname: row.pathname, attempts: row.attempts, withdrawnAt: row.withdrawn_at ? benchIso(row.withdrawn_at) : null, purgedAt: row.purged_at ? benchIso(row.purged_at) : null });
export function assertBenchRights(file: BenchFileInput) {
  if (Date.parse(file.rights.grantedAt) > Date.now() + 60_000 || file.rights.expiresAt && Date.parse(file.rights.expiresAt) <= Date.now()) benchFail("The private-review permission is not currently valid.", "needs_evidence");
  if ((file.provenance === "sample_generated") !== (file.rights.basis === "sample_generated")) benchFail("Generated Sample files must keep their Sample provenance and rights basis.", "invalid_request");
}
export async function benchAssets(db: PoolClient, tenantId: string, runId: string): Promise<BenchAsset[]> {
  return (await db.query("SELECT a.payload,x.state FROM wk_bench_assets a JOIN wk_bench_asset_access x ON x.asset_id=a.id AND x.run_id=a.run_id AND x.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.run_id=$2 ORDER BY a.created_at,a.id", [tenantId, runId])).rows.map(row => ({ ...row.payload, originalBytesRetained: row.state !== "purged", availability: row.state === "available" ? "available" : row.state === "purged" ? "purged" : "withdrawn" }));
}
export async function createBenchUpload(db: PoolClient, access: BenchAccess, edition: BenchEdition, file: BenchFileInput, generated?: number) {
  assertBenchRights(file); const auth = await authorizeBench(db, access, edition.runId, "owner"), mode = benchStorageMode();
  if (mode === "unavailable") benchFail("Private original-file storage has not been configured. The report can be planned, but no upload is accepted.", "needs_evidence");
  if (edition.phase === "sealed") benchFail("This manifest is sealed; prepare a new report for new originals.", "stale_revision");
  if (edition.sourceMode === "sample" && file.provenance === "operator_original") benchFail("A Sample rehearsal cannot accept a file labeled as physical operator evidence.", "invalid_request");
  const count = Number((await db.query("SELECT count(*) AS count FROM wk_bench_uploads WHERE tenant_id=$1 AND run_id=$2", [access.tenantId, edition.runId])).rows[0].count);
  const reserved = Number((await db.query("SELECT COALESCE(sum((file->>'bytes')::bigint),0) AS bytes FROM wk_bench_uploads WHERE tenant_id=$1", [access.tenantId])).rows[0].bytes);
  if (count >= BENCH_MAX_FILES || reserved + file.bytes > 2 * 1024 ** 3) benchFail("This workspace's original-file allowance is full (32 intents per report, 2 GiB per workspace). Prepare a smaller, clearly scoped report.", "needs_evidence");
  const id = randomUUID(), pathname = `physical-notebook/${edition.sourceMode}/${access.tenantId}/${edition.runId}/${id}.${suffix[file.mediaType]}`, expires = new Date(Math.min(Date.parse(auth.expiresAt), Date.now() + 60 * 60_000)).toISOString();
  const receipt = generated === undefined ? null : { generator: "worldkit.physical-sample.1", part: generated, graphHash: edition.binding.graphHash, inputs: edition.binding.steps.filter(step => step.id.startsWith("source:")).length };
  const row = (await db.query("INSERT INTO wk_bench_uploads(id,run_id,tenant_id,file,pathname,transport,phase,expires_at,completed_receipt) VALUES($1,$2,$3,$4,$5,$6,'awaiting_upload',$7,$8) RETURNING *", [id, edition.runId, access.tenantId, file, pathname, mode, expires, receipt])).rows[0];
  await benchEvent(db, access, edition.runId, "original.intent", generated === undefined ? "An exact original-file intent records declared provenance and private-review rights; no physical execution is inferred." : "A generated Sample-file intent was saved. No physical file or provider callback is claimed.", { uploadId: id, fileHash: hash(file), bytes: file.bytes, transport: mode });
  return benchUploadDto(row);
}
export async function generatedBenchBytes(receipt: { part: number; graphHash: string; inputs: number }) {
  if (receipt.part < 2) return sampleBenchWave(receipt.part === 0 ? Math.max(2, receipt.inputs) : 1, receipt.graphHash, receipt.part === 1);
  if (receipt.part !== 2) benchFail("Unknown generated Sample artifact.", "invalid_request");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="360"><rect width="800" height="360" fill="#f4f0e6"/><rect x="35" y="30" width="730" height="300" rx="20" fill="#123d32"/><g fill="#f4f0e6" font-family="sans-serif"><text x="70" y="85" font-size="22">SAMPLE REHEARSAL · GENERATED DIAGRAM</text><text x="70" y="120" font-size="15">No hardware was photographed, assembled or tested.</text><text x="70" y="290" font-size="13">Private workflow rehearsal · original certificates remain unchanged</text></g><g fill="none" stroke="#c6e7b2" stroke-width="3"><rect x="80" y="160" width="150" height="70" rx="9"/><path d="M230 195h95"/><rect x="325" y="160" width="150" height="70" rx="9"/><path d="M475 195h95"/><rect x="570" y="160" width="150" height="70" rx="9"/></g><g fill="#f4f0e6" font-family="sans-serif" font-size="15"><text x="119" y="201">Sources</text><text x="357" y="201">Recorder</text><text x="598" y="201">Inspection</text></g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
export async function createBenchSamples(db: PoolClient, access: BenchAccess, edition: BenchEdition) {
  if (edition.sourceMode !== "sample") benchFail("Generated rehearsal files belong only in a Sample report.");
  const uploads: BenchUpload[] = [];
  for (let part = 0; part < 3; part++) {
    const bytes = await generatedBenchBytes({ part, graphHash: edition.binding.graphHash, inputs: edition.binding.steps.filter(step => step.id.startsWith("source:")).length });
    const file: BenchFileInput = { filename: part === 0 ? "Sample-isolated-paths.wav" : part === 1 ? "Sample-stream-mix.wav" : "Sample-connection-diagram.png", bytes: bytes.length, mediaType: part < 2 ? "audio/wav" : "image/png", kind: part === 0 ? "isolated_track" : part === 1 ? "stream_mix" : "connection_photo", provenance: "sample_generated", expectedSha256: benchDigest(bytes), rights: { basis: "sample_generated", holder: "WorldKit generated Sample", permissionReference: "Original generated routing tones and line diagram; no people or physical equipment recorded.", grantedAt: new Date().toISOString(), expiresAt: null, attribution: "WorldKit · generated Sample", privateReviewAllowed: true, publicSharingAllowed: true, identifiablePeople: false, participantConsentConfirmed: false, restrictions: "Never present this artifact as physical execution." } };
    uploads.push(await createBenchUpload(db, access, edition, file, part));
  }
  return uploads.map(upload => upload.id);
}
async function ownedUpload(db: PoolClient, access: BenchAccess, runId: string, uploadId: string, lock = false): Promise<BenchRow> {
  const row = (await db.query(`SELECT * FROM wk_bench_uploads WHERE id=$1 AND run_id=$2 AND tenant_id=$3 ${lock ? "FOR UPDATE" : ""}`, [uploadId, runId, access.tenantId])).rows[0];
  if (!row) benchFail("That original-file intent is outside this report.", "not_found"); return row;
}
export async function controlledBenchIntake(access: BenchAccess, runId: string, uploadId: string, stream: ReadableStream<Uint8Array>) {
  await initializePhysicalNotebook();
  const upload = await transaction(async db => {
    await authorizeBench(db, access, runId, "owner"); const row = await ownedUpload(db, access, runId, uploadId);
    if (row.transport !== "controlled_local" || row.withdrawn_at || Date.parse(benchIso(row.expires_at)) <= Date.now() || ["verified", "rejected"].includes(row.phase) || row.completed_receipt?.generator) benchFail("This controlled upload is no longer open.", "stale_revision");
    assertBenchRights(row.file); return benchUploadDto(row);
  });
  await writeControlledBenchObject(upload, stream);
  const arrived = await database().query("SELECT withdrawn_at FROM wk_bench_uploads WHERE id=$1 AND tenant_id=$2", [uploadId, access.tenantId]);
  if (arrived.rows[0]?.withdrawn_at) { await deleteBenchObject(upload); benchFail("This upload was withdrawn while its bytes were in flight.", "stale_revision"); }
  return transaction(async db => {
    await authorizeBench(db, access, runId, "owner"); const row = await ownedUpload(db, access, runId, uploadId, true);
    if (row.phase === "awaiting_upload") {
      await db.query("UPDATE wk_bench_uploads SET phase='uploaded' WHERE id=$1", [uploadId]);
      await benchEvent(db, access, runId, "original.controlled_upload", "Original bytes arrived through the isolated controlled intake. No provider callback or physical origin is claimed.", { uploadId });
    }
    return { uploadId, accepted: true };
  });
}

/** A committed lease precedes every external original read; retry never creates another asset. */
export async function verifyBenchUpload(access: BenchAccess, runId: string, uploadId: string) {
  await initializePhysicalNotebook(); const lease = randomUUID();
  const claim = await transaction(async db => {
    await authorizeBench(db, access, runId, "owner"); const row = await ownedUpload(db, access, runId, uploadId, true);
    if (row.phase === "verified" || row.phase === "rejected") return { done: true as const, row };
    if (row.lease_expires_at && Date.parse(benchIso(row.lease_expires_at)) > Date.now()) benchFail("Original-byte verification is already in progress. Refresh its saved status before retrying.", "stale_revision");
    assertBenchRights(row.file);
    await db.query("UPDATE wk_bench_uploads SET phase='verifying',lease_token=$2,lease_expires_at=clock_timestamp()+interval '4 minutes',attempts=attempts+1,failure=NULL WHERE id=$1", [uploadId, lease]);
    await benchEvent(db, access, runId, "original.verification_started", "A durable verification attempt will read and hash the exact private original.", { uploadId, attempt: row.attempts + 1 });
    return { done: false as const, row };
  });
  if (claim.done) return benchUploadDto(claim.row);
  const upload = benchUploadDto(claim.row);
  try {
    let object = await readBenchObject(upload);
    if (!object && claim.row.completed_receipt?.generator === "worldkit.physical-sample.1") {
      if (Date.parse(upload.expiresAt) <= Date.now()) benchFail("This generated-file intent expired before its bytes were created. Its expiry is never renewed.", "stale_revision");
      await writeBenchGeneratedObject(upload, await generatedBenchBytes(claim.row.completed_receipt)); object = await readBenchObject(upload);
    }
    if (!object) throw new Error("original_not_arrived");
    if (object.size !== upload.file.bytes) { await object.stream.cancel(); throw new BenchInspectionError("The stored original size differs from the exact declared byte count."); }
    const inspection = await inspectBenchOriginal(object.stream, upload.file, async () => {
      const auth = await transaction(async db => { await authorizeBench(db, access, runId, "owner"); return db.query("UPDATE wk_bench_uploads SET lease_expires_at=clock_timestamp()+interval '4 minutes' WHERE id=$1 AND tenant_id=$2 AND lease_token=$3 AND phase='verifying'", [uploadId, access.tenantId, lease]); });
      if (!auth.rowCount) throw new Error("verification_lease_lost");
    });
    return transaction(async db => {
      await authorizeBench(db, access, runId, "owner"); const row = await ownedUpload(db, access, runId, uploadId, true);
      if (row.withdrawn_at || row.lease_token !== lease || row.phase !== "verifying" || Date.parse(benchIso(row.lease_expires_at)) <= Date.now()) benchFail("The saved original verification lease changed. Inspect current status.", "stale_revision");
      assertBenchRights(row.file);
      const asset: BenchAsset = { ...upload.file, ...inspection, id: randomUUID(), runId, uploadId, verifiedAt: new Date().toISOString(), originalBytesRetained: true, availability: "available", detectedModelExport: inspection.detectedModelExport || ["sample_generated", "model_export"].includes(upload.file.provenance) };
      await db.query("INSERT INTO wk_bench_assets(id,run_id,tenant_id,upload_id,content_hash,bytes,payload) VALUES($1,$2,$3,$4,$5,$6,$7)", [asset.id, runId, access.tenantId, uploadId, asset.sha256, asset.bytes, asset]);
      await db.query("INSERT INTO wk_bench_asset_access(asset_id,run_id,tenant_id) VALUES($1,$2,$3)", [asset.id, runId, access.tenantId]);
      const updated = (await db.query("UPDATE wk_bench_uploads SET phase='verified',asset_id=$2,lease_token=NULL,lease_expires_at=NULL,failure=NULL WHERE id=$1 RETURNING *", [uploadId, asset.id])).rows[0];
      await benchEvent(db, access, runId, "original.verified", "The unchanged original was read, size-checked and hashed. Physical origin remains an operator declaration, separate from byte inspection.", { uploadId, assetId: asset.id, sha256: asset.sha256, bytes: asset.bytes, provenance: asset.provenance });
      await authorizeBench(db, access, runId, "owner"); return benchUploadDto(updated);
    });
  } catch (error) {
    const rejected = error instanceof BenchInspectionError; let withdrawn = false;
    await transaction(async db => {
      const row = await ownedUpload(db, access, runId, uploadId, true);
      withdrawn = !!row.withdrawn_at;
      if (row.lease_token === lease && row.phase === "verifying") {
        await db.query("UPDATE wk_bench_uploads SET phase=$2,lease_token=NULL,lease_expires_at=NULL,failure=$3 WHERE id=$1", [uploadId, rejected ? "rejected" : "uploaded", rejected ? error.message : "The original could not be fully verified. Existing bytes are retained; explicitly retry under current access."]);
        await benchEvent(db, access, runId, rejected ? "original.rejected" : "original.verification_interrupted", rejected ? error.message : "Original verification did not complete. No asset or physical result was created.", { uploadId });
      }
    });
    if (withdrawn) await deleteBenchObject(upload).catch(() => undefined);
    if (rejected) return benchUploadDto((await database().query("SELECT * FROM wk_bench_uploads WHERE id=$1 AND tenant_id=$2", [uploadId, access.tenantId])).rows[0]);
    throw error;
  }
}

/** Withdrawal is already durable before deletion; no success is reported for an unacknowledged delete. */
export async function purgeBenchAsset(access: BenchAccess, runId: string, assetId: string) {
  const lease = randomUUID();
  const claim = await transaction(async db => {
    await authorizeBench(db, access, runId, "owner");
    const row = (await db.query("SELECT x.*,u.id AS upload_id,u.pathname,u.transport,u.token_expires_at FROM wk_bench_asset_access x JOIN wk_bench_assets a ON a.id=x.asset_id AND a.tenant_id=x.tenant_id JOIN wk_bench_uploads u ON u.id=a.upload_id WHERE x.asset_id=$1 AND x.run_id=$2 AND x.tenant_id=$3 FOR UPDATE OF x", [assetId, runId, access.tenantId])).rows[0];
    if (!row) benchFail("That original is outside this report.", "not_found");
    if (row.state === "purged") return null;
    if (row.state === "available") benchFail("Withdraw access before removing the original.");
    if (row.transport === "private_blob" && row.token_expires_at && Date.parse(benchIso(row.token_expires_at)) > Date.now()) {
      await db.query("UPDATE wk_bench_asset_access SET failure='Access is withdrawn. Removal is queued until the already-issued upload token expires.' WHERE asset_id=$1", [assetId]); return null;
    }
    if (row.lease_expires_at && Date.parse(benchIso(row.lease_expires_at)) > Date.now()) return null;
    await db.query("UPDATE wk_bench_asset_access SET state='purging',attempts=attempts+1,lease_token=$2,lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE asset_id=$1", [assetId, lease]); return row;
  });
  if (!claim) return;
  try {
    await deleteBenchObject({ pathname: claim.pathname, transport: claim.transport });
    await transaction(async db => {
      const updated = await db.query("UPDATE wk_bench_asset_access SET state='purged',purged_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,failure=NULL WHERE asset_id=$1 AND tenant_id=$2 AND lease_token=$3 AND state='purging'", [assetId, access.tenantId, lease]);
      if (updated.rowCount) {
        await db.query("UPDATE wk_bench_uploads SET purged_at=COALESCE(purged_at,clock_timestamp()) WHERE id=$1 AND tenant_id=$2 AND withdrawn_at IS NOT NULL", [claim.upload_id, access.tenantId]);
        await benchEvent(db, access, runId, "original.purged", "The private store acknowledged deletion of this original. Its immutable fingerprint and report history remain, and cannot be used as available original evidence.", { assetId });
      }
    });
  } catch {
    await database().query("UPDATE wk_bench_asset_access SET state='retry_wait',lease_token=NULL,lease_expires_at=NULL,failure='Deletion was not acknowledged. Access remains withdrawn; explicitly retry removal.' WHERE asset_id=$1 AND tenant_id=$2 AND lease_token=$3 AND state='purging'", [assetId, access.tenantId, lease]);
  }
}

export async function purgeBenchUpload(access: BenchAccess, runId: string, uploadId: string) {
  const lease = randomUUID();
  const claim = await transaction(async db => {
    await authorizeBench(db, access, runId, "owner"); const row = await ownedUpload(db, access, runId, uploadId, true);
    if (!row.withdrawn_at || row.asset_id) benchFail("Withdraw the unverified upload before removing its bytes.");
    if (row.purged_at) return null;
    if (row.transport === "private_blob" && row.token_expires_at && Date.parse(benchIso(row.token_expires_at)) > Date.now()) {
      await db.query("UPDATE wk_bench_uploads SET failure='Upload withdrawn. Removal is queued until the already-issued upload token expires.' WHERE id=$1", [uploadId]); return null;
    }
    if (row.lease_expires_at && Date.parse(benchIso(row.lease_expires_at)) > Date.now()) return null;
    await db.query("UPDATE wk_bench_uploads SET lease_token=$2,lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE id=$1", [uploadId, lease]); return row;
  });
  if (!claim) return;
  try {
    await deleteBenchObject({ pathname: claim.pathname, transport: claim.transport });
    await transaction(async db => {
      const updated = await db.query("UPDATE wk_bench_uploads SET purged_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,failure='Upload withdrawn; its private store acknowledged removal of the original bytes.' WHERE id=$1 AND tenant_id=$2 AND lease_token=$3 AND withdrawn_at IS NOT NULL AND purged_at IS NULL", [uploadId, access.tenantId, lease]);
      if (updated.rowCount) await benchEvent(db, access, runId, "upload.purged", "The private store acknowledged removal of withdrawn upload bytes. Its original declaration remains in the audit history.", { uploadId });
    });
  } catch {
    await database().query("UPDATE wk_bench_uploads SET lease_token=NULL,lease_expires_at=NULL,failure='Upload access remains withdrawn. The store did not acknowledge removal; explicitly retry.' WHERE id=$1 AND tenant_id=$2 AND lease_token=$3", [uploadId, access.tenantId, lease]);
  }
}
