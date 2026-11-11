import { createHash, randomUUID } from "node:crypto";
import { get, put, del } from "@vercel/blob";
import sharp from "sharp";
import { WorldKitError } from "../../packages/contracts/index";
import { CropSchema, type Crop, type InventoryPhoto } from "../../packages/inventory/contracts";
import { database, initialize, transaction } from "./db";
import { appendEvent, type Session } from "./repository";
import { enqueueJob } from "./jobs";
import { hash } from "../../packages/compatibility/index";

export const MAX_PHOTO_BYTES = 3_500_000;
export type PhotoRow = { id: string; tenant_id: string; blob_path: string; blob_url: string | null; content_hash: string; width: number; height: number; bytes: number; status: string; source_mode: "live" | "sample"; created_at: Date };
export function publicPhoto(row: PhotoRow): InventoryPhoto { return { id: row.id, width: row.width, height: row.height, bytes: row.bytes, contentHash: row.content_hash, sourceMode: row.source_mode, status: row.status === "deleting" ? "deleting" : "active", createdAt: new Date(row.created_at).toISOString(), imageUrl: `/api/inventory/photos/${row.id}` }; }
export function storageReady(): boolean { return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID); }
export async function normalizePhoto(bytes: Buffer): Promise<{ bytes: Buffer; width: number; height: number; contentHash: string }> {
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) throw new WorldKitError("invalid_request", "Use a photo smaller than 3.5 MB after resizing.", 413);
  try {
    const image = sharp(bytes, { limitInputPixels: 36_000_000, animated: false }); const metadata = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new Error("Unsupported photo");
    const normalized = await image.rotate().resize(2200, 2200, { fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer({ resolveWithObject: true });
    if (normalized.info.width < 64 || normalized.info.height < 64 || normalized.data.length > MAX_PHOTO_BYTES) throw new Error("Photo dimensions or size are outside the accepted range");
    // Re-encoding drops EXIF/location metadata. Original filenames are never stored.
    return { bytes: normalized.data, width: normalized.info.width, height: normalized.info.height, contentHash: createHash("sha256").update(normalized.data).digest("hex") };
  } catch { throw new WorldKitError("invalid_request", "Choose a readable JPEG, PNG or WebP photo, at least 64 pixels on each side.", 400); }
}
export async function addInventoryPhoto(session: Session, bytes: Buffer, sourceMode: "live" | "sample" = "live"): Promise<InventoryPhoto> {
  if (!storageReady()) throw new WorldKitError("provider_unavailable", "Private photo storage is not connected yet. You can add equipment by model or URL.", 503);
  const photo = await normalizePhoto(bytes); const id = randomUUID(); const path = `worldkit/${session.id}/inventory/${id}.webp`;
  const row = await transaction(async db => {
    await db.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [session.id]);
    const prior = await db.query("SELECT * FROM wk_inventory_photos WHERE tenant_id=$1 AND content_hash=$2 AND status='active'", [session.id, photo.contentHash]);
    if (prior.rows[0]) return prior.rows[0] as PhotoRow;
    const count = await db.query("SELECT count(*)::int AS count FROM wk_inventory_photos WHERE tenant_id=$1 AND status IN ('uploading','active','deleting')", [session.id]);
    if (count.rows[0].count >= 12) throw new WorldKitError("rate_limited", "This workspace holds twelve private photos. Remove one before adding another.", 429);
    const result = await db.query("INSERT INTO wk_inventory_photos(id,tenant_id,blob_path,content_hash,mime,width,height,bytes,source_mode) VALUES($1,$2,$3,$4,'image/webp',$5,$6,$7,$8) RETURNING *", [id, session.id, path, photo.contentHash, photo.width, photo.height, photo.bytes.length, sourceMode]);
    return result.rows[0] as PhotoRow;
  });
  if (row.status === "active") return publicPhoto(row);
  try {
    const result = await put(path, photo.bytes, { access: "private", contentType: "image/webp", addRandomSuffix: false, allowOverwrite: false, abortSignal: AbortSignal.timeout(25000) });
    await transaction(async db => {
      await db.query("UPDATE wk_inventory_photos SET blob_url=$2,status='active' WHERE id=$1 AND tenant_id=$3", [id, result.url, session.id]);
      await appendEvent(db, session.id, "inventory.photo_saved", "Private equipment photo saved", "Location metadata removed. Model suggestions and crop searches start only when you choose them.", null, sourceMode);
    });
    return publicPhoto({ ...row, status: "active" });
  } catch {
    await database().query("UPDATE wk_inventory_photos SET status='deleting' WHERE id=$1 AND tenant_id=$2", [id, session.id]);
    await enqueueJob(session, "inventory_photo_delete", { photoId: id }, id, "Cleaning up an incomplete photo upload");
    throw new WorldKitError("provider_unavailable", "The private photo could not be saved. Your equipment list is unchanged; try the upload again.", 503);
  }
}
export async function photoRecord(tenantId: string, id: string, includeDeleting = false): Promise<PhotoRow> {
  await initialize();
  const result = await database().query("SELECT * FROM wk_inventory_photos WHERE tenant_id=$1 AND id=$2 AND (status='active' OR ($3::boolean AND status='deleting'))", [tenantId, id, includeDeleting]);
  const row = result.rows[0] as PhotoRow | undefined;
  if (!row || row.blob_path !== `worldkit/${tenantId}/inventory/${id}.webp`) throw new WorldKitError("not_found", "That photo is not available in this workspace.", 404);
  return row;
}
export async function readPhoto(tenantId: string, id: string): Promise<{ row: PhotoRow; bytes: Buffer }> {
  const row = await photoRecord(tenantId, id); const result = await get(row.blob_path, { access: "private", useCache: false, abortSignal: AbortSignal.timeout(25000) });
  if (!result || result.statusCode !== 200 || result.blob.size > MAX_PHOTO_BYTES) throw new WorldKitError("provider_unavailable", "The saved private photo could not be loaded. Try again shortly.", 503);
  const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== row.content_hash) throw new WorldKitError("provider_unavailable", "The photo no longer matches its saved fingerprint.", 503);
  return { row, bytes };
}
export async function cropPhoto(bytes: Buffer, width: number, height: number, value: Crop): Promise<Buffer> {
  const crop = CropSchema.parse(value); const left = Math.floor(crop.x * width); const top = Math.floor(crop.y * height);
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(crop.width * width))); const cropHeight = Math.max(1, Math.min(height - top, Math.round(crop.height * height)));
  return sharp(bytes).extract({ left, top, width: cropWidth, height: cropHeight }).resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
}
export async function requestPhotoDeletion(session: Session, id: string) {
  await photoRecord(session.id, id, true);
  await transaction(async db => {
    // Workers fence their job before locking the source photo; use the same lock order.
    await db.query("UPDATE wk_jobs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,progress='The source photo was removed',updated_at=now() WHERE tenant_id=$1 AND managed=true AND kind IN ('inventory_regions','inventory_crop_search') AND input->>'photoId'=$2 AND status IN ('queued','running','retry_wait')", [session.id, id]);
    await db.query("UPDATE wk_inventory_photos SET status='deleting' WHERE id=$1 AND tenant_id=$2", [id, session.id]);
  });
  return enqueueJob(session, "inventory_photo_delete", { photoId: id }, id, "Removing your private photo");
}
export async function deletePhotoBlob(tenantId: string, id: string): Promise<PhotoRow> { const row = await photoRecord(tenantId, id, true); await del(row.blob_path, { abortSignal: AbortSignal.timeout(25000) }); return row; }

export async function recoverPhotoIntents(tenantId?: string): Promise<number> {
  return transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('worldkit:photo-cleanup:v1'))");
    const rows = await db.query(`SELECT p.id,p.tenant_id FROM wk_inventory_photos p JOIN wk_sessions s ON s.id=p.tenant_id
      WHERE ($1::text IS NULL OR p.tenant_id=$1) AND (p.status='deleting' OR (p.status='uploading' AND p.created_at<now()-interval '10 minutes') OR (p.status='active' AND s.expires_at<=now()))
      ORDER BY p.created_at LIMIT 20 FOR UPDATE OF p SKIP LOCKED`, [tenantId ?? null]);
    let inserted = 0;
    for (const photo of rows.rows) {
      const input = { photoId: photo.id };
      const result = await db.query("INSERT INTO wk_jobs(id,tenant_id,kind,status,input,managed,idempotency_key,input_hash,progress) VALUES($1,$2,'inventory_photo_delete','queued',$3,true,$4,$5,'Removing an expired or incomplete private photo') ON CONFLICT(tenant_id,kind,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id", [randomUUID(), photo.tenant_id, input, photo.id, hash(input)]);
      if (!result.rowCount) await db.query("UPDATE wk_jobs SET status='retry_wait',max_attempts=attempts-continuations+3,next_attempt_at=now(),error=NULL,progress='Resuming private photo cleanup',updated_at=now() WHERE tenant_id=$1 AND kind='inventory_photo_delete' AND idempotency_key=$2 AND status IN ('failed','cancelled') AND updated_at<now()-interval '1 hour'", [photo.tenant_id, photo.id]);
      await db.query("UPDATE wk_inventory_photos SET status='deleting' WHERE id=$1", [photo.id]); inserted += result.rowCount ?? 0;
    }
    return inserted;
  });
}
