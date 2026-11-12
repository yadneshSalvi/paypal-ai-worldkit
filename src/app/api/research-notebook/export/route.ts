import { requireSession } from "../../../../server/http";
import { ownerResearchAccess } from "../../../../server/research-notebook-authority";
import { researchExportResponse } from "../../../../server/research-notebook-export";
import { researchError } from "../../../../server/research-notebook-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { return await researchExportResponse(request, ownerResearchAccess(await requireSession())); } catch (error) { return researchError(error); } }
