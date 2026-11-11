import { after } from "next/server";
import { z } from "zod";
import { PaymentError, ProviderError } from "@fracture/paypal-core";
import { SAMPLE_SCENARIOS } from "../../../../packages/living-repair/contracts";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
import { cancelRepairRun, createRepairCommitment, processRepairQueue, proposeKitAmendment, retryRepair, startIncidentRepair, startNextSampleRepair, startSampleRepair } from "@/server/living-repair";
import { acceptKitCompensation, prepareKitCompensation, refreshKitCompensation, resumeKitCompensation, saveRepairSupportRequest, simulateKitShipment } from "@/server/living-repair-compensation";
import { initializeLivingRepair } from "@/server/living-repair-db";
import { acceptKitAmendment, cancelKitAmendment, createKitRepairPolicy, refreshKitAmendment, resumeKitAmendment, revokeKitRepairPolicy } from "@/server/living-repair-payments";
import { livingRepairView, processRepairMaintenance } from "@/server/living-repair-view";
import { loadAmendment } from "@/server/living-repair-store";
export const runtime = "nodejs";
export const maxDuration = 180;
const id = z.string().min(1).max(180); const digest = z.string().regex(/^[a-f0-9]{64}$/); const paymentMode = z.enum(["sample", "live_sandbox"]);
const scenario = z.enum(SAMPLE_SCENARIOS.map(value => value.id) as [typeof SAMPLE_SCENARIOS[number]["id"], ...typeof SAMPLE_SCENARIOS[number]["id"][]]);
const Input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sample"), scenario, requestId: z.uuid(), acceptSampleBranch: z.literal(true) }).strict(),
  z.object({ kind: z.literal("next_sample"), commitmentId: z.uuid(), expectedVersion: z.number().int().positive(), requestId: z.uuid(), acceptSampleTrigger: z.literal(true) }).strict(),
  z.object({ kind: z.literal("incident"), incidentId: z.uuid() }).strict(),
  z.object({ kind: z.literal("advance"), runId: z.uuid() }).strict(),
  z.object({ kind: z.literal("retry"), runId: z.uuid() }).strict(),
  z.object({ kind: z.literal("cancel_run"), runId: z.uuid() }).strict(),
  z.object({ kind: z.literal("commitment"), runId: z.uuid(), graphHash: digest, acceptSampleCommitment: z.literal(true) }).strict(),
  z.object({ kind: z.literal("propose"), runId: z.uuid(), candidateId: id, candidateDigest: digest }).strict(),
  z.object({ kind: z.literal("accept"), amendmentId: z.uuid(), proposalDigest: digest, paymentMode, authority: z.enum(["buyer", "policy"]), policyId: z.uuid().optional(), acceptExactAmendment: z.literal(true), acceptMerchantBoundary: z.literal(true) }).strict(),
  z.object({ kind: z.literal("capture"), amendmentId: z.uuid(), acceptExactCapture: z.literal(true) }).strict(),
  z.object({ kind: z.literal("reconcile"), amendmentId: z.uuid() }).strict(),
  z.object({ kind: z.literal("resume"), amendmentId: z.uuid(), proposalDigest: digest, continueSavedApproval: z.literal(true) }).strict(),
  z.object({ kind: z.literal("cancel"), amendmentId: z.uuid() }).strict(),
  z.object({ kind: z.literal("policy"), requestId: z.uuid(), amendmentId: z.uuid(), proposalDigest: digest, commitmentId: z.uuid(), expectedVersion: z.number().int().positive(), capMinor: z.number().int().min(100).max(100_000), paymentMode, walletId: z.uuid().optional(), walletDigest: digest.optional(), acceptSeparateKitAuthority: z.literal(true) }).strict(),
  z.object({ kind: z.literal("revoke_policy"), policyId: z.uuid() }).strict(),
  z.object({ kind: z.literal("prepare_compensation"), amendmentId: z.uuid(), purpose: z.enum(["undo", "failed_commit"]) }).strict(),
  z.object({ kind: z.literal("accept_compensation"), compensationId: z.uuid(), compensationDigest: digest, acceptExactCompensation: z.literal(true), acceptConditionalRestoration: z.literal(true) }).strict(),
  z.object({ kind: z.literal("reconcile_compensation"), compensationId: z.uuid() }).strict(),
  z.object({ kind: z.literal("resume_compensation"), compensationId: z.uuid(), compensationDigest: digest, continueSavedApproval: z.literal(true) }).strict(),
  z.object({ kind: z.literal("capture_restoration"), compensationId: z.uuid(), acceptExactCapture: z.literal(true) }).strict(),
  z.object({ kind: z.literal("sample_shipment"), commitmentId: z.uuid(), expectedVersion: z.number().int().positive(), acceptShipmentSimulation: z.literal(true) }).strict(),
  z.object({ kind: z.literal("support"), amendmentId: z.uuid(), requestId: z.uuid(), message: z.string().trim().min(10).max(2000) }).strict(),
]);
const headers = { "Cache-Control": "no-store" };
function failure(error: unknown) {
  if (error instanceof PaymentError || error instanceof ProviderError) return Response.json({ error: { code: "payment_state", message: error.message, nextAction: "Reconcile the retained operation; never replace an uncertain payment." } }, { status: error.httpStatus, headers });
  return errorResponse(error);
}
export async function GET(request: Request) {
  try {
    const session = await requireSession(); const query = new URL(request.url).searchParams; let run = query.get("run"); const amendment = query.get("amendment");
    if (run) z.uuid().parse(run);
    if (amendment) { z.uuid().parse(amendment); run = (await loadAmendment(session.id, amendment)).proposal.runId; }
    after(async () => { await processRepairMaintenance(session.id); });
    return Response.json(await livingRepairView(session, run ?? undefined), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request); const session = await requireSession(); const input = Input.parse(await readJson(request));
    await initializeLivingRepair(); let result: unknown; let runId: string | undefined;
    switch (input.kind) {
      case "sample": { const run = await startSampleRepair(session, input.scenario, input.requestId); runId = run.id; result = run; break; }
      case "next_sample": { const run = await startNextSampleRepair(session, input.commitmentId, input.expectedVersion, input.requestId); runId = run.id; result = run; break; }
      case "incident": { const run = await startIncidentRepair(session, input.incidentId); runId = run.id; result = run; break; }
      case "advance": await processRepairQueue(session.id, input.runId); runId = input.runId; break;
      case "retry": result = await retryRepair(session, input.runId); runId = input.runId; break;
      case "cancel_run": result = await cancelRepairRun(session, input.runId); runId = input.runId; break;
      case "commitment": result = await createRepairCommitment(session, input.runId, input.graphHash); runId = input.runId; break;
      case "propose": result = await proposeKitAmendment(session, input.runId, input.candidateId, input.candidateDigest); runId = input.runId; break;
      case "accept": result = await acceptKitAmendment(session, { ...input, origin: request.headers.get("origin")! }); break;
      case "capture": result = await refreshKitAmendment(session, input.amendmentId, { capture: true }); break;
      case "reconcile": result = await refreshKitAmendment(session, input.amendmentId); break;
      case "resume": result = await resumeKitAmendment(session, input.amendmentId, input.proposalDigest); break;
      case "cancel": result = await cancelKitAmendment(session, input.amendmentId); break;
      case "policy": result = await createKitRepairPolicy(session, { ...input, origin: request.headers.get("origin")! }); break;
      case "revoke_policy": result = await revokeKitRepairPolicy(session, input.policyId); break;
      case "prepare_compensation": result = await prepareKitCompensation(session, input.amendmentId, input.purpose); break;
      case "accept_compensation": result = await acceptKitCompensation(session, input.compensationId, input.compensationDigest, request.headers.get("origin")!); break;
      case "reconcile_compensation": result = await refreshKitCompensation(session, input.compensationId); break;
      case "resume_compensation": result = await resumeKitCompensation(session, input.compensationId, input.compensationDigest); break;
      case "capture_restoration": result = await refreshKitCompensation(session, input.compensationId, { capture: true }); break;
      case "sample_shipment": result = await simulateKitShipment(session, input.commitmentId, input.expectedVersion); break;
      case "support": result = await saveRepairSupportRequest(session, input.amendmentId, input.requestId, input.message); break;
    }
    let selected = runId ?? (result && typeof result === "object" && "proposal" in result ? (result.proposal as { runId: string }).runId : undefined);
    if (!selected && result && typeof result === "object" && "amendmentId" in result && typeof result.amendmentId === "string") selected = (await loadAmendment(session.id, result.amendmentId)).proposal.runId;
    if (!selected && "amendmentId" in input) selected = (await loadAmendment(session.id, input.amendmentId)).proposal.runId;
    if (!selected) { const requested = new URL(request.url).searchParams.get("run"); if (requested) selected = z.uuid().parse(requested); }
    after(async () => { await processRepairMaintenance(session.id); });
    return Response.json({ result: result ?? null, repair: await livingRepairView(session, selected) }, { headers });
  } catch (error) { return failure(error); }
}
