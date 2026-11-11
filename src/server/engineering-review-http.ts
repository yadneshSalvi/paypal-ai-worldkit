import { cookies } from "next/headers";
import { WorldKitError } from "../../packages/contracts";
import { authenticateReviewer, ownerReviewAccess } from "./engineering-review";
import { errorResponse, requireSession, sameOrigin } from "./http";

export const reviewCookie = process.env.WORLDKIT_QA_MODE === "engineering" ? "wk_engineering_reviewer_qa" : "wk_reviewer";
export const reviewHeaders = { "Cache-Control": "private, no-store, max-age=0", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "Referrer-Policy": "no-referrer" };
export async function requireReviewAccess() {
  const credential = (await cookies()).get(reviewCookie)?.value;
  if (credential) {
    const access = await authenticateReviewer(credential);
    if (!access) throw new WorldKitError("forbidden", "This specialist session has expired or been revoked. Leave specialist mode to return to your own workbench.", 401);
    return access;
  }
  return ownerReviewAccess(await requireSession());
}
export function reviewError(error: unknown) {
  const response = errorResponse(error);
  Object.entries(reviewHeaders).forEach(([key, value]) => response.headers.set(key, value));
  return response;
}
export async function reviewJson(request: Request): Promise<unknown> {
  sameOrigin(request, 200_000);
  const reader = request.body?.getReader();
  if (!reader) throw new WorldKitError("invalid_request", "The review command needs a JSON body.");
  const parts: Uint8Array[] = []; let count = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; count += next.value.length; if (count > 200_000) { await reader.cancel(); throw new WorldKitError("invalid_request", "This proposal exceeds the review limit.", 413); } parts.push(next.value); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new WorldKitError("invalid_request", "The review command could not be read."); }
}
