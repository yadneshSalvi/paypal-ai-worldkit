import type { PoolClient } from "pg";
import { hash } from "../../packages/compatibility";
import type { ResearchAttempt, ResearchConsent, ResearchConsentInput, ResearchOutcomeInput, ResearchParticipant, ResearchProtocol, ResearchSourceObservation, ResearchStudy } from "../../packages/research-notebook/contracts";
import { researchConsentCurrent } from "../../packages/research-notebook/policy";
import { researchFail, researchIso, researchPrivateHash, type ResearchAccess, type ResearchRow } from "./research-notebook-authority";
import { unseal } from "./secrets";

export type StoredConsent = { id: string; participantId: string; number: number; recordedAt: string; input: ResearchConsentInput; reason: string };
export type StoredIdentity = { id: string; pseudonym: string; experience: ResearchParticipant["experience"]; mode: ResearchParticipant["mode"]; createdAt: string };
export type StoredStart = Pick<ResearchAttempt, "id" | "participantId" | "mode" | "protocolId" | "protocolHash" | "task" | "consentId" | "consentHash" | "number" | "retryOf" | "firstAttempt" | "startedAt" | "startSource"> & { hash: string };
export type StoredOutcome = { attemptId: string; finishedAt: string; recordedIntervalMs: number; result: ResearchOutcomeInput; source: ResearchSourceObservation; authorizationConsentId: string; authorizationConsentHash: string; completionKind: "operator_observation" | "administrative_no_outcome" };
export type StudyRevision = { study: ResearchStudy; stateRoot: string; parentHash: string | null };
export const researchScope = (kind: string, access: ResearchAccess, studyId: string, id: string) => `research-${kind}:${access.tenantId}:${studyId}:${id}`;

export async function researchStudy(db: PoolClient, access: ResearchAccess, studyId: string, lock = false): Promise<{ row: ResearchRow; study: ResearchStudy }> {
  const row = (await db.query(`SELECT s.*,r.payload AS revision FROM wk_research_studies s JOIN wk_research_revisions r ON r.study_id=s.id AND r.tenant_id=s.tenant_id AND r.number=s.version AND r.content_hash=s.content_hash WHERE s.id=$1 AND s.tenant_id=$2 ${lock ? "FOR UPDATE OF s" : ""}`, [studyId, access.tenantId])).rows[0];
  if (!row) researchFail("That study is outside this private workspace.", "not_found");
  const revision = row.revision as StudyRevision, { hash: fingerprint, ...studyContent } = revision.study;
  const { hash: bindingHash, ...bindingContent } = revision.study.binding;
  if (hash({ study: studyContent, stateRoot: revision.stateRoot, parentHash: revision.parentHash }) !== fingerprint || hash(bindingContent) !== bindingHash || row.content_hash !== fingerprint || row.version !== revision.study.version || row.creator_id !== access.tenantId || row.source_mode !== revision.study.mode || row.binding_hash !== bindingHash || row.phase !== revision.study.phase || row.current_protocol_id !== revision.study.currentProtocolId) researchFail("The immutable study fingerprint is inconsistent.", "needs_evidence");
  return { row, study: revision.study };
}
export async function researchProtocols(db: PoolClient, access: ResearchAccess, studyId: string): Promise<ResearchProtocol[]> {
  return (await db.query("SELECT content_hash,payload FROM wk_research_protocols WHERE study_id=$1 AND tenant_id=$2 ORDER BY number", [studyId, access.tenantId])).rows.map(row => {
    const protocol = row.payload as ResearchProtocol, { hash: fingerprint, ...content } = protocol;
    if (hash(content) !== fingerprint || fingerprint !== row.content_hash) researchFail("This task protocol fingerprint is inconsistent.", "needs_evidence");
    return protocol;
  });
}
export function decodeResearchConsent(access: ResearchAccess, studyId: string, row: ResearchRow): StoredConsent {
  const value = unseal<StoredConsent>(researchScope("consent", access, studyId, row.id), row.payload_sealed);
  if (researchPrivateHash(value) !== row.content_hash || value.id !== row.id || value.participantId !== row.participant_id || value.number !== row.number || value.input.privateResearch !== row.private_research || value.input.anonymousPublicAggregate !== row.public_aggregate || value.input.grantedAt !== researchIso(row.granted_at) || value.input.expiresAt !== (row.expires_at ? researchIso(row.expires_at) : null)) researchFail("The original consent fingerprint is inconsistent.", "needs_evidence");
  return value;
}
export async function researchParticipantRows(db: PoolClient, access: ResearchAccess, studyId: string) {
  const participants = (await db.query("SELECT * FROM wk_research_participants WHERE study_id=$1 AND tenant_id=$2 ORDER BY created_at,id", [studyId, access.tenantId])).rows as ResearchRow[];
  const consentRows = (await db.query("SELECT * FROM wk_research_consents WHERE study_id=$1 AND tenant_id=$2 ORDER BY participant_id,number", [studyId, access.tenantId])).rows as ResearchRow[];
  const consents = new Map(consentRows.map(row => [row.id, { row, value: decodeResearchConsent(access, studyId, row) }]));
  return { participants, consents };
}
export function researchParticipantAvailability(row: ResearchRow, consent: StoredConsent | undefined, now = Date.now()): ResearchParticipant["availability"] {
  if (row.withdrawn_at) return "withdrawn";
  if (consent?.input.expiresAt && Date.parse(consent.input.expiresAt) <= now) return "consent_expired";
  if (!consent || !researchConsentCurrent(consent.input, now)) return "permission_missing";
  return "current";
}
export async function prepareResearchPeopleAndAttempts(db: PoolClient, access: ResearchAccess, study: ResearchStudy): Promise<(now: number) => { participants: ResearchParticipant[]; attempts: ResearchAttempt[] }> {
  const records = await researchParticipantRows(db, access, study.id);
  const rows = (await db.query("SELECT a.*,o.content_hash AS outcome_hash,o.payload_sealed AS outcome_sealed FROM wk_research_attempts a LEFT JOIN wk_research_outcomes o ON o.attempt_id=a.id AND o.study_id=a.study_id AND o.tenant_id=a.tenant_id WHERE a.study_id=$1 AND a.tenant_id=$2 ORDER BY a.started_at,a.id", [study.id, access.tenantId])).rows;
  // Evaluate permission only after every awaited read and the enclosing commit.
  return (now: number) => {
    const participants: ResearchParticipant[] = records.participants.map(row => {
      const identity = unseal<StoredIdentity>(researchScope("participant", access, study.id, row.id), row.identity_sealed);
      if (researchPrivateHash(identity) !== row.identity_hash || identity.id !== row.id || identity.mode !== study.mode || row.source_mode !== study.mode || identity.experience !== row.experience) researchFail("This participant fingerprint is inconsistent.", "needs_evidence");
      const current = records.consents.get(row.current_consent_id)?.value, availability = researchParticipantAvailability(row, current, now), permitted = availability === "current";
      const consents: ResearchConsent[] = [...records.consents.values()].filter(item => item.value.participantId === row.id).map(item => {
        const value = item.value, input = value.input;
        const status = row.withdrawn_at ? "withdrawn" : input.expiresAt && Date.parse(input.expiresAt) <= now ? "expired" : !researchConsentCurrent(input, now) ? "permission_missing" : value.id !== row.current_consent_id ? "superseded" : "current";
        return { ...input, id: value.id, hash: item.row.content_hash, number: value.number, recordedAt: value.recordedAt, status, consentReference: permitted && researchConsentCurrent(input, now) ? input.consentReference : null };
      });
      return { id: row.id, hash: row.identity_hash, mode: row.source_mode, pseudonym: permitted ? identity.pseudonym : null, experience: row.experience, createdAt: researchIso(row.created_at), withdrawnAt: row.withdrawn_at ? researchIso(row.withdrawn_at) : null, availability, currentConsent: consents.find(value => value.id === row.current_consent_id) ?? null, consents, eligibleForPrivateSummary: permitted, eligibleForPublicSummary: permitted && !!current?.input.anonymousPublicAggregate, runningAttemptId: null };
    });
    const attempts: ResearchAttempt[] = rows.map(row => {
      const start = row.payload as StoredStart, { hash: startHash, ...content } = start;
      if (hash(content) !== startHash || startHash !== row.content_hash || start.mode !== study.mode) researchFail("This original task-start fingerprint is inconsistent.", "needs_evidence");
      const outcome = row.outcome_sealed ? unseal<StoredOutcome>(researchScope("outcome", access, study.id, start.id), row.outcome_sealed) : null;
      if (outcome && (researchPrivateHash(outcome) !== row.outcome_hash || outcome.attemptId !== start.id)) researchFail("The original task-outcome fingerprint is inconsistent.", "needs_evidence");
      const participant = participants.find(value => value.id === start.participantId), original = records.consents.get(start.consentId), final = outcome ? records.consents.get(outcome.authorizationConsentId) : original;
      if (!participant || !original || original.row.content_hash !== start.consentHash || outcome && (!final || final.row.content_hash !== outcome.authorizationConsentHash)) researchFail("A task's consent binding is inconsistent.", "needs_evidence");
      const originalLive = researchConsentCurrent(original.value.input, now), finalLive = !!final && researchConsentCurrent(final.value.input, now);
      const permitted = participant.eligibleForPrivateSummary && originalLive && finalLive;
      const scored = permitted && outcome?.completionKind !== "administrative_no_outcome";
      const expired = [original.value.input, final?.value.input].some(input => input?.expiresAt && Date.parse(input.expiresAt) <= now);
      const visibility: ResearchAttempt["visibility"] = participant.availability === "withdrawn" ? "withdrawn" : participant.availability === "consent_expired" || expired ? "consent_expired" : !permitted ? "permission_missing" : "available";
      return { ...start, hash: outcome ? hash({ startHash, outcomeHash: row.outcome_hash }) : startHash, finishedAt: outcome?.finishedAt ?? null, recordedIntervalMs: outcome?.recordedIntervalMs ?? null, outcomeSource: outcome?.source ?? null, state: outcome ? "finished" : "running", completionKind: outcome?.completionKind ?? null,
        result: outcome ? { ...outcome.result, observedNote: scored ? outcome.result.observedNote : null, response: scored ? outcome.result.response : null } : null,
        visibility, eligibleForPrivateSummary: scored,
        eligibleForPublicSummary: scored && participant.eligibleForPublicSummary && original.value.input.anonymousPublicAggregate && !!final?.value.input.anonymousPublicAggregate,
        exclusionReason: outcome?.completionKind === "administrative_no_outcome" ? "The application interval was closed administratively after permission ended. No participant performance outcome was recorded; it is permanently excluded from scored summaries." : permitted ? null : visibility === "withdrawn" ? "The participant withdrew. Private text is withheld and this record is excluded from current summaries." : visibility === "consent_expired" ? "A current or original consent expired. A later grant does not renew the original task's permission." : "Current and original private-research permission are both required; this record is excluded.",
      };
    });
    for (const participant of participants) participant.runningAttemptId = attempts.find(value => value.participantId === participant.id && value.state === "running")?.id ?? null;
    return { participants, attempts };
  };
}
