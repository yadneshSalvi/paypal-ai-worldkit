import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
import { paymentEvidenceDesk, readPaymentEvidence } from "@/server/payment-evidence";
import { ToolkitReadInput } from "../../../../packages/commerce/toolkit-contracts";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function GET() { try { return Response.json(await paymentEvidenceDesk(await requireSession()), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) {
  try { sameOrigin(request); const input = ToolkitReadInput.parse(await readJson(request)); const session = await requireSession(); const record = await readPaymentEvidence({ session }, input); return Response.json({ record, desk: await paymentEvidenceDesk(session) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
