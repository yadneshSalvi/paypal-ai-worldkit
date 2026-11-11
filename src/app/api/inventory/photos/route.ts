import { trustedOrigin } from "../../../../../packages/security/origin";
import { WorldKitError } from "../../../../../packages/contracts/index";
import { addInventoryPhoto, MAX_PHOTO_BYTES } from "@/server/inventory-photos";
import { errorResponse, requireSession } from "@/server/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    if (!trustedOrigin(request, process.env.WORLDKIT_PUBLIC_URL, process.env.VERCEL_URL)) throw new WorldKitError("forbidden", "Upload from your WorldKit equipment passport.", 403);
    const session = await requireSession();
    if (!/^image\/(jpeg|png|webp)$/.test(request.headers.get("content-type") ?? "")) throw new WorldKitError("invalid_request", "Choose a JPEG, PNG or WebP photo.", 415);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_PHOTO_BYTES) throw new WorldKitError("invalid_request", "This photo is too large. Resize it before uploading.", 413);
    const reader = request.body?.getReader(); if (!reader) throw new WorldKitError("invalid_request", "Choose a photo to upload.");
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > MAX_PHOTO_BYTES) { await reader.cancel(); throw new WorldKitError("invalid_request", "This photo is too large. Resize it before uploading.", 413); } chunks.push(part.value); }
    const photo = await addInventoryPhoto(session, Buffer.concat(chunks));
    return Response.json({ photo }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
