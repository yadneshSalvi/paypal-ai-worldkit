import { z } from "zod";
import { engineeringCommand, engineeringDetail, engineeringHome } from "@/server/engineering-review";
import { requireReviewAccess, reviewError, reviewHeaders, reviewJson } from "@/server/engineering-review-http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const access = await requireReviewAccess(), params = new URL(request.url).searchParams;
    const id = params.get("proposalId"), editionId = params.get("editionId");
    return Response.json(id ? await engineeringDetail(access, z.uuid().parse(id), editionId ? z.uuid().parse(editionId) : undefined) : await engineeringHome(access), { headers: reviewHeaders });
  } catch (error) { return reviewError(error); }
}
export async function POST(request: Request) {
  try {
    const input = await reviewJson(request), access = await requireReviewAccess();
    return Response.json(await engineeringCommand(access, input), { headers: reviewHeaders });
  } catch (error) { return reviewError(error); }
}
