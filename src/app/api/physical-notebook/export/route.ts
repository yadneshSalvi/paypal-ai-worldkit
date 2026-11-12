import { physicalExportResponse } from "../../../../server/physical-notebook-export";
import { benchError } from "../../../../server/physical-notebook-http";
import { requireBenchAccess } from "../../../../server/physical-notebook-session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { return await physicalExportResponse(request, await requireBenchAccess(new URL(request.url).searchParams.get("access") === "review")); } catch (error) { return benchError(error); } }
