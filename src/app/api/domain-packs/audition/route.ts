import { WorldKitError } from "../../../../../packages/contracts";
import { renderPackAudition } from "../../../../../packages/domain-packs/soundcheck";
import { domainHome } from "../../../../server/domain-packs";
import { errorResponse, requireSession } from "../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const projectId = url.searchParams.get("projectId"); const editionId = url.searchParams.get("editionId"); const graphHash = url.searchParams.get("graphHash"); const requestedChannel = url.searchParams.get("channel") ?? "mix";
    if (!projectId || !editionId || !graphHash) throw new WorldKitError("invalid_request", "Choose one saved edition for the routing audition.");
    const home = await domainHome(await requireSession(), projectId, editionId); const selected = home.selected;
    if (!selected || selected.edition.certificate.graphHash !== graphHash) throw new WorldKitError("stale_revision", "This audition belongs to a different saved graph.", 409);
    const audition = renderPackAudition(selected.edition, requestedChannel === "mix" ? "mix" : Number(requestedChannel));
    return new Response(audition.wav, { headers: { "Content-Type": "audio/wav", "Content-Disposition": `inline; filename="worldkit-modelled-${graphHash.slice(0, 12)}.wav"`, "Cache-Control": "no-store", "X-WorldKit-Provenance": "modelled", "X-WorldKit-Graph": graphHash, "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error); }
}
