import { PublicEditionSchema, PublicSlugSchema } from "../../../../../../packages/public-record";
import { recordFailure, recordJson, recordQr, PUBLIC_RECORD_HEADERS } from "@/server/public-record-http";
import { readPublicRecord } from "@/server/public-records";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ slug: string; asset?: string[] }> };
export async function GET(_request: Request, context: Context) {
  try {
    const { slug, asset = [] } = await context.params;
    if (!PublicSlugSchema.safeParse(slug).success) return recordJson({ error: { code: "not_found", message: "This certificate is unavailable." } }, 404);
    const parsed = asset.length ? PublicEditionSchema.safeParse(asset[1]) : null;
    if (asset.length && (asset[0] !== "e" || !parsed?.success || asset.length > 3 || (asset.length === 3 && !["qr", "guide"].includes(asset[2]!)))) return recordJson({ error: { code: "not_found", message: "This certificate address is unavailable." } }, 404);
    const view = await readPublicRecord(slug, parsed?.success ? parsed.data : undefined);
    if (asset[2] === "qr" && view.state === "published" && view.record) {
      return new Response(new Uint8Array(await recordQr(slug, view.record.edition)), { headers: { ...PUBLIC_RECORD_HEADERS, "Content-Type": "image/png", "Content-Disposition": 'inline; filename="worldkit-immutable-edition-qr.png"', "Content-Security-Policy": "default-src 'none'; sandbox" } });
    }
    return recordJson(view, view.state === "published" ? 200 : view.state === "withdrawn" ? 410 : 404);
  } catch (error) { return recordFailure(error); }
}
