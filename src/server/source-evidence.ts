import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { get, put, del } from "@vercel/blob";
import { z } from "zod";
import { hash } from "../../packages/compatibility";
import { WorldKitError, type DeviceProfile, type Source } from "../../packages/contracts";
import manifest from "../../packages/device-library/corpus-source-manifest.json";
import { candidateProfiles, candidateSources } from "../../packages/device-library/candidates";
import { corpusDevices, retrieveManufacturerSource, sha256, type CorpusDevice, type SourceDocument } from "../../packages/spec-evidence/sources";
import { extractSource, extractionInput } from "../../packages/spec-evidence/extractor";
import { candidateProfile, immutableSource } from "../../packages/spec-evidence/profile";
import { sourceQueries, suggestedPages } from "../../packages/spec-evidence/queries";
import { ModelPending } from "../../packages/spec-evidence/providers";
import type { EvidenceCandidate, EvidenceDetail, EvidenceDocument, EvidenceDraftDetail, EvidenceDraftSummary, EvidenceReviewRequest, EvidenceWorkspace, ExtractionDraft } from "../../packages/spec-evidence/contracts";
import type { ModelReceipt } from "../../packages/planner";
import { database, initialize, transaction } from "./db";
import { enqueueJob, type ClaimedJob, type JobResult } from "./jobs";
import { appendEvent, type Session } from "./repository";
import { storageReady } from "./inventory-photos";
import { SourceModelStore } from "./source-models";

type DocumentRow = { id: string; tenant_id: string; profile_id: string; job_id: string; source_url: string; blob_path: string; content_hash: string | null; text_hash: string | null; media_type: string | null; bytes: number | null; payload: SourceDocument | null; status: EvidenceDocument["status"]; created_at: Date; write_until: Date | null; current_document_id?: string; head_version?: number };
type DraftRow = { id: string; tenant_id: string; document_id: string; profile_id: string; job_id: string; payload: ExtractionDraft; receipt: ModelReceipt; created_at: Date; saved_candidate_id?: string | null };
const sourceInput = z.object({ profileId: z.string(), documentId: z.uuid(), expectedHeadId: z.uuid().nullable() }).strict();
const extractInput = z.object({ profileId: z.string(), documentId: z.uuid(), expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/), provider: z.enum(["openai", "gemini"]), selectedPages: z.array(z.number().int().positive()).min(1).max(400) }).strict();
function deviceById(id: string): CorpusDevice { const device = corpusDevices.find(device => device.id === id); if (!device) throw new WorldKitError("not_found", "Choose an exact device from the source library.", 404); return device; }
function publicDocument(row: DocumentRow): EvidenceDocument {
  return { id: row.id, profileId: row.profile_id, sourceUrl: row.source_url, contentHash: row.content_hash, textHash: row.text_hash, status: row.status, mediaType: row.media_type, bytes: row.bytes, pages: row.payload?.pages.length ?? 0, characters: row.payload?.pages.reduce((n, page) => n + page.text.length, 0) ?? 0, retrievedAt: row.payload?.retrievedAt ?? null, createdAt: new Date(row.created_at).toISOString(), current: row.current_document_id === row.id, headVersion: row.head_version ?? null, identityMentioned: row.payload?.identityMentioned ?? false, suggestedPages: row.payload ? suggestedPages(row.payload) : [], pageSizes: row.payload?.pages.map(page => ({ number: page.number, characters: page.text.length })) ?? [] };
}
function publicDraft(row: DraftRow): EvidenceDraftSummary { return { id: row.id, profileId: row.profile_id, documentId: row.document_id, sourceHash: row.payload.sourceHash, provider: row.receipt.provider, model: row.receipt.model, createdAt: new Date(row.created_at).toISOString(), counts: row.payload.counts, savedCandidateId: row.saved_candidate_id ?? null }; }
function reviewRequest(row: Record<string, any>): EvidenceReviewRequest { return { id: row.id, draftId: row.draft_id, assertionIds: row.assertion_ids, question: row.question, status: "open", createdAt: new Date(row.created_at).toISOString() }; }
function publicCandidate(device: CorpusDevice, document: DocumentRow | undefined, savedCandidateId: string | null, proposedFacts: number): EvidenceCandidate {
  const source = manifest.find(row => row.profileId === device.id);
  return { id: device.id, manufacturer: device.manufacturer, model: device.model, variant: device.variant, kind: device.kind, group: device.group, family: device.family, split: device.split, source: { title: device.source.title, publisher: device.manufacturer, url: source?.url ?? device.source.url, retrievedAt: source?.retrievedAt ?? null, contentHash: source?.contentHash ?? null, pages: source?.pages ?? 0, status: source?.status ?? "unretrieved" }, currentDocument: document ? publicDocument(document) : null, proposedFacts, pendingReview: true, savedCandidateId };
}
async function sourceRow(tenantId: string, id: string, db?: PoolClient): Promise<DocumentRow> {
  await initialize();
  const result = await (db ?? database()).query("SELECT d.*,h.document_id AS current_document_id,h.version AS head_version FROM wk_source_documents d LEFT JOIN wk_source_heads h ON h.tenant_id=d.tenant_id AND h.profile_id=d.profile_id WHERE d.tenant_id=$1 AND d.id=$2", [tenantId, id]);
  if (!result.rows[0]) throw new WorldKitError("not_found", "That document is not in this workspace.", 404);
  const row = result.rows[0] as DocumentRow;
  if (row.blob_path !== `worldkit/${tenantId}/sources/${id}.source`) throw new WorldKitError("needs_evidence", "The private document binding needs attention.", 422);
  return row;
}
async function draftRow(tenantId: string, id: string, db?: PoolClient): Promise<DraftRow> {
  await initialize();
  const result = await (db ?? database()).query("SELECT d.*,v.id AS saved_candidate_id FROM wk_source_drafts d LEFT JOIN wk_source_profile_versions v ON v.tenant_id=d.tenant_id AND v.draft_id=d.id WHERE d.tenant_id=$1 AND d.id=$2", [tenantId, id]);
  if (!result.rows[0]) throw new WorldKitError("not_found", "That source proposal is not in this workspace.", 404);
  return result.rows[0] as DraftRow;
}
async function assertLease(db: PoolClient, job: ClaimedJob) {
  const active = await db.query("SELECT j.id FROM wk_jobs j JOIN wk_sessions s ON s.id=j.tenant_id WHERE j.id=$1 AND j.tenant_id=$2 AND j.status='running' AND j.lease_token=$3 AND j.lease_expires_at>now() AND s.expires_at>now() FOR UPDATE OF j", [job.id, job.tenantId, job.leaseToken]);
  if (!active.rowCount) throw new WorldKitError("stale_revision", "This source task ended before its result could be saved.", 409);
}

export async function evidenceWorkspace(session: Session): Promise<EvidenceWorkspace> {
  await initialize();
  const [heads, versions] = await Promise.all([
    database().query("SELECT d.*,h.document_id AS current_document_id,h.version AS head_version FROM wk_source_heads h JOIN wk_source_documents d ON d.id=h.document_id WHERE h.tenant_id=$1", [session.id]),
    database().query("SELECT DISTINCT ON(profile_id) profile_id,id,payload FROM wk_source_profile_versions WHERE tenant_id=$1 ORDER BY profile_id,created_at DESC", [session.id]),
  ]);
  return { candidates: corpusDevices.map(device => {
    const saved = versions.rows.find(row => row.profile_id === device.id);
    const primary = candidateProfiles.find(profile => profile.corpusId === device.id);
    return publicCandidate(device, heads.rows.find(row => row.profile_id === device.id), saved?.id ?? null, Object.values((saved?.payload as DeviceProfile | undefined)?.facts ?? primary?.facts ?? {}).filter(fact => fact.state === "supported").length);
  }), summary: { candidates: corpusDevices.length, retrieved: manifest.filter(row => row.status === "retrieved").length, heldOut: corpusDevices.filter(device => device.split === "held_out").length, development: corpusDevices.filter(device => device.split === "development").length, humanReviewed: 0, physicalTests: 0 }, storageReady: storageReady() };
}
export async function evidenceDetail(session: Session, profileId: string): Promise<EvidenceDetail> {
  const device = deviceById(profileId); await initialize();
  const [documents, drafts, reviews, versions] = await Promise.all([
    database().query("SELECT d.*,h.document_id AS current_document_id,h.version AS head_version FROM wk_source_documents d LEFT JOIN wk_source_heads h ON h.tenant_id=d.tenant_id AND h.profile_id=d.profile_id WHERE d.tenant_id=$1 AND d.profile_id=$2 ORDER BY d.created_at DESC LIMIT 20", [session.id, profileId]),
    database().query("SELECT d.*,v.id AS saved_candidate_id FROM wk_source_drafts d LEFT JOIN wk_source_profile_versions v ON v.tenant_id=d.tenant_id AND v.draft_id=d.id WHERE d.tenant_id=$1 AND d.profile_id=$2 ORDER BY d.created_at DESC LIMIT 20", [session.id, profileId]),
    database().query("SELECT r.* FROM wk_source_review_requests r JOIN wk_source_drafts d ON d.id=r.draft_id WHERE r.tenant_id=$1 AND d.profile_id=$2 ORDER BY r.created_at DESC LIMIT 30", [session.id, profileId]),
    database().query("SELECT id,payload FROM wk_source_profile_versions WHERE tenant_id=$1 AND profile_id=$2 ORDER BY created_at DESC LIMIT 1", [session.id, profileId]),
  ]);
  const saved = versions.rows[0]; const primary = candidateProfiles.find(profile => profile.corpusId === device.id);
  return { candidate: publicCandidate(device, documents.rows.find(row => row.current_document_id === row.id), saved?.id ?? null, Object.values((saved?.payload as DeviceProfile | undefined)?.facts ?? primary?.facts ?? {}).filter(fact => fact.state === "supported").length), documents: documents.rows.map(publicDocument), drafts: drafts.rows.map(publicDraft), queries: sourceQueries(device), reviewRequests: reviews.rows.map(reviewRequest), libraryProfile: primary ?? null, librarySource: candidateSources.find(source => source.id === `manufacturer:${device.id}:${primary?.sourceVersion}`) ?? null };
}

export async function requestSourceRetrieval(session: Session, profileId: string, requestId: string, expectedHeadId: string | null) {
  deviceById(profileId); if (!storageReady()) throw new WorldKitError("provider_unavailable", "Private source storage is not configured.", 503);
  await initialize();
  const prior = await database().query("SELECT id FROM wk_jobs WHERE tenant_id=$1 AND kind='source_retrieve' AND idempotency_key=$2", [session.id, requestId]);
  if (!prior.rowCount) {
    const head = await database().query("SELECT document_id FROM wk_source_heads WHERE tenant_id=$1 AND profile_id=$2", [session.id, profileId]);
    if ((head.rows[0]?.document_id ?? null) !== expectedHeadId) throw new WorldKitError("stale_revision", "The current source changed. Review its version before refreshing it.", 409);
  }
  return enqueueJob(session, "source_retrieve", { profileId, documentId: requestId, expectedHeadId }, requestId, "Retrieving the manufacturer document");
}
async function readPrivateCopy(row: DocumentRow): Promise<Buffer | null> {
  const result = await get(row.blob_path, { access: "private", useCache: false, abortSignal: AbortSignal.timeout(25000) });
  if (!result) return null;
  if (result.statusCode !== 200 || result.blob.size > 25_000_000 || result.blob.size !== row.bytes) throw new WorldKitError("needs_evidence", "The private source copy does not match its saved size.", 422);
  const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
  if (bytes.length !== row.bytes || sha256(bytes) !== row.content_hash) throw new WorldKitError("needs_evidence", "The private source copy does not match its fingerprint. No facts were accepted.", 422);
  return bytes;
}

export async function retrieveSourceJob(job: ClaimedJob): Promise<JobResult> {
  const input = sourceInput.parse(job.input); const device = deviceById(input.profileId);
  await transaction(async db => {
    await assertLease(db, job); await db.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [job.tenantId]);
    const existing = await db.query("SELECT id FROM wk_source_documents WHERE job_id=$1 AND tenant_id=$2", [job.id, job.tenantId]);
    if (!existing.rowCount) {
      const count = await db.query("SELECT count(*)::int AS count FROM wk_source_documents WHERE tenant_id=$1", [job.tenantId]);
      if (count.rows[0].count >= 120) throw new WorldKitError("rate_limited", "This workspace has reached its source-version allowance. Existing evidence remains available.", 429);
      await db.query("INSERT INTO wk_source_documents(id,tenant_id,profile_id,job_id,source_url,blob_path) VALUES($1,$2,$3,$4,$5,$6)", [input.documentId, job.tenantId, device.id, job.id, device.source.url, `worldkit/${job.tenantId}/sources/${input.documentId}.source`]);
    }
  });
  let row = await sourceRow(job.tenantId, input.documentId);
  if (["deleting", "deleted"].includes(row.status)) throw new WorldKitError("not_found", "This private source copy was removed.", 404);
  if (row.status !== "prepared") {
    const savedBytes = row.status === "staged" ? await readPrivateCopy(row) : null;
    if (!savedBytes) {
      const retrieved = await retrieveManufacturerSource(device);
      if (row.content_hash && (row.content_hash !== retrieved.document.contentHash || row.text_hash !== retrieved.document.textHash)) throw new WorldKitError("needs_evidence", "The manufacturer changed the document during a recovered upload. Start a new retrieval to preserve both source identities.", 422);
      await transaction(async db => {
        await assertLease(db, job); await db.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [job.tenantId]);
        const stored = await db.query("SELECT coalesce(sum(bytes),0)::bigint AS bytes FROM wk_source_documents WHERE tenant_id=$1 AND id<>$2 AND status<>'deleted'", [job.tenantId, input.documentId]);
        if (Number(stored.rows[0].bytes) + retrieved.raw.length > 250_000_000) throw new WorldKitError("rate_limited", "Remove an older private source copy before storing more than 250 MB in this workspace.", 429);
        await db.query("UPDATE wk_source_documents SET content_hash=$3,text_hash=$4,media_type=$5,bytes=$6,payload=$7,status='staged',source_url=$8,write_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status IN ('retrieving','staged')", [input.documentId, job.tenantId, retrieved.document.contentHash, retrieved.document.textHash, retrieved.document.mediaType, retrieved.raw.length, retrieved.document, retrieved.document.url]);
      });
      row = await sourceRow(job.tenantId, input.documentId);
      if (row.status !== "staged" || !row.write_until || new Date(row.write_until).getTime() <= Date.now()) throw new WorldKitError("stale_revision", "The private source upload window ended. Its saved intent will be recovered.", 409);
      try { await put(row.blob_path, retrieved.raw, { access: "private", contentType: retrieved.document.mediaType, addRandomSuffix: false, allowOverwrite: false, abortSignal: AbortSignal.timeout(25000) }); }
      catch { if (!await readPrivateCopy(row)) throw new WorldKitError("provider_unavailable", "The private source upload has not been confirmed. Its intent is saved for recovery.", 503); }
    }
    await transaction(async db => { await assertLease(db, job); await db.query("UPDATE wk_source_documents SET status='prepared',write_until=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='staged'", [input.documentId, job.tenantId]); });
    row = await sourceRow(job.tenantId, input.documentId);
  }
  if (!row.payload || row.status !== "prepared") throw new WorldKitError("needs_evidence", "The source copy is not ready to publish as a version.", 422);
  const output = { document: { ...publicDocument(row), status: "available" as const }, currentSourceUpdated: false, sourceMode: "live" as const, humanReview: "pending" as const };
  return { output, persist: async db => {
    const active = await db.query("UPDATE wk_source_documents SET status='available',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='prepared' RETURNING id", [row.id, job.tenantId]);
    if (!active.rowCount) throw new WorldKitError("stale_revision", "The private document changed before its source version could be saved.", 409);
    const head = await db.query("SELECT * FROM wk_source_heads WHERE tenant_id=$1 AND profile_id=$2 FOR UPDATE", [job.tenantId, device.id]);
    const current = head.rows[0];
    if ((current?.document_id ?? null) === input.expectedHeadId) {
      const update = await db.query("INSERT INTO wk_source_heads(tenant_id,profile_id,document_id,version) VALUES($1,$2,$3,1) ON CONFLICT(tenant_id,profile_id) DO UPDATE SET document_id=EXCLUDED.document_id,version=wk_source_heads.version+1,updated_at=now() WHERE wk_source_heads.document_id=$4 RETURNING version", [job.tenantId, device.id, row.id, input.expectedHeadId]);
      output.currentSourceUpdated = Boolean(update.rowCount); output.document.current = Boolean(update.rowCount); output.document.headVersion = update.rows[0]?.version ?? null;
    }
    await appendEvent(db, job.tenantId, "source.retrieved", `${device.model} source version saved`, `${row.content_hash!.slice(0, 12)} · ${row.payload!.pages.length} text pages. ${output.currentSourceUpdated ? "Available for a new source proposal." : "A concurrent source version remains current; both copies are retained."} Saved kits and certificates keep their original evidence.`, null, "live");
  } };
}

export async function requestSourceExtraction(session: Session, input: z.infer<typeof extractInput>, requestId: string) {
  const device = deviceById(input.profileId); const row = await sourceRow(session.id, input.documentId);
  if (row.profile_id !== device.id || row.status !== "available" || !row.payload || row.content_hash !== input.expectedSourceHash) throw new WorldKitError("stale_revision", "Choose an available source version with the expected fingerprint.", 409);
  if (new Set(input.selectedPages).size !== input.selectedPages.length || input.selectedPages.some(number => !row.payload!.pages.some(page => page.number === number))) throw new WorldKitError("invalid_request", "Choose distinct text pages that exist in this saved document.");
  extractionInput(device, row.payload, sourceQueries(device), input.selectedPages);
  return enqueueJob(session, "source_extract", input, requestId, "Reading the selected manufacturer pages");
}
export async function extractSourceJob(job: ClaimedJob): Promise<JobResult> {
  const input = extractInput.parse(job.input); const device = deviceById(input.profileId); const row = await sourceRow(job.tenantId, input.documentId);
  if (row.profile_id !== device.id || row.status !== "available" || row.content_hash !== input.expectedSourceHash || !row.payload) throw new WorldKitError("stale_revision", "The exact private source version is no longer available for this proposal.", 409);
  if (sha256(row.payload.pages.map(page => page.text).join("\n\n")) !== row.text_hash) throw new WorldKitError("needs_evidence", "The normalized source text no longer matches its fingerprint.", 422);
  const result = await extractSource(device, row.payload, sourceQueries(device), input.provider, input.selectedPages, { operationId: job.id, store: new SourceModelStore(job, input.provider) });
  return { output: { draftId: result.draft.id, documentId: row.id, profileId: device.id, counts: result.draft.counts, receipt: result.receipt, humanReview: "pending", requiresCandidateConfirmation: true }, persist: async db => {
    const available = await db.query("SELECT id FROM wk_source_documents WHERE id=$1 AND tenant_id=$2 AND status='available' AND content_hash=$3 FOR SHARE", [row.id, job.tenantId, result.draft.sourceHash]);
    if (!available.rowCount) throw new WorldKitError("stale_revision", "The private source was removed before its proposal could be saved.", 409);
    await db.query("INSERT INTO wk_source_drafts(id,tenant_id,document_id,profile_id,job_id,payload,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)", [result.draft.id, job.tenantId, row.id, device.id, job.id, result.draft, result.receipt]);
    await db.query("INSERT INTO wk_provider_receipts(id,tenant_id,provider,payload) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING", [result.receipt.id, job.tenantId, input.provider, result.receipt]);
    await appendEvent(db, job.tenantId, "source.facts_proposed", `${device.model} source proposal ready`, `${result.draft.counts.located} traceable proposals, ${result.draft.counts.unknown} abstentions, ${result.draft.counts.rejected} rejected, ${result.draft.counts.conflicted} conflicts. Independent technical review remains pending.`, null, "live");
  } };
}

export async function evidenceDraft(session: Session, id: string): Promise<EvidenceDraftDetail> {
  const draft = await draftRow(session.id, id); const row = await sourceRow(session.id, draft.document_id); const device = deviceById(draft.profile_id);
  const fingerprint = { url: row.source_url, retrievedAt: row.payload?.retrievedAt ?? new Date(row.created_at).toISOString(), contentHash: draft.payload.sourceHash, textHash: draft.payload.textHash };
  const profile = candidateProfile(device, fingerprint, draft.payload); const source = immutableSource(device, fingerprint);
  const excerpts = draft.payload.facts.flatMap(fact => fact.evidence.flatMap(anchor => {
    const page = row.payload?.pages.find(page => page.number === anchor.page); if (!page) return [];
    const exact = page.text.slice(anchor.start, anchor.end); if (sha256(exact) !== anchor.excerptHash) return [];
    const words = exact.replace(/\s+/g, " ").split(" "); const short = words.slice(0, 24).join(" ").slice(0, 220);
    return [{ assertionId: fact.assertionId, page: anchor.page, text: short + (words.length > 24 || short.length < exact.length ? "…" : ""), sourceUrl: row.source_url + (row.media_type === "application/pdf" ? `#page=${anchor.page}` : ""), excerptHash: anchor.excerptHash }];
  }));
  return { draft: draft.payload, document: publicDocument(row), receipt: draft.receipt, excerpts, profile, source, previewHash: hash({ draftId: id, profile, source }), savedCandidateId: draft.saved_candidate_id ?? null };
}
export async function saveSourceCandidate(session: Session, draftId: string, previewHash: string, expectedHeadId: string) {
  const preview = await evidenceDraft(session, draftId);
  if (preview.previewHash !== previewHash) throw new WorldKitError("stale_revision", "Review this exact proposal before saving its candidate profile.", 409);
  return transaction(async db => {
    const active = await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>now() FOR UPDATE", [session.id]);
    if (!active.rowCount) throw new WorldKitError("forbidden", "This workspace has expired.", 401);
    const prior = await db.query("SELECT payload FROM wk_source_profile_versions WHERE tenant_id=$1 AND draft_id=$2", [session.id, draftId]);
    if (prior.rows[0]) return prior.rows[0].payload as DeviceProfile;
    const document = await sourceRow(session.id, preview.document.id, db);
    const head = await db.query("SELECT document_id FROM wk_source_heads WHERE tenant_id=$1 AND profile_id=$2 FOR SHARE", [session.id, preview.draft.profileId]);
    if (document.status !== "available" || expectedHeadId !== document.id || head.rows[0]?.document_id !== expectedHeadId) throw new WorldKitError("stale_revision", "A newer source is current. Review that version before saving a new candidate.", 409);
    await db.query("INSERT INTO wk_source_profile_versions(id,tenant_id,profile_id,draft_id,source_document_id,payload,source) VALUES($1,$2,$3,$4,$5,$6,$7)", [preview.profile.id, session.id, preview.draft.profileId, draftId, document.id, preview.profile, preview.source]);
    await appendEvent(db, session.id, "source.candidate_saved", `${preview.profile.model} candidate added`, "Saved as an immutable profile available in the equipment passport. Identity, ownership, technical review and physical testing remain separate decisions.", null, "live");
    return preview.profile;
  });
}
export async function requestSourceReview(session: Session, draftId: string, assertionIds: string[], question: string, requestId: string) {
  const draft = await draftRow(session.id, draftId);
  if (new Set(assertionIds).size !== assertionIds.length || assertionIds.some(id => !draft.payload.facts.some(fact => fact.assertionId === id))) throw new WorldKitError("invalid_request", "Choose distinct assertions from this source proposal.");
  const inputHash = hash({ draftId, assertionIds, question });
  return transaction(async db => {
    const active = await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>now() FOR UPDATE", [session.id]);
    if (!active.rowCount) throw new WorldKitError("forbidden", "This workspace has expired.", 401);
    const prior = await db.query("SELECT * FROM wk_source_review_requests WHERE tenant_id=$1 AND request_id=$2", [session.id, requestId]);
    if (prior.rows[0]) { if (prior.rows[0].input_hash !== inputHash) throw new WorldKitError("stale_revision", "This review request was already used for a different question.", 409); return reviewRequest(prior.rows[0]); }
    const count = await db.query("SELECT count(*)::int AS count FROM wk_source_review_requests WHERE tenant_id=$1", [session.id]);
    if (count.rows[0].count >= 120) throw new WorldKitError("rate_limited", "This workspace has reached its review-question allowance.", 429);
    const result = await db.query("INSERT INTO wk_source_review_requests(id,tenant_id,draft_id,request_id,input_hash,assertion_ids,question) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [randomUUID(), session.id, draftId, requestId, inputHash, JSON.stringify(assertionIds), question]);
    await appendEvent(db, session.id, "source.review_requested", "Technical question added to the review queue", `${assertionIds.length} exact assertions await independent source review.`, null, "live");
    return reviewRequest(result.rows[0]);
  });
}
export async function evidenceLibrary(tenantId: string): Promise<{ profiles: DeviceProfile[]; sources: Source[] }> {
  await initialize();
  const result = await database().query("SELECT payload,source FROM wk_source_profile_versions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 120", [tenantId]);
  return { profiles: [...result.rows.map(row => row.payload as DeviceProfile), ...candidateProfiles], sources: [...result.rows.map(row => row.source as Source), ...candidateSources] };
}

export async function requestSourceDeletion(session: Session, id: string) {
  const row = await sourceRow(session.id, id); if (row.status === "deleted") throw new WorldKitError("not_found", "This private source copy has already been removed.", 404);
  await transaction(async db => {
    await db.query("UPDATE wk_jobs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,progress='The private source copy was removed',updated_at=now() WHERE tenant_id=$1 AND kind IN ('source_retrieve','source_extract') AND input->>'documentId'=$2 AND status IN ('queued','running','retry_wait')", [session.id, id]);
    await db.query("UPDATE wk_source_documents SET status='deleting',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status<>'deleted'", [id, session.id]);
  });
  return enqueueJob(session, "source_document_delete", { documentId: id }, id, "Removing the private source copy");
}
export async function deleteSourceJob(job: ClaimedJob): Promise<JobResult> {
  const input = z.object({ documentId: z.uuid() }).strict().parse(job.input); const row = await sourceRow(job.tenantId, input.documentId);
  if (!["deleting", "deleted"].includes(row.status)) throw new WorldKitError("invalid_request", "Request removal of this private copy before cleanup.");
  if (row.write_until && new Date(row.write_until).getTime() > Date.now()) throw new ModelPending("Waiting for the source upload to settle before removing its private copy", Math.ceil((new Date(row.write_until).getTime() - Date.now()) / 1000) + 1);
  if (row.status !== "deleted") await del(row.blob_path, { abortSignal: AbortSignal.timeout(25000) });
  return { output: { documentId: row.id, removed: true }, persist: async db => {
    await db.query("UPDATE wk_source_documents SET status='deleted',payload=NULL,write_until=NULL,deleted_at=now(),updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, job.tenantId]);
    await appendEvent(db, job.tenantId, "source.private_copy_deleted", "Private source copy removed", "The manufacturer's link, document fingerprint, proposal history and saved candidate versions remain private. Public certificate editions that depend on this copy are withheld. New extraction needs a fresh private copy.", null, "live");
  } };
}
export async function recoverSourceIntents(tenantId?: string): Promise<number> {
  return transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('worldkit:source-cleanup:v1'))");
    const candidates = await db.query(`SELECT d.id,d.tenant_id FROM wk_source_documents d JOIN wk_sessions s ON s.id=d.tenant_id JOIN wk_jobs j ON j.id=d.job_id
      WHERE ($1::text IS NULL OR d.tenant_id=$1) AND (d.status='deleting' OR (d.status IN ('retrieving','staged','prepared') AND d.updated_at<now()-interval '10 minutes' AND NOT(j.status='running' AND j.lease_expires_at>now())) OR (d.status='available' AND s.expires_at<=now()))
      ORDER BY d.created_at LIMIT 20`, [tenantId ?? null]);
    let queued = 0;
    for (const candidate of candidates.rows) {
      // Keep the same job-before-document lock order as result persistence.
      await db.query("UPDATE wk_jobs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,progress='The source copy expired or was removed',updated_at=now() WHERE tenant_id=$1 AND kind IN ('source_retrieve','source_extract') AND input->>'documentId'=$2 AND status IN ('queued','running','retry_wait') AND (lease_expires_at IS NULL OR lease_expires_at<=now())", [candidate.tenant_id, candidate.id]);
      const result = await db.query(`UPDATE wk_source_documents d SET status='deleting',updated_at=now() FROM wk_sessions s WHERE d.id=$1 AND s.id=d.tenant_id
        AND (d.status='deleting' OR (d.status IN ('retrieving','staged','prepared') AND d.updated_at<now()-interval '10 minutes') OR (d.status='available' AND s.expires_at<=now())) RETURNING d.id`, [candidate.id]);
      if (!result.rowCount) continue;
      const input = { documentId: candidate.id };
      const inserted = await db.query("INSERT INTO wk_jobs(id,tenant_id,kind,status,input,managed,idempotency_key,input_hash,progress) VALUES($1,$2,'source_document_delete','queued',$3,true,$4,$5,'Removing an expired or incomplete source copy') ON CONFLICT(tenant_id,kind,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id", [randomUUID(), candidate.tenant_id, input, candidate.id, hash(input)]);
      if (!inserted.rowCount) await db.query("UPDATE wk_jobs SET status='retry_wait',max_attempts=attempts-continuations+3,next_attempt_at=now(),error=NULL,progress='Resuming private source cleanup',updated_at=now() WHERE tenant_id=$1 AND kind='source_document_delete' AND idempotency_key=$2 AND status IN ('failed','cancelled') AND updated_at<now()-interval '1 hour'", [candidate.tenant_id, candidate.id]);
      queued += inserted.rowCount ?? 0;
    }
    return queued;
  });
}
