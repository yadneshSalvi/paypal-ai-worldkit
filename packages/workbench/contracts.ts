import { z } from "zod";
import { CertificateSchema, WitnessSchema } from "../contracts/index";

/** Browser-safe contracts. Executing an edit stays on the server. */
export const EditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("template"), templateId: z.enum(["T1", "T2", "T3", "T4"]) }).strict(),
  z.object({ kind: z.literal("connection"), connectionId: z.string().min(1).max(160), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal("microphone"), componentId: z.enum(["mic-1", "mic-2"]), profileId: z.enum(["shure-sm58-lc", "at2020-xlr"]) }).strict(),
  z.object({ kind: z.literal("repair"), repairId: z.string().min(1).max(160) }).strict(),
  z.object({ kind: z.literal("sample_rate"), value: z.enum(["48000", "96000"]) }).strict(),
  z.object({ kind: z.literal("goal"), title: z.string().trim().min(1).max(80), brief: z.string().trim().min(10).max(2000), budgetMinor: z.number().int().min(1).max(1_000_000), tracks: z.number().int().min(1).max(8) }).strict(),
  z.object({ kind: z.literal("position"), componentId: z.string().min(1).max(160), x: z.number().min(-2000).max(4000), y: z.number().min(-2000).max(4000) }).strict(),
]);
export type Edit = z.infer<typeof EditSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pins = { expectedRevisionId: z.string().min(1).max(200), expectedGraphHash: digest, edit: EditSchema };
export const MutationSchema = z.object(pins).strict();
export const WorkbenchPreviewInputSchema = z.object({ kind: z.literal("preview"), ...pins }).strict();
export const WorkbenchApplyInputSchema = z.object({ kind: z.literal("apply"), ...pins, requestId: z.uuid(), previewHash: digest, acknowledgedModelledChange: z.literal(true) }).strict();
export const WorkbenchCommandSchema = z.discriminatedUnion("kind", [WorkbenchPreviewInputSchema, WorkbenchApplyInputSchema]);
export type WorkbenchPreviewInput = z.infer<typeof WorkbenchPreviewInputSchema>;
export type WorkbenchApplyInput = z.infer<typeof WorkbenchApplyInputSchema>;
export type WorkbenchCommand = z.infer<typeof WorkbenchCommandSchema>;

export const WorkbenchHeadSchema = z.object({ kitId: z.string().min(1), revisionId: z.string().min(1), revision: z.number().int().positive(), graphHash: digest }).strict();
export type WorkbenchHead = z.infer<typeof WorkbenchHeadSchema>;
export const WorkbenchEvaluationSchema = CertificateSchema.pick({ graphHash: true, sourceHash: true, ruleVersion: true, status: true, counts: true, review: true, results: true, scope: true, physicalTest: true }).strict();
export type WorkbenchEvaluation = z.infer<typeof WorkbenchEvaluationSchema>;
const routing = z.object({ input1: z.boolean(), input2: z.boolean(), isolated: z.boolean(), stream: z.boolean(), monitor: z.boolean() }).strict();
export const WorkbenchPreviewSchema = z.object({
  schema: z.literal("worldkit.workbench-preview.v1"), kind: z.literal("preview"), workspaceKey: digest, expiresAt: z.iso.datetime(),
  base: WorkbenchHeadSchema, edit: EditSchema, changed: z.boolean(), before: WorkbenchEvaluationSchema, after: WorkbenchEvaluationSchema,
  beforeRouting: routing, afterRouting: routing,
  changes: z.array(z.object({ before: WitnessSchema.nullable(), after: WitnessSchema }).strict()),
  evaluatedAt: z.iso.datetime(), previewHash: digest,
}).strict();
export type WorkbenchPreview = z.infer<typeof WorkbenchPreviewSchema>;
export const WorkbenchReceiptSchema = z.object({
  schema: z.literal("worldkit.workbench-receipt.v1"), kind: z.literal("applied"), requestId: z.uuid(), inputHash: digest, previewHash: digest,
  workspaceKey: digest, expiresAt: z.iso.datetime(), base: WorkbenchHeadSchema, saved: WorkbenchHeadSchema,
  savedAt: z.iso.datetime(), current: WorkbenchHeadSchema, replayed: z.boolean(),
}).strict();
export type WorkbenchReceipt = z.infer<typeof WorkbenchReceiptSchema>;

/** Matches the deterministic server fingerprint without importing Node crypto. */
export function workbenchCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(workbenchCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${workbenchCanonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
