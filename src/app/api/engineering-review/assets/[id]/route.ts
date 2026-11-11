import { z } from "zod";
import { reviewAssetAuthority } from "@/server/engineering-review";
import { requireReviewAccess, reviewError, reviewHeaders } from "@/server/engineering-review-http";
import { readPhoto, cropPhoto } from "@/server/inventory-photos";
import { digestText } from "../../../../../../packages/engineering-review/policy";
import { SAMPLE_REVIEW_IMAGE } from "../../../../../../packages/engineering-review/sample-image";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireReviewAccess(), { asset, tenantId } = await reviewAssetAuthority(access, z.uuid().parse((await params).id));
    if (!asset.photoId && asset.provenance === "sample" && asset.imageHash === digestText(SAMPLE_REVIEW_IMAGE)) {
      const crop = asset.crop;
      const image = SAMPLE_REVIEW_IMAGE.replace('viewBox="0 0 800 480"', `viewBox="${crop.x * 800} ${crop.y * 480} ${crop.width * 800} ${crop.height * 480}"`);
      return new Response(image, { headers: { ...reviewHeaders, "Content-Type": "image/svg+xml", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
    }
    if (!asset.photoId) return new Response(null, { status: 404, headers: reviewHeaders });
    const result = await readPhoto(tenantId, asset.photoId);
    if (result.row.content_hash !== asset.imageHash) return new Response(null, { status: 409, headers: reviewHeaders });
    const cropped = await cropPhoto(result.bytes, result.row.width, result.row.height, asset.crop);
    // Recheck after the bounded storage read so revocation/deletion wins before disclosure.
    await reviewAssetAuthority(access, asset.id);
    return new Response(new Uint8Array(cropped), { headers: { ...reviewHeaders, "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return reviewError(error); }
}
