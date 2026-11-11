import { after } from "next/server";
import { rawWebhookBody } from "../../../../../packages/webhooks/signatures";
import { acceptWebhook } from "@/server/webhooks";
import { processWebhookQueue } from "@/server/webhook-runner";
import { errorResponse } from "@/server/http";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function POST(request: Request) {
  try {
    const raw = await rawWebhookBody(request);
    await acceptWebhook("channel3", raw, request.headers);
    after(async () => { await processWebhookQueue(); });
    return Response.json({ accepted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
