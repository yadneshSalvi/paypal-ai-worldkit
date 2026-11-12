import { z } from "zod";

export const WorkspaceAdmissionSchema = z.object({
  kind: z.literal("start_sample"),
  requestId: z.string().uuid(),
  recoveryKey: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgedSample: z.literal(true),
}).strict();
export type WorkspaceAdmission = z.infer<typeof WorkspaceAdmissionSchema>;
export const ADMISSION_STORAGE_KEY = "worldkit.sample-entry.v1";
export const AdmissionJournalSchema = z.object({
  version: z.literal(1), origin: z.string().url(), recordedAt: z.string().datetime(),
  command: WorkspaceAdmissionSchema,
}).strict();
export type AdmissionJournal = z.infer<typeof AdmissionJournalSchema>;
