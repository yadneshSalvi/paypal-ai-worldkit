import { benchError, physicalOriginalResponse } from "../../../../../server/physical-notebook-http";
import { requireBenchAccess } from "../../../../../server/physical-notebook-session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) { try { return await physicalOriginalResponse(request, await requireBenchAccess(new URL(request.url).searchParams.get("access") === "review"), (await context.params).assetId); } catch (error) { return benchError(error); } }
