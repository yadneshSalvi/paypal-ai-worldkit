import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { WorldKitError, type Principal } from "../../packages/contracts";
import { hash } from "../../packages/compatibility";
import { InventoryItemSchema, type InventoryItem } from "../../packages/inventory/contracts";
import { engineeringId } from "../../packages/inventory/identity";
import { manifestFor, packHash, packManifests, sourcesFor } from "../../packages/domain-packs/catalog";
import { assertPackEdition, makePackEdition, packChanges, packGuide, packRequirements, verifyPack } from "../../packages/domain-packs/compiler";
import { PackCommandSchema, PackEditionSchema, type PackCommand, type PackCommandResult, type PackEdition, type PackFreshness, type PackHome, type PackPreview, type PackProfile, type PackProject, type PackState } from "../../packages/domain-packs/contracts";
import { database, transaction } from "./db";
import { initializeDomainPacks } from "./domain-packs-db";
import { currentAccess, type Session } from "./repository";

type ProjectRow = { id: string; pack_id: PackProject["packId"]; title: string; current_edition_id: string; version: number; created_at: Date; archived_at: Date | null };
const projectValue = (row: ProjectRow): PackProject => ({ id: row.id, packId: row.pack_id, title: row.title, currentEditionId: row.current_edition_id, version: row.version, createdAt: row.created_at.toISOString(), archivedAt: row.archived_at?.toISOString() ?? null });
async function authority(db: PoolClient, session: Session, write = false): Promise<Date> {
  const row = (await db.query(`SELECT expires_at FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR ${write ? "UPDATE" : "SHARE"}`, [session.id])).rows[0];
  if (!row) throw new WorldKitError("forbidden", "This private workspace has expired.", 401);
  return row.expires_at;
}
async function project(db: PoolClient, tenantId: string, id: string, write = false): Promise<PackProject> {
  const row = (await db.query<ProjectRow>(`SELECT * FROM wk_domain_projects WHERE tenant_id=$1 AND id=$2 FOR ${write ? "UPDATE" : "SHARE"}`, [tenantId, id])).rows[0];
  if (!row) throw new WorldKitError("not_found", "That system is not in this private workspace.", 404);
  return projectValue(row);
}
async function savedEdition(db: PoolClient, tenantId: string, projectId: string, id: string): Promise<PackEdition> {
  const row = (await db.query("SELECT payload FROM wk_domain_editions WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [tenantId, projectId, id])).rows[0];
  if (!row) throw new WorldKitError("not_found", "That edition does not belong to this system.", 404);
  const edition = PackEditionSchema.parse(row.payload); assertPackEdition(edition); return edition;
}
function exactIdentity(item: InventoryItem, target: PackProfile): boolean {
  return engineeringId(item.profile) === target.id && item.profile.manufacturer === target.manufacturer && item.profile.model === target.model && item.profile.variant === target.variant && item.profile.kind === target.kind;
}
async function inventory(db: PoolClient, tenantId: string): Promise<InventoryItem[]> {
  return (await db.query("SELECT payload FROM wk_inventory_items WHERE tenant_id=$1 ORDER BY id FOR SHARE", [tenantId])).rows.map(row => InventoryItemSchema.parse(row.payload));
}
function ownershipIssues(edition: PackEdition, items: InventoryItem[]): PackFreshness["issues"] {
  const issues: PackFreshness["issues"] = []; const allocations = new Map<string, number>();
  for (const binding of edition.graph.state.ownership) {
    const component = edition.graph.components.find(c => c.id === binding.componentId); const target = edition.profiles.find(p => p.id === component?.profileId); const item = items.find(item => item.id === binding.inventoryItemId);
    const invalid = !item || !target || item.status !== "active" || item.ownership !== "owned" || item.version !== binding.inventoryVersion || hash(item.profile) !== binding.profileHash || !exactIdentity(item, target) || binding.quantity !== component?.quantity;
    if (invalid) issues.push({ kind: "inventory", message: `The saved ownership claim for ${binding.componentId} no longer matches an active, exact equipment-passport entry. Rebind or remove the claim.`, componentIds: [binding.componentId] });
    allocations.set(binding.inventoryItemId, (allocations.get(binding.inventoryItemId) ?? 0) + binding.quantity);
  }
  for (const [id, allocated] of allocations) {
    const item = items.find(item => item.id === id);
    if (item && allocated > item.quantity) issues.push({ kind: "inventory", message: `${allocated} positions use this passport entry, but only ${item.quantity} pieces are confirmed.`, componentIds: edition.graph.state.ownership.filter(o => o.inventoryItemId === id).map(o => o.componentId) });
  }
  return issues;
}
function freshness(edition: PackEdition, items: InventoryItem[]): PackFreshness {
  const issues = ownershipIssues(edition, items);
  if (edition.packHash !== packHash(edition.graph.packId)) issues.push({ kind: "pack", message: "The installed pack, its rules or source edition changed. Review a fresh preview before saving or relying on current checks.", componentIds: [] });
  const current = sourcesFor(edition.graph.packId);
  for (const source of edition.sources) if (!current.some(s => s.id === source.id && s.contentHash === source.contentHash)) issues.push({ kind: "source", message: `${source.title} has a different current source fingerprint. The historical proof is preserved.`, componentIds: [] });
  return { current: !issues.length, issues };
}
function requireFreshOwnership(edition: PackEdition, items: InventoryItem[]) {
  const issues = ownershipIssues(edition, items);
  if (issues.length) throw new WorldKitError("invalid_identity", issues[0]!.message, 409, "Refresh the equipment passport and preview again");
}
function expectCurrent(project: PackProject, edition: PackEdition, command: { expectedEditionId: string; expectedVersion: number; expectedGraphHash: string }) {
  if (project.archivedAt) throw new WorldKitError("forbidden", "This system is archived. Its saved history remains available.", 403);
  if (project.version !== command.expectedVersion || project.currentEditionId !== command.expectedEditionId || edition.certificate.graphHash !== command.expectedGraphHash) throw new WorldKitError("stale_revision", "The saved system changed. Refresh it before preparing another edition.", 409);
}
async function insertEdition(db: PoolClient, tenantId: string, edition: PackEdition) {
  assertPackEdition(edition);
  await db.query("INSERT INTO wk_domain_editions(id,tenant_id,project_id,number,content_hash,graph_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7)", [edition.id, tenantId, edition.projectId, edition.number, edition.hash, edition.certificate.graphHash, edition]);
}
async function event(db: PoolClient, tenantId: string, projectId: string, kind: string, editionId: string | null, detail: Record<string, unknown>) {
  await db.query("INSERT INTO wk_domain_events(id,tenant_id,project_id,kind,edition_id,payload) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), tenantId, projectId, kind, editionId, { ...detail, sourceMode: "modelled", physicalTest: "not_performed" }]);
}
export async function domainHome(session: Session, projectId?: string, editionId?: string): Promise<PackHome> {
  await initializeDomainPacks();
  return transaction(async db => {
    await authority(db, session);
    const projects = (await db.query<ProjectRow>("SELECT * FROM wk_domain_projects WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 40", [session.id])).rows.map(projectValue);
    const selectedId = projectId ?? projects.find(p => !p.archivedAt)?.id;
    if (!selectedId) return { manifests: packManifests, projects, selected: null };
    const selectedProject = await project(db, session.id, selectedId); const edition = await savedEdition(db, session.id, selectedProject.id, editionId ?? selectedProject.currentEditionId); const items = await inventory(db, session.id);
    const history = (await db.query("SELECT id,number,content_hash,created_at,payload->>'reason' AS reason FROM wk_domain_editions WHERE tenant_id=$1 AND project_id=$2 ORDER BY number DESC LIMIT 100", [session.id, selectedId])).rows.map(row => ({ id: row.id, number: row.number, hash: row.content_hash, createdAt: row.created_at.toISOString(), reason: row.reason }));
    const grants = (await db.query("SELECT t.id,t.expires_at,t.revoked_at FROM wk_domain_grants g JOIN wk_access_tokens t ON t.id=g.id AND t.tenant_id=g.tenant_id WHERE g.tenant_id=$1 AND g.project_id=$2 ORDER BY g.created_at DESC LIMIT 30", [session.id, selectedId])).rows.map(row => ({ id: row.id, expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null }));
    const matching = items.filter(item => item.status === "active" && item.ownership === "owned").map(item => ({ id: item.id, version: item.version, label: `${item.profile.manufacturer} ${item.profile.model} · ${item.profile.variant}`, profileId: item.profile.id, profileHash: hash(item.profile), quantity: item.quantity, compatibleComponents: edition.graph.components.filter(component => { const p = edition.profiles.find(p => p.id === component.profileId); return p && exactIdentity(item, p); }).map(c => c.id) })).filter(item => item.compatibleComponents.length);
    const currentGraphHash = edition.id === selectedProject.currentEditionId ? edition.certificate.graphHash : (await savedEdition(db, session.id, selectedProject.id, selectedProject.currentEditionId)).certificate.graphHash;
    await authority(db, session);
    return { manifests: packManifests, projects, selected: { project: selectedProject, edition, currentGraphHash, history, freshness: freshness(edition, items), requirements: packRequirements(edition.graph.state), guide: packGuide(edition), inventory: matching, grants } };
  });
}
export async function domainCommand(session: Session, input: unknown): Promise<PackCommandResult> {
  const command = PackCommandSchema.parse(input); await initializeDomainPacks();
  return transaction(async db => {
    const sessionExpiry = await authority(db, session, true); const actor = `owner:${session.id}`; const inputHash = hash(command);
    const previous = (await db.query("SELECT input_hash,response FROM wk_domain_commands WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3", [session.id, actor, command.requestId])).rows[0];
    if (previous) { if (previous.input_hash !== inputHash) throw new WorldKitError("stale_revision", "This request identity was already used for a different action.", 409); return previous.response as PackCommandResult; }
    const count = (await db.query("SELECT count(*)::integer AS count FROM wk_domain_commands WHERE tenant_id=$1", [session.id])).rows[0].count;
    if (count >= 1500) throw new WorldKitError("rate_limited", "This workspace has reached its saved system action limit.", 429);
    let result: PackCommandResult;
    if (command.kind === "create") {
      const total = (await db.query("SELECT count(*)::integer AS count FROM wk_domain_projects WHERE tenant_id=$1", [session.id])).rows[0].count;
      if (total >= 40) throw new WorldKitError("rate_limited", "This workspace can retain up to 40 systems.", 429);
      const projectId = `pack_${randomUUID()}`; const id = `packrev_${randomUUID()}`;
      const edition = makePackEdition(structuredClone(manifestFor(command.packId).defaultState), { id, projectId, edition: 1, parentEditionId: null, title: command.title, at: new Date().toISOString() }, "Started from the pack’s documented example; ownership unclaimed.");
      await db.query("INSERT INTO wk_domain_projects(id,tenant_id,pack_id,title,current_edition_id,version) VALUES($1,$2,$3,$4,$5,1)", [projectId, session.id, command.packId, command.title, id]);
      await insertEdition(db, session.id, edition); await event(db, session.id, projectId, "created", id, { packId: command.packId, graphHash: edition.certificate.graphHash });
      result = { projectId, editionId: id };
    } else {
      const selected = await project(db, session.id, command.projectId, true); const current = await savedEdition(db, session.id, selected.id, selected.currentEditionId);
      if (command.kind === "revoke_grant") {
        const grant = (await db.query("SELECT id FROM wk_domain_grants WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [session.id, selected.id, command.grantId])).rows[0];
        if (!grant) throw new WorldKitError("not_found", "That agent grant does not belong to this system.", 404);
        await db.query("UPDATE wk_access_tokens SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE tenant_id=$1 AND id=$2", [session.id, grant.id]);
        await event(db, session.id, selected.id, "grant_revoked", current.id, { grantId: grant.id }); result = { projectId: selected.id, revoked: true };
      } else {
        expectCurrent(selected, current, command);
        if (command.kind === "archive") {
          await db.query("UPDATE wk_domain_projects SET archived_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2", [session.id, selected.id]);
          await db.query("UPDATE wk_access_tokens t SET revoked_at=COALESCE(t.revoked_at,clock_timestamp()) FROM wk_domain_grants g WHERE g.id=t.id AND g.tenant_id=$1 AND g.project_id=$2", [session.id, selected.id]);
          await event(db, session.id, selected.id, "archived", current.id, {}); result = { projectId: selected.id, archived: true };
        } else if (command.kind === "grant") {
          const active = (await db.query("SELECT count(*)::integer AS count FROM wk_domain_grants g JOIN wk_access_tokens t ON t.id=g.id WHERE g.tenant_id=$1 AND g.project_id=$2 AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp()", [session.id, selected.id])).rows[0].count;
          if (active >= 5) throw new WorldKitError("rate_limited", "Revoke an existing agent grant before creating another.", 429);
          const id = randomUUID(); const token = `wk_${randomBytes(32).toString("base64url")}`; const expiresAt = new Date(Math.min(Date.now() + 3600000, sessionExpiry.getTime())).toISOString();
          await db.query("INSERT INTO wk_access_tokens(id,token_hash,tenant_id,scopes,kit_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6)", [id, createHash("sha256").update(token).digest("hex"), session.id, JSON.stringify(["kit:verify"]), JSON.stringify([selected.id]), expiresAt]);
          await db.query("INSERT INTO wk_domain_grants(id,tenant_id,project_id) VALUES($1,$2,$3)", [id, session.id, selected.id]);
          await event(db, session.id, selected.id, "grant_created", current.id, { grantId: id, scopes: ["kit:verify"], expiresAt });
          result = { projectId: selected.id, grant: { id, token, expiresAt } };
        } else {
          const items = await inventory(db, session.id);
          if (command.kind === "apply") {
            const row = (await db.query("SELECT payload FROM wk_domain_previews WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND content_hash=$4 AND expires_at>clock_timestamp()", [session.id, selected.id, command.previewId, command.previewHash])).rows[0];
            const preview = row?.payload as PackPreview | undefined;
            if (!preview) throw new WorldKitError("stale_revision", "This preview expired or no longer matches the reviewed change.", 409);
            const { hash: expectedHash, ...content } = preview;
            if (hash(content) !== expectedHash || preview.expectedEditionId !== current.id || preview.expectedVersion !== selected.version || preview.expectedGraphHash !== current.certificate.graphHash || preview.packHash !== packHash(selected.packId) || preview.edition.projectId !== selected.id || preview.edition.graph.parentEditionId !== current.id || preview.edition.number !== selected.version + 1) throw new WorldKitError("stale_revision", "The preview’s exact system or source basis changed. Review a new preview.", 409);
            requireFreshOwnership(preview.edition, items); await insertEdition(db, session.id, preview.edition);
            await db.query("UPDATE wk_domain_projects SET current_edition_id=$3,version=version+1 WHERE tenant_id=$1 AND id=$2", [session.id, selected.id, preview.edition.id]);
            await event(db, session.id, selected.id, "edition_saved", preview.edition.id, { previewId: preview.id, previewHash: preview.hash, previousEditionId: current.id, changes: preview.changes });
            result = { projectId: selected.id, editionId: preview.edition.id };
          } else {
            let state: PackState; let reason: string;
            if (command.kind === "restore_preview") { const old = await savedEdition(db, session.id, selected.id, command.restoreEditionId); state = structuredClone(old.graph.state); reason = `Revisit edition ${old.number} using current pack sources. Historical edition retained.`; }
            else if (command.kind === "refresh_preview") { state = structuredClone(current.graph.state); reason = "Refresh the current plan against the installed pack and its current sources."; }
            else { state = command.state; reason = command.reason; }
            if (state.config.packId !== selected.packId) throw new WorldKitError("invalid_request", "Start a separate system to use another domain pack.");
            if (selected.version >= 100) throw new WorldKitError("rate_limited", "This system has reached its 100-edition limit.", 429);
            const edition = makePackEdition(state, { id: `packrev_${randomUUID()}`, projectId: selected.id, edition: selected.version + 1, parentEditionId: current.id, title: selected.title, at: new Date().toISOString() }, reason);
            requireFreshOwnership(edition, items);
            const content = { id: `packpreview_${randomUUID()}`, expectedEditionId: current.id, expectedVersion: selected.version, expectedGraphHash: current.certificate.graphHash, packHash: edition.packHash, state: edition.graph.state, edition, changes: packChanges(current.graph.state, edition.graph.state), expiresAt: new Date(Math.min(Date.now() + 600000, sessionExpiry.getTime())).toISOString(), reason, freshness: freshness(edition, items) };
            const preview: PackPreview = { ...content, hash: hash(content) };
            await db.query("INSERT INTO wk_domain_previews(id,tenant_id,project_id,content_hash,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6)", [preview.id, session.id, selected.id, preview.hash, preview, preview.expiresAt]);
            await event(db, session.id, selected.id, "preview_created", current.id, { previewId: preview.id, previewHash: preview.hash }); result = { projectId: selected.id, preview };
          }
        }
      }
    }
    await authority(db, session, true);
    // Bearer secrets are shown once, never persisted in command receipts or events.
    const stored: PackCommandResult = result.grant ? { ...result, grant: { id: result.grant.id, expiresAt: result.grant.expiresAt } } : result;
    await db.query("INSERT INTO wk_domain_commands(tenant_id,actor_id,request_id,kind,input_hash,response) VALUES($1,$2,$3,$4,$5,$6)", [session.id, actor, command.requestId, command.kind, inputHash, stored]);
    return result;
  });
}

export async function readScopedDomain(principal: Principal, editionId: string, expectedGraphHash: string, kind: "certificate" | "assembly", freshnessPolicy: "historical" | "current_sources" = "historical", projectId?: string) {
  await initializeDomainPacks(); const access = await currentAccess(principal, "kit:verify");
  if (!principal.scopes.includes("kit:verify") || Date.parse(principal.expiresAt) <= Date.now()) throw new WorldKitError("forbidden", "This agent grant is not current.", 403);
  const value = await transaction(async db => {
    const session = { id: access.tenantId, expiresAt: access.expiresAt, discoveryRequests: 0, liveRebuilds: 0 }; await authority(db, session);
    const row = (await db.query("SELECT e.project_id FROM wk_domain_editions e JOIN wk_domain_grants g ON g.project_id=e.project_id AND g.tenant_id=e.tenant_id WHERE e.tenant_id=$1 AND e.id=$2 AND g.id=$3", [access.tenantId, editionId, access.id])).rows[0];
    if (!row || !access.allowedKitIds.includes(row.project_id) || !principal.allowedKitIds.includes(row.project_id) || projectId && projectId !== row.project_id) throw new WorldKitError("forbidden", "This saved system is outside the exact agent grant.", 403);
    const selected = await project(db, access.tenantId, row.project_id); if (selected.archivedAt) throw new WorldKitError("forbidden", "This system is archived and its agent access has ended.", 403);
    const edition = await savedEdition(db, access.tenantId, selected.id, editionId);
    if (edition.certificate.graphHash !== expectedGraphHash) throw new WorldKitError("stale_revision", "The expected graph hash does not match this saved edition.", 409);
    const fresh = freshness(edition, await inventory(db, access.tenantId));
    // A newly retrieved document cannot silently inherit the old document's
    // extracted facts. Changed fingerprints make those facts unavailable.
    const matchingSources = sourcesFor(edition.graph.packId).filter(source => edition.sources.some(old => old.id === source.id && old.contentHash === source.contentHash));
    const certificate = freshnessPolicy === "current_sources" ? verifyPack(edition.graph, edition.profiles, matchingSources) : edition.certificate;
    await authority(db, session);
    return { schema: `worldkit.scoped-domain-${kind}.1`, access: "scoped_private", projectId: selected.id, editionId: edition.id, editionHash: edition.hash, graphHash: expectedGraphHash, currentEditionId: selected.currentEditionId, freshness: fresh, sourceMode: "modelled", physicalTest: "not_performed", authority: "Read-only planning evidence for this system; no purchase, repair, payment, physical-test or review authority.", certificate,
      ...(kind === "certificate" ? { requirements: packRequirements(edition.graph.state), profiles: edition.profiles, sources: edition.sources } : { title: selected.title, graph: edition.graph, assembly: packGuide(edition), sources: edition.sources }) };
  });
  const latest = await currentAccess(principal, "kit:verify");
  if (!latest.allowedKitIds.includes(value.projectId)) throw new WorldKitError("forbidden", "The system grant changed while it was being read.", 403);
  return value;
}
export async function listScopedDomains(principal: Principal, kind: "certificate" | "assembly") {
  await initializeDomainPacks(); const access = await currentAccess(principal, "kit:verify");
  const rows = (await database().query("SELECT e.id,e.project_id,e.number,e.graph_hash,p.title FROM wk_domain_editions e JOIN wk_domain_projects p ON p.id=e.project_id AND p.tenant_id=e.tenant_id JOIN wk_domain_grants g ON g.project_id=p.id AND g.tenant_id=p.tenant_id WHERE e.tenant_id=$1 AND g.id=$2 AND p.archived_at IS NULL AND p.id=ANY($3::text[]) ORDER BY e.number DESC LIMIT 100", [access.tenantId, access.id, access.allowedKitIds.filter(id => principal.allowedKitIds.includes(id))])).rows;
  const latest = await currentAccess(principal, "kit:verify");
  return { resources: rows.filter(row => latest.allowedKitIds.includes(row.project_id)).map(row => ({ uri: `worldkit://domains/${row.project_id}/${row.id}/${row.graph_hash}/${kind}`, name: `domain-${kind}-${row.id}`, title: `${row.title} · edition ${row.number} · ${kind}`, mimeType: "application/json", description: "Immutable system evidence with current freshness. Modeled routing; physical tests and human review remain pending." })) };
}
