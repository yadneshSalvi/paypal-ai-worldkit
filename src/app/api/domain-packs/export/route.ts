import { WorldKitError } from "../../../../../packages/contracts";
import { domainHome } from "../../../../server/domain-packs";
import { errorResponse, requireSession } from "../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const projectId = url.searchParams.get("projectId"); const editionId = url.searchParams.get("editionId"); const graphHash = url.searchParams.get("graphHash");
    if (!projectId || !editionId || !graphHash) throw new WorldKitError("invalid_request", "Choose one saved system edition to export.");
    const home = await domainHome(await requireSession(), projectId, editionId); const selected = home.selected;
    if (!selected || selected.edition.certificate.graphHash !== graphHash) throw new WorldKitError("stale_revision", "The export request does not match this exact saved graph.", 409);
    return new Response(JSON.stringify({ schema: "worldkit.domain-dossier.1", edition: selected.edition, freshness: selected.freshness, requirements: selected.requirements, assembly: selected.guide, physicalTest: "not_performed", actualHumanReviews: 0, exportedAt: new Date().toISOString() }, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="worldkit-${selected.project.packId}-edition-${selected.edition.number}.json"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error); }
}
