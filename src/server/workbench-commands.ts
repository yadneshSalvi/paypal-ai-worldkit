import type { PoolClient } from "pg";
import { WorldKitError, type CatalogSnapshot, type Certificate } from "../../packages/contracts";
import { canonical, hash, verifyKit } from "../../packages/compatibility";
import { architectures } from "../../packages/device-library";
import { routingState } from "../../packages/soundcheck";
import { editKit } from "../../packages/workbench";
import { WorkbenchCommandSchema, WorkbenchEvaluationSchema, WorkbenchPreviewSchema, WorkbenchReceiptSchema, type WorkbenchCommand, type WorkbenchHead, type WorkbenchPreview, type WorkbenchPreviewInput, type WorkbenchReceipt } from "../../packages/workbench/contracts";
import { transaction } from "./db";
import { persistEditedRevision, type RevisionBundle, type Session } from "./repository";
import { authorizeWorkbench, workbenchLive } from "./workbench-authority";
import { initializeWorkbench } from "./workbench-db";

const head = (bundle: RevisionBundle): WorkbenchHead => ({ kitId: bundle.kit.kitId, revisionId: bundle.kit.id, revision: bundle.kit.revision, graphHash: bundle.certificate.graphHash });
function evaluation(certificate: Certificate) {
  const { id: _id, revisionId: _revision, issuedAt: _at, sourceMode: _mode, ...content } = certificate;
  return WorkbenchEvaluationSchema.parse(content);
}
async function currentGraph(db: PoolClient, session: Session): Promise<RevisionBundle> {
  const lock = (await db.query("SELECT id,current_revision_id FROM wk_kits WHERE tenant_id=$1 ORDER BY created_at LIMIT 1 FOR UPDATE", [session.id])).rows[0];
  if (!lock) throw new WorldKitError("not_found", "The original workbench was not found.", 404);
  const row = (await db.query("SELECT kit,certificate,profiles,sources FROM wk_revisions WHERE id=$1 AND kit_id=$2 AND tenant_id=$3", [lock.current_revision_id, lock.id, session.id])).rows[0];
  if (!row) throw new WorldKitError("not_found", "The saved workbench edition was not found.", 404);
  return row as RevisionBundle;
}
async function preview(db: PoolClient, session: Session, input: WorkbenchPreviewInput, current: RevisionBundle, authority: Awaited<ReturnType<typeof authorizeWorkbench>>) {
  if (current.kit.id !== input.expectedRevisionId || current.certificate.graphHash !== input.expectedGraphHash)
    throw new WorldKitError("stale_revision", "This plan changed. Refresh the saved workbench and preview the change again.", 409);
  const draft = editKit(current.kit, current.certificate, input.edit, current.profiles);
  const activeProfiles = current.profiles.filter(profile => profile.engineeringReview && draft.components.some(component => component.profileId === profile.id));
  if (activeProfiles.length) {
    const { assertEngineeringProfilesCurrent } = await import("./engineering-review");
    await assertEngineeringProfilesCurrent(db, session.id, activeProfiles);
  }
  const snapshots = (await db.query("SELECT snapshot FROM wk_catalog WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 80", [session.id])).rows.map(row => row.snapshot as CatalogSnapshot);
  const evaluatedAt = new Date().toISOString();
  const evaluate = (kit: RevisionBundle["kit"]) => verifyKit(kit, current.profiles, current.sources, architectures, snapshots, evaluatedAt);
  const before = evaluation(evaluate(current.kit)), checked: Certificate = evaluate(draft), after = evaluation(checked);
  const content = {
    schema: "worldkit.workbench-preview.v1" as const, kind: "preview" as const, ...authority, base: head(current), edit: input.edit,
    changed: canonical(draft) !== canonical(current.kit), before, after, beforeRouting: routingState(current.kit), afterRouting: routingState(draft),
    changes: after.results.flatMap(witness => { const previous = before.results.find(item => item.requirementId === witness.requirementId) ?? null; return canonical(previous) === canonical(witness) ? [] : [{ before: previous, after: witness }]; }),
  };
  // A new wall-clock label does not invalidate an otherwise identical preview.
  // Any changed graph, source, rule, catalog constraint or authority does.
  const response = WorkbenchPreviewSchema.parse({ ...content, evaluatedAt, previewHash: hash(content) });
  workbenchLive(authority.expiresAt);
  return { response, draft, checked };
}

export async function workbenchCommand(session: Session, value: unknown): Promise<WorkbenchPreview | WorkbenchReceipt> {
  const input: WorkbenchCommand = WorkbenchCommandSchema.parse(value);
  await initializeWorkbench();
  const result = await transaction(async db => {
    const authority = await authorizeWorkbench(db, session), current = await currentGraph(db, session);
    if (input.kind === "apply") {
      const previous = (await db.query("SELECT input_hash,preview_hash,base_revision_id,result_revision_id,result FROM wk_workbench_commands WHERE tenant_id=$1 AND request_id=$2", [session.id, input.requestId])).rows[0];
      if (previous) {
        if (previous.input_hash !== hash(input)) throw new WorldKitError("invalid_request", "This saved request already belongs to a different edit. Recover the original request before starting another.", 409);
        const receipt = WorkbenchReceiptSchema.parse(previous.result);
        if (receipt.requestId !== input.requestId || receipt.inputHash !== previous.input_hash || receipt.previewHash !== previous.preview_hash || receipt.base.revisionId !== previous.base_revision_id || receipt.saved.revisionId !== previous.result_revision_id || receipt.workspaceKey !== authority.workspaceKey || receipt.expiresAt !== authority.expiresAt)
          throw new WorldKitError("needs_evidence", "The original saved receipt is inconsistent. Its outcome needs inspection before another change.", 422);
        workbenchLive(authority.expiresAt);
        return { ...receipt, current: head(current), replayed: true };
      }
    }
    const proposed = await preview(db, session, { kind: "preview", expectedRevisionId: input.expectedRevisionId, expectedGraphHash: input.expectedGraphHash, edit: input.edit }, current, authority);
    if (input.kind === "preview") return proposed.response;
    if (proposed.response.previewHash !== input.previewHash) throw new WorldKitError("stale_revision", "The checked evidence changed after this preview. Review a fresh preview before saving.", 409);
    if (!proposed.response.changed) throw new WorldKitError("invalid_request", "This change already matches the current plan. No new edition was saved.", 422);
    const saved = await persistEditedRevision(db, session, current, proposed.draft, proposed.checked, input.edit);
    const receipt = WorkbenchReceiptSchema.parse({ schema: "worldkit.workbench-receipt.v1", kind: "applied", ...authority,
      requestId: input.requestId, inputHash: hash(input), previewHash: input.previewHash, base: head(current), saved: head(saved), savedAt: saved.kit.createdAt, current: head(saved), replayed: false });
    await db.query("INSERT INTO wk_workbench_commands(tenant_id,request_id,input_hash,preview_hash,base_revision_id,result_revision_id,result) VALUES($1,$2,$3,$4,$5,$6,$7)", [session.id, input.requestId, receipt.inputHash, input.previewHash, current.kit.id, saved.kit.id, receipt]);
    workbenchLive(authority.expiresAt);
    return receipt;
  });
  // Do not expose a delayed private preview after its original authority ends.
  // A save may already have committed, so a late answer is explicitly unknown,
  // rather than being described as a refused change.
  if (Date.parse(result.expiresAt) <= Date.now()) throw new WorldKitError("forbidden", "The original workspace expired before its answer was ready. Its retained receipt and original deadline must be inspected; no replacement save is authorized.", input.kind === "apply" ? 410 : 401);
  return result;
}
