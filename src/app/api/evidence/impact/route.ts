import { z } from "zod";
import { sourceImpact } from "@/server/source-impact";
import { errorResponse, requireSession } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const session = await requireSession(), params = new URL(request.url).searchParams;
    const profileId = z.string().min(1).max(100).parse(params.get("profileId"));
    const documentId = params.has("documentId") ? z.uuid().parse(params.get("documentId")) : undefined;
    return Response.json(await sourceImpact(session, profileId, documentId), { headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } });
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Robots-Tag", "noindex");
    return response;
  }
}
