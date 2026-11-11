import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
import { synthesisCommand, synthesisHome, synthesisOwner } from "@/server/synthesis";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store, max-age=0", "Vercel-CDN-Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const session = await requireSession(), id = new URL(request.url).searchParams.get("edition") ?? undefined;
    if (id && id.length > 200) return Response.json({ error: { code: "invalid_request", message: "Use one saved comparison identity." } }, { status: 400, headers });
    return Response.json(await synthesisHome(synthesisOwner(session), id), { headers });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request); const session = await requireSession();
    const result = await synthesisCommand(synthesisOwner(session), await readJson(request));
    return Response.json({ result, workspace: await synthesisHome(synthesisOwner(session), result.editionId) }, { headers });
  } catch (error) { return errorResponse(error); }
}
