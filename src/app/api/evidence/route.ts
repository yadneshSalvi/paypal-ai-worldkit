import { after } from "next/server";
import { z } from "zod";
import { EvidenceActionSchema } from "../../../../packages/spec-evidence/contracts";
import { evidenceDetail, evidenceDraft, evidenceWorkspace, requestSourceDeletion, requestSourceExtraction, requestSourceRetrieval, requestSourceReview, saveSourceCandidate } from "@/server/source-evidence";
import { runQueuedJobs } from "@/server/jobs";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
export const runtime = "nodejs";
export const maxDuration = 180;
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const session = await requireSession(); const params = new URL(request.url).searchParams;
    const draftId = params.get("draftId"); const profileId = params.get("profileId");
    if (draftId) return Response.json(await evidenceDraft(session, z.uuid().parse(draftId)), { headers });
    if (profileId) return Response.json(await evidenceDetail(session, z.string().min(1).max(100).parse(profileId)), { headers });
    return Response.json(await evidenceWorkspace(session), { headers });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request); const session = await requireSession(); const input = EvidenceActionSchema.parse(await readJson(request));
    if (input.kind === "save_candidate") return Response.json({ profile: await saveSourceCandidate(session, input.draftId, input.previewHash, input.expectedHeadId) }, { headers });
    if (input.kind === "request_review") return Response.json({ review: await requestSourceReview(session, input.draftId, input.assertionIds, input.question, input.requestId) }, { headers });
    const job = input.kind === "retrieve" ? await requestSourceRetrieval(session, input.profileId, input.requestId, input.expectedHeadId)
      : input.kind === "delete_document" ? await requestSourceDeletion(session, input.documentId)
      : await requestSourceExtraction(session, { profileId: input.profileId, documentId: input.documentId, expectedSourceHash: input.expectedSourceHash, provider: input.provider, selectedPages: input.selectedPages }, input.requestId);
    after(async () => { await runQueuedJobs(session.id); });
    return Response.json({ job }, { status: 202, headers });
  } catch (error) { return errorResponse(error); }
}
