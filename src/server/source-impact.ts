import { corpusDevices } from "../../packages/spec-evidence/sources";
import manifest from "../../packages/device-library/corpus-source-manifest.json";
import { traceSourceImpact, type ImpactBundle, type ImpactSource } from "../../packages/spec-evidence/impact";
import { WorldKitError } from "../../packages/contracts";
import { database, initialize } from "./db";
import type { Session } from "./repository";

export async function sourceImpact(session: Session, profileId: string, documentId?: string) {
  const device = corpusDevices.find(device => device.id === profileId);
  if (!device) throw new WorldKitError("not_found", "That exact source candidate is not in the library.", 404);
  await initialize();
  const db = await database().connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const requireCurrent = async () => {
      if (!(await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp()", [session.id])).rowCount)
        throw new WorldKitError("forbidden", "This workspace access has ended. No source impact is disclosed.", 401);
    };
    await requireCurrent();
    const head = (await db.query("SELECT h.document_id,h.version,d.content_hash,d.text_hash,d.source_url,d.status FROM wk_source_heads h JOIN wk_source_documents d ON d.id=h.document_id AND d.tenant_id=h.tenant_id AND d.profile_id=h.profile_id WHERE h.tenant_id=$1 AND h.profile_id=$2", [session.id, profileId])).rows[0];
    const row = documentId ? (await db.query("SELECT id AS document_id,content_hash,text_hash,source_url,status FROM wk_source_documents WHERE id=$1 AND tenant_id=$2 AND profile_id=$3", [documentId, session.id, profileId])).rows[0] : head;
    if (documentId && !row) throw new WorldKitError("not_found", "That source version does not belong to this workspace and exact model.", 404);
    const bundled = manifest.find(record => record.profileId === profileId);
    const source: ImpactSource = { profileId, model: device.model, variant: device.variant,
      documentId: row?.document_id ?? null, contentHash: row?.content_hash ?? (row ? null : bundled?.contentHash ?? null),
      textHash: row?.text_hash ?? null, url: row?.source_url ?? bundled?.url ?? device.source.url,
      status: row ? row.status === "available" ? "available" : "unavailable" : bundled?.status === "retrieved" ? "available" : "unavailable",
      current: row ? row.document_id === head?.document_id : !head, headVersion: head?.version ?? null };
    const total = Number((await db.query("SELECT count(*)::int n FROM wk_revisions WHERE tenant_id=$1", [session.id])).rows[0].n);
    const rows = (await db.query("SELECT r.kit,r.certificate,r.profiles,r.sources,(k.current_revision_id=r.id) AS current FROM wk_revisions r JOIN wk_kits k ON k.id=r.kit_id AND k.tenant_id=r.tenant_id WHERE r.tenant_id=$1 ORDER BY (k.current_revision_id=r.id) DESC,r.created_at DESC,r.id LIMIT 100", [session.id])).rows as ImpactBundle[];
    const report = traceSourceImpact(source, rows, total, 100);
    await requireCurrent();
    await db.query("COMMIT");
    return report;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}
