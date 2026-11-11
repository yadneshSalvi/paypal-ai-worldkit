import { z } from "zod";
import type { DeviceProfile } from "../contracts";

export const REVIEW_POLICY = "worldkit.engineering-review.1" as const;
export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().min(1).max(180);
const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/);
export const RoleSchema = z.enum(["reader", "editor", "reviewer", "adjudicator"]);
export type ReviewRole = z.infer<typeof RoleSchema>;
export const ExactScopeSchema = z.object({
  manufacturer: z.string().min(1).max(100), model: z.string().min(1).max(150), variant: z.string().min(1).max(250),
  firmware: z.string().min(1).max(150), os: z.string().min(1).max(150), application: z.string().min(1).max(150),
  conditions: z.array(z.string().min(1).max(250)).max(20),
}).strict();
export const AnchorSchema = z.object({
  contentHash: Digest, textHash: Digest, page: z.number().int().positive().max(400),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), excerptHash: Digest,
}).strict();
export type SourceAnchor = z.infer<typeof AnchorSchema>;
export const ClaimSchema = z.object({
  id: Key, predicate: Key, target: Key, value: z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]),
  unit: z.string().max(30).nullable(), conditions: z.array(z.string().min(1).max(250)).max(20),
  category: z.enum(["fact", "simultaneous", "port", "resource", "identity"]), critical: z.boolean(),
  originalAssertionId: Key.nullable(), evidence: z.array(AnchorSchema).max(8), rationale: z.string().max(1500),
}).strict();
export type EngineeringClaim = z.infer<typeof ClaimSchema>;
export const PortProposalSchema = z.object({
  id: Key, label: z.string().min(1).max(100),
  fields: z.object({ connector: Key.nullable(), direction: Key.nullable(), signal: Key.nullable(), protocols: Key.nullable(),
    channels: Key.nullable(), power: Key.nullable(), resource: Key.nullable() }).strict(),
  anchor: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("rail"), reason: z.string().min(4).max(300) }).strict(),
    z.object({ kind: z.literal("image"), assetId: z.uuid(), imageHash: Digest, cropHash: Digest,
      x: z.number().min(0).max(1), y: z.number().min(0).max(1), facing: z.enum(["front", "back", "left", "right", "top", "bottom"]),
      labelSide: z.enum(["left", "right", "above", "below"]) }).strict(),
  ]),
}).strict();
export type PortProposal = z.infer<typeof PortProposalSchema>;
export const ProposalContentSchema = z.object({
  scope: ExactScopeSchema, claims: z.array(ClaimSchema).min(1).max(100), ports: z.array(PortProposalSchema).max(48),
  portMapDeclaredComplete: z.boolean(), notes: z.string().max(2500),
}).strict();
export type ProposalContent = z.infer<typeof ProposalContentSchema>;
export type ReviewBinding = {
  kitId: string; revisionId: string; graphHash: string; profileId: string; candidateId: string; candidateHash: string;
  documentId: string; sourceHash: string; textHash: string; sourceHeadVersion: number; profileHeadId: string | null;
  assetId: string | null; assetHash: string | null; cropHash: string | null; draftId: string; draftHash: string;
};
export type ReviewEdition = {
  id: string; proposalId: string; version: number; hash: string; policy: typeof REVIEW_POLICY; provenance: "human" | "sample";
  authorId: string; authors: string[]; authorIdentities: { actorId: string; identityHash: string | null; qualificationId: string | null }[]; createdAt: string; predecessorId: string | null; correctionReason: string;
  binding: ReviewBinding; content: ProposalContent; requiredAssertions: string[]; disputedPredicates: string[];
};
export type Qualification = {
  id: string; actorId: string; identityHash: string; evidenceHash: string; expertise: ("identity" | "engineering" | "simultaneous" | "geometry")[];
  method: string; issuer: string; expiresAt: string; provenance: "human" | "sample";
};
export type ReviewActor = { id: string; name: string; kind: "owner" | "specialist"; provenance: "human" | "sample"; version: number; revoked: boolean; qualification: Qualification | null };
export type ReviewCapability = { id: string; actorId: string; role: ReviewRole; kitId: string; profileId: string; documentId: string; expiresAt: string; version: number; status: "invited" | "active" | "revoked" };
export type ReviewAccess = { tenantId: string; actorId: string; kind: "owner" | "specialist"; capabilityId: string | null };
export type ReviewDecision = {
  id: string; editionId: string; editionHash: string; targetId: string; actorId: string; actorName: string; principalHash: string;
  capabilityId: string; capabilityVersion: number; qualification: Qualification; outcome: "accept" | "reject" | "unresolved";
  kind: "review" | "adjudication"; reason: string; decisionSetHash: string | null; createdAt: string; active: boolean;
};
export type TargetAssessment = { id: string; label: string; required: number; accepted: number; status: "accepted" | "pending" | "conflicted" | "rejected" | "unresolved"; blocking: boolean; reason: string; decisionSetHash: string; activeReviewers: string[] };
export type ReviewAssessment = { eligible: boolean; state: "ready" | "incomplete" | "conflicted" | "stale"; targets: TargetAssessment[]; blockers: string[]; actualReviewed: number; sampleReviewed: number; physicalTests: 0 };
export type ReviewAsset = { id: string; profileId: string; photoId: string | null; imageHash: string; cropHash: string; crop: { x: number; y: number; width: number; height: number }; width: number; height: number; provenance: "human" | "sample"; description: string; current: boolean; available: boolean };
export type ReviewCandidate = { id: string; profileId: string; model: string; variant: string; documentId: string; sourceHash: string; textHash: string; draftId: string; current: boolean };
export type Promotion = { id: string; editionId: string; profile: DeviceProfile; sourceHash: string; provenance: "human" | "sample"; scope: { predicates: string[]; conditions: string[] }; createdAt: string; supersedes: string | null; current: boolean; withdrawn: boolean };
export type ReviewDetail = { edition: ReviewEdition; history: ReviewEdition[]; decisions: ReviewDecision[]; assessment: ReviewAssessment; stale: string[]; source: { url: string; title: string; pages: { number: number; characters: number }[]; excerpts: { targetId: string; page: number; start: number; end: number; text: string; hash: string }[] }; asset: ReviewAsset | null; currentAsset: ReviewAsset | null; promotions: Promotion[]; affected: { revisionId: string; current: boolean; requirements: string[]; connections: string[] }[] };
export type ReviewHome = { actor: ReviewActor; role: "owner" | ReviewRole; expiresAt: string; policy: typeof REVIEW_POLICY; actors: ReviewActor[]; capabilities: ReviewCapability[]; candidates: ReviewCandidate[]; assets: ReviewAsset[]; proposals: { id: string; model: string; version: number; editionId: string; provenance: "human" | "sample"; state: string }[]; photos: { id: string; hash: string; width: number; height: number }[]; kits: { id: string; revisionId: string; graphHash: string; title: string }[]; audit: { sequence: number; actorName: string; kind: string; at: string; detail: string }[]; qualificationGate: string };

const Command = { requestId: z.uuid() };
const Expected = { proposalId: z.uuid(), expectedVersion: z.number().int().positive(), expectedHash: Digest };
export const ReviewActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("register_actor"), ...Command, name: z.string().trim().min(2).max(80), provenance: z.enum(["human", "sample"]) }).strict(),
  z.object({ kind: z.literal("invite"), ...Command, actorId: z.uuid(), role: RoleSchema, kitId: z.uuid(), profileId: Id, documentId: z.uuid(), expiresAt: z.iso.datetime() }).strict(),
  z.object({ kind: z.literal("revoke"), ...Command, capabilityId: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(8).max(600) }).strict(),
  z.object({ kind: z.literal("revoke_actor"), ...Command, actorId: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(8).max(600) }).strict(),
  z.object({ kind: z.literal("approve_asset"), ...Command, profileId: Id, photoId: z.uuid(), expectedImageHash: Digest, expectedAssetId: z.uuid().nullable(), crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.025).max(1), height: z.number().min(0.025).max(1) }).strict(), description: z.string().trim().min(8).max(500), rightsConfirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("create"), ...Command, candidateId: Id, kitId: z.uuid(), expectedRevisionId: z.uuid(), expectedGraphHash: Digest, provenance: z.enum(["human", "sample"]) }).strict(),
  z.object({ kind: z.literal("revise"), ...Command, ...Expected, content: ProposalContentSchema, reason: z.string().trim().min(8).max(1500), rebase: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("decide"), ...Command, ...Expected, targetId: Id, outcome: z.enum(["accept", "reject", "unresolved"]), reason: z.string().trim().min(8).max(1500) }).strict(),
  z.object({ kind: z.literal("adjudicate"), ...Command, ...Expected, targetId: Id, outcome: z.enum(["accept", "reject", "unresolved"]), reason: z.string().trim().min(16).max(1500), decisionSetHash: Digest }).strict(),
  z.object({ kind: z.literal("promote"), ...Command, ...Expected, acknowledgeScope: z.literal(true) }).strict(),
  z.object({ kind: z.literal("withdraw"), ...Command, promotionId: Id, expectedHeadId: Id, reason: z.string().trim().min(8).max(1000) }).strict(),
]);
export type ReviewAction = z.infer<typeof ReviewActionSchema>;
