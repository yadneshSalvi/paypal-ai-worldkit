import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { hash } from "../../packages/compatibility";
import { WorldKitError, type Source } from "../../packages/contracts";
import { sources as librarySources } from "../../packages/device-library";
import { candidateSources } from "../../packages/device-library/candidates";
import { PublicRecordActionInput, PublicRecordPayloadSchema, PublicSlugSchema, projectPublicRecord, publicRecordHash, type PublicRecordAction, type PublicRecordDesk, type PublicRecordSnapshot, type PublicRecordView } from "../../packages/public-record";
import { database, transaction } from "./db";
import { initializePublicRecords } from "./public-record-db";
import { publicRecordOrigin, publicRecordUrl } from "./public-record-origin";
import { appendEvent, type RevisionBundle, type Session } from "./repository";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const BindingSchema = z.object({ bundleHash: digest, sources: z.array(z.object({ id: z.string(), contentHash: z.string(), authority: z.enum(["library", "document"]), documentId: z.string().nullable(), profileId: z.string().nullable() }).strict()), freshnessHash: digest }).strict();
type Binding = z.infer<typeof BindingSchema>;
type ShareRow = { kit_id: string; tenant_id: string; slug: string; version: number; current_record_id: string | null; withdrawn_at: Date | null };
type EditionRow = { id: string; tenant_id: string; kit_id: string; revision_id: string; edition: number; version: number; share_version: number; state: PublicRecordSnapshot["state"]; content_hash: string; payload: unknown; source_binding: unknown; reviewed_at: Date | null; published_at: Date | null; withdrawn_at: Date | null };
const iso = (value: Date | string | null) => value ? new Date(value).toISOString() : null;
const currentSources: Source[] = [...librarySources, ...candidateSources];

function snapshot(row: EditionRow, share: ShareRow): PublicRecordSnapshot {
  const payload = PublicRecordPayloadSchema.parse(row.payload);
  if (publicRecordHash(payload) !== row.content_hash || payload.revisionId !== row.revision_id) throw new WorldKitError("needs_evidence", "This saved edition needs integrity review before it can be opened.", 422);
  return { id: row.id, slug: share.slug, edition: row.edition, version: row.version, shareVersion: row.share_version, state: row.state, contentHash: row.content_hash, payload, reviewedAt: iso(row.reviewed_at), publishedAt: iso(row.published_at), withdrawnAt: iso(row.withdrawn_at) };
}

/** The persisted session is checked inside every publication transaction, including a replay. */
async function activeSession(db: PoolClient, tenantId: string) {
  const row = (await db.query("SELECT expires_at FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR SHARE", [tenantId])).rows[0];
  if (!row) throw new WorldKitError("forbidden", "This private workspace has expired. Its public records are no longer available.", 401);
  return new Date(row.expires_at).toISOString();
}

async function ownerKit(db: PoolClient, tenantId: string, lock = false) {
  const row = (await db.query(`SELECT id,current_revision_id FROM wk_kits WHERE tenant_id=$1 ORDER BY created_at LIMIT 1 ${lock ? "FOR UPDATE" : ""}`, [tenantId])).rows[0];
  if (!row) throw new WorldKitError("not_found", "No saved kit belongs to this workspace.", 404);
  return row as { id: string; current_revision_id: string };
}

async function savedBundle(db: PoolClient, tenantId: string, revisionId: string): Promise<RevisionBundle> {
  const row = (await db.query("SELECT kit,certificate,profiles,sources FROM wk_revisions WHERE tenant_id=$1 AND id=$2", [tenantId, revisionId])).rows[0];
  if (!row) throw new WorldKitError("not_found", "This saved edition does not belong to your workspace.", 404);
  return row as RevisionBundle;
}

async function bindSources(db: PoolClient, tenantId: string, bundle: RevisionBundle, sourceIds: string[]): Promise<Binding> {
  const versions = (await db.query("SELECT v.id,v.profile_id,v.source_document_id,v.source,d.content_hash,d.status,d.deleted_at FROM wk_source_profile_versions v JOIN wk_source_documents d ON d.id=v.source_document_id AND d.tenant_id=v.tenant_id WHERE v.tenant_id=$1 AND v.source->>'id'=ANY($2::text[]) ORDER BY v.created_at", [tenantId, sourceIds])).rows;
  const usedProfiles = bundle.kit.components.flatMap(c => { const profile = bundle.profiles.find(p => p.id === c.profileId); return [c.profileId, profile?.basisProfileId].filter((id): id is string => Boolean(id)); });
  const bindings = sourceIds.map(id => {
    const saved = bundle.sources.find(source => source.id === id)!;
    // A workspace-derived profile keeps its own document authority even if the
    // same public manufacturer manual is also present in the built-in library.
    const matching = versions.filter(v => v.source.id === id);
    const version = matching.find(v => usedProfiles.includes(v.id)) ?? matching.find(v => v.source.contentHash === saved.contentHash);
    if (version) return { id, contentHash: saved.contentHash, authority: "document" as const, documentId: version.source_document_id as string, profileId: version.profile_id as string };
    const source = currentSources.find(source => source.id === id);
    if (!source) throw new WorldKitError("needs_evidence", "A source in this revision has no available sharing authority. Review its provenance first.", 422);
    return { id, contentHash: saved.contentHash, authority: "library" as const, documentId: null, profileId: null };
  });
  const binding: Binding = { bundleHash: hash(bundle), sources: bindings, freshnessHash: "0".repeat(64) };
  const check = await sourceState(db, tenantId, binding, true);
  if (!check.available) throw new WorldKitError("needs_evidence", "A source copy used by this revision is unavailable. Prepare a new source-backed revision before sharing it.", 422);
  return { ...binding, freshnessHash: check.freshnessHash };
}

async function sourceState(db: PoolClient, tenantId: string, binding: Binding, lock = false): Promise<{ available: boolean; freshnessHash: string; changed: boolean }> {
  const documentIds = [...new Set(binding.sources.flatMap(source => source.documentId ? [source.documentId] : []))];
  const documents = documentIds.length ? (await db.query(`SELECT id,profile_id,content_hash,status,deleted_at FROM wk_source_documents WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id ${lock ? "FOR SHARE" : ""}`, [tenantId, documentIds])).rows : [];
  const profileIds = [...new Set(binding.sources.flatMap(source => source.profileId ? [source.profileId] : []))];
  const heads = profileIds.length ? (await db.query(`SELECT profile_id,document_id,version FROM wk_source_heads WHERE tenant_id=$1 AND profile_id=ANY($2::text[]) ORDER BY profile_id ${lock ? "FOR SHARE" : ""}`, [tenantId, profileIds])).rows : [];
  let available = true;
  const authority = binding.sources.map(source => {
    if (source.authority === "library") {
      const current = currentSources.find(item => item.id === source.id);
      if (!current) available = false;
      return { id: source.id, hash: current ? hash(current) : null };
    }
    const document = documents.find(row => row.id === source.documentId);
    if (!document || document.status !== "available" || document.deleted_at || document.content_hash !== source.contentHash) available = false;
    return { id: source.id, document: document?.id ?? null, hash: document?.content_hash ?? null, status: document?.status ?? "missing" };
  });
  const freshnessHash = hash({ authority, heads });
  return { available, freshnessHash, changed: freshnessHash !== binding.freshnessHash };
}

async function requireExactReview(db: PoolClient, session: Session, share: ShareRow, row: EditionRow, input: Exclude<PublicRecordAction, { action: "prepare" | "withdraw" }>, currentRevisionId: string) {
  if (row.version !== input.expectedVersion || row.content_hash !== input.expectedContentHash || row.revision_id !== input.expectedRevisionId || row.revision_id !== currentRevisionId || share.version !== input.expectedShareVersion || row.share_version !== share.version) throw new WorldKitError("stale_revision", "This preview, saved revision or sharing state changed. Prepare and review the current edition before publishing.", 409);
  const record = snapshot(row, share);
  if (record.payload.graphHash !== input.expectedGraphHash) throw new WorldKitError("stale_revision", "The graph no longer matches the reviewed edition.", 409);
  const bundle = await savedBundle(db, session.id, row.revision_id), binding = BindingSchema.parse(row.source_binding);
  if (hash(bundle) !== binding.bundleHash) throw new WorldKitError("stale_revision", "The saved evidence changed after this preview was prepared. Review a new edition.", 409);
  const current = await sourceState(db, session.id, binding, true);
  if (!current.available || current.changed) throw new WorldKitError("stale_revision", "Source availability or its current version changed. Prepare and review a new edition.", 409);
}

export async function mutatePublicRecord(session: Session, raw: unknown): Promise<{ record: PublicRecordSnapshot | null; replayed: boolean }> {
  const input = PublicRecordActionInput.parse(raw);
  await initializePublicRecords();
  return transaction(async db => {
    await activeSession(db, session.id);
    const kit = await ownerKit(db, session.id, true), inputHash = hash(input);
    let share = (await db.query("SELECT * FROM wk_record_shares WHERE kit_id=$1 AND tenant_id=$2 FOR UPDATE", [kit.id, session.id])).rows[0] as ShareRow | undefined;
    const prior = (await db.query("SELECT * FROM wk_record_intents WHERE tenant_id=$1 AND request_id=$2", [session.id, input.requestId])).rows[0];
    if (prior) {
      if (prior.input_hash !== inputHash || prior.action !== input.action) throw new WorldKitError("stale_revision", "That action identity was already used for different content.", 409);
      const row = prior.record_id ? (await db.query("SELECT * FROM wk_record_editions WHERE id=$1 AND tenant_id=$2", [prior.record_id, session.id])).rows[0] as EditionRow : null;
      // A retry returns the present lifecycle state. It can never revive a withdrawn edition.
      return { record: row && share ? snapshot(row, share) : null, replayed: true };
    }
    if ((share?.version ?? 0) !== input.expectedShareVersion) throw new WorldKitError("stale_revision", "Sharing changed in another view. Refresh the publication desk before continuing.", 409);
    let result: EditionRow | null = null;
    if (input.action === "prepare") {
      publicRecordOrigin();
      if (kit.current_revision_id !== input.expectedRevisionId) throw new WorldKitError("stale_revision", "This kit changed. Refresh before preparing its public preview.", 409);
      const bundle = await savedBundle(db, session.id, input.expectedRevisionId);
      if (bundle.certificate.graphHash !== input.expectedGraphHash) throw new WorldKitError("stale_revision", "The graph does not match this preview request.", 409);
      const payload = projectPublicRecord(bundle, input.title);
      const binding = await bindSources(db, session.id, bundle, payload.sources.map(source => source.id));
      if (!share) share = (await db.query("INSERT INTO wk_record_shares(kit_id,tenant_id,slug) VALUES($1,$2,$3) RETURNING *", [kit.id, session.id, randomBytes(24).toString("base64url")])).rows[0] as ShareRow;
      const next = Number((await db.query("SELECT coalesce(max(edition),0)+1 AS edition FROM wk_record_editions WHERE kit_id=$1", [kit.id])).rows[0].edition);
      if (next > 100) throw new WorldKitError("rate_limited", "This workspace has reached its 100-edition preparation allowance.", 429);
      result = (await db.query("INSERT INTO wk_record_editions(id,tenant_id,kit_id,revision_id,edition,share_version,state,content_hash,payload,source_binding) VALUES($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9) RETURNING *", [randomUUID(), session.id, kit.id, bundle.kit.id, next, share.version, publicRecordHash(payload), payload, binding])).rows[0] as EditionRow;
    } else if (input.action === "withdraw") {
      if (!share || !share.current_record_id) throw new WorldKitError("not_found", "There is no publication to withdraw.", 404);
      await db.query("UPDATE wk_record_editions SET state='withdrawn',version=version+1,withdrawn_at=clock_timestamp() WHERE kit_id=$1 AND tenant_id=$2 AND state='published'", [kit.id, session.id]);
      share = (await db.query("UPDATE wk_record_shares SET version=version+1,withdrawn_at=clock_timestamp() WHERE kit_id=$1 RETURNING *", [kit.id])).rows[0] as ShareRow;
    } else {
      if (!share) throw new WorldKitError("not_found", "Prepare a private preview before reviewing or publishing it.", 404);
      const row = (await db.query("SELECT * FROM wk_record_editions WHERE id=$1 AND tenant_id=$2 AND kit_id=$3 FOR UPDATE", [input.recordId, session.id, kit.id])).rows[0] as EditionRow | undefined;
      if (!row) throw new WorldKitError("not_found", "That edition does not belong to this workspace.", 404);
      await requireExactReview(db, session, share, row, input, kit.current_revision_id);
      if (input.action === "review") {
        if (row.state !== "draft") throw new WorldKitError("stale_revision", "Only a private draft can receive this exact preview review.", 409);
        result = (await db.query("UPDATE wk_record_editions SET state='reviewed',version=version+1,reviewed_at=clock_timestamp() WHERE id=$1 RETURNING *", [row.id])).rows[0] as EditionRow;
      } else {
        publicRecordOrigin();
        if (row.state !== "reviewed" || !row.reviewed_at) throw new WorldKitError("forbidden", "Review the exact public preview before the separate publish action.", 403);
        result = (await db.query("UPDATE wk_record_editions SET state='published',version=version+1,published_at=clock_timestamp() WHERE id=$1 RETURNING *", [row.id])).rows[0] as EditionRow;
        share = (await db.query("UPDATE wk_record_shares SET current_record_id=$2,version=version+1,withdrawn_at=NULL WHERE kit_id=$1 RETURNING *", [kit.id, row.id])).rows[0] as ShareRow;
      }
    }
    await activeSession(db, session.id);
    await db.query("INSERT INTO wk_record_intents(tenant_id,request_id,action,input_hash,record_id) VALUES($1,$2,$3,$4,$5)", [session.id, input.requestId, input.action, inputHash, result?.id ?? null]);
    await db.query("INSERT INTO wk_record_events(tenant_id,kit_id,record_id,action,input_hash,content_hash) VALUES($1,$2,$3,$4,$5,$6)", [session.id, kit.id, result?.id ?? null, input.action, inputHash, result?.content_hash ?? null]);
    const titles = { prepare: "Private certificate preview prepared", review: "Exact public preview reviewed", publish: "Certificate edition published", withdraw: "All shared certificate editions withdrawn" };
    await appendEvent(db, session.id, `certificate.${input.action}`, titles[input.action], input.action === "withdraw" ? "Public certificate, JSON, assembly, print and QR access are closed. Private records remain; saved copies cannot be recalled." : "This action preserves one immutable model record. Publication does not establish technical review or physical performance.", result?.revision_id ?? null, "modelled");
    return { record: result && share ? snapshot(result, share) : null, replayed: false };
  });
}

export async function publicRecordDesk(session: Session): Promise<PublicRecordDesk> {
  await initializePublicRecords();
  return transaction(async db => {
    const expiresAt = await activeSession(db, session.id), kit = await ownerKit(db, session.id), bundle = await savedBundle(db, session.id, kit.current_revision_id);
    const share = (await db.query("SELECT * FROM wk_record_shares WHERE kit_id=$1 AND tenant_id=$2", [kit.id, session.id])).rows[0] as ShareRow | undefined;
    const rows = share ? (await db.query("SELECT * FROM wk_record_editions WHERE kit_id=$1 AND tenant_id=$2 ORDER BY edition DESC", [kit.id, session.id])).rows as EditionRow[] : [];
    const records: PublicRecordDesk["records"] = [];
    for (const row of rows) {
      const record = snapshot(row, share!), sources = await sourceState(db, session.id, BindingSchema.parse(row.source_binding));
      const availability = row.state === "published" && !share!.withdrawn_at && sources.available ? "published" : row.state === "published" || row.state === "withdrawn" ? "withdrawn" : "private";
      records.push({ ...record, availability, currentSourceState: sources.available ? sources.changed ? "changed" : "recorded" : "unavailable" });
    }
    return { revisionId: kit.current_revision_id, graphHash: bundle.certificate.graphHash, revision: bundle.kit.revision, publicOrigin: publicRecordOrigin(), share: share ? { slug: share.slug, version: share.version, currentRecordId: share.current_record_id, withdrawnAt: iso(share.withdrawn_at) } : null, records, expiresAt };
  });
}

const emptyView = (state: "withdrawn" | "unavailable"): PublicRecordView => ({ state, record: null, revisionState: null, sourceState: null, checkedAt: new Date().toISOString(), expiresAt: null, editionUrl: null });

/** Public GETs only read saved projections. They never run verification or fetch a source. */
export async function readPublicRecord(slug: string, edition?: number): Promise<PublicRecordView> {
  if (!PublicSlugSchema.safeParse(slug).success) return emptyView("unavailable");
  await initializePublicRecords();
  return transaction(async db => {
    const identity = (await db.query("SELECT tenant_id,kit_id FROM wk_record_shares WHERE slug=$1", [slug])).rows[0];
    if (!identity) return emptyView("unavailable");
    // Match the mutation lock order: session → kit → share → edition → sources.
    const session = (await db.query("SELECT expires_at FROM wk_sessions WHERE id=$1 FOR SHARE", [identity.tenant_id])).rows[0];
    const kit = (await db.query("SELECT current_revision_id FROM wk_kits WHERE id=$1 AND tenant_id=$2 FOR SHARE", [identity.kit_id, identity.tenant_id])).rows[0];
    const share = (await db.query("SELECT * FROM wk_record_shares WHERE slug=$1 FOR SHARE", [slug])).rows[0] as ShareRow | undefined;
    if (!share || !session || !kit) return emptyView("unavailable");
    const row = (await db.query(`SELECT * FROM wk_record_editions WHERE kit_id=$1 AND tenant_id=$2 AND ${edition === undefined ? "id=$3" : "edition=$3"} FOR SHARE`, [share.kit_id, share.tenant_id, edition ?? share.current_record_id])).rows[0] as EditionRow | undefined;
    // A guessed draft number reveals neither private content nor its existence.
    if (!row || !["published", "withdrawn"].includes(row.state)) return emptyView("unavailable");
    if (share.withdrawn_at || row.state !== "published" || new Date(session.expires_at).getTime() <= Date.now()) return emptyView("withdrawn");
    try {
      const sources = await sourceState(db, share.tenant_id, BindingSchema.parse(row.source_binding), true);
      if (!sources.available) return emptyView("withdrawn");
      const record = snapshot(row, share);
      if (new Date(session.expires_at).getTime() <= Date.now()) return emptyView("withdrawn");
      return { state: "published", record, revisionState: row.revision_id === kit.current_revision_id ? "current" : "superseded", sourceState: sources.changed ? "changed" : "recorded", checkedAt: new Date().toISOString(), expiresAt: new Date(session.expires_at).toISOString(), editionUrl: publicRecordUrl(slug, row.edition) };
    } catch (error) {
      if (error instanceof WorldKitError || error instanceof z.ZodError) return emptyView("withdrawn");
      throw error;
    }
  });
}

export async function privateRecord(session: Session, recordId: string): Promise<PublicRecordSnapshot> {
  await initializePublicRecords();
  return transaction(async db => {
    await activeSession(db, session.id);
    const row = (await db.query("SELECT e.* FROM wk_record_editions e WHERE e.id=$1 AND e.tenant_id=$2", [recordId, session.id])).rows[0] as EditionRow | undefined;
    if (!row) throw new WorldKitError("not_found", "That edition does not belong to this workspace.", 404);
    const share = (await db.query("SELECT * FROM wk_record_shares WHERE kit_id=$1 AND tenant_id=$2", [row.kit_id, session.id])).rows[0] as ShareRow;
    return snapshot(row, share);
  });
}
