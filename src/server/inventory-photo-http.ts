import { trustedOrigin } from "../../packages/security/origin";
import { WorldKitError } from "../../packages/contracts/index";
import { addInventoryPhoto, MAX_PHOTO_BYTES } from "./inventory-photos";
import { errorResponse } from "./http";
import { findSession } from "./repository";
import { workspaceCookie } from "./workspace-admission-http";

export async function handleInventoryPhotoUpload(request: Request) {
  try {
    if (!trustedOrigin(request, process.env.WORLDKIT_PUBLIC_URL, process.env.VERCEL_URL)) throw new WorldKitError("forbidden", "Upload from your WorldKit equipment passport.", 403);
    const session = await findSession(workspaceCookie(request));
    if (!session) throw new WorldKitError("forbidden", "Open your original private workbench to upload an image.", 401);
    const sourceMode = request.headers.get("X-WorldKit-Image-Source") ?? "live";
    if (sourceMode !== "live" && sourceMode !== "sample") throw new WorldKitError("invalid_request", "Choose Photograph or Sample illustration for this image.", 400);
    if (!/^image\/(jpeg|png|webp)$/.test(request.headers.get("content-type") ?? "")) throw new WorldKitError("invalid_request", "Choose a JPEG, PNG or WebP image.", 415);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_PHOTO_BYTES) throw new WorldKitError("invalid_request", "This image is too large. Resize it before uploading.", 413);
    const reader = request.body?.getReader(); if (!reader) throw new WorldKitError("invalid_request", "Choose an image to upload.");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.length;
        if (length > MAX_PHOTO_BYTES) { await reader.cancel(); throw new WorldKitError("invalid_request", "This image is too large. Resize it before uploading.", 413); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const photo = await addInventoryPhoto(session, Buffer.concat(chunks), sourceMode);
    return Response.json({ photo }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
