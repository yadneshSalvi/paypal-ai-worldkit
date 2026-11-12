import { BenchCommandSchema, type BenchCommand, type BenchDetail, type BenchHome, type BenchUpload } from "../../packages/physical-notebook/contracts";

export type BenchCommandBody = { [K in BenchCommand["kind"]]: Omit<Extract<BenchCommand, { kind: K }>, "requestId"> }[BenchCommand["kind"]];
type SerialCommand = Extract<BenchCommand, { kind: "private_serial" }>;
export type PendingBenchAction = {
  version: 1;
  workspaceKey: string;
  reviewer: boolean;
} & (
  | { mode: "command"; command: Exclude<BenchCommand, SerialCommand> }
  | { mode: "private_serial"; identity: Omit<SerialCommand, "serial"> }
  | { mode: "upload_check"; runId: string; uploadId: string }
);

export class BenchRequestError extends Error {
  constructor(message: string, public code: string, public status?: number, public nextAction?: string) { super(message); }
}

export async function benchRequest<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  } catch {
    throw new BenchRequestError("The response did not arrive. The original action may already be saved.", "response_unknown");
  }
  let value: unknown;
  try { value = await response.json(); }
  catch {
    throw new BenchRequestError(response.ok ? "The action answered, but its result could not be read. Recover the same action." : "The notebook response could not be read.", "unreadable_response", response.ok ? undefined : response.status);
  }
  if (!response.ok) {
    const error = (value as { error?: { message?: string; code?: string; nextAction?: string } })?.error;
    throw new BenchRequestError(error?.message ?? "The notebook could not complete this request.", error?.code ?? "request_failed", response.status, error?.nextAction);
  }
  return value as T;
}

export const benchEndpoint = (reviewer: boolean) => reviewer ? "/api/physical-notebook/review" : "/api/physical-notebook";
export function benchHomePath(reviewer: boolean, runId?: string, editionId?: string) {
  const query = new URLSearchParams();
  if (runId) query.set("runId", runId);
  if (runId && editionId) query.set("editionId", editionId);
  return `${benchEndpoint(reviewer)}${query.size ? `?${query}` : ""}`;
}

export function benchCurrent(detail: BenchDetail) {
  return { runId: detail.runId, expectedEditionId: detail.currentEditionId, expectedVersion: detail.currentVersion, expectedEditionHash: detail.currentEditionHash };
}

/** Invalidation only. Server authority still controls every read and command. */
export function benchContextKey(home: BenchHome): string {
  const d = home.selected;
  return JSON.stringify([home.workspaceKey, home.expiresAt, d ? [d.role, d.runId, d.edition.id, d.edition.hash, d.currentEditionId, d.currentVersion, d.currentEditionHash, d.historical, d.subjectCurrent, d.subjectIssues,
    d.reviewer, d.grants.map(g => [g.id, g.actorId, g.version, g.status, g.qualification, g.expiresAt]),
    d.assets.map(a => [a.id, a.sha256, a.availability, a.originalBytesRetained, a.rights])] : null]);
}

function storageKey(workspaceKey: string, reviewer: boolean) { return `worldkit.physical-notebook.pending.1:${reviewer ? "reviewer" : "owner"}:${encodeURIComponent(workspaceKey)}`; }
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function readBenchPending(storage: Storage, workspaceKey: string, reviewer: boolean): PendingBenchAction | null {
  const raw = storage.getItem(storageKey(workspaceKey, reviewer));
  if (!raw) return null;
  if (raw.length > 80_000) throw new Error("The saved recovery record is too large. No new action was sent.");
  let entry: unknown;
  try { entry = JSON.parse(raw); } catch { throw new Error("The saved recovery record cannot be read. It has not been replaced."); }
  if (!plainObject(entry) || entry.version !== 1 || entry.workspaceKey !== workspaceKey || entry.reviewer !== reviewer) throw new Error("The recovery record has a different access scope. It has not been replayed.");
  if (entry.mode === "command") {
    const parsed = BenchCommandSchema.safeParse(entry.command);
    if (!parsed.success || parsed.data.kind === "private_serial" || (reviewer && parsed.data.kind !== "review")) throw new Error("The saved action is not valid for this notebook access.");
    return { version: 1, workspaceKey, reviewer, mode: "command", command: parsed.data };
  }
  if (entry.mode === "private_serial" && !reviewer && plainObject(entry.identity)) {
    if ("serial" in entry.identity) throw new Error("A private serial must not be stored in browser recovery.");
    const parsed = BenchCommandSchema.safeParse({ ...entry.identity, serial: "re-entry required" });
    if (parsed.success && parsed.data.kind === "private_serial") {
      const { serial: _private, ...identity } = parsed.data;
      return { version: 1, workspaceKey, reviewer, mode: "private_serial", identity };
    }
  }
  if (entry.mode === "upload_check" && !reviewer && typeof entry.runId === "string" && entry.runId.length > 0 && typeof entry.uploadId === "string" && entry.uploadId.length > 0) {
    return { version: 1, workspaceKey, reviewer, mode: "upload_check", runId: entry.runId, uploadId: entry.uploadId };
  }
  throw new Error("The saved recovery record is incomplete. It has not been replaced.");
}

export function saveBenchPending(storage: Storage, entry: PendingBenchAction) {
  if (entry.mode === "command" && entry.command.kind === ("private_serial" as string)) throw new Error("Private serial values cannot enter the recovery journal.");
  const previous = readBenchPending(storage, entry.workspaceKey, entry.reviewer);
  if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error("Recover the original saved action before starting another.");
  const key = storageKey(entry.workspaceKey, entry.reviewer);
  storage.setItem(key, JSON.stringify(entry));
  if (storage.getItem(key) !== JSON.stringify(entry)) throw new Error("This browser could not retain the original action. No request was sent.");
}

export function clearBenchPending(storage: Storage, entry: PendingBenchAction) {
  const current = readBenchPending(storage, entry.workspaceKey, entry.reviewer);
  if (current && JSON.stringify(current) === JSON.stringify(entry)) storage.removeItem(storageKey(entry.workspaceKey, entry.reviewer));
}

export function replaceBenchUploadCheck(storage: Storage, entry: PendingBenchAction, next: PendingBenchAction) {
  if (entry.mode !== "upload_check" || next.mode !== "command" || next.command.kind !== "verify_upload" || entry.workspaceKey !== next.workspaceKey || entry.reviewer !== next.reviewer || entry.runId !== next.command.runId || entry.uploadId !== next.command.uploadId) throw new Error("Only the original upload can be checked from this recovery record.");
  const current = readBenchPending(storage, entry.workspaceKey, entry.reviewer);
  if (!current || JSON.stringify(current) !== JSON.stringify(entry)) throw new Error("The original upload recovery changed. Reopen its current record.");
  storage.setItem(storageKey(entry.workspaceKey, entry.reviewer), JSON.stringify(next));
  if (JSON.stringify(readBenchPending(storage, entry.workspaceKey, entry.reviewer)) !== JSON.stringify(next)) throw new Error("The original verification action could not be retained.");
}

export function commandRecovery(workspaceKey: string, reviewer: boolean, command: BenchCommand): PendingBenchAction {
  if (command.kind === "private_serial") {
    const { serial: _private, ...identity } = command;
    return { version: 1, workspaceKey, reviewer, mode: "private_serial", identity };
  }
  return { version: 1, workspaceKey, reviewer, mode: "command", command };
}

export function benchOriginalUrl(assetId: string, runId: string, reviewer: boolean) {
  return `/api/physical-notebook/originals/${encodeURIComponent(assetId)}?${new URLSearchParams({ runId, ...(reviewer ? { access: "review" } : {}) })}`;
}
export function benchExportUrl(detail: BenchDetail, reviewer: boolean, view: "private" | "redacted") {
  return `/api/physical-notebook/export?${new URLSearchParams({ runId: detail.runId, editionId: detail.edition.id, view, ...(reviewer ? { access: "review" } : {}) })}`;
}

export type BenchBlobTransport = (pathname: string, file: File, options: { access: "private"; contentType: string; handleUploadUrl: string; multipart: true; clientPayload: string }) => Promise<unknown>;
export async function sendBenchOriginal(intent: BenchUpload, file: File, runId: string, blobTransport?: BenchBlobTransport): Promise<void> {
  if (intent.runId !== runId || file.name !== intent.file.filename || file.size !== intent.file.bytes) throw new Error("Choose the exact file named in this original upload intent.");
  if (intent.transport === "controlled_local") {
    const response = await fetch(`/api/physical-notebook/uploads/${encodeURIComponent(intent.id)}?${new URLSearchParams({ runId })}`, { method: "PUT", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": intent.file.mediaType }, body: file });
    if (!response.ok) throw new BenchRequestError("The original upload was not acknowledged. Check this same upload before sending anything again.", "upload_unknown", response.status);
    return;
  }
  const upload = blobTransport ?? (await import("@vercel/blob/client")).upload;
  await upload(intent.pathname, file, { access: "private", contentType: intent.file.mediaType, handleUploadUrl: "/api/physical-notebook/uploads", multipart: true, clientPayload: JSON.stringify({ runId, uploadId: intent.id }) });
}

export const benchTime = (value: string | null) => value ? new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" }).format(new Date(value)) + " UTC" : "Not recorded";
export const benchShort = (hash: string) => `${hash.slice(0, 12)}…`;
export const benchBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
export const utcInput = (value: string) => new Date(value).toISOString().slice(0, -1);
export const fromUtcInput = (value: string) => new Date(`${value.replace(/Z$/, "")}Z`).toISOString();
