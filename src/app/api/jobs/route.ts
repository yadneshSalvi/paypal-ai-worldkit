import { after } from "next/server";
import { z } from "zod";
import { cancelJob, getJob, listJobs, retryJob, runQueuedJobs } from "@/server/jobs";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function GET(request: Request) {
  try {
    const session = await requireSession(); const id = new URL(request.url).searchParams.get("id");
    const value = id ? { job: await getJob(session.id, z.string().min(1).max(100).parse(id)) } : { jobs: await listJobs(session.id) };
    after(async () => { await runQueuedJobs(session.id); });
    return Response.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
const Input = z.object({ action: z.enum(["cancel", "retry"]), id: z.string().min(1).max(100) }).strict();
export async function POST(request: Request) {
  try {
    sameOrigin(request); const session = await requireSession(); const input = Input.parse(await readJson(request));
    const job = input.action === "cancel" ? await cancelJob(session.id, input.id) : await retryJob(session, input.id);
    if (input.action === "retry") after(async () => { await runQueuedJobs(session.id); });
    return Response.json({ job }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
