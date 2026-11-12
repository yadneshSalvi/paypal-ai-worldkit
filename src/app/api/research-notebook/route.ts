import { requireSession } from "../../../server/http";
import { ownerResearchAccess } from "../../../server/research-notebook-authority";
import { handleResearchNotebook, researchError } from "../../../server/research-notebook-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request) { try { return await handleResearchNotebook(request, ownerResearchAccess(await requireSession())); } catch (error) { return researchError(error); } }
export const GET = handle;
export const POST = handle;
