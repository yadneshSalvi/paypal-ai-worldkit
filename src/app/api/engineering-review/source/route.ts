import { z } from "zod";
import { engineeringSourcePage } from "@/server/engineering-review";
import { requireReviewAccess, reviewError, reviewHeaders, reviewJson } from "@/server/engineering-review-http";
export const runtime = "nodejs";
const Input = z.object({ proposalId: z.uuid(), editionId: z.uuid(), page: z.number().int().positive(), offset: z.number().int().nonnegative(), end: z.number().int().positive().optional() }).strict();
export async function POST(request: Request) {
  try {
    const input = Input.parse(await reviewJson(request)), access = await requireReviewAccess();
    return Response.json(await engineeringSourcePage(access, input.proposalId, input.editionId, input.page, input.offset, input.end), { headers: reviewHeaders });
  } catch (error) { return reviewError(error); }
}
