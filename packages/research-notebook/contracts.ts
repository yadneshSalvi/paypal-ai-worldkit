import { z } from "zod";

export const RESEARCH_SCHEMA = "worldkit.research-notebook.1" as const;
export const RESEARCH_POLICY = "Private task records are operator-reported observations, not independently verified identity, consent, expertise or human performance. Sample participants are fictional and contribute zero real participants. Physical evidence and the consented 5–8 novice/audio-engineer research gate remain separate.";
export const RESEARCH_MAX_TASKS = 20;
const Id = z.string().min(1).max(200);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime({ offset: true });
const ShortText = z.string().trim().min(2).max(120);

export const ResearchSubjectSchema = z.object({ kind: z.enum(["creator", "domain"]), subjectId: Id, revisionId: Id, graphHash: Hash }).strict();
export type ResearchSubject = z.infer<typeof ResearchSubjectSchema>;
export type ResearchMode = "sample" | "operator_recorded";
export type ResearchBinding = ResearchSubject & {
  title: string; hash: string; certificateHash: string; ruleVersion: string;
  graphSource: "modelled" | "sample" | "mixed";
  components: { id: string; profileId: string; model: string; profileHash: string }[];
  connections: { id: string; from: string; to: string; signal: string; protocol: string; cable: string; enabled: boolean }[];
  configuration: { componentId: string; settings: Record<string, string | number | boolean> }[];
  sources: { id: string; hash: string; title: string; url: string | null }[];
  requirements: { id: string; label: string; modeledStatus: string }[];
};
/** Server-observed source identity, never accepted as a client assertion. */
export type ResearchSourceObservation = {
  kind: "creator" | "domain"; subjectId: string;
  revisionId: string | null; graphHash: string | null; observedAt: string;
  availability: "available" | "missing"; matchesStudyBinding: boolean;
};

export const ResearchTaskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  title: ShortText,
  instruction: z.string().trim().min(8).max(2000),
  successCriteria: z.string().trim().min(8).max(2000),
}).strict();
export type ResearchTask = z.infer<typeof ResearchTaskSchema>;
export const ResearchTasksSchema = z.array(ResearchTaskSchema).min(1).max(RESEARCH_MAX_TASKS).superRefine((tasks, ctx) => {
  const seen = new Set<string>();
  tasks.forEach((task, index) => {
    if (seen.has(task.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "Task identities must be unique within this protocol." });
    seen.add(task.id);
  });
});
export const RESEARCH_STARTER_TASKS: readonly ResearchTask[] = Object.freeze([
  { id: "understand_goal", title: "Understand the goal", instruction: "Inspect the saved system. Explain whose goal it serves and what the system must do.", successCriteria: "The participant describes the intended goal and at least one hard requirement in their own words." },
  { id: "find_blocker", title: "Find a blocking requirement", instruction: "Locate a requirement that is failed or unknown. If none exists, identify a requirement and its supporting witness.", successCriteria: "The participant locates the exact requirement and correctly distinguishes failed, unknown and supported status." },
  { id: "explain_source", title: "Explain a source or unknown", instruction: "Open a source or witness. Explain what it supports and what still needs evidence.", successCriteria: "The participant identifies the source scope and one supported fact or unresolved condition without inventing proof." },
  { id: "propose_repair", title: "Propose an allowed repair", instruction: "Describe a repair or next evidence step that preserves the goal and stays inside the authority shown.", successCriteria: "The participant proposes a relevant change or evidence request and identifies any approval or re-verification needed." },
  { id: "distinguish_evidence", title: "Distinguish model from reality", instruction: "Explain which results are Modelled or Sample and which would require actual equipment, people or a merchant receipt.", successCriteria: "The participant distinguishes a modeled/Sample result from physical execution, genuine human review and merchant delivery." },
].map(task => Object.freeze(task)));

export const ResearchConsentInputSchema = z.object({
  consentVersion: z.string().trim().min(1).max(120),
  privateResearch: z.boolean(),
  anonymousPublicAggregate: z.boolean(),
  consentReference: z.string().trim().min(2).max(500),
  grantedAt: Timestamp,
  expiresAt: Timestamp.nullable(),
}).strict().superRefine((consent, ctx) => {
  if (consent.expiresAt && Date.parse(consent.expiresAt) <= Date.parse(consent.grantedAt)) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Consent expiry must follow the recorded grant time." });
  if (consent.anonymousPublicAggregate && !consent.privateResearch) ctx.addIssue({ code: "custom", path: ["anonymousPublicAggregate"], message: "Public aggregate permission does not replace private research permission." });
});
export type ResearchConsentInput = z.infer<typeof ResearchConsentInputSchema>;
export type ResearchConsent = Omit<ResearchConsentInput, "consentReference"> & {
  id: string; hash: string; number: number; recordedAt: string;
  consentReference: string | null;
  status: "current" | "superseded" | "expired" | "withdrawn" | "permission_missing";
};
export const ResearchParticipantInputSchema = z.object({
  pseudonym: z.string().trim().min(2).max(80),
  experience: z.enum(["novice", "experienced", "not_recorded"]),
  consent: ResearchConsentInputSchema,
}).strict();
export type ResearchParticipantInput = z.infer<typeof ResearchParticipantInputSchema>;
export type ResearchParticipant = {
  id: string; hash: string; mode: ResearchMode; pseudonym: string | null;
  experience: "novice" | "experienced" | "not_recorded";
  createdAt: string; withdrawnAt: string | null;
  availability: "current" | "withdrawn" | "consent_expired" | "permission_missing";
  currentConsent: ResearchConsent | null; consents: ResearchConsent[];
  eligibleForPrivateSummary: boolean; eligibleForPublicSummary: boolean;
  runningAttemptId: string | null;
};

export const ResearchOutcomeInputSchema = z.object({
  outcome: z.enum(["success", "partial", "failure", "abandoned", "unknown"]),
  assistance: z.enum(["none", "prompted", "guided", "not_recorded"]),
  comprehension: z.enum(["correct", "incorrect", "uncertain", "not_assessed"]),
  observedNote: z.string().trim().min(3).max(2000),
  response: z.string().trim().max(2000),
}).strict();
export type ResearchOutcomeInput = z.infer<typeof ResearchOutcomeInputSchema>;
export type ResearchAttempt = {
  id: string; hash: string; participantId: string; mode: ResearchMode;
  protocolId: string; protocolHash: string; task: ResearchTask;
  consentId: string; consentHash: string;
  number: number; retryOf: string | null; firstAttempt: boolean;
  startedAt: string; finishedAt: string | null; recordedIntervalMs: number | null;
  startSource: ResearchSourceObservation; outcomeSource: ResearchSourceObservation | null;
  state: "running" | "finished";
  completionKind: null | "operator_observation" | "administrative_no_outcome";
  result: null | Omit<ResearchOutcomeInput, "observedNote" | "response"> & { observedNote: string | null; response: string | null };
  visibility: "available" | "withdrawn" | "consent_expired" | "permission_missing";
  eligibleForPrivateSummary: boolean; eligibleForPublicSummary: boolean; exclusionReason: string | null;
};
export type ResearchProtocol = {
  id: string; number: number; hash: string; tasks: ResearchTask[]; reason: string; createdAt: string;
};
export type ResearchCounts = {
  success: number; partial: number; failure: number; abandoned: number;
  unknown: number; pending: number; excluded: number;
  /** Current eligible first attempts only: success + partial + failure + abandoned. */
  denominator: number;
  unaidedSuccess: number;
  assistance: { none: number; prompted: number; guided: number; notRecorded: number };
  comprehension: { correct: number; incorrect: number; uncertain: number; notAssessed: number };
};
export type ResearchCohort = {
  protocolId: string; protocolHash: string; protocolNumber: number; taskId: string; taskTitle: string;
  mode: ResearchMode; eligibleParticipants: number; counts: ResearchCounts;
  variedSystemAttempts: number; missingSourceAttempts: number;
};
export type ResearchSummary = {
  protocolId: string; protocolHash: string;
  basis: "first_attempt_per_participant_task_protocol";
  operatorReportedParticipants: number; sampleParticipants: number; independentlyVerifiedParticipants: 0;
  eligibleParticipants: number; publicAggregateEligibleParticipants: number; excludedParticipants: number;
  variedSystemAttempts: number; missingSourceAttempts: number;
  counts: ResearchCounts;
  allAttempts: { total: number; first: number; retries: number; running: number; unknown: number; excluded: number };
  /** Each exact protocol/task cohort remains distinct; the UI must never pool versions. */
  cohorts: ResearchCohort[];
  limitations: string[];
};
export type ResearchStudy = {
  id: string; title: string; objective: string; mode: ResearchMode; phase: "open" | "sealed";
  version: number; hash: string; binding: ResearchBinding; currentProtocolId: string;
  createdAt: string; updatedAt: string; sealedAt: string | null;
};
export type ResearchDetail = {
  study: ResearchStudy; protocol: ResearchProtocol; protocols: ResearchProtocol[];
  currentSource: ResearchSourceObservation;
  historical: boolean; subjectCurrent: boolean; subjectIssues: string[];
  participants: ResearchParticipant[]; attempts: ResearchAttempt[]; summary: ResearchSummary;
  history: { version: number; hash: string; protocolId: string; reason: string; createdAt: string }[];
  events: { id: string; kind: string; at: string; summary: string }[];
};
export type ResearchHome = {
  workspaceKey: string; expiresAt: string; serverTime: string; policy: typeof RESEARCH_POLICY;
  subjects: { subject: ResearchSubject; title: string; componentCount: number; kindLabel: string }[];
  studies: { id: string; title: string; mode: ResearchMode; phase: "open" | "sealed"; version: number; updatedAt: string; participantCount: number; attemptCount: number }[];
  selected: ResearchDetail | null;
};

const Identity = { requestId: z.uuid() };
const Current = { studyId: Id, expectedVersion: z.number().int().positive(), expectedStudyHash: Hash };
const ConsentIdentity = { participantId: Id, consentId: Id, consentHash: Hash };
export const ResearchCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), ...Identity, subject: ResearchSubjectSchema, title: ShortText, objective: z.string().trim().min(8).max(2000), mode: z.enum(["sample", "operator_recorded"]), tasks: ResearchTasksSchema, acknowledgedOperatorScope: z.literal(true) }).strict(),
  z.object({ kind: z.literal("revise_protocol"), ...Identity, ...Current, tasks: ResearchTasksSchema, reason: z.string().trim().min(8).max(1000) }).strict(),
  z.object({ kind: z.literal("add_participant"), ...Identity, ...Current, participant: ResearchParticipantInputSchema, acknowledgedConsentRecord: z.literal(true), acknowledgedSampleIsFictional: z.boolean() }).strict(),
  z.object({ kind: z.literal("amend_consent"), ...Identity, ...Current, ...ConsentIdentity, consent: ResearchConsentInputSchema, reason: z.string().trim().min(8).max(1000), acknowledgedConsentRecord: z.literal(true) }).strict(),
  z.object({ kind: z.literal("withdraw_participant"), ...Identity, ...Current, ...ConsentIdentity, reason: z.string().trim().min(8).max(1000), acknowledgedRetainedFingerprints: z.literal(true) }).strict(),
  z.object({ kind: z.literal("begin_task"), ...Identity, ...Current, ...ConsentIdentity, protocolId: Id, protocolHash: Hash, taskId: Id, retryOf: Id.nullable(), acknowledgedOperatorObservation: z.literal(true) }).strict(),
  z.object({ kind: z.literal("record_outcome"), ...Identity, ...Current, attemptId: Id, consentId: Id, consentHash: Hash, result: ResearchOutcomeInputSchema, acknowledgedOperatorObservation: z.literal(true) }).strict(),
  z.object({ kind: z.literal("close_unreported_attempt"), ...Identity, ...Current, attemptId: Id, acknowledgedNoTaskOutcome: z.literal(true) }).strict(),
  z.object({ kind: z.literal("seal"), ...Identity, ...Current, reason: z.string().trim().min(8).max(1000), acknowledgedReportedEvidence: z.literal(true) }).strict(),
]);
export type ResearchCommand = z.infer<typeof ResearchCommandSchema>;
export type ResearchCommandResult = {
  studyId: string; version: number; hash: string;
  protocolId?: string; participantId?: string; consentId?: string; attemptId?: string; sealed?: true; withdrawn?: true;
};
export type ResearchErrorResponse = { error: { code: string; message: string; nextAction?: string } };
