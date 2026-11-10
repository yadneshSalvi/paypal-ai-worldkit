import { MutationSchema } from "../../../../packages/workbench/index";
import { commitEdit, getWorkspace } from "@/server/repository";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
export const runtime = "nodejs";
export async function PATCH(request: Request) { try {
  sameOrigin(request); const session = await requireSession(); const input = MutationSchema.parse(await readJson(request));
  await commitEdit(session, input.expectedRevisionId, input.expectedGraphHash, input.edit);
  return Response.json(await getWorkspace(session), { headers: { "Cache-Control": "no-store" } });
} catch (error) { return errorResponse(error); } }
