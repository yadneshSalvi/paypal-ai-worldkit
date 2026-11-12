import { controlledBenchIntake } from "../../../../../server/physical-notebook-assets";
import { benchFail } from "../../../../../server/physical-notebook-authority";
import { benchError, benchHeaders, benchOrigin } from "../../../../../server/physical-notebook-http";
import { requireBenchAccess } from "../../../../../server/physical-notebook-session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function PUT(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  try { benchOrigin(request); if (!request.body) benchFail("Select original bytes to upload.", "invalid_request"); return Response.json(await controlledBenchIntake(await requireBenchAccess(), new URL(request.url).searchParams.get("runId") ?? "", (await context.params).uploadId, request.body), { headers: benchHeaders }); }
  catch (error) { return benchError(error); }
}
