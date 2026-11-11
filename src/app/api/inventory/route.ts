import { after } from "next/server";
import { z } from "zod";
import { ConfirmationSchema, CropSchema } from "../../../../packages/inventory/contracts";
import { applyPlacement, confirmInventory, getInventory, previewInventory, previewPlacement, updateInventoryNotes } from "@/server/inventory";
import { photoRecord, requestPhotoDeletion } from "@/server/inventory-photos";
import { enqueueJob, runQueuedJobs } from "@/server/jobs";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
export const runtime = "nodejs";
export const maxDuration = 180;
const Position = z.object({ itemId: z.string().max(150), target: z.string().max(150), expectedRevisionId: z.string(), expectedGraphHash: z.string().length(64), confirmOwnedReplacement: z.boolean().default(false) }).strict();
const Input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preview"), confirmation: ConfirmationSchema }).strict(),
  z.object({ kind: z.literal("confirm"), confirmation: ConfirmationSchema, previewHash: z.string().length(64) }).strict(),
  z.object({ kind: z.literal("preview_placement"), placement: Position }).strict(),
  z.object({ kind: z.literal("place"), placement: Position.extend({ previewGraphHash: z.string().length(64) }) }).strict(),
  z.object({ kind: z.literal("notes"), itemId: z.string(), expectedVersion: z.number().int().positive(), notes: z.string().max(1000), accessories: z.array(z.string().max(120)).max(12), status: z.enum(["active", "archived"]) }).strict(),
  z.object({ kind: z.literal("regions"), requestId: z.uuid(), photoId: z.string().max(100), provider: z.enum(["openai", "gemini"]) }).strict(),
  z.object({ kind: z.literal("search_crop"), requestId: z.uuid(), photoId: z.string().max(100), crop: CropSchema, label: z.string().trim().min(1).max(80), hint: z.string().trim().max(180), confirmedCrop: z.literal(true) }).strict(),
  z.object({ kind: z.literal("delete_photo"), photoId: z.string().max(100) }).strict(),
]);
export async function GET() { try { const session = await requireSession(); return Response.json(await getInventory(session), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) {
  try {
    sameOrigin(request); const session = await requireSession(); const input = Input.parse(await readJson(request));
    if (input.kind === "preview") return Response.json(await previewInventory(session, input.confirmation), { headers: { "Cache-Control": "no-store" } });
    if (input.kind === "confirm") return Response.json({ item: await confirmInventory(session, input.confirmation, input.previewHash) }, { headers: { "Cache-Control": "no-store" } });
    if (input.kind === "preview_placement") {
      const p = input.placement; const result = await previewPlacement(session, p.itemId, p.target, p.expectedRevisionId, p.expectedGraphHash, p.confirmOwnedReplacement);
      return Response.json({ certificate: result.bundle.certificate, changesOwnedConstraint: result.changesOwnedConstraint }, { headers: { "Cache-Control": "no-store" } });
    }
    if (input.kind === "place") { await applyPlacement(session, input.placement); return Response.json({ placed: true }); }
    if (input.kind === "notes") return Response.json({ item: await updateInventoryNotes(session, input.itemId, input.expectedVersion, { notes: input.notes, accessories: input.accessories, status: input.status }) });
    if (input.kind === "delete_photo") {
      const job = await requestPhotoDeletion(session, input.photoId); after(async () => { await runQueuedJobs(session.id); }); return Response.json({ job }, { status: 202 });
    }
    await photoRecord(session.id, input.photoId);
    const job = input.kind === "regions"
      ? await enqueueJob(session, "inventory_regions", { photoId: input.photoId, provider: input.provider }, input.requestId, "Finding equipment regions in your photo")
      : await enqueueJob(session, "inventory_crop_search", { photoId: input.photoId, crop: input.crop, label: input.label, hint: input.hint, regionId: input.requestId }, input.requestId, "Searching Channel3 with your confirmed crop");
    after(async () => { await runQueuedJobs(session.id); });
    return Response.json({ job }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
