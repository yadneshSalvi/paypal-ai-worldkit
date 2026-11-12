import { benchError, handlePhysicalNotebook } from "../../../../server/physical-notebook-http";
import { requireBenchAccess } from "../../../../server/physical-notebook-session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request) { try { return await handlePhysicalNotebook(request, await requireBenchAccess(true)); } catch (error) { return benchError(error); } }
export const GET = handle;
export const POST = handle;
