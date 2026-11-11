import { z } from "zod";
import { PaymentError, ProviderError } from "@fracture/paypal-core";
import { VaultFault } from "../../../../packages/commerce/vault";
import { walletView } from "../../../../packages/commerce/contracts";
import { WorldKitError } from "../../../../packages/contracts/index";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
import { createQuote, getRevision } from "@/server/repository";
import { acceptCheckout, loadOrder, cancelCheckout, captureCheckout, commerceView, deliverDossier, enableRepairPolicy, executeRepair, openSupportRequest, refreshOrder, refundCheckout, revokeRepairPolicy } from "@/server/commerce";
import { beginWalletSetup, completeWalletSetup, createWalletConsent, revokeWallet } from "@/server/wallets";
export const runtime = "nodejs";
export const maxDuration = 120;
const id = z.string().min(1).max(128); const digest = z.string().regex(/^[a-f0-9]{64}$/);
const Input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("quote"), revisionId: id, graphHash: digest }).strict(),
  z.object({ kind: z.literal("checkout"), quoteId: id, quoteHash: digest, saveWallet: z.boolean(), acceptServiceTerms: z.literal(true), acceptWalletTerms: z.boolean() }).strict(),
  z.object({ kind: z.literal("capture"), orderId: id }).strict(),
  z.object({ kind: z.literal("refresh"), orderId: id }).strict(),
  z.object({ kind: z.literal("cancel"), orderId: id }).strict(),
  z.object({ kind: z.literal("refund"), orderId: id, confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("deliver"), orderId: id }).strict(),
  z.object({ kind: z.literal("wallet_begin"), acceptWalletTerms: z.literal(true) }).strict(),
  z.object({ kind: z.literal("wallet_complete"), consentId: id }).strict(),
  z.object({ kind: z.literal("wallet_revoke"), consentId: id }).strict(),
  z.object({ kind: z.literal("policy_enable"), orderId: id, walletId: id, walletDigest: digest, capMinor: z.literal(2500), accepted: z.literal(true) }).strict(),
  z.object({ kind: z.literal("policy_revoke"), policyId: id }).strict(),
  z.object({ kind: z.literal("repair"), policyId: id, scenarioId: id, revisionId: id, graphHash: digest, acceptSampleTrigger: z.literal(true) }).strict(),
  z.object({ kind: z.literal("support"), orderId: id, message: z.string().trim().min(10).max(2000) }).strict(),
]);
function failure(error: unknown) {
  if (error instanceof PaymentError || error instanceof ProviderError) return Response.json({ error: { code: "payment_state", message: error.message, nextAction: "Refresh the saved payment state" } }, { status: error.httpStatus, headers: { "Cache-Control": "no-store" } });
  if (error instanceof VaultFault) return Response.json({ error: { code: "wallet_state", message: error.message, nextAction: "Refresh the saved wallet state" } }, { status: error.status >= 400 ? error.status : 502, headers: { "Cache-Control": "no-store" } });
  return errorResponse(error);
}
export async function GET() { try { return Response.json(await commerceView(await requireSession()), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return failure(error); } }
export async function POST(request: Request) {
  try {
    sameOrigin(request); const session = await requireSession(); const input = Input.parse(await readJson(request)); const origin = request.headers.get("origin")!;
    if ("orderId" in input && (await loadOrder(session.id, input.orderId)).livingRepair) throw new WorldKitError("invalid_request", "This order belongs to Living Repair. Use its separately scoped amendment or compensation controls.", 409);
    let value: unknown;
    switch (input.kind) {
      case "quote": { const bundle = await getRevision(session.id); if (bundle.kit.id !== input.revisionId || bundle.certificate.graphHash !== input.graphHash) throw new WorldKitError("stale_revision", "Refresh the kit before requesting its quote.", 409); value = await createQuote(session.id, bundle); break; }
      case "checkout": if (input.saveWallet && !input.acceptWalletTerms) throw new WorldKitError("forbidden", "Review and accept wallet saving before enabling it.", 403); value = await acceptCheckout(session, input.quoteId, input.quoteHash, input.saveWallet, origin); break;
      case "capture": value = await captureCheckout(session, input.orderId); break;
      case "refresh": value = await refreshOrder(session, input.orderId); break;
      case "cancel": value = await cancelCheckout(session, input.orderId); break;
      case "refund": value = await refundCheckout(session, input.orderId); break;
      case "deliver": value = await deliverDossier(session, input.orderId); break;
      case "wallet_begin": { const consent = await createWalletConsent(session, origin, "separate_setup"); value = walletView(await beginWalletSetup(session, consent.id)); break; }
      case "wallet_complete": value = walletView(await completeWalletSetup(session, input.consentId)); break;
      case "wallet_revoke": value = walletView(await revokeWallet(session, input.consentId)); break;
      case "policy_enable": value = await enableRepairPolicy(session, input.orderId, input.walletId, input.walletDigest); break;
      case "policy_revoke": value = await revokeRepairPolicy(session, input.policyId); break;
      case "repair": value = await executeRepair(session, input.policyId, input.scenarioId, input.revisionId, input.graphHash); break;
      case "support": value = await openSupportRequest(session, input.orderId, input.message); break;
    }
    return Response.json({ result: value ?? null, commerce: await commerceView(session) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
