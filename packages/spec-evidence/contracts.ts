import { z } from "zod";
import type { DeviceProfile, Source } from "../contracts";
import type { ModelReceipt } from "../planner";

export const ExtractionQuerySchema = z.object({
  id: z.string().regex(/^[a-z0-9:_-]{1,100}$/), property: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,80}$/),
  question: z.string().min(8).max(600), valueType: z.enum(["number", "boolean", "string"]),
  unit: z.string().max(24).nullable(), scope: z.string().min(1).max(250), critical: z.boolean(),
}).strict();
export type ExtractionQuery = z.infer<typeof ExtractionQuerySchema>;
export const ExtractedFactSchema = z.object({
  assertionId: z.string(), state: z.enum(["supported", "unknown", "conflicted"]),
  value: z.union([z.number(), z.boolean(), z.string().max(250), z.null()]), unit: z.string().max(24).nullable(),
  scope: z.string().max(250), conditions: z.array(z.string().max(250)).max(12),
  evidence: z.array(z.object({ page: z.number().int().positive(), quote: z.string().min(3).max(800) }).strict()).max(4),
  explanation: z.string().max(700),
}).strict();
export const ExtractionResponseSchema = z.object({ facts: z.array(ExtractedFactSchema).max(40), limitations: z.array(z.string().max(300)).max(12) }).strict();
export type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>;
export type EvidenceAnchor = { sourceId: string; contentHash: string; textHash: string; page: number; start: number; end: number; excerptHash: string };
export type ValidatedFact = Omit<z.infer<typeof ExtractedFactSchema>, "evidence"> & { property: string; critical: boolean; proposedState: "supported" | "unknown" | "conflicted" | null; evidence: EvidenceAnchor[]; validation: "located_pending_review" | "abstained" | "rejected" | "conflicted"; validationIssues: string[]; review: { status: "pending"; reviewer: null; date: null } };
export type ExtractionDraft = { id: string; profileId: string; sourceId: string; sourceHash: string; textHash: string; createdAt: string; promptVersion: "source-extractor.1"; queriesHash: string; facts: ValidatedFact[]; limitations: string[]; counts: { located: number; unknown: number; rejected: number; conflicted: number }; promotion: "human_review_required"; physicalTest: "not_performed" };
export const SourceExtractRequest = z.object({ profileId: z.string(), provider: z.enum(["openai", "gemini"]), requestId: z.uuid(), expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const DraftReferenceSchema = z.object({
  id: z.string(), version: z.number().int().positive(), frozenAt: z.iso.datetime(), sourceMode: z.literal("source_based_ai_draft"),
  methodology: z.string(), humanReview: z.object({ status: z.literal("pending"), reviewers: z.array(z.string()).length(0) }),
  assertions: z.array(ExtractionQuerySchema.extend({ profileId: z.string(), family: z.string(), expectedState: z.enum(["supported", "unknown", "conflicted"]), expectedValue: z.union([z.number(),z.boolean(),z.string(),z.null()]), expectedConditions: z.array(z.string()), sourceHash: z.string(), evidence: z.array(z.object({ page: z.number().int().positive(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), excerptHash: z.string() })) }).strict()),
}).strict();
export type DraftReference = z.infer<typeof DraftReferenceSchema>;

export type EvidenceDocument = {
  id: string; profileId: string; sourceUrl: string; contentHash: string | null; textHash: string | null;
  status: "retrieving" | "staged" | "prepared" | "available" | "deleting" | "deleted";
  mediaType: string | null; bytes: number | null; pages: number; characters: number;
  retrievedAt: string | null; createdAt: string; current: boolean; headVersion: number | null;
  identityMentioned: boolean; suggestedPages: number[]; pageSizes: { number: number; characters: number }[];
};
export type EvidenceCandidate = {
  id: string; manufacturer: string; model: string; variant: string; kind: string; group: string; family: string; split: string;
  source: { title: string; publisher: string; url: string; retrievedAt: string | null; contentHash: string | null; pages: number; status: string };
  currentDocument: EvidenceDocument | null; proposedFacts: number; pendingReview: true; savedCandidateId: string | null;
};
export type EvidenceDraftSummary = { id: string; profileId: string; documentId: string; sourceHash: string; provider: string; model: string; createdAt: string; counts: ExtractionDraft["counts"]; savedCandidateId: string | null };
export type EvidenceReviewRequest = { id: string; draftId: string; assertionIds: string[]; question: string; status: "open"; createdAt: string };
export type EvidenceWorkspace = { candidates: EvidenceCandidate[]; summary: { candidates: number; retrieved: number; heldOut: number; development: number; humanReviewed: 0; physicalTests: 0 }; storageReady: boolean };
export type EvidenceDetail = {
  candidate: EvidenceCandidate; documents: EvidenceDocument[]; drafts: EvidenceDraftSummary[];
  queries: ExtractionQuery[]; reviewRequests: EvidenceReviewRequest[]; libraryProfile: DeviceProfile | null; librarySource: Source | null;
};
export type EvidenceDraftDetail = {
  draft: ExtractionDraft; document: EvidenceDocument; receipt: ModelReceipt;
  excerpts: { assertionId: string; page: number; text: string; sourceUrl: string; excerptHash: string }[];
  profile: DeviceProfile; source: Source; previewHash: string; savedCandidateId: string | null;
};
export const EvidenceActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("retrieve"), profileId: z.string().max(100), requestId: z.uuid(), expectedHeadId: z.uuid().nullable() }).strict(),
  z.object({ kind: z.literal("extract"), profileId: z.string().max(100), documentId: z.uuid(), expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/), provider: z.enum(["openai", "gemini"]), selectedPages: z.array(z.number().int().min(1).max(400)).min(1).max(400), requestId: z.uuid() }).strict(),
  z.object({ kind: z.literal("save_candidate"), draftId: z.uuid(), previewHash: z.string().regex(/^[a-f0-9]{64}$/), expectedHeadId: z.uuid(), acknowledgePendingReview: z.literal(true) }).strict(),
  z.object({ kind: z.literal("request_review"), draftId: z.uuid(), assertionIds: z.array(z.string().max(100)).min(1).max(40), question: z.string().trim().min(8).max(1200), requestId: z.uuid() }).strict(),
  z.object({ kind: z.literal("delete_document"), documentId: z.uuid() }).strict(),
]);
