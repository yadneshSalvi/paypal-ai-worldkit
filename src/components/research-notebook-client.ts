import { ResearchCommandSchema, RESEARCH_POLICY, type ResearchAttempt, type ResearchCommand, type ResearchCommandResult, type ResearchDetail, type ResearchHome, type ResearchParticipant } from "../../packages/research-notebook/contracts";

export class ResearchRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly unknown = false) { super(message); }
}

export async function researchRequest<T>(path: string, command?: ResearchCommand): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store", ...(command ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) } : {}) });
  } catch {
    throw new ResearchRequestError(command ? "The answer was lost. Keep the original action and recover it before recording anything else." : "The saved notebook could not be read. Refresh this same view before recording.", "transport_unknown", 0, true);
  }
  let value: unknown;
  try { value = await response.json(); } catch { throw new ResearchRequestError("The server answer could not be read. Recover the original action; do not create a replacement.", "unreadable_answer", response.status, true); }
  if (!response.ok) {
    const error = (value as { error?: { code?: unknown; message?: unknown; nextAction?: unknown } })?.error;
    const message = typeof error?.message === "string" ? error.message : "This action was not accepted. Refresh the current notebook.";
    throw new ResearchRequestError(`${message}${typeof error?.nextAction === "string" ? ` ${error.nextAction}` : ""}`, typeof error?.code === "string" ? error.code : "request_refused", response.status, response.status >= 500);
  }
  return value as T;
}

export function validateResearchHome(value: ResearchHome): ResearchHome {
  if (!value || typeof value.workspaceKey !== "string" || !value.workspaceKey || !Number.isFinite(Date.parse(value.expiresAt)) || !Number.isFinite(Date.parse(value.serverTime)) || value.policy !== RESEARCH_POLICY || !Array.isArray(value.studies) || !Array.isArray(value.subjects)) throw new ResearchRequestError("The current notebook authority could not be established. Refresh the saved view.", "invalid_read", 0);
  if (value.selected && (!value.selected.study?.id || !Number.isInteger(value.selected.study.version) || !/^[a-f0-9]{64}$/.test(value.selected.study.hash) || !value.selected.protocol?.id || !value.selected.currentSource || !Array.isArray(value.selected.participants) || !Array.isArray(value.selected.attempts))) throw new ResearchRequestError("The exact saved study could not be established. Refresh the saved view.", "invalid_read", 0);
  return value;
}
export function validateResearchResult(value: ResearchCommandResult): ResearchCommandResult {
  if (!value || typeof value.studyId !== "string" || !value.studyId || !Number.isInteger(value.version) || value.version < 1 || !/^[a-f0-9]{64}$/.test(value.hash)) throw new ResearchRequestError("The acknowledgement is incomplete. Recover this same action before starting another.", "invalid_acknowledgement", 200, true);
  return value;
}

type ResearchStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PendingResearchAction = { version: 1; workspaceKey: string; command: ResearchCommand };
const storageKey = (workspaceKey: string) => `worldkit.research.pending.v1:${workspaceKey}`;
export function readResearchPending(storage: ResearchStorage, workspaceKey: string): PendingResearchAction | null {
  const raw = storage.getItem(storageKey(workspaceKey));
  if (!raw) return null;
  if (raw.length > 300_000) throw new Error("The original research action is too large to recover safely. Keep this tab open; no replacement action will be sent.");
  let parsed: { version?: unknown; workspaceKey?: unknown; command?: unknown };
  try { parsed = JSON.parse(raw); } catch { throw new Error("The original research action could not be decoded. Resolve it before starting another."); }
  if (parsed.version !== 1 || parsed.workspaceKey !== workspaceKey) throw new Error("The saved action belongs to another actor or workspace. It cannot be used here.");
  const result = ResearchCommandSchema.safeParse(parsed.command);
  if (!result.success) throw new Error("The original research action is incomplete. Resolve it before recording anything else.");
  return { version: 1, workspaceKey, command: result.data };
}
export function recordResearchPending(storage: ResearchStorage, pending: PendingResearchAction): void {
  const current = readResearchPending(storage, pending.workspaceKey);
  if (current && JSON.stringify(current) !== JSON.stringify(pending)) throw new Error("Recover the earlier research action before starting another.");
  const encoded = JSON.stringify(pending);
  storage.setItem(storageKey(pending.workspaceKey), encoded);
  if (storage.getItem(storageKey(pending.workspaceKey)) !== encoded) throw new Error("This browser could not retain the original action. No request was sent.");
}
export function clearResearchPending(storage: ResearchStorage, pending: PendingResearchAction): void {
  const current = readResearchPending(storage, pending.workspaceKey);
  if (current && JSON.stringify(current) === JSON.stringify(pending)) {
    storage.removeItem(storageKey(pending.workspaceKey));
    if (storage.getItem(storageKey(pending.workspaceKey)) !== null) throw new Error("The acknowledgement was received, but this browser could not clear the retained action. Recover its original identity before continuing.");
  }
}

export type ResearchDraft = ResearchCommand extends infer T ? T extends ResearchCommand ? Omit<T, "requestId"> : never : never;
export const researchCurrent = (detail: ResearchDetail) => ({ studyId: detail.study.id, expectedVersion: detail.study.version, expectedStudyHash: detail.study.hash });
export const researchCurrentConsent = (participant: ResearchDetail["participants"][number], now: number) => participant.availability === "current" && !participant.withdrawnAt && participant.currentConsent?.status === "current" && participant.currentConsent.privateResearch && Date.parse(participant.currentConsent.grantedAt) <= now && (!participant.currentConsent.expiresAt || Date.parse(participant.currentConsent.expiresAt) > now);
export function researchCanRecordOutcome(participant: ResearchParticipant | undefined, attempt: ResearchAttempt, now: number): boolean {
  if (!participant || !researchCurrentConsent(participant, now)) return false;
  const original = participant.consents.find(consent => consent.id === attempt.consentId && consent.hash === attempt.consentHash);
  return !!original && ["current", "superseded"].includes(original.status) && original.privateResearch && Date.parse(original.grantedAt) <= now && (!original.expiresAt || Date.parse(original.expiresAt) > now);
}
export const researchQuery = (studyId?: string, protocolId?: string) => `/api/research-notebook${studyId ? `?${new URLSearchParams({ studyId, ...(protocolId ? { protocolId } : {}) })}` : ""}`;
export function researchExportUrl(detail: ResearchDetail, view: "private" | "redacted", format: "json" | "csv") {
  return `/api/research-notebook/export?${new URLSearchParams({ studyId: detail.study.id, protocolId: detail.protocol.id, view, format })}`;
}
export const researchShort = (value: string) => `${value.slice(0, 12)}…`;
export const researchTime = (value: string | null) => value ? new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" }).format(new Date(value)) + " UTC" : "Not recorded";
export const researchUtcInput = (value: string) => new Date(value).toISOString().slice(0, -1);
export const researchFromUtc = (value: string) => { const parsed = new Date(`${value.replace(/Z$/, "")}Z`); return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : value; };
export const researchInterval = (ms: number | null) => ms === null ? "Not finished" : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
export const researchActionLabel: Record<ResearchCommand["kind"], string> = { create: "Create study", revise_protocol: "Save protocol version", add_participant: "Add participant", amend_consent: "Record new consent", withdraw_participant: "Withdraw participant", begin_task: "Start task", record_outcome: "Record outcome", close_unreported_attempt: "Close interval without an outcome", seal: "Seal notebook" };
