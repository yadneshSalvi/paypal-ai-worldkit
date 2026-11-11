import { after } from "next/server";
import { z } from "zod";
import { DomainSchema } from "../../../../packages/webhooks/contracts";
import { WorldKitError } from "../../../../packages/contracts";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
import { livingView, dismissIncident } from "@/server/living-kit";
import { runLivingMaintenance } from "@/server/living-maintenance";
import { readNotification } from "@/server/notifications";
import { requestOfferWatch, retryOfferWatch, stopOfferWatch } from "@/server/subscriptions";
import { retryWebhook, webhookReadiness } from "@/server/webhooks";
export const runtime = "nodejs";
export const maxDuration = 180;
const id = z.uuid();
const Input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start_watch"), itemId: z.string().min(1).max(150), expectedVersion: z.number().int().positive(), requestId: id, domains: z.array(DomainSchema).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("stop_watch"), watchId: id }).strict(),
  z.object({ kind: z.literal("retry_watch"), watchId: id }).strict(),
  z.object({ kind: z.literal("retry_event"), eventId: id }).strict(),
  z.object({ kind: z.literal("read_notification"), notificationId: id }).strict(),
  z.object({ kind: z.literal("dismiss_incident"), incidentId: id }).strict(),
]);
const headers = { "Cache-Control": "no-store" };
export async function GET() {
  try { const session = await requireSession(); after(async () => { await runLivingMaintenance(session.id); }); return Response.json(await livingView(session.id), { headers }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request); const session = await requireSession(); const input = Input.parse(await readJson(request));
    switch (input.kind) {
      case "start_watch":
        if (!webhookReadiness().channel3) throw new WorldKitError("provider_unavailable", "Equipment alerts are awaiting endpoint setup. Your saved catalog identities remain available.", 503);
        await requestOfferWatch(session, input); break;
      case "stop_watch": await stopOfferWatch(session, input.watchId); break;
      case "retry_watch": await retryOfferWatch(session, input.watchId); break;
      case "retry_event": await retryWebhook(session.id, input.eventId); break;
      case "read_notification": await readNotification(session.id, input.notificationId); break;
      case "dismiss_incident": await dismissIncident(session.id, input.incidentId); break;
    }
    after(async () => { await runLivingMaintenance(session.id); });
    return Response.json(await livingView(session.id), { headers });
  } catch (error) { return errorResponse(error); }
}
