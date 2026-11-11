import { timingSafeEqual } from "node:crypto";
import { runQueuedJobs } from "@/server/jobs";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function GET(request: Request) {
  const configured = process.env.CRON_SECRET; const received = request.headers.get("authorization") ?? ""; const expected = `Bearer ${configured ?? ""}`;
  if (!configured || configured.length < 24 || Buffer.byteLength(received) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return Response.json({ error: "Not authorized" }, { status: 401 });
  const claimed = await runQueuedJobs();
  return Response.json({ recoveredOrStarted: claimed }, { headers: { "Cache-Control": "no-store" } });
}
