import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WorldKitError } from "../../packages/contracts/index";
import { CropSchema, type InventoryRegion } from "../../packages/inventory/contracts";
import { proposePhotoRegions } from "../../packages/inventory/vision";
import { proposeGoal } from "../../packages/planner/index";
import { searchImageCrop } from "../../packages/channel3/client";
import { appendEvent, getRevision, reserveUsage, saveCatalogResultInTransaction } from "./repository";
import { cropPhoto, deletePhotoBlob, readPhoto } from "./inventory-photos";
import type { ClaimedJob, JobResult } from "./jobs";

export async function executeWorldKitJob(job: ClaimedJob): Promise<JobResult> {
  if (["source_retrieve", "source_extract", "source_document_delete"].includes(job.kind)) {
    const evidence = await import("./source-evidence");
    return job.kind === "source_retrieve" ? evidence.retrieveSourceJob(job) : job.kind === "source_extract" ? evidence.extractSourceJob(job) : evidence.deleteSourceJob(job);
  }
  if (job.kind === "goal_proposal") {
    const input = z.object({ brief: z.string(), provider: z.enum(["openai", "gemini"]), revisionId: z.string() }).parse(job.input);
    const previous = await getRevision(job.tenantId, input.revisionId);
    await reserveUsage(job.tenantId, "model");
    return { output: { ...await proposeGoal(input.brief, previous.kit.goal, input.provider), basedOnRevisionId: input.revisionId, requiresConfirmation: true } };
  }
  if (job.kind === "inventory_regions") {
    const input = z.object({ photoId: z.string(), provider: z.enum(["openai", "gemini"]) }).parse(job.input);
    const photo = await readPhoto(job.tenantId, input.photoId); await reserveUsage(job.tenantId, "model");
    const result = await proposePhotoRegions(photo.bytes, input.provider); const at = new Date().toISOString();
    const regions: InventoryRegion[] = result.proposal.regions.map(region => ({ id: randomUUID(), photoId: input.photoId, label: region.label, hint: region.hint, crop: { x: region.x, y: region.y, width: region.width, height: region.height }, origin: "model_proposal", confirmedAt: null, snapshotIds: [], jobId: job.id, createdAt: at }));
    return { output: { ...result, regions, photoId: input.photoId, sourceMode: photo.row.source_mode, requiresCropConfirmation: true }, persist: async db => {
      const active = await db.query("SELECT id FROM wk_inventory_photos WHERE id=$1 AND tenant_id=$2 AND status='active' FOR UPDATE", [input.photoId, job.tenantId]);
      if (!active.rowCount) throw new WorldKitError("not_found", "This photo was removed before its suggestions finished.", 404);
      for (const region of regions) await db.query("INSERT INTO wk_inventory_regions(id,tenant_id,photo_id,payload,job_id) VALUES($1,$2,$3,$4,$5)", [region.id, job.tenantId, input.photoId, region, job.id]);
    } };
  }
  if (job.kind === "inventory_crop_search") {
    const input = z.object({ photoId: z.string(), crop: CropSchema, label: z.string(), hint: z.string(), regionId: z.string() }).parse(job.input);
    const photo = await readPhoto(job.tenantId, input.photoId); const crop = await cropPhoto(photo.bytes, photo.row.width, photo.row.height, input.crop);
    await reserveUsage(job.tenantId, "discovery"); const result = await searchImageCrop(crop, input.hint, job.tenantId);
    const region: InventoryRegion = { id: input.regionId, photoId: input.photoId, label: input.label, hint: input.hint, crop: input.crop, origin: "manual", confirmedAt: job.createdAt, snapshotIds: result.value.map(snapshot => snapshot.id), jobId: job.id, createdAt: job.createdAt };
    return { output: { snapshots: result.value, receipt: result.receipt, photoId: input.photoId, region, sourceMode: photo.row.source_mode, requiresIdentityConfirmation: true }, persist: async db => {
      const active = await db.query("SELECT id FROM wk_inventory_photos WHERE id=$1 AND tenant_id=$2 AND status='active' FOR UPDATE", [input.photoId, job.tenantId]);
      if (!active.rowCount) throw new WorldKitError("not_found", "This photo was removed before its search finished.", 404);
      await saveCatalogResultInTransaction(db, job.tenantId, result.value, result.receipt);
      await db.query("INSERT INTO wk_inventory_regions(id,tenant_id,photo_id,payload,job_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,job_id=EXCLUDED.job_id", [region.id, job.tenantId, input.photoId, region, job.id]);
    } };
  }
  if (job.kind === "inventory_photo_delete") {
    const input = z.object({ photoId: z.string() }).parse(job.input);
    await deletePhotoBlob(job.tenantId, input.photoId);
    return { output: { photoId: input.photoId, removed: true }, persist: async db => {
      await db.query("UPDATE wk_inventory_photos SET status='deleted',deleted_at=now(),blob_url=NULL WHERE id=$1 AND tenant_id=$2", [input.photoId, job.tenantId]);
      await appendEvent(db, job.tenantId, "inventory.photo_deleted", "Private photo removed", "Its non-image fingerprint and prior equipment confirmations remain in your history. The photo can no longer be viewed or sent for recognition.", null);
    } };
  }
  throw new WorldKitError("invalid_request", "This task type has no configured executor.", 400);
}
