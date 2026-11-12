import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hash } from "../../packages/compatibility";
import { RESEARCH_POLICY, ResearchCommandSchema, type ResearchCommand, type ResearchCommandResult, type ResearchConsentInput, type ResearchDetail, type ResearchHome, type ResearchProtocol, type ResearchStudy } from "../../packages/research-notebook/contracts";
import { researchConsentCurrent, summarizeResearch } from "../../packages/research-notebook/policy";
import { transaction } from "./db";
import { initializeResearchNotebook } from "./research-notebook-db";
import { authorizeResearch, researchBinding, researchFail, researchIso, researchPrivateHash, researchSource, type ResearchAccess, type ResearchRow } from "./research-notebook-authority";
import { decodeResearchConsent, researchParticipantAvailability, prepareResearchPeopleAndAttempts, researchProtocols, researchScope, researchStudy, type StoredConsent, type StoredIdentity, type StoredOutcome, type StoredStart, type StudyRevision } from "./research-notebook-records";
import { benchSubjects } from "./physical-notebook-binding";
import { seal, unseal } from "./secrets";

async function event(db: PoolClient, access: ResearchAccess, studyId: string, kind: string, summary: string, payload: unknown = {}) {
  await db.query("INSERT INTO wk_research_events(id,study_id,tenant_id,actor_id,kind,summary,payload) VALUES($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), studyId, access.tenantId, access.actorId, kind, summary, payload]);
}
async function stateRoot(db: PoolClient, access: ResearchAccess, studyId: string) {
  const protocols = (await db.query("SELECT id,content_hash FROM wk_research_protocols WHERE study_id=$1 AND tenant_id=$2 ORDER BY id", [studyId, access.tenantId])).rows.map(row => ({ id: row.id, hash: row.content_hash }));
  const participants = (await db.query("SELECT p.id,p.identity_hash,p.current_consent_id,p.withdrawn_at,c.content_hash FROM wk_research_participants p JOIN wk_research_consents c ON c.id=p.current_consent_id AND c.participant_id=p.id AND c.study_id=p.study_id AND c.tenant_id=p.tenant_id WHERE p.study_id=$1 AND p.tenant_id=$2 ORDER BY p.id", [studyId, access.tenantId])).rows.map(row => ({ id: row.id, hash: row.identity_hash, currentConsentId: row.current_consent_id, currentConsentHash: row.content_hash, withdrawnAt: row.withdrawn_at ? researchIso(row.withdrawn_at) : null }));
  const attempts = (await db.query("SELECT a.id,a.content_hash,o.content_hash AS outcome_hash FROM wk_research_attempts a LEFT JOIN wk_research_outcomes o ON o.attempt_id=a.id AND o.study_id=a.study_id AND o.tenant_id=a.tenant_id WHERE a.study_id=$1 AND a.tenant_id=$2 ORDER BY a.id", [studyId, access.tenantId])).rows.map(row => ({ id: row.id, hash: row.content_hash, outcomeHash: row.outcome_hash ?? null }));
  return hash({ protocols, participants, attempts });
}
function revision(study: Omit<ResearchStudy, "hash">, root: string, parentHash: string | null): StudyRevision {
  return { study: { ...study, hash: hash({ study, stateRoot: root, parentHash }) }, stateRoot: root, parentHash };
}
async function insertRevision(db: PoolClient, access: ResearchAccess, value: StudyRevision, reason: string) {
  await db.query("INSERT INTO wk_research_revisions(id,study_id,tenant_id,number,content_hash,payload,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), value.study.id, access.tenantId, value.study.version, value.study.hash, value, reason, value.study.updatedAt]);
}
async function nextRevision(db: PoolClient, access: ResearchAccess, current: ResearchStudy, patch: Partial<Pick<ResearchStudy, "currentProtocolId" | "phase" | "sealedAt">>, reason: string): Promise<ResearchStudy> {
  if (current.version >= 1500) researchFail("This study reached its revision allowance. Retain it and declare a separate study.", "needs_evidence");
  const { hash: parentHash, ...prior } = current;
  const content = { ...prior, ...patch, version: current.version + 1, updatedAt: new Date().toISOString() };
  const next = revision(content, await stateRoot(db, access, current.id), parentHash); await insertRevision(db, access, next, reason);
  await db.query("UPDATE wk_research_studies SET version=$3,content_hash=$4,current_protocol_id=$5,phase=$6,sealed_at=$7,updated_at=$8 WHERE id=$1 AND tenant_id=$2", [current.id, access.tenantId, next.study.version, next.study.hash, next.study.currentProtocolId, next.study.phase, next.study.sealedAt, next.study.updatedAt]);
  return next.study;
}
function currentVersion(study: ResearchStudy, command: { expectedVersion: number; expectedStudyHash: string }) {
  if (study.version !== command.expectedVersion || study.hash !== command.expectedStudyHash) researchFail("This study changed. Refresh the exact current study and consent before recording another action.", "stale_revision");
}
function protocol(tasks: ResearchProtocol["tasks"], number: number, reason: string): ResearchProtocol {
  const content = { id: randomUUID(), number, tasks, reason, createdAt: new Date().toISOString() }; return { ...content, hash: hash(content) };
}
async function insertProtocol(db: PoolClient, access: ResearchAccess, studyId: string, value: ResearchProtocol) {
  await db.query("INSERT INTO wk_research_protocols(id,study_id,tenant_id,number,content_hash,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [value.id, studyId, access.tenantId, value.number, value.hash, value, value.createdAt]);
}
function assertNewConsent(input: ResearchConsentInput) {
  if (Date.parse(input.grantedAt) > Date.now()) researchFail("Record the date consent was actually granted; a future declaration is not current consent.", "needs_evidence");
}
async function insertConsent(db: PoolClient, access: ResearchAccess, studyId: string, participantId: string, input: ResearchConsentInput, number: number, reason: string, id = randomUUID()) {
  assertNewConsent(input);
  input = { ...input, grantedAt: new Date(input.grantedAt).toISOString(), expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null };
  const value: StoredConsent = { id, participantId, number, recordedAt: new Date().toISOString(), input, reason }, fingerprint = researchPrivateHash(value);
  await db.query("INSERT INTO wk_research_consents(id,participant_id,study_id,tenant_id,number,content_hash,payload_sealed,private_research,public_aggregate,granted_at,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [id, participantId, studyId, access.tenantId, number, fingerprint, seal(researchScope("consent", access, studyId, id), value), input.privateResearch, input.anonymousPublicAggregate, input.grantedAt, input.expiresAt, value.recordedAt]);
  return { value, hash: fingerprint };
}
async function participantRecord(db: PoolClient, access: ResearchAccess, studyId: string, participantId: string) {
  const row = (await db.query("SELECT * FROM wk_research_participants WHERE id=$1 AND study_id=$2 AND tenant_id=$3 FOR UPDATE", [participantId, studyId, access.tenantId])).rows[0];
  if (!row) researchFail("That participant is outside the exact study.", "not_found");
  const consent = (await db.query("SELECT * FROM wk_research_consents WHERE id=$1 AND participant_id=$2 AND study_id=$3 AND tenant_id=$4", [row.current_consent_id, participantId, studyId, access.tenantId])).rows[0];
  if (!consent) researchFail("The participant's current consent record is unavailable.", "needs_evidence");
  return { row: row as ResearchRow, consent: decodeResearchConsent(access, studyId, consent), consentHash: consent.content_hash as string };
}
async function actionConsent(db: PoolClient, access: ResearchAccess, command: Extract<ResearchCommand, { kind: "begin_task" | "record_outcome" }>) {
  let attempt: ResearchRow | null = null;
  if (command.kind === "record_outcome") {
    attempt = (await db.query("SELECT * FROM wk_research_attempts WHERE id=$1 AND study_id=$2 AND tenant_id=$3", [command.attemptId, command.studyId, access.tenantId])).rows[0] ?? null;
    if (!attempt) researchFail("That original task attempt is outside this study.", "not_found");
  }
  const participant = await participantRecord(db, access, command.studyId, command.kind === "begin_task" ? command.participantId : attempt!.participant_id);
  if (researchParticipantAvailability(participant.row, participant.consent) !== "current") researchFail("This participant's current private research permission is absent, expired or withdrawn.");
  const originalRow = (await db.query("SELECT * FROM wk_research_consents WHERE id=$1 AND participant_id=$2 AND study_id=$3 AND tenant_id=$4", [command.consentId, participant.row.id, command.studyId, access.tenantId])).rows[0];
  if (!originalRow || originalRow.content_hash !== command.consentHash || command.kind === "begin_task" && participant.row.current_consent_id !== command.consentId || attempt && (attempt.consent_id !== command.consentId || attempt.consent_hash !== command.consentHash)) researchFail("Review the exact consent bound to this action.", "stale_revision");
  const original = decodeResearchConsent(access, command.studyId, originalRow);
  if (!researchConsentCurrent(original.input)) researchFail("The original task permission has ended. A later grant does not renew that original scope.");
  return { participant, original, attempt };
}
async function prepareDetail(db: PoolClient, access: ResearchAccess, studyId: string, protocolId?: string): Promise<(now: number) => ResearchDetail> {
  const { study } = await researchStudy(db, access, studyId), protocols = await researchProtocols(db, access, studyId);
  const selected = protocols.find(value => value.id === (protocolId ?? study.currentProtocolId));
  if (!selected) researchFail("That protocol is outside this exact study.", "not_found");
  const projectPeople = await prepareResearchPeopleAndAttempts(db, access, study), source = await researchSource(db, access.tenantId, study.binding);
  const bound = await researchBinding(db, access.tenantId, study.binding);
  if (bound.binding.hash !== study.binding.hash) bound.issues.push("The bound profile/source interpretation differs from the retained study baseline. Earlier observations keep their original fingerprint.");
  const history = (await db.query("SELECT number,content_hash,payload->'study'->>'currentProtocolId' AS protocol_id,reason,created_at FROM wk_research_revisions WHERE study_id=$1 AND tenant_id=$2 ORDER BY number DESC", [studyId, access.tenantId])).rows.map(row => ({ version: row.number, hash: row.content_hash, protocolId: row.protocol_id, reason: row.reason, createdAt: researchIso(row.created_at) }));
  const events = (await db.query("SELECT id,kind,summary,created_at FROM wk_research_events WHERE study_id=$1 AND tenant_id=$2 ORDER BY created_at DESC,id LIMIT 200", [studyId, access.tenantId])).rows.map(row => ({ id: row.id, kind: row.kind, summary: row.summary, at: researchIso(row.created_at) }));
  return (now: number) => {
    const data = projectPeople(now);
    return { study, protocol: selected, protocols, currentSource: source, historical: selected.id !== study.currentProtocolId, subjectCurrent: bound.current && bound.binding.hash === study.binding.hash, subjectIssues: bound.issues, ...data, summary: summarizeResearch(study, selected, protocols, data.participants, data.attempts), history, events };
  };
}
export async function researchNotebookHome(access: ResearchAccess, studyId?: string, protocolId?: string): Promise<ResearchHome> {
  await initializeResearchNotebook();
  const prepared = await transaction(async db => {
    const auth = await authorizeResearch(db, access);
    const rows = (await db.query("SELECT s.*, (SELECT count(*)::integer FROM wk_research_participants p WHERE p.study_id=s.id AND p.tenant_id=s.tenant_id) AS participants,(SELECT count(*)::integer FROM wk_research_attempts a WHERE a.study_id=s.id AND a.tenant_id=s.tenant_id) AS attempts FROM wk_research_studies s WHERE s.tenant_id=$1 ORDER BY s.updated_at DESC,s.id LIMIT 40", [access.tenantId])).rows;
    const selectedId = studyId ?? rows[0]?.id, selected = selectedId ? await prepareDetail(db, access, selectedId, protocolId) : null;
    const home: Omit<ResearchHome, "selected" | "serverTime"> = { workspaceKey: hash(["research-notebook-workspace", access.tenantId, access.actorId]), expiresAt: auth.expiresAt, policy: RESEARCH_POLICY,
      subjects: await benchSubjects(db, access.tenantId), studies: rows.map(row => ({ id: row.id, title: row.title, mode: row.source_mode, phase: row.phase, version: row.version, updatedAt: researchIso(row.updated_at), participantCount: row.participants, attemptCount: row.attempts })) };
    await authorizeResearch(db, access); return { home, selected };
  });
  const now = Date.now();
  if (Date.parse(prepared.home.expiresAt) <= now) researchFail("This private research workspace has expired.");
  return { ...prepared.home, serverTime: new Date(now).toISOString(), selected: prepared.selected?.(now) ?? null };
}

async function createStudy(db: PoolClient, access: ResearchAccess, command: Extract<ResearchCommand, { kind: "create" }>) {
  if (Number((await db.query("SELECT count(*) AS count FROM wk_research_studies WHERE tenant_id=$1", [access.tenantId])).rows[0].count) >= 40) researchFail("This workspace reached its study allowance. Retain and export the existing studies.", "needs_evidence");
  const bound = await researchBinding(db, access.tenantId, command.subject, true);
  const initialProtocol = protocol(command.tasks, 1, "Task instructions and success criteria declared before observations."), id = randomUUID(), now = new Date().toISOString();
  const content: Omit<ResearchStudy, "hash"> = { id, title: command.title, objective: command.objective, mode: command.mode, phase: "open", version: 1, binding: bound.binding, currentProtocolId: initialProtocol.id, createdAt: now, updatedAt: now, sealedAt: null };
  const initial = revision(content, hash({ protocols: [{ id: initialProtocol.id, hash: initialProtocol.hash }], participants: [], attempts: [] }), null), study = initial.study;
  await db.query("INSERT INTO wk_research_studies(id,tenant_id,creator_id,title,objective,source_mode,binding,binding_hash,current_protocol_id,version,content_hash,phase,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,'open',$11,$11)", [id, access.tenantId, access.actorId, study.title, study.objective, study.mode, study.binding, study.binding.hash, study.currentProtocolId, study.hash, now]);
  await insertProtocol(db, access, id, initialProtocol); await insertRevision(db, access, initial, "Study and first task protocol declared.");
  await event(db, access, id, "study.created", command.mode === "sample" ? "A fictional Sample study was declared. It contributes no real research participants." : "An operator-recorded study was declared. No person, consent or performance has been independently verified.", { bindingHash: bound.binding.hash, protocolId: initialProtocol.id, protocolHash: initialProtocol.hash });
  return { study, extra: { protocolId: initialProtocol.id } };
}
async function reviseProtocol(db: PoolClient, access: ResearchAccess, study: ResearchStudy, command: Extract<ResearchCommand, { kind: "revise_protocol" }>) {
  const saved = await researchProtocols(db, access, study.id); if (saved.length >= 100) researchFail("This study reached its protocol allowance.", "needs_evidence");
  const next = protocol(command.tasks, Math.max(...saved.map(value => value.number)) + 1, command.reason); await insertProtocol(db, access, study.id, next);
  await event(db, access, study.id, "protocol.revised", "A new task protocol was declared. Earlier attempts retain their original instructions, criteria and results.", { protocolId: next.id, protocolHash: next.hash, previousProtocolId: study.currentProtocolId });
  return { study: await nextRevision(db, access, study, { currentProtocolId: next.id }, "New immutable task protocol declared."), extra: { protocolId: next.id } };
}
async function addParticipant(db: PoolClient, access: ResearchAccess, study: ResearchStudy, command: Extract<ResearchCommand, { kind: "add_participant" }>) {
  if (study.mode === "sample" && !command.acknowledgedSampleIsFictional) researchFail("Explicitly acknowledge that this Sample participant is fictional.", "invalid_request");
  if (study.mode === "operator_recorded" && command.acknowledgedSampleIsFictional) researchFail("A fictional participant belongs in a Sample study.", "invalid_request");
  if (Number((await db.query("SELECT count(*) AS count FROM wk_research_participants WHERE study_id=$1 AND tenant_id=$2", [study.id, access.tenantId])).rows[0].count) >= 100) researchFail("This study reached its participant allowance.", "needs_evidence");
  const id = randomUUID(), consentId = randomUUID(), createdAt = new Date().toISOString();
  const identity: StoredIdentity = { id, pseudonym: command.participant.pseudonym, experience: command.participant.experience, mode: study.mode, createdAt };
  await db.query("INSERT INTO wk_research_participants(id,study_id,tenant_id,source_mode,identity_hash,identity_sealed,experience,current_consent_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, study.id, access.tenantId, study.mode, researchPrivateHash(identity), seal(researchScope("participant", access, study.id, id), identity), identity.experience, consentId, createdAt]);
  const consent = await insertConsent(db, access, study.id, id, command.participant.consent, 1, "Initial operator-recorded consent declaration.", consentId);
  await event(db, access, study.id, "participant.recorded", study.mode === "sample" ? "A fictional Sample participant and consent declaration were saved." : "A pseudonym and operator-recorded consent declaration were saved; identity and permission are not independently verified.", { participantId: id, consentId, consentHash: consent.hash });
  return { study: await nextRevision(db, access, study, {}, "Participant and dated consent declaration recorded."), extra: { participantId: id, consentId } };
}
async function changeConsent(db: PoolClient, access: ResearchAccess, study: ResearchStudy, command: Extract<ResearchCommand, { kind: "amend_consent" | "withdraw_participant" }>) {
  const participant = await participantRecord(db, access, study.id, command.participantId);
  if (participant.row.withdrawn_at) researchFail("This participant was permanently withdrawn. Their original record cannot be reactivated.");
  if (participant.consent.id !== command.consentId || participant.consentHash !== command.consentHash) researchFail("The participant's current consent changed. Refresh before recording this action.", "stale_revision");
  if (command.kind === "withdraw_participant") {
    const at = new Date().toISOString();
    await db.query("UPDATE wk_research_participants SET withdrawn_at=$4,withdrawal_sealed=$5 WHERE id=$1 AND study_id=$2 AND tenant_id=$3", [command.participantId, study.id, access.tenantId, at, seal(researchScope("withdrawal", access, study.id, command.participantId), { at, reason: command.reason, actorId: access.actorId })]);
    await event(db, access, study.id, "participant.withdrawn", "The participant withdrew. Private free text is withheld and all their observations are excluded from current summaries; immutable fingerprints remain.", { participantId: command.participantId, consentId: participant.consent.id });
    return { study: await nextRevision(db, access, study, {}, "Participant withdrawal recorded without rewriting prior observations."), extra: { participantId: command.participantId, withdrawn: true as const } };
  }
  if (participant.consent.number >= 50) researchFail("This participant reached the consent-record allowance.", "needs_evidence");
  const next = await insertConsent(db, access, study.id, command.participantId, command.consent, participant.consent.number + 1, command.reason);
  await db.query("UPDATE wk_research_participants SET current_consent_id=$4 WHERE id=$1 AND study_id=$2 AND tenant_id=$3", [command.participantId, study.id, access.tenantId, next.value.id]);
  await event(db, access, study.id, "consent.amended", "A new dated consent declaration was recorded. It does not expand or renew the original permission bound to earlier attempts.", { participantId: command.participantId, consentId: next.value.id, consentHash: next.hash, previousConsentId: participant.consent.id });
  return { study: await nextRevision(db, access, study, {}, "New consent declaration appended; original permissions retained."), extra: { participantId: command.participantId, consentId: next.value.id } };
}

async function beginTask(db: PoolClient, access: ResearchAccess, study: ResearchStudy, command: Extract<ResearchCommand, { kind: "begin_task" }>) {
  const permission = await actionConsent(db, access, command), protocols = await researchProtocols(db, access, study.id), selected = protocols.find(value => value.id === command.protocolId);
  if (!selected || selected.id !== study.currentProtocolId || selected.hash !== command.protocolHash) researchFail("Start a task from the exact current protocol.", "stale_revision");
  const task = selected.tasks.find(value => value.id === command.taskId); if (!task) researchFail("That task is outside the selected protocol.", "not_found");
  if ((await db.query("SELECT a.id FROM wk_research_attempts a LEFT JOIN wk_research_outcomes o ON o.attempt_id=a.id WHERE a.participant_id=$1 AND a.study_id=$2 AND a.tenant_id=$3 AND o.attempt_id IS NULL LIMIT 1", [command.participantId, study.id, access.tenantId])).rowCount) researchFail("This participant has an unfinished interval. Record its permitted outcome or explicitly close it without an outcome after permission ends.", "needs_evidence");
  const earlier = (await db.query("SELECT id,number FROM wk_research_attempts WHERE participant_id=$1 AND study_id=$2 AND tenant_id=$3 AND protocol_id=$4 AND task_id=$5 ORDER BY number", [command.participantId, study.id, access.tenantId, selected.id, task.id])).rows;
  if (earlier.length && command.retryOf !== earlier[0]!.id || !earlier.length && command.retryOf !== null) researchFail("A repeat must explicitly retain the original first attempt; it cannot replace that result.", "stale_revision");
  if (Number((await db.query("SELECT count(*) AS count FROM wk_research_attempts WHERE study_id=$1 AND tenant_id=$2", [study.id, access.tenantId])).rows[0].count) >= 2000) researchFail("This study reached its attempt allowance.", "needs_evidence");
  const source = await researchSource(db, access.tenantId, study.binding); if (source.availability === "missing") researchFail("The saved source is unavailable. Preserve the study and restore an available system before a new task starts.", "needs_evidence");
  const content: Omit<StoredStart, "hash"> = { id: randomUUID(), participantId: command.participantId, mode: study.mode, protocolId: selected.id, protocolHash: selected.hash, task, consentId: permission.original.id, consentHash: command.consentHash, number: earlier.length + 1, retryOf: command.retryOf, firstAttempt: earlier.length === 0, startedAt: new Date().toISOString(), startSource: source };
  const start: StoredStart = { ...content, hash: hash(content) };
  await db.query("INSERT INTO wk_research_attempts(id,study_id,tenant_id,participant_id,protocol_id,protocol_hash,task_id,consent_id,consent_hash,number,retry_of,content_hash,payload,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [start.id, study.id, access.tenantId, start.participantId, start.protocolId, start.protocolHash, task.id, start.consentId, start.consentHash, start.number, start.retryOf, start.hash, start, start.startedAt]);
  await event(db, access, study.id, "task.started", start.firstAttempt ? "The original task interval started under exact protocol, consent and server-observed system identities." : "An explicitly linked retry started. The first outcome remains in the primary metrics.", { attemptId: start.id, taskId: task.id, protocolId: selected.id, consentId: start.consentId, source, retryOf: start.retryOf });
  return { study: await nextRevision(db, access, study, {}, start.firstAttempt ? "Original task interval started." : "Explicit retry started; first attempt retained."), extra: { attemptId: start.id } };
}
async function finishTask(db: PoolClient, access: ResearchAccess, study: ResearchStudy, command: Extract<ResearchCommand, { kind: "record_outcome" | "close_unreported_attempt" }>) {
  let start: StoredStart, authorization: Awaited<ReturnType<typeof participantRecord>>;
  const administrative = command.kind === "close_unreported_attempt";
  if (!administrative) {
    const permission = await actionConsent(db, access, command); start = permission.attempt!.payload; authorization = permission.participant;
  } else {
    const row = (await db.query("SELECT payload FROM wk_research_attempts WHERE id=$1 AND study_id=$2 AND tenant_id=$3", [command.attemptId, study.id, access.tenantId])).rows[0];
    if (!row) researchFail("That original interval is outside this study.", "not_found"); start = row.payload;
    authorization = await participantRecord(db, access, study.id, start.participantId);
    const original = (await db.query("SELECT * FROM wk_research_consents WHERE id=$1 AND participant_id=$2 AND study_id=$3 AND tenant_id=$4", [start.consentId, start.participantId, study.id, access.tenantId])).rows[0];
    if (!original || original.content_hash !== start.consentHash) researchFail("This original consent binding is inconsistent.", "needs_evidence");
    if (researchParticipantAvailability(authorization.row, authorization.consent) === "current" && researchConsentCurrent(decodeResearchConsent(access, study.id, original).input)) researchFail("Permission is still current. Record an explicit permitted outcome, including unknown or abandoned, instead of an administrative closure.", "needs_evidence");
  }
  const { hash: startHash, ...content } = start; if (hash(content) !== startHash) researchFail("This original interval fingerprint is inconsistent.", "needs_evidence");
  if ((await db.query("SELECT attempt_id FROM wk_research_outcomes WHERE attempt_id=$1 AND study_id=$2 AND tenant_id=$3", [start.id, study.id, access.tenantId])).rowCount) researchFail("This attempt already has an immutable outcome. Begin an explicit retry to record another attempt.", "stale_revision");
  const source = await researchSource(db, access.tenantId, study.binding);
  if (!administrative && source.availability === "missing" && !["abandoned", "unknown"].includes(command.result.outcome)) researchFail("The source became unavailable. Record unknown or abandoned, retaining the missing-source condition.", "needs_evidence");
  const finishedAt = new Date().toISOString(), elapsed = Date.parse(finishedAt) - Date.parse(start.startedAt);
  if (elapsed < 0) researchFail("The server clock precedes the recorded start. Retain this interval and resolve the clock discrepancy.", "needs_evidence");
  const result = administrative ? { outcome: "unknown" as const, assistance: "not_recorded" as const, comprehension: "not_assessed" as const, observedNote: "No participant performance outcome recorded. The application interval was closed administratively after permission ended.", response: "" } : command.result;
  const outcome: StoredOutcome = { attemptId: start.id, finishedAt, recordedIntervalMs: elapsed, result, source, authorizationConsentId: authorization.consent.id, authorizationConsentHash: authorization.consentHash, completionKind: administrative ? "administrative_no_outcome" : "operator_observation" };
  await db.query("INSERT INTO wk_research_outcomes(attempt_id,study_id,tenant_id,content_hash,payload_sealed,finished_at) VALUES($1,$2,$3,$4,$5,$6)", [start.id, study.id, access.tenantId, researchPrivateHash(outcome), seal(researchScope("outcome", access, study.id, start.id), outcome), finishedAt]);
  await event(db, access, study.id, administrative ? "task.closed_without_outcome" : "task.outcome_recorded", administrative ? "An interval with ended permission was closed administratively. No task outcome or new participant note was recorded; it is excluded from scored summaries." : "An immutable operator-reported outcome was appended under the original protocol and consent. It is not independently measured performance.", { attemptId: start.id, originalConsentId: start.consentId, authorizationConsentId: authorization.consent.id, completionKind: outcome.completionKind, source });
  return { study: await nextRevision(db, access, study, {}, administrative ? "Permission-ended interval closed without a task outcome." : "Operator-reported task outcome recorded."), extra: { attemptId: start.id } };
}
async function sealStudy(db: PoolClient, access: ResearchAccess, study: ResearchStudy, command: Extract<ResearchCommand, { kind: "seal" }>) {
  if ((await db.query("SELECT a.id FROM wk_research_attempts a LEFT JOIN wk_research_outcomes o ON o.attempt_id=a.id WHERE a.study_id=$1 AND a.tenant_id=$2 AND o.attempt_id IS NULL LIMIT 1", [study.id, access.tenantId])).rowCount) researchFail("Finish each permitted interval, or explicitly close an interval with ended permission without an outcome, before sealing.", "needs_evidence");
  const next = await nextRevision(db, access, study, { phase: "sealed", sealedAt: new Date().toISOString() }, command.reason);
  await event(db, access, study.id, "study.sealed", "The exact study was sealed. No further protocol or task observations can be added; participant withdrawal remains available.", { studyHash: next.hash, version: next.version });
  return { study: next, extra: { sealed: true as const } };
}
export async function researchNotebookCommand(access: ResearchAccess, value: unknown): Promise<ResearchCommandResult> {
  const command = ResearchCommandSchema.parse(value); await initializeResearchNotebook();
  return transaction(async db => {
    await authorizeResearch(db, access);
    const current = "studyId" in command ? (await researchStudy(db, access, command.studyId, true)).study : null;
    if (command.kind === "begin_task" || command.kind === "record_outcome") await actionConsent(db, access, command);
    const inputHash = researchPrivateHash(command), scope = `research-command:${access.tenantId}:${access.actorId}:${command.requestId}`;
    const prior = (await db.query("SELECT input_hash,response_sealed FROM wk_research_commands WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3", [access.tenantId, access.actorId, command.requestId])).rows[0];
    if (prior) {
      if (prior.input_hash !== inputHash) researchFail("This operation identity already belongs to different research details.", "stale_revision");
      const result = unseal<ResearchCommandResult>(scope, prior.response_sealed); await authorizeResearch(db, access);
      if (command.kind === "begin_task" || command.kind === "record_outcome") await actionConsent(db, access, command);
      return result;
    }
    if (Number((await db.query("SELECT count(*) AS count FROM wk_research_commands WHERE tenant_id=$1", [access.tenantId])).rows[0].count) >= 10_000) researchFail("This workspace reached its research-command allowance. Preserve and export existing evidence.", "needs_evidence");
    let saved: { study: ResearchStudy; extra: Partial<ResearchCommandResult> };
    if (command.kind === "create") saved = await createStudy(db, access, command);
    else {
      currentVersion(current!, command);
      if (current!.phase === "sealed" && command.kind !== "withdraw_participant") researchFail("This study is sealed. Its task and protocol history cannot be changed; participant withdrawal remains available.", "stale_revision");
      switch (command.kind) {
        case "revise_protocol": saved = await reviseProtocol(db, access, current!, command); break;
        case "add_participant": saved = await addParticipant(db, access, current!, command); break;
        case "amend_consent": case "withdraw_participant": saved = await changeConsent(db, access, current!, command); break;
        case "begin_task": saved = await beginTask(db, access, current!, command); break;
        case "record_outcome": case "close_unreported_attempt": saved = await finishTask(db, access, current!, command); break;
        case "seal": saved = await sealStudy(db, access, current!, command); break;
      }
    }
    const result: ResearchCommandResult = { studyId: saved.study.id, version: saved.study.version, hash: saved.study.hash, ...saved.extra };
    await db.query("INSERT INTO wk_research_commands(tenant_id,actor_id,request_id,kind,input_hash,response_sealed) VALUES($1,$2,$3,$4,$5,$6)", [access.tenantId, access.actorId, command.requestId, command.kind, inputHash, seal(scope, result)]);
    await authorizeResearch(db, access);
    if (command.kind === "begin_task" || command.kind === "record_outcome") await actionConsent(db, access, command);
    return result;
  });
}
