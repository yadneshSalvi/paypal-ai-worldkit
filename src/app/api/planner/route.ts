import { z } from "zod";
import { after } from "next/server";
import { getRevision } from "@/server/repository";
import { enqueueJob, runQueuedJobs } from "@/server/jobs";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
export const runtime = "nodejs";
export const maxDuration = 180;
const Input = z.object({ brief: z.string().trim().min(10).max(2000), provider: z.enum(["openai", "gemini"]), requestId: z.uuid() }).strict();
export async function POST(request: Request) {
  try {
    sameOrigin(request); const session = await requireSession(); const input = Input.parse(await readJson(request)); const bundle = await getRevision(session.id);
    const job = await enqueueJob(session, "goal_proposal", { brief: input.brief, provider: input.provider, revisionId: bundle.kit.id }, input.requestId, "Compiling your goal into a reviewable proposal");
    after(async () => { await runQueuedJobs(session.id); });
    return Response.json({ job, requiresConfirmation: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
