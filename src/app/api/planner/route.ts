import { z } from "zod";
import { proposeGoal } from "../../../../packages/planner/index";
import { finishJob, getRevision, reserveUsage, startJob, type Session } from "@/server/repository";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
export const runtime = "nodejs";
export const maxDuration = 180;
const Input = z.object({ brief: z.string().trim().min(10).max(2000), provider: z.enum(["openai", "gemini"]) }).strict();
export async function POST(request: Request) {
  let session: Session | null = null; let jobId: string | null = null;
  try {
    sameOrigin(request); session = await requireSession(); const input = Input.parse(await readJson(request));
    await reserveUsage(session.id, "model"); const bundle = await getRevision(session.id);
    jobId = await startJob(session, "goal_proposal", { ...input, basedOnRevisionId: bundle.kit.id });
    const result = await proposeGoal(input.brief, bundle.kit.goal, input.provider); await finishJob(session, jobId, result);
    return Response.json({ ...result, jobId, basedOnRevisionId: bundle.kit.id, requiresConfirmation: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (session && jobId) await finishJob(session, jobId, null, "The provider did not complete a validated goal proposal.");
    return errorResponse(error);
  }
}
