import { z } from "zod";
import { ArchitectureSchema, CatalogSnapshotSchema, CertificateSchema, DeviceSchema, KitSchema, SourceSchema, type Workspace } from "../../packages/contracts";
import { ADMISSION_STORAGE_KEY, AdmissionJournalSchema, type AdmissionJournal } from "../../packages/workspace-entry";

const WorkspaceReadSchema = z.object({
  session: z.object({ id: z.string().min(1), expiresAt: z.string().datetime() }),
  kit: KitSchema, certificate: CertificateSchema,
  profiles: z.array(DeviceSchema), sources: z.array(SourceSchema), architectures: z.array(ArchitectureSchema),
  alternatives: z.array(z.object({ kit: KitSchema, certificate: CertificateSchema })), snapshots: z.array(CatalogSnapshotSchema),
  receipts: z.array(z.object({ id: z.string(), operation: z.string(), status: z.string() }).passthrough()),
  events: z.array(z.object({ id: z.string(), sequence: z.number(), type: z.string(), title: z.string(), at: z.string(), detail: z.string() }).passthrough()),
  assembly: z.array(z.object({ id: z.string(), title: z.string(), instruction: z.string() }).passthrough()),
  completedSteps: z.array(z.string()), repairOptions: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), change: z.string() })),
  usage: z.object({ discoveryRequests: z.number(), maxDiscoveryRequests: z.number(), liveRebuilds: z.number(), maxLiveRebuilds: z.number() }),
}).passthrough();
export function parseEntryWorkspace(value: unknown): Workspace {
  const parsed = WorkspaceReadSchema.safeParse(value);
  if (!parsed.success || Date.parse(parsed.data.session.expiresAt) <= Date.now() || !parsed.data.architectures.some(item => item.id === parsed.data.kit.templateId)) throw new Error("The saved workbench response was incomplete or expired. Check the original request before continuing.");
  // Keep the server's complete versioned DTO, including fields unknown to this
  // entry validator. The validator never rewrites a graph or certificate.
  return value as Workspace;
}
export function readAdmissionJournal(storage: Storage, origin: string): AdmissionJournal | null {
  const value = storage.getItem(ADMISSION_STORAGE_KEY); if (value === null) return null;
  const parsed = AdmissionJournalSchema.safeParse(JSON.parse(value));
  if (!parsed.success || parsed.data.origin !== origin) throw new Error("The saved Sample request could not be matched to this page. Check your saved workbench; a replacement request has not been sent.");
  return parsed.data;
}
export function writeAdmissionJournal(storage: Storage, journal: AdmissionJournal) {
  AdmissionJournalSchema.parse(journal); const value = JSON.stringify(journal);
  storage.setItem(ADMISSION_STORAGE_KEY, value);
  if (storage.getItem(ADMISSION_STORAGE_KEY) !== value) throw new Error("This browser could not retain the Sample request for recovery. No new request was sent.");
}
export function newAdmissionJournal(origin: string): AdmissionJournal {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return { version: 1, origin, recordedAt: new Date().toISOString(), command: { kind: "start_sample", requestId: crypto.randomUUID(), recoveryKey: Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""), acknowledgedSample: true } };
}
export function clearAdmissionJournal(storage: Storage, journal: AdmissionJournal) {
  const current = readAdmissionJournal(storage, journal.origin);
  if (current && JSON.stringify(current) === JSON.stringify(journal)) storage.removeItem(ADMISSION_STORAGE_KEY);
}
export function entryError(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "error" in value) { const error = (value as { error?: { message?: unknown } }).error; if (typeof error?.message === "string" && error.message.length < 1000) return error.message; }
  return fallback;
}
