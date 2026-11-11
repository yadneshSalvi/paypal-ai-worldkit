import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DeviceSchema, SourceSchema, WorldKitError, type DeviceProfile, type Fact, type Source, type KitRevision, type Certificate } from "../../packages/contracts";
import { hash } from "../../packages/compatibility";
import { REVIEW_POLICY, ReviewActionSchema, type ReviewAccess, type ReviewAction, type ReviewActor, type ReviewAsset, type ReviewBinding, type ReviewCapability, type ReviewCandidate, type ReviewDecision, type ReviewDetail, type ReviewEdition, type ReviewHome, type Qualification, type Promotion } from "../../packages/engineering-review/contracts";
import { decisionSetHash, digestText, initialContent, reviewAssessment, simultaneous, validAnchors, validateContent } from "../../packages/engineering-review/policy";
import type { ExtractionDraft } from "../../packages/spec-evidence/contracts";
import type { SourceDocument } from "../../packages/spec-evidence/sources";
import { database, transaction } from "./db";
import { initializeEngineeringReview } from "./engineering-review-db";
import { seal, unseal } from "./secrets";
import type { Session } from "./repository";

type Row = Record<string, any>;
type Resource = { kitId: string; profileId: string; documentId: string };
function fail(message: string, code: "forbidden" | "not_found" | "stale_revision" | "needs_evidence" | "invalid_request" = "forbidden", status = code === "not_found" ? 404 : code === "stale_revision" ? 409 : code === "needs_evidence" ? 422 : 403): never { throw new WorldKitError(code, message, status); }
const iso = (value: Date | string) => new Date(value).toISOString();
const secretToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const activeTime = (value: string | Date) => new Date(value).getTime() > Date.now();
const assetDto = (row: Row): ReviewAsset => ({ ...row.payload, current: row.current_asset_id === row.id, available: row.payload.provenance === "sample" && !row.photo_id || row.photo_status === "active" && row.photo_hash === row.image_hash });
const capabilityDto = (row: Row): ReviewCapability => ({ id: row.id, actorId: row.actor_id, role: row.role, kitId: row.kit_id, profileId: row.profile_id, documentId: row.document_id, expiresAt: iso(row.expires_at), version: row.version, status: row.status });
const actorDto = (row: Row): ReviewActor => ({ id: row.id, name: row.name, kind: row.kind, provenance: row.provenance, version: row.version, revoked: Boolean(row.revoked_at), qualification: row.qualification ?? null });

async function event(db: PoolClient, access: ReviewAccess, kind: string, objectId: string | null, payload: unknown) {
  await db.query("INSERT INTO wk_review_events(tenant_id,actor_id,kind,object_id,payload) VALUES($1,$2,$3,$4,$5)", [access.tenantId, access.actorId, kind, objectId, payload]);
}
export async function ownerReviewAccess(session: Session): Promise<ReviewAccess> {
  await initializeEngineeringReview();
  return transaction(async db => {
    if (!(await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE", [session.id])).rowCount) fail("This workspace has expired.");
    await db.query("INSERT INTO wk_review_actors(id,tenant_id,name,kind,provenance) VALUES($1,$1,'Workspace creator','owner','human') ON CONFLICT(id) DO NOTHING", [session.id]);
    return { tenantId: session.id, actorId: session.id, kind: "owner", capabilityId: null };
  });
}

async function authorize(db: PoolClient, access: ReviewAccess, resource?: Resource, purpose: "read" | "edit" | "review" | "adjudicate" | "owner" = "read") {
  // Every accepted command and read serializes with revocation on the workspace.
  const session = (await db.query("SELECT id,expires_at FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE", [access.tenantId])).rows[0];
  if (!session) fail("This workspace access has ended.");
  const actorRow = (await db.query("SELECT a.*,q.payload AS qualification FROM wk_review_actors a LEFT JOIN wk_review_qualifications q ON q.id=a.qualification_id AND q.actor_id=a.id AND q.tenant_id=a.tenant_id WHERE a.id=$1 AND a.tenant_id=$2 AND a.revoked_at IS NULL", [access.actorId, access.tenantId])).rows[0];
  if (!actorRow) fail("This reviewer identity has been revoked or is outside this workspace.");
  const actor = actorDto(actorRow);
  if (access.kind === "owner") {
    if (actor.kind !== "owner" || actor.id !== access.tenantId || access.capabilityId) fail("The creator identity does not match this workspace.");
    if (purpose === "review" || purpose === "adjudicate") fail("The creator can propose and promote, but engineering decisions require a separately qualified specialist.");
    return { actor, capability: null, expiresAt: iso(session.expires_at) };
  }
  const cap = (await db.query("SELECT * FROM wk_review_capabilities WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 AND status='active' AND expires_at>clock_timestamp()", [access.capabilityId, access.tenantId, access.actorId])).rows[0];
  if (!cap || actor.kind !== "specialist" || purpose === "owner") fail("This specialist capability is expired, revoked or does not permit that action.");
  if (resource && (resource.kitId !== cap.kit_id || resource.profileId !== cap.profile_id || resource.documentId !== cap.document_id)) fail("This invitation only permits its named kit, exact profile and source document.");
  if (purpose === "edit" && cap.role === "reader" || purpose === "review" && !["reviewer", "adjudicator"].includes(cap.role) || purpose === "adjudicate" && cap.role !== "adjudicator") fail("This invitation does not carry the role required for this action.");
  return { actor, capability: capabilityDto(cap), expiresAt: iso(new Date(Math.min(new Date(session.expires_at).getTime(), new Date(cap.expires_at).getTime()))) };
}

export async function authenticateReviewer(token?: string): Promise<ReviewAccess | null> {
  if (!token || !/^wkr_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  await initializeEngineeringReview();
  const row = (await database().query("SELECT c.tenant_id,c.actor_id,c.id FROM wk_review_capabilities c JOIN wk_sessions s ON s.id=c.tenant_id JOIN wk_review_actors a ON a.id=c.actor_id AND a.tenant_id=c.tenant_id WHERE c.credential_hash=$1 AND c.status='active' AND c.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp() AND a.revoked_at IS NULL", [digestText(token)])).rows[0];
  return row ? { tenantId: row.tenant_id, actorId: row.actor_id, capabilityId: row.id, kind: "specialist" } : null;
}
export async function inspectInvitation(token: string) {
  if (!/^wki_[A-Za-z0-9_-]{43}$/.test(token)) fail("This invitation is unavailable.", "not_found");
  await initializeEngineeringReview();
  const row = (await database().query("SELECT c.*,a.name,a.provenance FROM wk_review_capabilities c JOIN wk_sessions s ON s.id=c.tenant_id JOIN wk_review_actors a ON a.id=c.actor_id AND a.tenant_id=c.tenant_id WHERE c.invite_hash=$1 AND c.status='invited' AND c.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp() AND a.revoked_at IS NULL", [digestText(token)])).rows[0];
  if (!row) fail("This invitation has expired, been redeemed, or been revoked.", "not_found");
  return { name: row.name, provenance: row.provenance, role: row.role, expiresAt: iso(row.expires_at), scope: "One kit, one exact equipment profile and one source document. No payment, equipment ownership or publication authority." };
}
export async function redeemInvitation(token: string) {
  await inspectInvitation(token);
  return transaction(async db => {
    const first = (await db.query("SELECT tenant_id FROM wk_review_capabilities WHERE invite_hash=$1", [digestText(token)])).rows[0];
    if (!first || !(await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE", [first.tenant_id])).rowCount) fail("This invitation is unavailable.");
    const row = (await db.query("SELECT c.* FROM wk_review_capabilities c JOIN wk_review_actors a ON a.id=c.actor_id AND a.tenant_id=c.tenant_id WHERE c.invite_hash=$1 AND c.status='invited' AND c.expires_at>clock_timestamp() AND a.revoked_at IS NULL FOR UPDATE OF c", [digestText(token)])).rows[0];
    if (!row) fail("This invitation was already used or is no longer available.", "stale_revision");
    const credential = secretToken("wkr");
    await db.query("UPDATE wk_review_capabilities SET credential_hash=$2,status='active',redeemed_at=now(),version=version+1 WHERE id=$1", [row.id, digestText(credential)]);
    const access: ReviewAccess = { tenantId: row.tenant_id, actorId: row.actor_id, kind: "specialist", capabilityId: row.id };
    await event(db, access, "invitation.redeemed", row.id, { version: row.version + 1, identityAssurance: "Possession of an invitation is not a qualification or proof of real-world identity." });
    return { credential, access, expiresAt: iso(row.expires_at) };
  });
}

async function currentAsset(db: PoolClient, tenantId: string, profileId: string, assetId?: string): Promise<ReviewAsset | null> {
  const row = (await db.query(`SELECT a.*,h.asset_id AS current_asset_id,p.status AS photo_status,p.content_hash AS photo_hash
    FROM wk_review_assets a LEFT JOIN wk_review_asset_heads h ON h.tenant_id=a.tenant_id AND h.profile_id=a.profile_id
    LEFT JOIN wk_inventory_photos p ON p.id=a.photo_id AND p.tenant_id=a.tenant_id
    WHERE a.tenant_id=$1 AND a.profile_id=$2 AND ${assetId ? "a.id=$3" : "a.id=h.asset_id"}`, assetId ? [tenantId, profileId, assetId] : [tenantId, profileId])).rows[0];
  return row ? assetDto(row) : null;
}
type Basis = { profile: DeviceProfile; draft: ExtractionDraft; document: SourceDocument; source: Source; binding: ReviewBinding; asset: ReviewAsset | null };
async function basis(db: PoolClient, access: ReviewAccess, candidateId: string, kitId: string, authorityAlreadyLocked = false): Promise<Basis> {
  const row = (await db.query(`SELECT v.*,d.status AS document_status,d.content_hash,d.text_hash,d.payload AS document,d.profile_id AS document_profile,d.source_url AS document_url,
    h.document_id AS current_document_id,h.version AS head_version,x.payload AS draft,x.profile_id AS draft_profile,x.document_id AS draft_document
    FROM wk_source_profile_versions v JOIN wk_source_documents d ON d.id=v.source_document_id AND d.tenant_id=v.tenant_id
    JOIN wk_source_drafts x ON x.id=v.draft_id AND x.tenant_id=v.tenant_id
    JOIN wk_source_heads h ON h.tenant_id=v.tenant_id AND h.profile_id=v.profile_id WHERE v.tenant_id=$1 AND v.id=$2 FOR SHARE OF v,d,x,h`, [access.tenantId, candidateId])).rows[0];
  if (!row) fail("Save an exact source candidate in this workspace before opening its engineering review.", "not_found");
  if (!authorityAlreadyLocked) await authorize(db, access, { kitId, profileId: row.profile_id, documentId: row.source_document_id }, "read");
  const profile = DeviceSchema.parse(row.payload), source = SourceSchema.parse(row.source), draft = row.draft as ExtractionDraft, document = row.document as SourceDocument;
  if (row.document_status !== "available" || !document || row.current_document_id !== row.source_document_id) fail("A current private manufacturer source is required. Save a candidate from the current document first.", "stale_revision");
  if (row.document_profile !== row.profile_id || row.draft_profile !== row.profile_id || row.draft_document !== row.source_document_id || draft.profileId !== row.profile_id || profile.corpusId !== row.profile_id || draft.sourceHash !== row.content_hash || draft.textHash !== row.text_hash || document.contentHash !== row.content_hash || document.textHash !== row.text_hash || digestText(document.pages.map(page => page.text).join("\n\n")) !== row.text_hash) fail("The candidate, extraction and exact normalized source do not share the same identity.", "needs_evidence");
  if (source.contentHash !== row.content_hash || source.url !== row.document_url || document.url !== row.document_url || draft.sourceId !== document.sourceId || !["manufacturer", "software_publisher", "sample"].includes(source.kind)) fail("The source identity must match the exact saved manufacturer document. A catalog or physical-test label cannot supply manufacturer authority.", "needs_evidence");
  const kit = (await db.query("SELECT k.current_revision_id,r.certificate FROM wk_kits k JOIN wk_revisions r ON r.id=k.current_revision_id AND r.tenant_id=k.tenant_id WHERE k.id=$1 AND k.tenant_id=$2", [kitId, access.tenantId])).rows[0];
  if (!kit) fail("That kit is outside this workspace.", "not_found");
  const head = (await db.query("SELECT promotion_id FROM wk_review_profile_heads WHERE tenant_id=$1 AND profile_id=$2", [access.tenantId, row.profile_id])).rows[0];
  const asset = await currentAsset(db, access.tenantId, row.profile_id);
  return { profile, draft, document, source, asset, binding: { kitId, revisionId: kit.current_revision_id, graphHash: kit.certificate.graphHash,
    profileId: row.profile_id, candidateId, candidateHash: hash({ profile, source }), documentId: row.source_document_id, sourceHash: row.content_hash, textHash: row.text_hash,
    sourceHeadVersion: row.head_version, profileHeadId: head?.promotion_id ?? null, assetId: asset?.id ?? null, assetHash: asset?.imageHash ?? null, cropHash: asset?.cropHash ?? null,
    draftId: row.draft_id, draftHash: hash(draft) } };
}
async function proposal(db: PoolClient, access: ReviewAccess, id: string, purpose: "read" | "edit" | "review" | "adjudicate" | "owner" = "read") {
  const row = (await db.query("SELECT p.*,e.payload AS edition FROM wk_review_proposals p JOIN wk_review_editions e ON e.id=p.current_edition_id AND e.tenant_id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2", [id, access.tenantId])).rows[0];
  if (!row) fail("This proposal is unavailable in this workspace.", "not_found");
  const authority = await authorize(db, access, { kitId: row.kit_id, profileId: row.profile_id, documentId: row.document_id }, purpose);
  return { row, edition: row.edition as ReviewEdition, ...authority };
}
async function freshness(db: PoolClient, access: ReviewAccess, edition: ReviewEdition, authorityAlreadyLocked = false): Promise<string[]> {
  const stale: string[] = [];
  try {
    const live = await basis(db, access, edition.binding.candidateId, edition.binding.kitId, authorityAlreadyLocked);
    for (const key of Object.keys(edition.binding) as (keyof ReviewBinding)[]) {
      if (key === "profileHeadId" && live.binding[key] === promotedId(edition)) continue;
      // Once promoted, the facts retain their exact source/operating scope while
      // a creator deliberately adopts them into a new graph. The first promotion
      // itself still requires the original current graph and revision binding.
      if (["revisionId", "graphHash"].includes(key) && live.binding.profileHeadId === promotedId(edition)) continue;
      if (live.binding[key] !== edition.binding[key]) stale.push(`${key}: a newer kit, profile, source or image is current. Create a fresh edition before making a decision.`);
    }
    validateContent(edition.content, live.draft, live.document, live.profile, live.asset);
    if (edition.provenance === "human") for (const author of edition.authorIdentities) {
      const row = (await db.query("SELECT a.revoked_at,a.qualification_id,q.payload FROM wk_review_actors a LEFT JOIN wk_review_qualifications q ON q.id=a.qualification_id AND q.tenant_id=a.tenant_id AND q.actor_id=a.id WHERE a.id=$1 AND a.tenant_id=$2", [author.actorId, access.tenantId])).rows[0];
      if (row?.revoked_at || author.qualificationId && (row?.qualification_id !== author.qualificationId || !activeTime(row.payload.expiresAt) || row.payload.identityHash !== author.identityHash || row.payload.provenance !== "human")) stale.push("An author identity attestation changed, expired or was revoked. Bind a new edition before actual review.");
      if (!author.qualificationId && row?.qualification_id) stale.push("The author’s identity has now been established. Bind it into a new edition before actual independent review.");
    }
  } catch (error) { if (error instanceof WorldKitError) stale.push(error.message); else throw error; }
  return stale;
}
async function decisions(db: PoolClient, tenantId: string, editionId: string): Promise<ReviewDecision[]> {
  const rows = (await db.query(`SELECT d.payload,c.status,c.version AS capability_version,c.expires_at AS capability_expiry,a.revoked_at,a.qualification_id,q.payload AS current_qualification
    FROM wk_review_decisions d JOIN wk_review_actors a ON a.id=d.actor_id AND a.tenant_id=d.tenant_id
    LEFT JOIN wk_review_capabilities c ON c.id=d.payload->>'capabilityId' AND c.tenant_id=d.tenant_id AND c.actor_id=d.actor_id
    LEFT JOIN wk_review_qualifications q ON q.id=a.qualification_id AND q.actor_id=a.id AND q.tenant_id=a.tenant_id
    WHERE d.tenant_id=$1 AND d.edition_id=$2 ORDER BY d.created_at,d.id`, [tenantId, editionId])).rows;
  return rows.map(row => ({ ...row.payload, active: row.status === "active" && row.capability_version === row.payload.capabilityVersion && activeTime(row.capability_expiry) && !row.revoked_at && row.qualification_id === row.payload.qualification.id && activeTime(row.current_qualification.expiresAt) }));
}
const promotedId = (edition: ReviewEdition) => `engineering:${edition.binding.profileId}:${edition.id}`;
async function saveEdition(db: PoolClient, access: ReviewAccess, proposalId: string, content: ReviewEdition["content"], found: Basis, previous: ReviewEdition | null, reason: string, provenance: ReviewEdition["provenance"]): Promise<ReviewEdition> {
  validateContent(content, found.draft, found.document, found.profile, found.asset);
  if (provenance === "human" && found.asset?.provenance === "sample" && content.ports.some(port => port.anchor.kind === "image")) fail("A Sample illustration cannot establish actual device geometry. Use the labelled rail or an approved actual photo.", "needs_evidence");
  if (content.portMapDeclaredComplete && !content.ports.length && found.profile.kind !== "stand") fail("This equipment still needs its source-backed ports. An empty map cannot be declared complete.", "needs_evidence");
  const previousVotes = previous ? await decisions(db, access.tenantId, previous.id) : [];
  const disputedPredicates = [...new Set([...(previous?.disputedPredicates ?? []), ...found.draft.facts.filter(fact => fact.validation === "conflicted").map(fact => `device:${fact.property}`), ...previousVotes.filter(vote => vote.outcome !== "accept").flatMap(vote => { const claim = previous!.content.claims.find(claim => claim.id === vote.targetId); return claim ? [`${claim.target}:${claim.predicate}`] : vote.targetId === "$port-map" ? ["$port-map"] : []; })])];
  for (const predicate of disputedPredicates.filter(value => value !== "$port-map")) {
    const correction = content.claims.find(claim => `${claim.target}:${claim.predicate}` === predicate);
    const priorClaim = previous?.content.claims.find(claim => `${claim.target}:${claim.predicate}` === predicate);
    if (!correction || priorClaim?.critical && !correction.critical) fail("A rejected, unresolved or disputed predicate must remain explicit without weakening its critical obligations. Renaming or omitting it cannot remove the need for independent adjudication.", "needs_evidence");
  }
  const authors = [...new Set([...(previous?.authors ?? []), access.actorId])];
  const authorIdentities = await Promise.all(authors.map(async actorId => {
    const row = (await db.query("SELECT a.provenance,q.id,q.identity_hash FROM wk_review_actors a LEFT JOIN wk_review_qualifications q ON q.id=a.qualification_id AND q.tenant_id=a.tenant_id AND q.actor_id=a.id WHERE a.id=$1 AND a.tenant_id=$2", [actorId, access.tenantId])).rows[0];
    if (provenance === "human" && row?.provenance !== "human") fail("A fictional Sample principal can only author Sample editions. Actual reviews retain the established identity of every author.", "needs_evidence");
    return { actorId, identityHash: row?.identity_hash ?? null, qualificationId: row?.id ?? null };
  }));
  const unsigned = { id: randomUUID(), proposalId, version: (previous?.version ?? 0) + 1, policy: REVIEW_POLICY, provenance,
    authorId: access.actorId, authors, authorIdentities, createdAt: new Date().toISOString(), predecessorId: previous?.id ?? null, correctionReason: reason,
    binding: found.binding, content, requiredAssertions: found.draft.facts.filter(fact => fact.critical).map(fact => fact.assertionId), disputedPredicates };
  const edition: ReviewEdition = { ...unsigned, hash: hash(unsigned) };
  await db.query("INSERT INTO wk_review_editions(id,proposal_id,tenant_id,version,content_hash,author_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7)", [edition.id, proposalId, access.tenantId, edition.version, edition.hash, access.actorId, edition]);
  await db.query("UPDATE wk_review_proposals SET current_edition_id=$2,version=$3 WHERE id=$1 AND tenant_id=$4", [proposalId, edition.id, edition.version, access.tenantId]);
  await event(db, access, "edition.created", edition.id, { hash: edition.hash, predecessorId: edition.predecessorId, reason, provenance });
  return edition;
}

export async function engineeringCommand(access: ReviewAccess, raw: unknown): Promise<Record<string, any>> {
  const input = ReviewActionSchema.parse(raw); await initializeEngineeringReview();
  return transaction(async db => {
    await authorize(db, access);
    const inputHash = hash(input);
    const prior = (await db.query("SELECT input_hash,response_sealed FROM wk_review_intents WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3", [access.tenantId, access.actorId, input.requestId])).rows[0];
    if (prior) {
      if (prior.input_hash !== inputHash) fail("This request identity already names a different command. Reload before making a new decision.", "stale_revision");
      // Authority is checked before returning an idempotent historical receipt.
      return { ...unseal<Record<string, any>>(access.tenantId, prior.response_sealed), replayed: true };
    }
    const response = await execute(db, access, input);
    await db.query("INSERT INTO wk_review_intents(tenant_id,actor_id,request_id,input_hash,response_sealed) VALUES($1,$2,$3,$4,$5)", [access.tenantId, access.actorId, input.requestId, inputHash, seal(access.tenantId, response)]);
    return response;
  });
}

async function execute(db: PoolClient, access: ReviewAccess, input: ReviewAction): Promise<Record<string, any>> {
  if (["register_actor", "invite", "revoke", "revoke_actor", "approve_asset", "promote", "withdraw"].includes(input.kind)) await authorize(db, access, undefined, "owner");
  if (input.kind === "register_actor") {
    const count = (await db.query("SELECT count(*)::int n FROM wk_review_actors WHERE tenant_id=$1", [access.tenantId])).rows[0].n;
    if (count >= 30) fail("This workspace has reached its 30-person collaboration allowance.", "invalid_request", 429);
    const id = randomUUID();
    await db.query("INSERT INTO wk_review_actors(id,tenant_id,name,kind,provenance) VALUES($1,$2,$3,'specialist',$4)", [id, access.tenantId, input.name, input.provenance]);
    if (input.provenance === "sample") {
      const qualification: Qualification = { id: randomUUID(), actorId: id, identityHash: hash({ samplePrincipal: id }), evidenceHash: hash({ samplePolicy: REVIEW_POLICY }), expertise: ["engineering", "simultaneous", "geometry"], method: "Fictional software rehearsal; no real expertise or human participation asserted.", issuer: "WorldKit Sample workflow", expiresAt: (await db.query("SELECT expires_at FROM wk_sessions WHERE id=$1", [access.tenantId])).rows[0].expires_at.toISOString(), provenance: "sample" };
      await insertQualification(db, access.tenantId, id, qualification);
    }
    await event(db, access, "actor.registered", id, { name: input.name, provenance: input.provenance, humanQualification: "not_established" });
    return { actorId: id };
  }
  if (input.kind === "invite") {
    const actor = (await db.query("SELECT id FROM wk_review_actors WHERE id=$1 AND tenant_id=$2 AND kind='specialist' AND revoked_at IS NULL", [input.actorId, access.tenantId])).rows[0];
    const source = (await db.query("SELECT id FROM wk_source_documents WHERE tenant_id=$1 AND id=$2 AND profile_id=$3 AND status='available'", [access.tenantId, input.documentId, input.profileId])).rows[0];
    const kit = (await db.query("SELECT id FROM wk_kits WHERE tenant_id=$1 AND id=$2", [access.tenantId, input.kitId])).rows[0];
    const expires = (await db.query("SELECT expires_at FROM wk_sessions WHERE id=$1", [access.tenantId])).rows[0].expires_at;
    if (!actor || !source || !kit) fail("The named person, kit and source must belong to this workspace.", "not_found");
    if (!activeTime(input.expiresAt) || new Date(input.expiresAt).getTime() > expires.getTime() || new Date(input.expiresAt).getTime() > Date.now() + 7 * 86400000) fail("Choose an invitation expiry within the workspace’s remaining lifetime.", "invalid_request", 400);
    const count = (await db.query("SELECT count(*)::int n FROM wk_review_capabilities WHERE tenant_id=$1", [access.tenantId])).rows[0].n;
    if (count >= 120) fail("This workspace has reached its invitation allowance.", "invalid_request", 429);
    const id = randomUUID(), token = secretToken("wki");
    await db.query("INSERT INTO wk_review_capabilities(id,tenant_id,actor_id,kit_id,profile_id,document_id,role,invite_hash,invite_sealed,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [id, access.tenantId, input.actorId, input.kitId, input.profileId, input.documentId, input.role, digestText(token), seal(access.tenantId, { token }), input.expiresAt]);
    await event(db, access, "invitation.created", id, { actorId: input.actorId, role: input.role, kitId: input.kitId, profileId: input.profileId, documentId: input.documentId, expiresAt: input.expiresAt });
    return { capabilityId: id, token, expiresAt: input.expiresAt, delivery: "Copy this link deliberately. No invitation has been sent." };
  }
  if (input.kind === "revoke") {
    const row = (await db.query("SELECT * FROM wk_review_capabilities WHERE id=$1 AND tenant_id=$2", [input.capabilityId, access.tenantId])).rows[0];
    if (!row) fail("That invitation is unavailable.", "not_found");
    if (row.version !== input.expectedVersion || row.status === "revoked") fail("The invitation changed. Reload its current state before revoking it.", "stale_revision");
    await db.query("UPDATE wk_review_capabilities SET status='revoked',revoked_at=now(),version=version+1 WHERE id=$1", [row.id]);
    await event(db, access, "capability.revoked", row.id, { reason: input.reason, version: row.version + 1 });
    return { revoked: true, version: row.version + 1 };
  }
  if (input.kind === "revoke_actor") {
    const row = (await db.query("SELECT * FROM wk_review_actors WHERE id=$1 AND tenant_id=$2 AND kind='specialist'", [input.actorId, access.tenantId])).rows[0];
    if (!row) fail("That specialist is unavailable.", "not_found");
    if (row.version !== input.expectedVersion || row.revoked_at) fail("The specialist’s authority changed. Reload before revoking it.", "stale_revision");
    await db.query("UPDATE wk_review_actors SET revoked_at=now(),version=version+1 WHERE id=$1", [row.id]);
    await event(db, access, "actor.revoked", row.id, { reason: input.reason, version: row.version + 1 });
    return { revoked: true };
  }
  if (input.kind === "approve_asset") {
    const photo = (await db.query("SELECT id,content_hash,width,height,status,source_mode FROM wk_inventory_photos WHERE id=$1 AND tenant_id=$2 AND status='active' FOR SHARE", [input.photoId, access.tenantId])).rows[0];
    if (!photo || photo.content_hash !== input.expectedImageHash) fail("Choose the exact available private photo before approving its crop.", "stale_revision");
    if (!(await db.query("SELECT id FROM wk_source_profile_versions WHERE tenant_id=$1 AND profile_id=$2", [access.tenantId, input.profileId])).rowCount) fail("Save the source candidate before linking an image.", "not_found");
    const previous = await currentAsset(db, access.tenantId, input.profileId);
    if ((previous?.id ?? null) !== input.expectedAssetId) fail("The current image changed. Review its new crop first.", "stale_revision");
    if (input.crop.x + input.crop.width > 1.00000001 || input.crop.y + input.crop.height > 1.00000001) fail("Keep the entire crop inside the original image.", "invalid_request", 400);
    const id = randomUUID(), cropHash = hash({ imageHash: photo.content_hash, crop: input.crop });
    const asset: ReviewAsset = { id, profileId: input.profileId, photoId: photo.id, imageHash: photo.content_hash, cropHash, crop: input.crop, width: photo.width, height: photo.height, provenance: photo.source_mode === "sample" ? "sample" : "human", description: input.description, current: true, available: true };
    await db.query("INSERT INTO wk_review_assets(id,tenant_id,profile_id,photo_id,image_hash,crop_hash,payload,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, access.tenantId, input.profileId, photo.id, photo.content_hash, cropHash, asset, access.actorId]);
    await db.query("INSERT INTO wk_review_asset_heads(tenant_id,profile_id,asset_id) VALUES($1,$2,$3) ON CONFLICT(tenant_id,profile_id) DO UPDATE SET asset_id=EXCLUDED.asset_id,version=wk_review_asset_heads.version+1", [access.tenantId, input.profileId, id]);
    await event(db, access, "asset.approved", id, { imageHash: asset.imageHash, cropHash, previousAssetId: previous?.id ?? null, rightsConfirmed: true, geometry: "requires_independent_review" });
    return { asset };
  }
  if (input.kind === "create") {
    const found = await basis(db, access, input.candidateId, input.kitId);
    await authorize(db, access, found.binding, "edit");
    if (input.expectedRevisionId !== found.binding.revisionId || input.expectedGraphHash !== found.binding.graphHash) fail("The kit changed. Reload before opening a new review.", "stale_revision");
    if (found.source.kind === "sample" && input.provenance !== "sample") fail("A fictional source can only enter a Sample review.", "needs_evidence");
    const chain = (await db.query("SELECT id,current_edition_id,kit_id,candidate_id FROM wk_review_proposals WHERE tenant_id=$1 AND profile_id=$2 AND document_id=$3 AND provenance=$4", [access.tenantId, found.binding.profileId, found.binding.documentId, input.provenance])).rows[0];
    if (chain) {
      if (chain.kit_id !== input.kitId || chain.candidate_id !== input.candidateId) fail("This exact source already has an immutable review chain. Open it and propose a correction; another kit or extraction cannot erase its authors or disagreements.", "stale_revision");
      return { proposalId: chain.id, editionId: chain.current_edition_id, existing: true };
    }
    const count = (await db.query("SELECT count(*)::int n FROM wk_review_proposals WHERE tenant_id=$1", [access.tenantId])).rows[0].n;
    if (count >= 120) fail("This workspace has reached its proposal allowance.", "invalid_request", 429);
    const id = randomUUID();
    await db.query("INSERT INTO wk_review_proposals(id,tenant_id,kit_id,profile_id,document_id,candidate_id,provenance) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, access.tenantId, input.kitId, found.binding.profileId, found.binding.documentId, input.candidateId, input.provenance]);
    const edition = await saveEdition(db, access, id, initialContent(found.profile, found.draft), found, null, "Opened a separate engineering edition; the extraction is retained unchanged.", input.provenance);
    return { proposalId: id, editionId: edition.id };
  }
  if (input.kind === "withdraw") {
    const row = (await db.query("SELECT * FROM wk_review_profiles WHERE id=$1 AND tenant_id=$2", [input.promotionId, access.tenantId])).rows[0];
    if (!row) fail("That promoted profile is unavailable.", "not_found");
    const head = (await db.query("SELECT promotion_id FROM wk_review_profile_heads WHERE tenant_id=$1 AND profile_id=$2", [access.tenantId, row.profile_id])).rows[0];
    if (head?.promotion_id !== input.expectedHeadId || input.promotionId !== input.expectedHeadId) fail("This profile is no longer current. Its historical promotion is retained.", "stale_revision");
    await db.query("INSERT INTO wk_review_withdrawals(promotion_id,tenant_id,actor_id,reason) VALUES($1,$2,$3,$4)", [row.id, access.tenantId, access.actorId, input.reason]);
    await db.query("UPDATE wk_review_profile_heads SET promotion_id=NULL,version=version+1 WHERE tenant_id=$1 AND profile_id=$2", [access.tenantId, row.profile_id]);
    await event(db, access, "profile.withdrawn", row.id, { reason: input.reason, historicalKits: "unchanged" });
    return { withdrawn: true };
  }
  const purpose = input.kind === "revise" ? "edit" : input.kind === "decide" ? "review" : input.kind === "adjudicate" ? "adjudicate" : "owner";
  const current = await proposal(db, access, input.proposalId, purpose), edition = current.edition;
  if (edition.version !== input.expectedVersion || edition.hash !== input.expectedHash) fail("Another person saved a newer edition. Compare it with your draft before trying again.", "stale_revision");
  const promoted = Boolean((await db.query("SELECT id FROM wk_review_profiles WHERE tenant_id=$1 AND edition_id=$2", [access.tenantId, edition.id])).rowCount);
  if (promoted && input.kind !== "revise") fail("This edition already has its immutable promotion. Start a new edition for any further change.", "stale_revision");
  const stale = await freshness(db, access, edition);
  if (input.kind === "revise") {
    if (edition.version >= 60) fail("This source review has reached its 60-edition allowance. Its authors and decisions remain retained; an operator must review additional capacity before this chain can continue.", "invalid_request", 429);
    if (stale.length && !input.rebase) fail(stale[0]!, "stale_revision");
    const found = await basis(db, access, edition.binding.candidateId, edition.binding.kitId);
    const next = await saveEdition(db, access, edition.proposalId, input.content, found, edition, input.reason, edition.provenance);
    return { proposalId: next.proposalId, editionId: next.id, version: next.version };
  }
  if (stale.length) fail(stale[0]!, "stale_revision");
  const votes = await decisions(db, access.tenantId, edition.id);
  const assessment = reviewAssessment(edition, votes, stale);
  if (input.kind === "decide" || input.kind === "adjudicate") {
    const target = assessment.targets.find(target => target.id === input.targetId);
    if (!target) fail("That assertion does not belong to this exact edition.", "not_found");
    const qualification = current.actor.qualification;
    if (!qualification || !activeTime(qualification.expiresAt) || qualification.provenance !== edition.provenance || !qualification.expertise.includes("engineering")) fail("Independent identity and engineering qualification are required for this review. Sample qualifications only apply to Sample editions.");
    const claim = edition.content.claims.find(claim => claim.id === input.targetId);
    if (input.targetId === "$port-map" && edition.disputedPredicates.includes("$port-map") && current.capability?.role !== "adjudicator") fail("The corrected port-map conflict requires distinct qualified adjudicators.");
    if (claim && edition.disputedPredicates.includes(`${claim.target}:${claim.predicate}`) && current.capability?.role !== "adjudicator") fail("This corrected conflict needs two distinct qualified adjudicators. Prior disagreement remains in the review chain.");
    if (claim && simultaneous(claim) && !qualification.expertise.includes("simultaneous")) fail("This qualification does not cover simultaneous operating modes.");
    if (input.targetId === "$port-map" && edition.content.ports.some(port => port.anchor.kind === "image") && !qualification.expertise.includes("geometry")) fail("The image anchors require qualification to review geometry.");
    if (edition.authors.includes(current.actor.id)) fail("An author of this proposal cannot review or adjudicate its own assertions.");
    if (edition.provenance === "human" && edition.authorIdentities.some(author => !author.identityHash || !author.qualificationId)) fail("Actual independent review requires the author’s established real-world principal, bound into this exact edition.");
    if (edition.authorIdentities.some(author => author.identityHash === qualification.identityHash)) fail("The reviewer’s established identity is also an author. A different browser or invitation cannot remove that conflict.");
    const existing = votes.some(vote => vote.targetId === input.targetId && vote.kind === (input.kind === "decide" ? "review" : "adjudication") && (vote.actorId === access.actorId || vote.principalHash === qualification.identityHash));
    if (existing) fail("This principal already recorded a decision. Corrections require a new edition; the earlier decision is immutable.", "stale_revision");
    if (input.outcome === "accept") {
      if (claim && (claim.value === null || !claim.evidence.length)) fail("An acceptance cannot replace missing values or exact source spans.", "needs_evidence");
      if (claim && simultaneous(claim) && [edition.content.scope.firmware, edition.content.scope.os, edition.content.scope.application].some(value => /^(unknown|unspecified)/i.test(value))) fail("Specify the exact firmware, OS and application conditions before accepting simultaneous operation.", "needs_evidence");
      if (input.targetId === "$port-map" && (!edition.content.portMapDeclaredComplete || edition.content.ports.some(port => Object.values(port.fields).some(value => !value)))) fail("Complete the port facts and declared map before accepting it. Unsupported geometry can remain on the labelled rail.", "needs_evidence");
    }
    const allForTarget = votes.filter(vote => vote.targetId === input.targetId);
    if (input.kind === "adjudicate" && (input.decisionSetHash !== decisionSetHash(allForTarget) || new Set(allForTarget.filter(vote => vote.kind === "review").map(vote => vote.outcome)).size < 2)) fail("Adjudication must name the exact retained disagreement. Reload the decision set before resolving it.", "stale_revision");
    const decision: ReviewDecision = { id: randomUUID(), editionId: edition.id, editionHash: edition.hash, targetId: input.targetId, actorId: access.actorId, actorName: current.actor.name,
      principalHash: qualification.identityHash, capabilityId: current.capability!.id, capabilityVersion: current.capability!.version, qualification, outcome: input.outcome,
      kind: input.kind === "decide" ? "review" : "adjudication", reason: input.reason, decisionSetHash: input.kind === "adjudicate" ? input.decisionSetHash : null, createdAt: new Date().toISOString(), active: true };
    await db.query("INSERT INTO wk_review_decisions(id,tenant_id,edition_id,actor_id,principal_hash,target_id,kind,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [decision.id, access.tenantId, edition.id, access.actorId, qualification.identityHash, input.targetId, decision.kind, decision]);
    await event(db, access, `assertion.${decision.kind}`, decision.id, { editionId: edition.id, hash: edition.hash, targetId: input.targetId, outcome: input.outcome, provenance: qualification.provenance });
    return { decisionId: decision.id };
  }
  if (!assessment.eligible) fail(`Promotion is blocked. ${assessment.blockers[0] ?? "The review is incomplete."}`, "needs_evidence");
  const found = await basis(db, access, edition.binding.candidateId, edition.binding.kitId);
  const id = promotedId(edition), human = edition.provenance === "human";
  const accepted = new Set(assessment.targets.filter(target => target.status === "accepted").map(target => target.id));
  const facts: Record<string, Fact> = {};
  for (const claim of edition.content.claims) {
    const supported = accepted.has(claim.id);
    const property = claim.target === "device" ? claim.predicate : `${claim.target}:${claim.predicate}`;
    facts[property] = { id: `${id}:${claim.id}`, property, value: claim.value, unit: claim.unit, scope: `${edition.content.scope.manufacturer} ${edition.content.scope.model}; ${edition.content.scope.variant}; firmware ${edition.content.scope.firmware}; OS ${edition.content.scope.os}; app ${edition.content.scope.application}`,
      conditions: [...edition.content.scope.conditions, ...claim.conditions], sourceIds: claim.evidence.length ? [found.source.id] : [], state: supported ? "supported" : "unknown", critical: claim.critical,
      review: { status: human && supported ? "reviewed" : "pending", reviewer: human && supported ? assessment.targets.find(target => target.id === claim.id)!.activeReviewers.join("; ") : null, date: human && supported ? new Date().toISOString() : null },
      evidence: claim.evidence.map(anchor => ({ ...anchor, sourceId: found.source.id })), interpretation: claim.rationale };
  }
  if (!human) facts.technicalScope = { id: `${id}:technicalScope`, property: "technicalScope", value: null, unit: null, conditions: ["This is a fictional software rehearsal. Independent human engineering review has not occurred."], scope: found.profile.model, sourceIds: [], state: "unknown", critical: true, review: { status: "pending", reviewer: null, date: null } };
  const field = (claimId: string | null) => edition.content.claims.find(claim => claim.id === claimId)!.value;
  const ports = edition.content.ports.map(port => ({ id: port.id, label: port.label, connector: String(field(port.fields.connector)), direction: field(port.fields.direction), signal: field(port.fields.signal), protocols: String(field(port.fields.protocols)).split(",").map(value => value.trim()).filter(Boolean), channels: field(port.fields.channels), facts: Object.values(port.fields).map(claimId => `${id}:${claimId}`) }));
  const profile = DeviceSchema.parse({ ...found.profile, id, version: (await db.query("SELECT count(*)::int n FROM wk_review_profiles WHERE tenant_id=$1 AND profile_id=$2", [access.tenantId, edition.binding.profileId])).rows[0].n + 1,
    baseProfileId: edition.binding.profileId, basisProfileId: found.profile.id, facts, ports, portMapStatus: human ? "reviewed" : "review_pending", reviewState: human ? "verified_scope" : "review_pending",
    description: human ? "Independently reviewed facts within the exact listed conditions. Physical performance remains untested." : "Sample engineering rehearsal. This profile has no actual human or physical approval.",
    engineeringReview: { editionId: edition.id, editionHash: edition.hash, policy: REVIEW_POLICY, provenance: edition.provenance, verifiedPredicates: [...accepted].filter(value => value !== "$port-map"), conditions: edition.content.scope.conditions, physicalTest: "not_performed" }, portAnchors: edition.content.ports.map(port => ({ portId: port.id, ...port.anchor })) });
  const promotion: Promotion = { id, editionId: edition.id, profile, sourceHash: edition.binding.sourceHash, provenance: edition.provenance,
    scope: { predicates: [...accepted].filter(value => value !== "$port-map"), conditions: [edition.content.scope.firmware, edition.content.scope.os, edition.content.scope.application, ...edition.content.scope.conditions] }, createdAt: new Date().toISOString(), supersedes: found.binding.profileHeadId, current: true, withdrawn: false };
  await db.query("INSERT INTO wk_review_profiles(id,tenant_id,profile_id,edition_id,source_document_id,payload,source,promotion) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, access.tenantId, edition.binding.profileId, edition.id, edition.binding.documentId, profile, found.source, promotion]);
  await db.query("INSERT INTO wk_review_profile_heads(tenant_id,profile_id,promotion_id) VALUES($1,$2,$3) ON CONFLICT(tenant_id,profile_id) DO UPDATE SET promotion_id=EXCLUDED.promotion_id,version=wk_review_profile_heads.version+1", [access.tenantId, edition.binding.profileId, id]);
  const affected = await affectedKits(db, access.tenantId, edition.binding.profileId, access.kind === "specialist" ? edition.binding.kitId : undefined);
  for (const impact of affected) await db.query("INSERT INTO wk_review_impacts(id,tenant_id,promotion_id,revision_id,payload) VALUES($1,$2,$3,$4,$5)", [randomUUID(), access.tenantId, id, impact.revisionId, { ...impact, action: "Review this new profile in a new kit revision; historical proofs and purchases remain unchanged." }]);
  await event(db, access, "profile.promoted", id, { editionHash: edition.hash, provenance: edition.provenance, actualHumanApproval: human, physicalTests: 0, affectedRevisions: affected.map(value => value.revisionId) });
  return { promotionId: id, affected: affected.length, provenance: edition.provenance };
}

async function insertQualification(db: PoolClient, tenantId: string, actorId: string, value: Qualification) {
  const identity = (await db.query("SELECT actor_id FROM wk_review_identities WHERE tenant_id=$1 AND identity_hash=$2", [tenantId, value.identityHash])).rows[0];
  if (identity && identity.actor_id !== actorId) fail("That independently established person already has a principal here. New links cannot create a second reviewer.", "stale_revision");
  const prior = (await db.query("SELECT identity_hash FROM wk_review_identities WHERE tenant_id=$1 AND actor_id=$2", [tenantId, actorId])).rows[0];
  if (prior && prior.identity_hash !== value.identityHash) fail("An existing principal cannot change its established identity.", "stale_revision");
  if (!prior) await db.query("INSERT INTO wk_review_identities(tenant_id,identity_hash,actor_id) VALUES($1,$2,$3)", [tenantId, value.identityHash, actorId]);
  await db.query("INSERT INTO wk_review_qualifications(id,tenant_id,actor_id,identity_hash,evidence_hash,payload) VALUES($1,$2,$3,$4,$5,$6)", [value.id, tenantId, actorId, value.identityHash, value.evidenceHash, value]);
  await db.query("UPDATE wk_review_actors SET qualification_id=$2,version=version+1 WHERE id=$1 AND tenant_id=$3", [actorId, value.id, tenantId]);
}

/** Operator-only seam. No browser route may call this; identity/qualification evidence is examined outside the bearer-link flow. */
export async function qualifyEngineeringPrincipal(tenantId: string, actorId: string, qualification: Omit<Qualification, "id" | "actorId" | "provenance">) {
  if (process.env.WORLDKIT_QA_MODE || process.env.WORLDKIT_DISABLE_PROVIDERS === "true") fail("Actual identity and qualification attestation is disabled in synthetic QA. Use explicitly Sample actors.", "needs_evidence");
  await initializeEngineeringReview();
  return transaction(async db => {
    if (!(await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE", [tenantId])).rowCount) fail("The qualification workspace has expired.");
    const actor = (await db.query("SELECT * FROM wk_review_actors WHERE id=$1 AND tenant_id=$2 AND provenance='human' AND revoked_at IS NULL", [actorId, tenantId])).rows[0];
    if (!actor || !activeTime(qualification.expiresAt) || !/^[a-f0-9]{64}$/.test(qualification.identityHash) || !/^[a-f0-9]{64}$/.test(qualification.evidenceHash) || qualification.issuer.trim().length < 3 || qualification.method.trim().length < 20 || !(actor.kind === "owner" ? qualification.expertise.includes("identity") : qualification.expertise.includes("engineering"))) fail("A current principal and examined identity/qualification evidence are required. Creator identity does not imply engineering expertise.", "needs_evidence");
    const value: Qualification = { ...qualification, id: randomUUID(), actorId, provenance: "human" };
    await insertQualification(db, tenantId, actorId, value);
    await event(db, { tenantId, actorId: tenantId, kind: "owner", capabilityId: null }, "qualification.operator_attested", actorId, { qualificationId: value.id, evidenceHash: value.evidenceHash, issuer: value.issuer, expertise: value.expertise, physicalApproval: false });
    return { qualificationId: value.id };
  });
}

async function affectedKits(db: PoolClient, tenantId: string, profileId: string, kitId?: string) {
  const rows = (await db.query("SELECT r.id,r.kit,r.certificate,r.profiles,(k.current_revision_id=r.id) AS current FROM wk_revisions r JOIN wk_kits k ON k.id=r.kit_id AND k.tenant_id=r.tenant_id WHERE r.tenant_id=$1 AND ($2::text IS NULL OR r.kit_id=$2) ORDER BY (k.current_revision_id=r.id) DESC,r.created_at DESC LIMIT 100", [tenantId, kitId ?? null])).rows;
  return rows.flatMap(row => {
    const matching = (row.profiles as DeviceProfile[]).filter(profile => profile.id === profileId || profile.corpusId === profileId || profile.baseProfileId === profileId);
    const kit = row.kit as KitRevision, certificate = row.certificate as Certificate;
    const componentIds = kit.components.filter(component => matching.some(profile => profile.id === component.profileId)).map(component => component.id);
    if (!componentIds.length) return [];
    return [{ revisionId: row.id, current: row.current, requirements: certificate.results.filter(result => result.componentIds.some(id => componentIds.includes(id))).map(result => result.requirementId), connections: kit.connections.filter(edge => edge.enabled && (componentIds.includes(edge.from.componentId) || componentIds.includes(edge.to.componentId))).map(edge => edge.id) }];
  });
}

export async function engineeringHome(access: ReviewAccess): Promise<ReviewHome> {
  await initializeEngineeringReview();
  return transaction(async db => {
    const auth = await authorize(db, access), cap = auth.capability;
    const queryScope = [access.tenantId, cap?.profileId ?? null, cap?.documentId ?? null];
    const candidateRows = (await db.query("SELECT v.id,v.profile_id,v.payload,v.draft_id,v.source_document_id,d.content_hash,d.text_hash,(h.document_id=d.id AND d.status='available') AS current FROM wk_source_profile_versions v JOIN wk_source_documents d ON d.id=v.source_document_id AND d.tenant_id=v.tenant_id LEFT JOIN wk_source_heads h ON h.tenant_id=v.tenant_id AND h.profile_id=v.profile_id WHERE v.tenant_id=$1 AND ($2::text IS NULL OR v.profile_id=$2) AND ($3::text IS NULL OR v.source_document_id=$3) ORDER BY v.created_at DESC LIMIT 120", queryScope)).rows;
    const candidates: ReviewCandidate[] = candidateRows.map(row => ({ id: row.id, profileId: row.profile_id, model: row.payload.model, variant: row.payload.variant, documentId: row.source_document_id, sourceHash: row.content_hash, textHash: row.text_hash, draftId: row.draft_id, current: row.current }));
    const proposalRows = (await db.query("SELECT p.*,e.payload FROM wk_review_proposals p JOIN wk_review_editions e ON e.id=p.current_edition_id AND e.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.profile_id=$2) AND ($3::text IS NULL OR p.document_id=$3) AND ($4::text IS NULL OR p.kit_id=$4) ORDER BY p.created_at DESC LIMIT 120", [...queryScope, cap?.kitId ?? null])).rows;
    const assetRows = (await db.query("SELECT a.*,h.asset_id AS current_asset_id,p.status AS photo_status,p.content_hash AS photo_hash FROM wk_review_assets a LEFT JOIN wk_review_asset_heads h ON h.tenant_id=a.tenant_id AND h.profile_id=a.profile_id LEFT JOIN wk_inventory_photos p ON p.id=a.photo_id AND p.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND ($2::text IS NULL OR a.profile_id=$2) ORDER BY a.created_at DESC LIMIT 120", queryScope.slice(0, 2))).rows;
    const actors = cap ? [auth.actor] : (await db.query("SELECT a.*,q.payload AS qualification FROM wk_review_actors a LEFT JOIN wk_review_qualifications q ON q.id=a.qualification_id AND q.tenant_id=a.tenant_id WHERE a.tenant_id=$1 ORDER BY a.created_at", [access.tenantId])).rows.map(actorDto);
    const capabilities = cap ? [cap] : (await db.query("SELECT * FROM wk_review_capabilities WHERE tenant_id=$1 ORDER BY created_at DESC", [access.tenantId])).rows.map(capabilityDto);
    const kits = (await db.query("SELECT k.id,r.id AS revision_id,r.kit,r.certificate FROM wk_kits k JOIN wk_revisions r ON r.id=k.current_revision_id AND r.tenant_id=k.tenant_id WHERE k.tenant_id=$1 AND ($2::text IS NULL OR k.id=$2)", [access.tenantId, cap?.kitId ?? null])).rows.map(row => ({ id: row.id, revisionId: row.revision_id, graphHash: row.certificate.graphHash, title: row.kit.goal.title }));
    const photos = cap ? [] : (await db.query("SELECT id,content_hash,width,height FROM wk_inventory_photos WHERE tenant_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 80", [access.tenantId])).rows.map(row => ({ id: row.id, hash: row.content_hash, width: row.width, height: row.height }));
    const audit = cap ? [] : (await db.query("SELECT e.sequence,e.kind,e.created_at,e.payload,a.name FROM wk_review_events e JOIN wk_review_actors a ON a.id=e.actor_id AND a.tenant_id=e.tenant_id WHERE e.tenant_id=$1 ORDER BY e.sequence DESC LIMIT 60", [access.tenantId])).rows.map(row => ({ sequence: Number(row.sequence), actorName: row.name, kind: row.kind, at: iso(row.created_at), detail: typeof row.payload.reason === "string" ? row.payload.reason : row.kind === "invitation.created" ? `Scoped ${row.payload.role} invitation; expires ${row.payload.expiresAt}. Deliberate copy-link only.` : row.kind === "qualification.operator_attested" ? "An independently examined identity/qualification attestation was recorded. No physical approval." : row.payload.outcome ? `${row.payload.outcome} decision, attached to its exact edition and authority.` : "The immutable event and exact authority binding are retained." }));
    return { actor: auth.actor, role: cap?.role ?? "owner", expiresAt: auth.expiresAt, policy: REVIEW_POLICY, actors, capabilities, candidates, assets: assetRows.map(assetDto), kits, photos, audit,
      proposals: proposalRows.map(row => ({ id: row.id, model: row.payload.content.scope.model, version: row.version, editionId: row.current_edition_id, provenance: row.payload.provenance, state: "Open exact review" })),
      qualificationGate: "A copied link grants scoped access only. Actual review requires a separately examined identity and engineering qualification. Sample people never count as human review; physical tests remain a separate gate." };
  });
}

export async function engineeringDetail(access: ReviewAccess, proposalId: string, editionId?: string): Promise<ReviewDetail> {
  await initializeEngineeringReview();
  return transaction(async db => {
    const found = await proposal(db, access, proposalId);
    const history = (await db.query("SELECT payload FROM wk_review_editions WHERE proposal_id=$1 AND tenant_id=$2 ORDER BY version DESC", [proposalId, access.tenantId])).rows.map(row => row.payload as ReviewEdition);
    const edition = editionId ? history.find(value => value.id === editionId) : found.edition;
    if (!edition) fail("That edition is outside this proposal.", "not_found");
    const stale = await freshness(db, access, edition);
    if (edition.id !== found.edition.id) stale.unshift("This is a historical edition. Its source, decisions and corrections are retained; new commands use the current edition.");
    const votes = await decisions(db, access.tenantId, edition.id);
    const doc = (await db.query("SELECT payload,source_url,status FROM wk_source_documents WHERE id=$1 AND tenant_id=$2", [edition.binding.documentId, access.tenantId])).rows[0];
    const document = doc?.status === "available" ? doc.payload as SourceDocument | null : null;
    // Only bounded cited excerpts are disclosed to this narrow source capability.
    const excerpts = document ? edition.content.claims.flatMap(claim => validAnchors(claim, document) ? claim.evidence.map(anchor => ({ targetId: claim.id, page: anchor.page, start: anchor.start, end: anchor.end,
      text: document.pages.find(page => page.number === anchor.page)!.text.slice(anchor.start, anchor.end).split(/\s+/).slice(0, 24).join(" "), hash: anchor.excerptHash })) : []) : [];
    const promotions = (await db.query("SELECT p.promotion,h.promotion_id,w.promotion_id AS withdrawn FROM wk_review_profiles p JOIN wk_review_editions pe ON pe.id=p.edition_id AND pe.tenant_id=p.tenant_id LEFT JOIN wk_review_profile_heads h ON h.tenant_id=p.tenant_id AND h.profile_id=p.profile_id LEFT JOIN wk_review_withdrawals w ON w.promotion_id=p.id AND w.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND p.profile_id=$2 AND ($3::text IS NULL OR pe.payload#>>'{binding,kitId}'=$3) AND ($4::text IS NULL OR p.source_document_id=$4) ORDER BY p.created_at DESC", [access.tenantId, edition.binding.profileId, access.kind === "specialist" ? edition.binding.kitId : null, access.kind === "specialist" ? edition.binding.documentId : null])).rows.map(row => ({ ...row.promotion, current: row.promotion.id === row.promotion_id, withdrawn: Boolean(row.withdrawn) }));
    return { edition, history, decisions: votes, assessment: reviewAssessment(edition, votes, stale), stale, source: { url: doc?.source_url ?? "", title: `${edition.content.scope.model} · exact source`, pages: document?.pages.map(page => ({ number: page.number, characters: page.text.length })) ?? [], excerpts },
      asset: edition.binding.assetId ? await currentAsset(db, access.tenantId, edition.binding.profileId, edition.binding.assetId) : null, currentAsset: await currentAsset(db, access.tenantId, edition.binding.profileId), promotions,
      affected: await affectedKits(db, access.tenantId, edition.binding.profileId, access.kind === "specialist" ? edition.binding.kitId : undefined) };
  });
}

export async function reviewedProfileLibrary(tenantId: string): Promise<{ profiles: DeviceProfile[]; sources: Source[] }> {
  await initializeEngineeringReview();
  // A saved historical profile is immutable. Only a currently valid head can be
  // proposed for a new equipment confirmation; existing graph snapshots stay intact.
  return transaction(async db => {
    const result: { profiles: DeviceProfile[]; sources: Source[] } = { profiles: [], sources: [] };
    const rows = (await db.query("SELECT p.*,e.payload AS edition FROM wk_review_profile_heads h JOIN wk_review_profiles p ON p.id=h.promotion_id AND p.tenant_id=h.tenant_id JOIN wk_review_editions e ON e.id=p.edition_id AND e.tenant_id=p.tenant_id JOIN wk_sessions s ON s.id=h.tenant_id WHERE h.tenant_id=$1 AND s.expires_at>clock_timestamp() ORDER BY p.created_at DESC LIMIT 120", [tenantId])).rows;
    for (const row of rows) {
      const access: ReviewAccess = { tenantId, actorId: tenantId, kind: "owner", capabilityId: null };
      const stale = await freshness(db, access, row.edition), votes = await decisions(db, tenantId, row.edition.id);
      if (!reviewAssessment(row.edition, votes, stale).eligible) continue;
      result.profiles.push(row.payload); result.sources.push(row.source);
    }
    return result;
  });
}

/** Recheck cached profile adoption inside the caller's transaction. Row-level
 * authority locks serialize with revocation without inverting kit/session locks.
 * The immutable past is readable; only new uses require current qualification. */
export async function assertEngineeringProfilesCurrent(db: PoolClient, tenantId: string, profiles: DeviceProfile[]) {
  const selected = profiles.filter(profile => profile.engineeringReview);
  if (!selected.length) return;
  if (!(await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp()", [tenantId])).rowCount) fail("This workspace has expired.");
  await db.query("SELECT id FROM wk_review_actors WHERE tenant_id=$1 ORDER BY id FOR SHARE", [tenantId]);
  await db.query("SELECT id FROM wk_review_capabilities WHERE tenant_id=$1 ORDER BY id FOR SHARE", [tenantId]);
  await db.query("SELECT profile_id FROM wk_review_profile_heads WHERE tenant_id=$1 ORDER BY profile_id FOR SHARE", [tenantId]);
  await db.query("SELECT profile_id FROM wk_review_asset_heads WHERE tenant_id=$1 ORDER BY profile_id FOR SHARE", [tenantId]);
  await db.query("SELECT id FROM wk_inventory_photos WHERE tenant_id=$1 ORDER BY id FOR SHARE", [tenantId]);
  const technical = (profile: DeviceProfile) => hash({ manufacturer: profile.manufacturer, model: profile.model, variant: profile.variant, kind: profile.kind, sourceVersion: profile.sourceVersion, facts: profile.facts, ports: profile.ports, portAnchors: profile.portAnchors, engineeringReview: profile.engineeringReview, reviewState: profile.reviewState, portMapStatus: profile.portMapStatus });
  for (const profile of selected) {
    const row = (await db.query("SELECT p.payload,e.payload AS edition FROM wk_review_profiles p JOIN wk_review_profile_heads h ON h.promotion_id=p.id AND h.tenant_id=p.tenant_id JOIN wk_review_editions e ON e.id=p.edition_id AND e.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND p.edition_id=$2", [tenantId, profile.engineeringReview!.editionId])).rows[0];
    if (!row || technical(profile) !== technical(row.payload)) fail("This engineering profile was withdrawn, superseded or changed. Review a current profile before adopting it in a new equipment entry or kit revision.", "stale_revision");
    const access: ReviewAccess = { tenantId, actorId: tenantId, kind: "owner", capabilityId: null };
    const stale = await freshness(db, access, row.edition, true), votes = await decisions(db, tenantId, row.edition.id);
    if (!reviewAssessment(row.edition, votes, stale).eligible) fail("The exact engineering source, crop or reviewer authority changed after this profile was reviewed. Preserve the earlier record and complete a new review before using it again.", "stale_revision");
  }
}

export async function checkEngineeringProfilesCurrent(tenantId: string, profiles: DeviceProfile[]) {
  if (!profiles.some(profile => profile.engineeringReview)) return;
  await initializeEngineeringReview();
  return transaction(db => assertEngineeringProfilesCurrent(db, tenantId, profiles));
}

export async function reviewAssetAuthority(access: ReviewAccess, assetId: string) {
  await initializeEngineeringReview();
  return transaction(async db => {
    const auth = await authorize(db, access);
    const row = (await db.query("SELECT profile_id FROM wk_review_assets WHERE id=$1 AND tenant_id=$2", [assetId, access.tenantId])).rows[0];
    if (!row || auth.capability && auth.capability.profileId !== row.profile_id) fail("This image is outside the invitation scope.", "not_found");
    const asset = await currentAsset(db, access.tenantId, row.profile_id, assetId);
    if (!asset?.available) fail("This private image is no longer available.", "not_found");
    return { asset, tenantId: access.tenantId };
  });
}

export async function engineeringSourcePage(access: ReviewAccess, proposalId: string, editionId: string, pageNumber: number, offset: number, end?: number) {
  await initializeEngineeringReview();
  return transaction(async db => {
    await proposal(db, access, proposalId);
    const edition = (await db.query("SELECT payload FROM wk_review_editions WHERE id=$1 AND proposal_id=$2 AND tenant_id=$3", [editionId, proposalId, access.tenantId])).rows[0]?.payload as ReviewEdition | undefined;
    if (!edition) fail("That source edition is unavailable.", "not_found");
    const row = (await db.query("SELECT payload,content_hash,text_hash FROM wk_source_documents WHERE id=$1 AND tenant_id=$2 AND status='available' FOR SHARE", [edition.binding.documentId, access.tenantId])).rows[0];
    const document = row?.payload as SourceDocument | undefined, page = document?.pages.find(page => page.number === pageNumber);
    if (!document || !page || row.content_hash !== edition.binding.sourceHash || row.text_hash !== edition.binding.textHash || digestText(document.pages.map(page => page.text).join("\n\n")) !== edition.binding.textHash) fail("The exact private source is unavailable. Historical fingerprints remain retained.", "needs_evidence");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= page.text.length || end !== undefined && (!Number.isSafeInteger(end) || end <= offset || end > page.text.length || end - offset > 1200)) fail("Choose an exact nonempty passage inside this saved page (up to 1,200 characters).", "invalid_request", 400);
    const text = page.text.slice(offset, end ?? offset + 12000);
    return { page: pageNumber, offset, total: page.text.length, text, contentHash: document.contentHash, textHash: document.textHash,
      anchor: end === undefined ? null : { contentHash: document.contentHash, textHash: document.textHash, page: pageNumber, start: offset, end, excerptHash: digestText(text) } };
  });
}
