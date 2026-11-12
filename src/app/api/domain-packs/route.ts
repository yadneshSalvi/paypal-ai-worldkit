import { domainCommand, domainHome } from "../../../server/domain-packs";
import { errorResponse, readJson, requireSession, sameOrigin } from "../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const session = await requireSession();
    const home = await domainHome(session, url.searchParams.get("projectId") ?? undefined, url.searchParams.get("editionId") ?? undefined);
    return Response.json(home, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try { sameOrigin(request); const session = await requireSession(); return Response.json(await domainCommand(session, await readJson(request)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
