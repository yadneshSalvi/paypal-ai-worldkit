import { z } from "zod";

export const BENCH_SCHEMA = "worldkit.physical-notebook.1" as const;
export const BENCH_MAX_BYTES = 512 * 1024 * 1024;
export const BENCH_MAX_FILES = 32;
export const BENCH_POLICY = "Original bytes, operator observations and independent review remain separate evidence. A file hash proves byte identity, not physical execution. Existing modeled certificates are never rewritten.";
const Id = z.string().min(1).max(200);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().trim().max(4000);
const Timestamp = z.iso.datetime({ offset: true });

export const BenchSubjectSchema = z.object({ kind: z.enum(["creator", "domain"]), subjectId: Id, revisionId: Id, graphHash: Hash }).strict();
export type BenchSubject = z.infer<typeof BenchSubjectSchema>;
export type BenchStep = { id: string; title: string; instruction: string; required: boolean; evidenceKinds: BenchFileKind[] };
export type BenchBinding = BenchSubject & {
  title: string; hash: string; certificateHash: string; ruleVersion: string;
  components: { id: string; profileId: string; model: string; profileHash: string }[];
  connections: { id: string; from: string; to: string; signal: string; protocol: string; cable: string; enabled: boolean }[];
  configuration: { componentId: string; settings: Record<string, string | number | boolean> }[];
  sources: { id: string; hash: string; title: string; url: string | null }[];
  requirements: { id: string; label: string; modeledStatus: string }[];
  steps: BenchStep[]; graphSource: "modelled" | "sample" | "mixed";
};
export const BenchHardwareSchema = z.object({
  componentId: Id, model: z.string().trim().min(1).max(160), revision: z.string().trim().min(1).max(120),
  firmware: z.string().trim().min(1).max(160), matchesBoundModel: z.boolean(), serialRecordId: Id.nullable(),
}).strict();
export const BenchConditionsSchema = z.object({
  hardware: z.array(BenchHardwareSchema).min(1).max(40),
  hostOs: z.string().trim().min(1).max(160), appAndVersion: z.string().trim().min(1).max(240),
  recordingSettings: z.string().trim().min(1).max(2000), streamSettings: z.string().trim().min(1).max(1600),
  storage: z.string().trim().min(1).max(800), power: z.string().trim().min(1).max(1000),
  hubsAndCables: z.string().trim().min(1).max(2000), monitoring: z.string().trim().min(1).max(1000),
  declaredSeconds: z.number().int().min(1).max(86_400), operator: z.string().trim().min(2).max(100),
  locationLabel: z.string().trim().max(160), notes: Text,
}).strict();
export type BenchConditions = z.infer<typeof BenchConditionsSchema>;
export const BenchFileKindSchema = z.enum(["isolated_track", "stream_mix", "camera_recording", "connection_photo", "screen_recording", "rights_record", "supporting_file"]);
export type BenchFileKind = z.infer<typeof BenchFileKindSchema>;
export const BenchRightsSchema = z.object({
  basis: z.enum(["original_creator", "written_permission", "sample_generated"]),
  holder: z.string().trim().min(2).max(200), permissionReference: z.string().trim().min(3).max(1000),
  grantedAt: Timestamp, expiresAt: Timestamp.nullable(), attribution: z.string().trim().max(500),
  privateReviewAllowed: z.literal(true), publicSharingAllowed: z.boolean(),
  identifiablePeople: z.boolean(), participantConsentConfirmed: z.boolean(), restrictions: Text,
}).strict().superRefine((value, ctx) => {
  if (value.identifiablePeople && !value.participantConsentConfirmed) ctx.addIssue({ code: "custom", path: ["participantConsentConfirmed"], message: "Confirm permission for private review before uploading identifiable participants." });
  if (value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.grantedAt)) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "The permission must expire after it was granted." });
});
export type BenchRights = z.infer<typeof BenchRightsSchema>;
export const BenchFileInputSchema = z.object({
  filename: z.string().trim().min(1).max(180).refine(value => !/[\x00-\x1f/\\]/.test(value), "Use a plain filename."),
  bytes: z.number().int().positive().max(BENCH_MAX_BYTES),
  mediaType: z.enum(["audio/wav", "audio/mpeg", "video/mp4", "video/webm", "image/png", "image/jpeg", "application/pdf"]),
  kind: BenchFileKindSchema, provenance: z.enum(["operator_original", "third_party", "model_export", "sample_generated"]),
  expectedSha256: Hash.nullable(), rights: BenchRightsSchema,
}).strict();
export type BenchFileInput = z.infer<typeof BenchFileInputSchema>;
export type BenchAudioInspection = {
  format: "pcm" | "float"; channels: number; sampleRate: number; bitsPerSample: number; frames: number; durationSeconds: number;
  channelPeaks: number[]; channelRms: number[]; envelope: number[][]; clippingSamples: number[];
  scope: "Byte-derived waveform and channel statistics; neither physical origin nor microphone independence is inferred.";
};
export type BenchAsset = BenchFileInput & {
  id: string; runId: string; uploadId: string; sha256: string; verifiedAt: string; observedMediaType: string;
  bytes: number; originalBytesRetained: boolean; availability: "available" | "withdrawn" | "purged"; detectedModelExport: boolean;
  audio: BenchAudioInspection | null; inspectionNotes: string[];
};
export type BenchUpload = {
  id: string; runId: string; file: BenchFileInput; createdAt: string; expiresAt: string;
  phase: "awaiting_upload" | "uploaded" | "queued" | "verifying" | "verified" | "rejected";
  assetId: string | null; failure: string | null; transport: "private_blob" | "controlled_local";
  pathname: string; attempts: number;
  withdrawnAt?: string | null; purgedAt?: string | null;
};
export const BenchObservationInputSchema = z.object({
  stepId: Id, outcome: z.enum(["observed_pass", "observed_failure", "uncertain", "not_performed"]),
  detail: z.string().trim().min(3).max(4000), observedAt: Timestamp,
}).strict();
export type BenchObservation = z.infer<typeof BenchObservationInputSchema> & { id: string; recordedAt: string; actorId: string };
export type BenchAttachment = { id: string; assetId: string; assetHash: string; stepId: string; note: string; attachedAt: string };
export type BenchPhase = "planning" | "running" | "recorded" | "sealed";
export type BenchEdition = {
  schema: typeof BENCH_SCHEMA; id: string; runId: string; number: number; parentId: string | null; hash: string;
  title: string; sourceMode: "sample" | "operator_recorded"; phase: BenchPhase; binding: BenchBinding;
  conditions: BenchConditions; observations: BenchObservation[]; attachments: BenchAttachment[];
  declaredAt: string | null; startedAt: string | null; finishedAt: string | null; sealedAt: string | null;
  createdAt: string; reason: string;
};
export type BenchGrant = {
  id: string; runId: string; editionId: string; editionHash: string; actorId: string; name: string;
  provenance: "human" | "sample"; role: "reviewer"; version: number; expiresAt: string;
  status: "invited" | "active" | "revoked"; qualification: "unestablished" | "current" | "expired" | "sample";
};
export const BenchDecisionInputSchema = z.object({
  outcome: z.enum(["supports_reported_scope", "contradiction", "needs_evidence"]),
  finding: z.string().trim().min(20).max(5000), limitations: z.string().trim().min(10).max(3000),
  inspectedAssetIds: z.array(Id).min(1).max(BENCH_MAX_FILES),
  inspectedOriginals: z.literal(true), reviewedExactConditions: z.literal(true),
}).strict();
export type BenchDecision = z.infer<typeof BenchDecisionInputSchema> & {
  id: string; editionId: string; editionHash: string; actorId: string; actorName: string;
  principalHash: string | null; qualificationId: string | null; grantId: string; grantVersion: number;
  provenance: "human" | "sample"; createdAt: string; currentlyQualified: boolean; currentAuthority: boolean;
};
export type BenchAssessment = {
  status: "planning" | "recording" | "evidence_incomplete" | "reported_failure" | "reported_unreviewed" | "review_needs_evidence" | "review_contradicted" | "reviewed_exact_conditions" | "sample_only";
  label: string; detail: string; physicalExecution: "not_performed" | "operator_reported" | "independently_reviewed_report";
  actualQualifiedReviews: number; sampleReviews: number; reportedFailures: number; missing: string[];
  elapsedSeconds: number | null; declaredSeconds: number; existingCertificateChanged: false;
};
export type BenchAccess = { tenantId: string; actorId: string; kind: "owner" | "reviewer"; grantId: string | null };
export type BenchDetail = {
  runId: string; currentEditionId: string; currentVersion: number; currentEditionHash: string;
  edition: BenchEdition; historical: boolean; subjectCurrent: boolean; subjectIssues: string[];
  history: { id: string; number: number; hash: string; phase: BenchPhase; reason: string; createdAt: string }[];
  assets: BenchAsset[]; uploads: BenchUpload[]; grants: BenchGrant[]; decisions: BenchDecision[]; assessment: BenchAssessment;
  serials: { id: string; componentId: string; hash: string }[];
  role: "owner" | "reviewer"; reviewer: null | { name: string; provenance: "human" | "sample"; qualified: boolean; expiresAt: string };
  events: { id: string; kind: string; at: string; summary: string }[];
};
export type BenchHome = {
  workspaceKey: string; expiresAt: string; policy: typeof BENCH_POLICY; storage: "private_blob" | "controlled_local" | "unavailable";
  subjects: { subject: BenchSubject; title: string; componentCount: number; kindLabel: string }[];
  reviewers: { id: string; name: string; provenance: "human" | "sample"; qualification: "unestablished" | "current" | "expired" | "sample" }[];
  runs: { id: string; title: string; sourceMode: "sample" | "operator_recorded"; phase: BenchPhase; version: number; updatedAt: string }[];
  selected: BenchDetail | null;
};
const Identity = { requestId: z.uuid() };
const Current = { runId: Id, expectedEditionId: Id, expectedVersion: z.number().int().positive(), expectedEditionHash: Hash };
export const BenchCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), ...Identity, subject: BenchSubjectSchema, title: z.string().trim().min(2).max(120), sourceMode: z.enum(["sample", "operator_recorded"]), acknowledgedEvidenceScope: z.literal(true) }).strict(),
  z.object({ kind: z.literal("plan"), ...Identity, ...Current, conditions: BenchConditionsSchema, reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ kind: z.literal("private_serial"), ...Identity, ...Current, componentId: Id, serial: z.string().trim().min(2).max(160) }).strict(),
  z.object({ kind: z.literal("start"), ...Identity, ...Current, confirmedExactEquipment: z.literal(true), acknowledgedOperatorReport: z.literal(true) }).strict(),
  z.object({ kind: z.literal("observe"), ...Identity, ...Current, observation: BenchObservationInputSchema }).strict(),
  z.object({ kind: z.literal("finish"), ...Identity, ...Current, note: z.string().trim().min(3).max(2000) }).strict(),
  z.object({ kind: z.literal("upload_intent"), ...Identity, ...Current, file: BenchFileInputSchema }).strict(),
  z.object({ kind: z.literal("verify_upload"), ...Identity, runId: Id, uploadId: Id }).strict(),
  z.object({ kind: z.literal("withdraw_upload"), ...Identity, runId: Id, uploadId: Id, reason: z.string().trim().min(8).max(1000), acknowledgedRetainedManifestHash: z.literal(true) }).strict(),
  z.object({ kind: z.literal("attach"), ...Identity, ...Current, assetId: Id, stepId: Id, note: z.string().trim().min(3).max(1000) }).strict(),
  z.object({ kind: z.literal("withdraw_asset"), ...Identity, runId: Id, assetId: Id, reason: z.string().trim().min(8).max(1000), acknowledgedRetainedManifestHash: z.literal(true) }).strict(),
  z.object({ kind: z.literal("sample_originals"), ...Identity, ...Current, acknowledgedGeneratedSample: z.literal(true) }).strict(),
  z.object({ kind: z.literal("seal"), ...Identity, ...Current, acknowledgedManifestIsReportedEvidence: z.literal(true) }).strict(),
  z.object({ kind: z.literal("invite_reviewer"), ...Identity, ...Current, actorId: Id.nullable(), name: z.string().trim().min(2).max(100), provenance: z.enum(["human", "sample"]), hours: z.number().int().min(1).max(72), acknowledgedPrivateReviewOnly: z.literal(true) }).strict(),
  z.object({ kind: z.literal("revoke_reviewer"), ...Identity, runId: Id, grantId: Id }).strict(),
  z.object({ kind: z.literal("review"), ...Identity, ...Current, decision: BenchDecisionInputSchema }).strict(),
]);
export type BenchCommand = z.infer<typeof BenchCommandSchema>;
export type BenchCommandResult = {
  runId: string; editionId?: string; upload?: BenchUpload; verifyUploadId?: string; sampleAssetIds?: string[];
  grant?: BenchGrant & { invitation?: string }; revoked?: true; withdrawn?: true; decisionId?: string; sampleUploadIds?: string[];
};
export const BenchRedeemSchema = z.object({ requestId: z.uuid(), invitation: z.string().regex(/^wkbi_[A-Za-z0-9_-]{43}$/) }).strict();
