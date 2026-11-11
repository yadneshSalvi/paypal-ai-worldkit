import { timingSafeEqual } from "node:crypto";
import { runQueuedJobs } from "@/server/jobs";
import { runLivingMaintenance } from "@/server/living-maintenance";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function GET(request: Request) {
  const configured = process.env.CRON_SECRET; const received = request.headers.get("authorization") ?? ""; const expected = `Bearer ${configured ?? ""}`;
  if (!configured || configured.length < 24 || Buffer.byteLength(received) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return Response.json({ error: "Not authorized" }, { status: 401 });
  const [claimed, living] = await Promise.all([runQueuedJobs(), runLivingMaintenance()]);
  return Response.json({ recoveredOrStarted: claimed, ...living }, { headers: { "Cache-Control": "no-store" } });
}
