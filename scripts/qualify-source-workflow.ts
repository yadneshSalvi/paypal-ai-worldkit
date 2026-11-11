import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { get } from "@vercel/blob";
import { createSession, getRevision, type Session } from "../src/server/repository";
import { closeDatabase, database } from "../src/server/db";
import { cancelJob, getJob, runOneJob, type Job } from "../src/server/jobs";
import { recoverSourceModels } from "../src/server/source-models";
import { evidenceDetail, evidenceDraft, evidenceWorkspace, requestSourceDeletion, requestSourceExtraction, requestSourceRetrieval, requestSourceReview, saveSourceCandidate } from "../src/server/source-evidence";
import { confirmInventory, getInventory, previewInventory } from "../src/server/inventory";
import type { InventoryConfirmation } from "../packages/inventory/contracts";
import { sha256 } from "../packages/spec-evidence/sources";

type State = { session: Session; foreign: Session; retrievalRequest: string; refreshRequest: string; geminiRequest: string; astraRequest: string; cancelRequest: string; reviewRequest: string; inventoryRequest: string; retrievalJob?: string; refreshJob?: string; geminiJob?: string; astraJob?: string; cancelJob?: string; confirmation?: InventoryConfirmation; confirmationPreview?: string; originalRevisionId?: string; originalGraphHash?: string; checks: string[]; finished?: boolean };
await mkdir(".artifacts", { recursive: true });
const path = ".artifacts/source-workflow-qualification.state.json";
let state: State;
try { state = JSON.parse(await readFile(path, "utf8")); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const [a, b] = await Promise.all([createSession(), createSession()]); state = { session: a.session, foreign: b.session, retrievalRequest: randomUUID(), refreshRequest: randomUUID(), geminiRequest: randomUUID(), astraRequest: randomUUID(), cancelRequest: randomUUID(), reviewRequest: randomUUID(), inventoryRequest: randomUUID(), checks: [] }; }
const persist = async () => writeFile(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
async function check(name: string) { if (!state.checks.includes(name)) state.checks.push(name); await persist(); console.log(JSON.stringify({ check: name, passed: true })); }
async function settle(id: string): Promise<Job> {
  while (true) {
    const job = await getJob(state.session.id, id);
    if (job.status === "succeeded") return job;
    if (job.status === "failed" || job.status === "cancelled") throw new Error(`The saved ${job.kind} qualification task ended as ${job.status}; inspect its retained evidence before starting any new operation.`);
    const remaining = Math.max(0, Date.parse(job.nextAttemptAt) - Date.now()); if (remaining) await new Promise(resolve => setTimeout(resolve, Math.min(remaining + 50, 15000)));
    await runOneJob({ tenantId: state.session.id, id });
  }
}
await persist();
if (state.finished) { console.log(JSON.stringify({ status: "already_finished", newProviderCalls: 0 })); await closeDatabase(); process.exit(0); }
try {
  const initial = await getRevision(state.session.id); state.originalRevisionId ??= initial.kit.id; state.originalGraphHash ??= initial.certificate.graphHash; await persist();
  const library = await evidenceWorkspace(state.session); assert.equal(library.summary.candidates, 60); assert.equal(library.summary.retrieved, 60); assert.equal(library.summary.humanReviewed, 0);
  if (!state.retrievalJob) { state.retrievalJob = (await requestSourceRetrieval(state.session, "at2020-xlr", state.retrievalRequest, null)).id; await persist(); }
  assert.equal((await requestSourceRetrieval(state.session, "at2020-xlr", state.retrievalRequest, null)).id, state.retrievalJob);
  const retrieval = await settle(state.retrievalJob); const originalDocumentId = (retrieval.output as { document: { id: string } }).document.id;
  const document = (await evidenceDetail(state.session, "at2020-xlr")).documents.find(document => document.id === originalDocumentId)!;
  assert.equal(document.status, "available"); assert.equal(document.identityMentioned, true); assert.match(document.contentHash!, /^[a-f0-9]{64}$/);
  const privateCopy = await get(`worldkit/${state.session.id}/sources/${originalDocumentId}.source`, { access: "private", useCache: false });
  assert.equal(privateCopy?.statusCode, 200);
  const raw = Buffer.from(await new Response(privateCopy!.stream).arrayBuffer()); assert.equal(sha256(raw), document.contentHash);
  await check("Actual manufacturer PDF and private Blob copy match their saved SHA-256; retrieval is idempotent");
  const baseInput = { profileId: "at2020-xlr", documentId: originalDocumentId, expectedSourceHash: document.contentHash!, selectedPages: document.suggestedPages };
  await assert.rejects(() => requestSourceExtraction(state.foreign, { ...baseInput, provider: "gemini" }, randomUUID()), /not in this workspace/);
  await assert.rejects(() => requestSourceExtraction(state.session, { ...baseInput, expectedSourceHash: "0".repeat(64), provider: "gemini" }, randomUUID()), /expected fingerprint/);
  await check("Foreign workspace and wrong source fingerprint cannot enqueue extraction");
  if (!state.geminiJob) { state.geminiJob = (await requestSourceExtraction(state.session, { ...baseInput, provider: "gemini" }, state.geminiRequest)).id; await persist(); }
  const gemini = await settle(state.geminiJob); const geminiDraftId = (gemini.output as { draftId: string }).draftId;
  const proposal = await evidenceDraft(state.session, geminiDraftId); assert.ok(proposal.draft.facts.length >= 10); assert.ok(proposal.draft.counts.located > 0); assert.equal(proposal.draft.promotion, "human_review_required");
  assert.ok(Object.values(proposal.profile.facts).every(fact => fact.review.status === "pending")); assert.equal(proposal.profile.portMapStatus, "pending");
  await assert.rejects(() => evidenceDraft(state.foreign, geminiDraftId), /not in this workspace/);
  await assert.rejects(() => saveSourceCandidate(state.session, geminiDraftId, "f".repeat(64), originalDocumentId), /exact proposal/);
  const saved = await saveSourceCandidate(state.session, geminiDraftId, proposal.previewHash, originalDocumentId);
  assert.equal((await saveSourceCandidate(state.session, geminiDraftId, proposal.previewHash, originalDocumentId)).id, saved.id);
  assert.ok((await getInventory(state.session)).library.some(profile => profile.id === saved.id));
  await check("Actual Gemini facts remain unreviewed; preview-bound candidate save is private and idempotent");
  if (!state.confirmation) {
    const before = await getRevision(state.session.id); assert.equal(before.certificate.graphHash, state.originalGraphHash);
    state.confirmation = { requestId: state.inventoryRequest, identity: { libraryProfileId: saved.id, manufacturer: saved.manufacturer, model: saved.model, variant: saved.variant, deviceKind: saved.kind, ownership: "planned", quantity: 1, condition: "unknown", accessories: [], notes: "Automated source-workflow qualification. Planned test entry; no equipment possession, human technical review or physical test is claimed.", confirmedExactIdentity: true, confirmedOwnership: false }, snapshotId: null, selectedOptions: [], photoId: null, regionId: null, targetComponentId: "mic-2", expectedRevisionId: before.kit.id, expectedGraphHash: before.certificate.graphHash, confirmOwnedReplacement: false, correctItemId: null, expectedItemVersion: null };
    await persist();
  }
  if (!state.confirmationPreview) { const preview = await previewInventory(state.session, state.confirmation); assert.equal(preview.certificate?.review.reviewed, 0); assert.equal(preview.certificate?.physicalTest, "not_performed"); state.confirmationPreview = preview.previewHash; await persist(); }
  const item = await confirmInventory(state.session, state.confirmation, state.confirmationPreview); assert.equal(item.ownership, "planned");
  const placed = await getRevision(state.session.id); assert.equal(placed.certificate.review.reviewed, 0); assert.ok(placed.sources.some(source => source.id === proposal.source.id));
  assert.notEqual(placed.certificate.status, "satisfied"); assert.equal((await getRevision(state.session.id, state.originalRevisionId)).certificate.graphHash, state.originalGraphHash);
  await check("Planned test identity can use the immutable candidate; incomplete ports remain unresolved and the original certificate is intact");
  const review = await requestSourceReview(state.session, geminiDraftId, proposal.draft.facts.slice(0, 2).map(fact => fact.assertionId), "Automated qualification question: check the exact operating scope and source support. No human reviewer is represented by this test.", state.reviewRequest);
  assert.equal(review.status, "open"); assert.equal((await evidenceDetail(state.session, "at2020-xlr")).reviewRequests.filter(row => row.id === review.id).length, 1);
  await check("A review request stores a question without inventing a reviewer or approving facts");
  if (!state.refreshJob) { state.refreshJob = (await requestSourceRetrieval(state.session, "at2020-xlr", state.refreshRequest, originalDocumentId)).id; await persist(); }
  const refreshed = await settle(state.refreshJob); const currentDocumentId = (refreshed.output as { document: { id: string } }).document.id;
  const current = (await evidenceDetail(state.session, "at2020-xlr")).documents.find(document => document.id === currentDocumentId)!;
  assert.equal(current.current, true); assert.notEqual(current.id, originalDocumentId);
  const astraInput = { ...baseInput, documentId: current.id, expectedSourceHash: current.contentHash!, selectedPages: current.suggestedPages, provider: "openai" as const };
  if (!state.astraJob) { state.astraJob = (await requestSourceExtraction(state.session, astraInput, state.astraRequest)).id; await persist(); await runOneJob({ tenantId: state.session.id, id: state.astraJob }); await closeDatabase(); }
  const astra = await settle(state.astraJob); const astraDraftId = (astra.output as { draftId: string }).draftId; const detailed = await evidenceDraft(state.session, astraDraftId);
  const modelRows = await database().query("SELECT payload FROM wk_source_model_requests WHERE job_id=$1 AND tenant_id=$2", [state.astraJob, state.session.id]); assert.equal(modelRows.rowCount, 1); assert.equal(modelRows.rows[0].payload.responseId, detailed.receipt.requestId); assert.equal(modelRows.rows[0].payload.phase, "received");
  await assert.rejects(() => saveSourceCandidate(state.session, astraDraftId, detailed.previewHash, originalDocumentId), /newer source/);
  await saveSourceCandidate(state.session, astraDraftId, detailed.previewHash, current.id);
  await check("Actual Astra background result resumes after database restart with one retained provider identity");
  if (!state.cancelJob) { state.cancelJob = (await requestSourceExtraction(state.session, astraInput, state.cancelRequest)).id; await persist(); await runOneJob({ tenantId: state.session.id, id: state.cancelJob }); }
  await cancelJob(state.session.id, state.cancelJob); await recoverSourceModels(state.session.id);
  const cancelled = await getJob(state.session.id, state.cancelJob); assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.output, null);
  const cancelRows = await database().query("SELECT payload FROM wk_source_model_requests WHERE job_id=$1 AND tenant_id=$2", [state.cancelJob, state.session.id]);
  assert.ok(cancelRows.rows[0]?.payload.responseId); assert.equal(cancelRows.rows[0].payload.phase, "failed");
  await check("Cancellation retains the actual provider response identity and prevents any source proposal from being applied");
  for (const id of [originalDocumentId, currentDocumentId]) {
    const row = (await evidenceDetail(state.session, "at2020-xlr")).documents.find(document => document.id === id)!;
    if (row.status !== "deleted") { const cleanup = await requestSourceDeletion(state.session, id); await settle(cleanup.id); }
    assert.equal(await get(`worldkit/${state.session.id}/sources/${id}.source`, { access: "private", useCache: false }), null);
  }
  const afterDeletion = await getRevision(state.session.id); assert.equal(afterDeletion.certificate.graphHash, placed.certificate.graphHash); assert.equal((await evidenceDraft(state.session, geminiDraftId)).excerpts.length, 0);
  await check("Actual private source deletion removes document text while retaining historical fingerprints, candidates and certificates");
  await writeFile("docs/evidence/source-workflow-qualification.json", JSON.stringify({ completedAt: new Date().toISOString(), sourceMode: "live_provider_calls", interfaceMode: "server_integration", plannedInventoryEntry: "automated qualification fixture; not possession or human review", checks: state.checks, originalRevisionId: state.originalRevisionId, sourceCopies: [document, current].map(document => ({ id: document.id, sourceHash: document.contentHash, textHash: document.textHash, pages: document.pages, bytes: document.bytes, removed: true })), models: [{ receipt: proposal.receipt, counts: proposal.draft.counts, continuations: gemini.continuations }, { receipt: detailed.receipt, counts: detailed.draft.counts, continuations: astra.continuations }], cancellation: { jobId: state.cancelJob, responseId: cancelRows.rows[0].payload.responseId, observedProviderStatus: cancelRows.rows[0].payload.providerStatus, outputApplied: false }, humanReviewDecisions: 0, physicalTests: 0, financialWrites: 0 }, null, 2) + "\n");
  state.finished = true; await persist(); console.log(JSON.stringify({ status: "finished", checks: state.checks.length, humanReviews: 0, financialWrites: 0 }));
} finally { await closeDatabase(); }
