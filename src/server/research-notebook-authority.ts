import { createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import { WorldKitError } from "../../packages/contracts";
import { canonical, hash } from "../../packages/compatibility";
import type { ResearchBinding, ResearchSourceObservation, ResearchSubject } from "../../packages/research-notebook/contracts";
import { resolveBenchBinding } from "./physical-notebook-binding";
import type { Session } from "./repository";

export type ResearchAccess = { tenantId: string; actorId: string };
export type ResearchRow = Record<string, any>;
export const ownerResearchAccess = (session: Session): ResearchAccess => ({ tenantId: session.id, actorId: session.id });
export const researchIso = (value: string | Date) => new Date(value).toISOString();
export function researchFail(message: string, code: "forbidden" | "not_found" | "invalid_request" | "stale_revision" | "needs_evidence" = "forbidden", status = code === "not_found" ? 404 : code === "invalid_request" ? 400 : code === "stale_revision" ? 409 : code === "needs_evidence" ? 422 : 403): never { throw new WorldKitError(code, message, status); }
export function researchPrivateHash(value: unknown): string {
  const key = process.env.AUTH_SECRET; if (!key || key.length < 32) throw new Error("Private research configuration is unavailable.");
  return createHmac("sha256", key).update("worldkit-research-v1:").update(canonical(value)).digest("hex");
}
/** Lock workspace authority before every command and recheck wall time after lock waits. */
export async function authorizeResearch(db: PoolClient, access: ResearchAccess) {
  if (access.actorId !== access.tenantId) researchFail("This research notebook requires the current workspace owner.");
  const row = (await db.query("SELECT id,expires_at FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE", [access.tenantId])).rows[0];
  if (!row || Date.parse(researchIso(row.expires_at)) <= Date.now()) researchFail("This private research workspace has expired.");
  return { expiresAt: researchIso(row.expires_at) };
}
export async function researchBinding(db: PoolClient, tenantId: string, subject: ResearchSubject, requireCurrent = false): Promise<{ binding: ResearchBinding; current: boolean; issues: string[] }> {
  const found = await resolveBenchBinding(db, tenantId, { kind: subject.kind, subjectId: subject.subjectId, revisionId: subject.revisionId, graphHash: subject.graphHash }, requireCurrent);
  const { steps: _physicalProtocol, hash: _physicalHash, ...content } = found.binding;
  return { binding: { ...content, hash: hash(content) }, current: found.current, issues: found.issues };
}
export async function researchSource(db: PoolClient, tenantId: string, binding: ResearchSubject): Promise<ResearchSourceObservation> {
  const row = binding.kind === "creator"
    ? (await db.query("SELECT r.id AS revision_id,r.certificate->>'graphHash' AS graph_hash FROM wk_kits k JOIN wk_revisions r ON r.id=k.current_revision_id AND r.kit_id=k.id AND r.tenant_id=k.tenant_id WHERE k.id=$1 AND k.tenant_id=$2", [binding.subjectId, tenantId])).rows[0]
    : (await db.query("SELECT e.id AS revision_id,e.graph_hash FROM wk_domain_projects p JOIN wk_domain_editions e ON e.id=p.current_edition_id AND e.project_id=p.id AND e.tenant_id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2 AND p.archived_at IS NULL", [binding.subjectId, tenantId])).rows[0];
  return { kind: binding.kind, subjectId: binding.subjectId, revisionId: row?.revision_id ?? null, graphHash: row?.graph_hash ?? null,
    observedAt: new Date().toISOString(), availability: row ? "available" : "missing", matchesStudyBinding: !!row && row.revision_id === binding.revisionId && row.graph_hash === binding.graphHash };
}
