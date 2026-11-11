import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { CertificateSchema, KitSchema, WorldKitError, type CatalogReceipt, type CatalogSnapshot, type Certificate, type DeviceProfile, type Event, type KitRevision, type Principal, type Quote, type Source, type ToolScope, type Workspace } from "../../packages/contracts/index";
import { architectures, profiles, seedKit, sources } from "../../packages/device-library/index";
import { generateAssembly, hash, suggestRepairs, verifyKit } from "../../packages/compatibility/index";
import { editKit, type Edit } from "../../packages/workbench/index";
import { database, initialize, transaction } from "./db";

export type Session = { id: string; expiresAt: string; discoveryRequests: number; liveRebuilds: number };
export type RevisionBundle = { kit: KitRevision; certificate: Certificate; profiles: DeviceProfile[]; sources: Source[] };
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const limits = { discoveryRequests: 80, liveRebuilds: 12 };
const now = () => new Date().toISOString();
export async function appendEvent(db: PoolClient, tenantId: string, type: string, title: string, detail: string, revisionId: string | null, sourceMode: Event["sourceMode"] = "modelled") {
  const payload = { id: randomUUID(), type, at: now(), title, detail, sourceMode, revisionId };
  await db.query("INSERT INTO wk_events(id,tenant_id,payload) VALUES($1,$2,$3)", [payload.id, tenantId, payload]);
}
export async function saveRevision(db: PoolClient, tenantId: string, bundle: RevisionBundle) {
  KitSchema.parse(bundle.kit); CertificateSchema.parse(bundle.certificate);
  await db.query("INSERT INTO wk_revisions(id,kit_id,tenant_id,revision,kit,certificate,profiles,sources) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [bundle.kit.id, bundle.kit.kitId, tenantId, bundle.kit.revision, bundle.kit, bundle.certificate, JSON.stringify(bundle.profiles), JSON.stringify(bundle.sources)]);
}
export async function createSession(): Promise<{ token: string; session: Session }> {
  const token = randomBytes(32).toString("base64url"); const id = randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const kitId = randomUUID(); const kit = { ...seedKit("T2", randomUUID()), kitId, createdAt: now() };
  await transaction(async db => {
    await db.query("INSERT INTO wk_sessions(id,token_hash,expires_at) VALUES($1,$2,$3)", [id, tokenHash(token), expiresAt]);
    await db.query("INSERT INTO wk_kits(id,tenant_id,current_revision_id) VALUES($1,$2,$3)", [kitId, id, kit.id]);
    await saveRevision(db, id, { kit, certificate: verifyKit(kit, profiles, sources, architectures), profiles, sources });
    await appendEvent(db, id, "workspace.created", "Your sample studio is ready", "A private copy of the two-musician scenario. Sample possessions and modeled checks are clearly marked.", kit.id, "sample");
  });
  return { token, session: { id, expiresAt, discoveryRequests: 0, liveRebuilds: 0 } };
}
export async function findSession(token: string | undefined): Promise<Session | null> {
  if (!token || token.length > 200) return null; await initialize();
  const result = await database().query("SELECT id,expires_at,discovery_requests,live_rebuilds FROM wk_sessions WHERE token_hash=$1 AND expires_at>now()", [tokenHash(token)]);
  const row = result.rows[0];
  return row ? { id: row.id, expiresAt: row.expires_at.toISOString(), discoveryRequests: row.discovery_requests, liveRebuilds: row.live_rebuilds } : null;
}
export async function getRevision(tenantId: string, revisionId?: string): Promise<RevisionBundle> {
  await initialize();
  const result = revisionId
    ? await database().query("SELECT kit,certificate,profiles,sources FROM wk_revisions WHERE tenant_id=$1 AND id=$2", [tenantId, revisionId])
    : await database().query("SELECT r.kit,r.certificate,r.profiles,r.sources FROM wk_kits k JOIN wk_revisions r ON r.id=k.current_revision_id WHERE k.tenant_id=$1 ORDER BY k.created_at LIMIT 1", [tenantId]);
  if (!result.rows[0]) throw new WorldKitError("not_found", "That saved kit does not belong to this session.", 404);
  return result.rows[0] as RevisionBundle;
}
export async function getSnapshots(tenantId: string): Promise<CatalogSnapshot[]> {
  await initialize(); const result = await database().query("SELECT snapshot FROM wk_catalog WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 80", [tenantId]);
  return result.rows.map(r => r.snapshot as CatalogSnapshot);
}
export async function getWorkspace(session: Session): Promise<Workspace> {
  const [bundle, snapshots, events, receipts, usage] = await Promise.all([
    getRevision(session.id), getSnapshots(session.id),
    database().query("SELECT sequence,payload FROM wk_events WHERE tenant_id=$1 ORDER BY sequence DESC LIMIT 100", [session.id]),
    database().query("SELECT payload FROM wk_provider_receipts WHERE tenant_id=$1 AND provider='channel3' ORDER BY created_at DESC LIMIT 50", [session.id]),
    database().query("SELECT discovery_requests,live_rebuilds FROM wk_sessions WHERE id=$1", [session.id]),
  ]);
  const checks = await database().query("SELECT step_id FROM wk_step_checks WHERE tenant_id=$1 AND revision_id=$2 AND completed=true", [session.id, bundle.kit.id]);
  const alternatives = architectures.map(template => {
    const kit = { ...editKit(bundle.kit, bundle.certificate, { kind: "template", templateId: template.id }, bundle.profiles), id: `${bundle.kit.id}:compare:${template.id}` };
    return { kit, certificate: verifyKit(kit, bundle.profiles, bundle.sources, architectures, snapshots, bundle.certificate.issuedAt) };
  });
  return { session: { id: session.id, expiresAt: session.expiresAt }, ...bundle, architectures, alternatives, snapshots,
    receipts: receipts.rows.map(r => r.payload as CatalogReceipt), events: events.rows.map(r => ({ ...r.payload, sequence: Number(r.sequence) })),
    assembly: generateAssembly(bundle.kit, bundle.profiles), completedSteps: checks.rows.map(r => r.step_id), repairOptions: suggestRepairs(bundle.kit, bundle.certificate, bundle.profiles),
    usage: { discoveryRequests: usage.rows[0].discovery_requests, maxDiscoveryRequests: limits.discoveryRequests, liveRebuilds: usage.rows[0].live_rebuilds, maxLiveRebuilds: limits.liveRebuilds } };
}
export async function commitEdit(session: Session, expectedRevisionId: string, expectedGraphHash: string, edit: Edit): Promise<RevisionBundle> {
  return transaction(async db => {
    const lock = await db.query("SELECT id,current_revision_id FROM wk_kits WHERE tenant_id=$1 ORDER BY created_at LIMIT 1 FOR UPDATE", [session.id]);
    const row = lock.rows[0];
    if (!row || row.current_revision_id !== expectedRevisionId) throw new WorldKitError("stale_revision", "This plan changed in another view. Refresh it before editing.", 409, "Refresh the workbench");
    const result = await db.query("SELECT kit,certificate,profiles,sources FROM wk_revisions WHERE id=$1 AND tenant_id=$2", [expectedRevisionId, session.id]);
    const previous = result.rows[0] as RevisionBundle;
    if (previous.certificate.graphHash !== expectedGraphHash) throw new WorldKitError("stale_revision", "The graph no longer matches that action.", 409);
    const next = editKit(previous.kit, previous.certificate, edit, previous.profiles);
    const kit = { ...next, id: randomUUID(), parentRevisionId: previous.kit.id, revision: previous.kit.revision + 1, createdAt: now(), sourceMode: "modelled" as const };
    const snapshots = await db.query("SELECT snapshot FROM wk_catalog WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 80", [session.id]);
    const bundle = { kit, profiles: previous.profiles, sources: previous.sources, certificate: verifyKit(kit, previous.profiles, previous.sources, architectures, snapshots.rows.map(r => r.snapshot)) };
    await saveRevision(db, session.id, bundle);
    await db.query("UPDATE wk_kits SET current_revision_id=$1 WHERE id=$2", [kit.id, kit.kitId]);
    await appendEvent(db, session.id, `kit.${edit.kind}`, edit.kind === "repair" ? "Repair applied and checked" : "Plan updated and checked", `Revision ${kit.revision}: ${bundle.certificate.counts.satisfied} checks satisfied, ${bundle.certificate.counts.violated} conflicts, ${bundle.certificate.counts.unknown} open questions. Previous revisions are preserved.`, kit.id);
    return bundle;
  });
}
export async function setStep(session: Session, revisionId: string, stepId: string, completed: boolean) {
  const bundle = await getRevision(session.id, revisionId);
  if (!generateAssembly(bundle.kit, bundle.profiles).some(s => s.id === stepId)) throw new WorldKitError("not_found", "Unknown assembly step.", 404);
  await database().query("INSERT INTO wk_step_checks(tenant_id,revision_id,step_id,completed) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,revision_id,step_id) DO UPDATE SET completed=EXCLUDED.completed,updated_at=now()", [session.id, revisionId, stepId, completed]);
}
export async function reserveUsage(tenantId: string, kind: "discovery" | "model", db?: PoolClient) {
  await initialize();
  const column = kind === "discovery" ? "discovery_requests" : "live_rebuilds"; const limit = kind === "discovery" ? limits.discoveryRequests : limits.liveRebuilds;
  const result = await (db ?? database()).query(`UPDATE wk_sessions SET ${column}=${column}+1 WHERE id=$1 AND expires_at>now() AND ${column}<$2 RETURNING id`, [tenantId, limit]);
  if (!result.rowCount) throw new WorldKitError("rate_limited", `This workspace has used its ${kind === "discovery" ? "catalog request" : "model request"} allowance. Your saved work is still available.`, 429);
}
export async function saveCatalogResult(tenantId: string, snapshots: CatalogSnapshot[], receipt: CatalogReceipt) {
  await transaction(db => saveCatalogResultInTransaction(db, tenantId, snapshots, receipt));
}
export async function saveCatalogResultInTransaction(db: PoolClient, tenantId: string, snapshots: CatalogSnapshot[], receipt: CatalogReceipt) {
    for (const snapshot of snapshots) await db.query("INSERT INTO wk_catalog(id,tenant_id,product_id,snapshot) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING", [snapshot.id, tenantId, snapshot.productId, snapshot]);
    await db.query("INSERT INTO wk_provider_receipts(id,tenant_id,provider,payload) VALUES($1,$2,'channel3',$3) ON CONFLICT(id) DO NOTHING", [receipt.id, tenantId, receipt]);
    await appendEvent(db, tenantId, `catalog.${receipt.operation}`, receipt.status === "succeeded" ? "Current catalog evidence received" : "Catalog request did not complete", receipt.status === "succeeded" ? `${receipt.resultIds.length} product identities returned for “${receipt.query.slice(0, 180)}”. Retailer fulfillment is separate.` : receipt.error ?? "The provider is unavailable.", null, "live");
}
export async function createAccessToken(session: Session, scopes: ToolScope[]) {
  const bundle = await getRevision(session.id); const token = `wk_${randomBytes(32).toString("base64url")}`; const id = randomUUID();
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  await database().query("INSERT INTO wk_access_tokens(id,token_hash,tenant_id,scopes,kit_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6)", [id, tokenHash(token), session.id, JSON.stringify(scopes), JSON.stringify([bundle.kit.kitId]), expiresAt]);
  return { id, token, scopes, kitId: bundle.kit.kitId, expiresAt };
}
export async function revokeAccessToken(session: Session, id: string) { await initialize(); await database().query("UPDATE wk_access_tokens SET revoked_at=now() WHERE id=$1 AND tenant_id=$2", [id, session.id]); }
export async function authenticateAccess(token: string): Promise<Principal | null> {
  await initialize(); if (token.length > 200) return null;
  const result = await database().query("UPDATE wk_access_tokens t SET request_count=request_count+1 FROM wk_sessions s WHERE t.tenant_id=s.id AND t.token_hash=$1 AND t.expires_at>now() AND s.expires_at>now() AND t.revoked_at IS NULL AND t.request_count<500 RETURNING t.id,t.tenant_id,t.scopes,t.kit_ids,t.expires_at", [tokenHash(token)]);
  const row = result.rows[0]; return row ? { id: row.id, tenantId: row.tenant_id, kind: "external", scopes: row.scopes, allowedKitIds: row.kit_ids, expiresAt: row.expires_at.toISOString() } : null;
}
export async function currentAccess(principal: Principal, scope: ToolScope): Promise<Principal> {
  await initialize();
  const row = (await database().query("SELECT t.id,t.tenant_id,t.scopes,t.kit_ids,least(t.expires_at,s.expires_at) AS expires_at FROM wk_access_tokens t JOIN wk_sessions s ON s.id=t.tenant_id WHERE t.id=$1 AND t.tenant_id=$2 AND t.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp() AND t.revoked_at IS NULL", [principal.id, principal.tenantId])).rows[0];
  if (!row || !row.scopes.includes(scope)) throw new WorldKitError("forbidden", "This scoped grant or its workspace expired, was revoked, or does not permit this resource.", 403);
  return { id: row.id, tenantId: row.tenant_id, kind: "external", scopes: row.scopes, allowedKitIds: row.kit_ids, expiresAt: new Date(row.expires_at).toISOString() };
}
export async function createQuote(tenantId: string, bundle: RevisionBundle): Promise<Quote> {
  const createdAt = now(); const items = [
    { sku: "wk-routing-dossier", name: "WorldKit Studio · source-linked routing dossier", quantity: 1, unitMinor: 800, profileId: null },
    { sku: "wk-assembly-guide", name: "WorldKit Studio · connection and assembly guide", quantity: 1, unitMinor: 400, profileId: null },
  ];
  const value = { tenantId, revisionId: bundle.kit.id, verificationId: bundle.certificate.id, graphHash: bundle.certificate.graphHash, merchantId: "worldkit-studio" as const, merchantName: "WorldKit Studio" as const, items, total: { currency: "USD" as const, minor: 1200 }, createdAt, expiresAt: new Date(Date.now() + 900000).toISOString(), policyVersion: "studio-sandbox.v1" as const, source: "sample" as const, checkoutRequired: true as const };
  const quote: Quote = { ...value, id: randomUUID(), quoteHash: hash(value) };
  await database().query("INSERT INTO wk_quotes(id,tenant_id,payload) VALUES($1,$2,$3)", [quote.id, tenantId, quote]); return quote;
}
export async function startJob(session: Session, kind: string, input: unknown): Promise<string> {
  const id = randomUUID(); await database().query("INSERT INTO wk_jobs(id,tenant_id,kind,status,input) VALUES($1,$2,$3,'running',$4)", [id, session.id, kind, input]); return id;
}
export async function finishJob(session: Session, id: string, output: unknown, error: string | null = null) {
  await database().query("UPDATE wk_jobs SET status=$1,output=$2,error=$3,updated_at=now() WHERE id=$4 AND tenant_id=$5", [error ? "failed" : "succeeded", output, error, id, session.id]);
}
