import { z } from "zod";
import { CertificateSchema, KitSchema, type Workspace } from "../../packages/contracts";
import { WorkbenchApplyInputSchema, WorkbenchPreviewSchema, WorkbenchReceiptSchema, workbenchCanonical, type WorkbenchCommand, type WorkbenchPreview, type WorkbenchReceipt } from "../../packages/workbench/contracts";

export const GuidedPendingSchema = z.object({
  schema: z.literal("worldkit.guided-pending.v1"), sessionId: z.string().min(1), kitId: z.string().min(1), expiresAt: z.iso.datetime(),
  workspaceKey: z.string().regex(/^[a-f0-9]{64}$/), command: WorkbenchApplyInputSchema,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/), proposedGraphHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(), receipt: WorkbenchReceiptSchema.nullable(),
  refusal: z.object({ status: z.number().int(), message: z.string().min(1).max(500) }).strict().nullable(),
}).strict().refine(value => !(value.receipt && value.refusal), "A saved action cannot also be refused");
export type GuidedPending = z.infer<typeof GuidedPendingSchema>;
type Scope = Pick<Workspace, "session" | "kit">;
export function guidedScope(w: Scope) { return `${w.session.id}:${w.kit.kitId}:${w.session.expiresAt}`; }
const key = (w: Scope) => `worldkit.guided.pending.v1:${window.location.origin}:${guidedScope(w)}`;
export function guidedLive(w: Scope) { return Date.parse(w.session.expiresAt) > Date.now(); }
export async function guidedDigest(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(workbenchCanonical(value)));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}
export const guidedWorkspaceKey = (w: Scope) => guidedDigest({ scope: "worldkit.workbench.v1", actorId: w.session.id, tenantId: w.session.id, expiresAt: w.session.expiresAt });
export function readGuidedPending(storage: Storage, w: Scope): GuidedPending | null {
  const text = storage.getItem(key(w)); if (text === null) return null;
  let pending: GuidedPending;
  try { pending = GuidedPendingSchema.parse(JSON.parse(text)); }
  catch { throw new Error("The original guided save record cannot be read. Keep it for inspection before making another guided change."); }
  if (pending.sessionId !== w.session.id || pending.kitId !== w.kit.kitId || pending.expiresAt !== w.session.expiresAt)
    throw new Error("The saved action belongs to a different workspace. Open its original workspace to inspect it.");
  return pending;
}
export function retainGuidedPending(storage: Storage, w: Scope, value: GuidedPending) {
  const pending = GuidedPendingSchema.parse(value), previous = readGuidedPending(storage, w);
  if (pending.sessionId !== w.session.id || pending.kitId !== w.kit.kitId || pending.expiresAt !== w.session.expiresAt) throw new Error("The guided action does not belong to this original workspace.");
  if (previous && (previous.inputHash !== pending.inputHash || workbenchCanonical(previous.command) !== workbenchCanonical(pending.command))) throw new Error("Resolve the original guided save before starting a different one.");
  const text = JSON.stringify(pending); storage.setItem(key(w), text);
  if (storage.getItem(key(w)) !== text) throw new Error("The browser could not retain this exact save request. No new save was sent.");
  return pending;
}
export function clearGuidedPending(storage: Storage, w: Scope, requestId: string) {
  const pending = readGuidedPending(storage, w); if (pending && pending.command.requestId !== requestId) throw new Error("The saved request changed; retain it for inspection.");
  storage.removeItem(key(w)); if (storage.getItem(key(w)) !== null) throw new Error("The acknowledged save remains in browser storage. Its original receipt can be recovered safely.");
}
export class GuidedRequestError extends Error {
  constructor(message: string, public status: number, public knownRefusal: boolean) { super(message); }
}
export async function guidedRequest(command: WorkbenchCommand): Promise<unknown> {
  const response = await fetch("/api/workbench", { method: "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000), headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
  const body = await response.json();
  if (!response.ok) {
    const known = [400, 401, 403, 404, 409, 413, 415, 422, 429].includes(response.status) && typeof body?.error?.code === "string" && typeof body?.error?.message === "string";
    throw new GuidedRequestError(known ? body.error.message : "The save outcome is not confirmed. Recover the original request before changing the plan again.", response.status, known);
  }
  return body;
}
export async function checkedGuidedPreview(raw: unknown, w: Workspace, command: WorkbenchCommand) {
  const preview = WorkbenchPreviewSchema.parse(raw);
  const { evaluatedAt: _time, previewHash, ...content } = preview;
  if (preview.workspaceKey !== await guidedWorkspaceKey(w) || preview.expiresAt !== w.session.expiresAt || preview.base.kitId !== w.kit.kitId || preview.base.revisionId !== command.expectedRevisionId || preview.base.graphHash !== command.expectedGraphHash || preview.base.revision !== w.kit.revision || workbenchCanonical(preview.edit) !== workbenchCanonical(command.edit) || previewHash !== await guidedDigest(content))
    throw new Error("The returned preview does not match this exact saved plan. Refresh the workbench before continuing.");
  return preview;
}
export async function checkedGuidedReceipt(raw: unknown, pending: GuidedPending): Promise<WorkbenchReceipt> {
  const receipt = WorkbenchReceiptSchema.parse(raw);
  if (pending.inputHash !== await guidedDigest(pending.command) || receipt.inputHash !== pending.inputHash || receipt.requestId !== pending.command.requestId || receipt.previewHash !== pending.command.previewHash || receipt.workspaceKey !== pending.workspaceKey || receipt.expiresAt !== pending.expiresAt || receipt.base.kitId !== pending.kitId || receipt.saved.kitId !== pending.kitId || receipt.current.kitId !== pending.kitId || receipt.base.revisionId !== pending.command.expectedRevisionId || receipt.base.graphHash !== pending.command.expectedGraphHash || receipt.saved.graphHash !== pending.proposedGraphHash || receipt.saved.revision !== receipt.base.revision + 1 || receipt.current.revision < receipt.saved.revision)
    throw new Error("The save response does not match the retained request. Keep the original request for recovery.");
  return receipt;
}
export async function freshGuidedWorkspace(w: Workspace, minimum?: WorkbenchReceipt): Promise<Workspace> {
  const response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000) }), value = await response.json();
  if (!response.ok) throw new GuidedRequestError(value?.error?.message ?? "The current saved workbench could not be read.", response.status, response.status === 401);
  const kit = KitSchema.parse(value.kit), certificate = CertificateSchema.parse(value.certificate);
  if (value.session?.id !== w.session.id || value.session?.expiresAt !== w.session.expiresAt || kit.kitId !== w.kit.kitId || kit.id !== certificate.revisionId || !Array.isArray(value.profiles) || !Array.isArray(value.sources) || !Array.isArray(value.architectures) || !Array.isArray(value.alternatives) || !Array.isArray(value.repairOptions) || kit.revision < w.kit.revision || minimum && (kit.revision < minimum.saved.revision || kit.revision === minimum.saved.revision && (kit.id !== minimum.saved.revisionId || certificate.graphHash !== minimum.saved.graphHash)))
    throw new Error("This read does not match the original workspace and acknowledged edition. The retained save can still be recovered.");
  if (!guidedLive(value)) throw new Error("The original workspace has expired. Reading it does not extend its deadline.");
  return value as Workspace;
}
export function applyFromPreview(w: Workspace, preview: WorkbenchPreview, requestId: string) {
  return WorkbenchApplyInputSchema.parse({ kind: "apply", requestId, expectedRevisionId: w.kit.id, expectedGraphHash: w.certificate.graphHash, edit: preview.edit, previewHash: preview.previewHash, acknowledgedModelledChange: true });
}
