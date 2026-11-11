import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { CatalogSnapshotSchema, WorldKitError, type CatalogSnapshot, type DeviceProfile, type KitRevision, type Source } from "../../packages/contracts/index";
import { architectures, profiles as library, sources as librarySources } from "../../packages/device-library/index";
import { hash, verifyKit } from "../../packages/compatibility/index";
import { InventoryItemSchema, type InventoryConfirmation, type InventoryHistory, type InventoryItem, type InventoryPreview, type InventoryRegion, type InventoryWorkspace } from "../../packages/inventory/contracts";
import { assertExactSelection, confirmedProfile, engineeringId, profileChoice } from "../../packages/inventory/identity";
import { database, initialize, transaction } from "./db";
import { appendEvent, getRevision, getSnapshots, saveRevision, type RevisionBundle, type Session } from "./repository";
import { photoRecord, publicPhoto, storageReady } from "./inventory-photos";
import { evidenceLibrary } from "./source-evidence";

type Prepared = { item: InventoryItem; input: InventoryConfirmation; bundle: RevisionBundle | null; preview: InventoryPreview; previewHash: string };
export async function getInventory(session: Session): Promise<InventoryWorkspace> {
  await initialize();
  const [items, photos, regions, history, candidates] = await Promise.all([
    database().query("SELECT payload FROM wk_inventory_items WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100", [session.id]),
    database().query("SELECT * FROM wk_inventory_photos WHERE tenant_id=$1 AND status IN ('active','deleting') ORDER BY created_at DESC LIMIT 12", [session.id]),
    database().query("SELECT r.payload FROM wk_inventory_regions r JOIN wk_inventory_photos p ON p.id=r.photo_id WHERE r.tenant_id=$1 AND p.status='active' ORDER BY r.created_at DESC LIMIT 100", [session.id]),
    database().query("SELECT payload FROM wk_inventory_history WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100", [session.id]),
    evidenceLibrary(session.id),
  ]);
  return { items: items.rows.map(row => InventoryItemSchema.parse(row.payload)), photos: photos.rows.map(publicPhoto), regions: regions.rows.map(row => row.payload as InventoryRegion), history: history.rows.map(row => row.payload as InventoryHistory), library: [...library, ...candidates.profiles].map(profileChoice), storageReady: storageReady() };
}
export async function getInventoryProfileChoices(session: Session) { return [...library, ...(await evidenceLibrary(session.id)).profiles].map(profileChoice); }
export async function getInventoryItem(tenantId: string, id: string): Promise<InventoryItem> {
  await initialize(); const result = await database().query("SELECT payload FROM wk_inventory_items WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  if (!result.rows[0]) throw new WorldKitError("not_found", "That item is not in this equipment passport.", 404);
  return InventoryItemSchema.parse(result.rows[0].payload);
}
export async function getCatalogSnapshot(tenantId: string, id: string, db?: PoolClient): Promise<CatalogSnapshot> {
  await initialize(); const result = await (db ?? database()).query("SELECT snapshot FROM wk_catalog WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  if (!result.rows[0]) throw new WorldKitError("not_found", "Discover and refresh this product in your own workspace first.", 404);
  return CatalogSnapshotSchema.parse(result.rows[0].snapshot);
}
async function confirmedSnapshot(tenantId: string, input: InventoryConfirmation, db?: PoolClient): Promise<CatalogSnapshot | null> {
  const read = db ?? database(); const snapshot = input.snapshotId ? await getCatalogSnapshot(tenantId, input.snapshotId, db) : null;
  if (snapshot) assertExactSelection(snapshot, input.selectedOptions);
  if (!snapshot && input.selectedOptions.length) throw new WorldKitError("invalid_identity", "Manual entries cannot claim catalog-selected options.");
  if (input.photoId || input.regionId) {
    if (!input.photoId || !input.regionId || !snapshot) throw new WorldKitError("invalid_identity", "A photo match needs the confirmed crop and its catalog result.");
    if (db) {
      const photo = await db.query("SELECT id FROM wk_inventory_photos WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE", [tenantId, input.photoId]);
      if (!photo.rowCount) throw new WorldKitError("not_found", "That photo is not available in this workspace.", 404);
    } else await photoRecord(tenantId, input.photoId);
    const region = await read.query("SELECT payload FROM wk_inventory_regions WHERE tenant_id=$1 AND id=$2 AND photo_id=$3", [tenantId, input.regionId, input.photoId]);
    const payload = region.rows[0]?.payload as InventoryRegion | undefined;
    if (!payload?.confirmedAt) throw new WorldKitError("invalid_identity", "Confirm the crop before attaching a product match.", 409);
    const snapshots = await read.query("SELECT snapshot FROM wk_catalog WHERE tenant_id=$1 AND id=ANY($2::text[])", [tenantId, payload.snapshotIds]);
    if (!snapshots.rows.some(row => row.snapshot.productId === snapshot.productId || row.snapshot.variantOptions?.some((option: { values: { productId: string }[] }) => option.values.some(value => value.productId === snapshot.productId)))) throw new WorldKitError("invalid_identity", "This product was not returned for that confirmed crop. Keep it as a separate catalog entry.", 409);
  }
  return snapshot;
}
function placeProfile(previous: RevisionBundle, item: InventoryItem, targets: string[], confirmOwnedReplacement: boolean, snapshots: CatalogSnapshot[], at: string, candidateSources: Source[] = []): { bundle: RevisionBundle; changesOwnedConstraint: boolean } {
  const kit = structuredClone(previous.kit); let changesOwnedConstraint = false;
  for (const target of targets) {
    const component = kit.components.find(c => c.id === target); const old = previous.profiles.find(p => p.id === component?.profileId);
    if (!component || !old) throw new WorldKitError("not_found", "That position is no longer part of this plan.", 404);
    const allowed = old.kind === item.profile.kind || ["recorder", "interface", "mixer"].includes(old.kind) && ["recorder", "interface", "mixer"].includes(item.profile.kind);
    if (!allowed) throw new WorldKitError("invalid_identity", `Choose a ${old.kind} for this position. Other equipment can stay in your passport.`);
    const requiredOwned = component.owned && kit.goal.requiredOwnedProfileIds.some(id => id === old.id || id === engineeringId(old));
    if (requiredOwned && (engineeringId(old) !== engineeringId(item.profile) || item.ownership !== "owned")) {
      if (item.ownership !== "owned" || !confirmOwnedReplacement) throw new WorldKitError("needs_evidence", "This position is required owned equipment. Explicitly confirm the corrected owned model before replacing it.", 409);
      changesOwnedConstraint = true;
      kit.goal.requiredOwnedProfileIds = kit.goal.requiredOwnedProfileIds.map(id => id === old.id || id === engineeringId(old) ? engineeringId(item.profile) : id);
      kit.goal.version += 1;
    }
    component.profileId = item.profile.id; component.owned = item.ownership === "owned";
    component.inventoryItemId = item.id; component.ownershipSource = "user_confirmed";
  }
  const allocated = kit.components.filter(component => component.inventoryItemId === item.id).reduce((count, component) => count + component.quantity, 0);
  if (allocated > item.quantity) throw new WorldKitError("needs_evidence", `This plan uses ${allocated} pieces of this equipment, but its passport quantity is ${item.quantity}. Confirm the correct quantity before using it in another position.`, 409);
  const profiles = [...previous.profiles.filter(p => p.id !== item.profile.id), item.profile];
  const neededSources = new Set(Object.values(item.profile.facts).flatMap(fact => fact.sourceIds));
  const additions = [...librarySources, ...candidateSources].filter(source => neededSources.has(source.id) && !previous.sources.some(old => old.id === source.id));
  const sources: Source[] = [...previous.sources, ...new Map(additions.map(source => [source.id, source])).values()];
  const revision: KitRevision = { ...kit, id: randomUUID(), parentRevisionId: previous.kit.id, revision: previous.kit.revision + 1, createdAt: at, sourceMode: "modelled" };
  return { bundle: { kit: revision, profiles, sources, certificate: verifyKit(revision, profiles, sources, architectures, snapshots, at) }, changesOwnedConstraint };
}
export async function previewInventory(session: Session, input: InventoryConfirmation): Promise<InventoryPreview & { previewHash: string }> {
  const [snapshot, previous, snapshots, candidates] = await Promise.all([confirmedSnapshot(session.id, input), getRevision(session.id), getSnapshots(session.id), evidenceLibrary(session.id)]);
  if (previous.kit.id !== input.expectedRevisionId || previous.certificate.graphHash !== input.expectedGraphHash) throw new WorldKitError("stale_revision", "Refresh the saved plan before checking this equipment.", 409);
  const oldItem = input.correctItemId ? await getInventoryItem(session.id, input.correctItemId) : null;
  if (oldItem && (oldItem.version !== input.expectedItemVersion || oldItem.status !== "active")) throw new WorldKitError("stale_revision", "This equipment entry changed. Reopen it before correcting the model.", 409);
  const at = new Date().toISOString(); const id = oldItem?.id ?? randomUUID(); const version = (oldItem?.version ?? 0) + 1;
  const profile = confirmedProfile(`inventory:${id}:v${version}`, input.identity, snapshot, [...previous.profiles, ...library.filter(p => !previous.profiles.some(old => old.id === p.id)), ...candidates.profiles], at); profile.version = version;
  const item = InventoryItemSchema.parse({ id, version, profile, ownership: input.identity.ownership, quantity: input.identity.quantity, condition: input.identity.condition, accessories: input.identity.accessories, notes: input.identity.notes,
    status: "active", origin: snapshot ? input.photoId ? "photo_crop" : "catalog" : "manual", snapshotId: snapshot?.id ?? null, photoId: input.photoId, regionId: input.regionId, confirmedAt: at, createdAt: oldItem?.createdAt ?? at, updatedAt: at });
  const targets = [...new Set([...(input.targetComponentId ? [input.targetComponentId] : []), ...previous.kit.components.filter(c => oldItem && c.inventoryItemId === oldItem.id).map(c => c.id)])];
  const placed = targets.length ? placeProfile(previous, item, targets, input.confirmOwnedReplacement, snapshots, at, candidates.sources) : null;
  const preview: InventoryPreview = { profile, certificate: placed?.bundle.certificate ?? null, previousProfile: previous.profiles.find(p => p.id === previous.kit.components.find(c => c.id === input.targetComponentId)?.profileId)?.model ?? null, targetComponentId: input.targetComponentId,
    changesOwnedConstraint: placed?.changesOwnedConstraint ?? false, warnings: ["Your identity confirmation does not approve engineering facts or prove physical performance.", ...(!profile.ports.length ? ["This candidate has no source-backed port map yet. Any affected connections will need evidence."] : []), ...(oldItem && targets.length ? [`Correcting this item rechecks ${targets.length} position${targets.length === 1 ? "" : "s"} in the current plan. Historical revisions stay intact.`] : [])] };
  const previewHash = hash({ input, profile, graph: placed?.bundle.certificate.graphHash ?? null });
  const prepared: Prepared = { item, input, bundle: placed?.bundle ?? null, preview, previewHash };
  await database().query("INSERT INTO wk_inventory_proposals(id,tenant_id,input_hash,payload,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes') ON CONFLICT(tenant_id,id) DO UPDATE SET input_hash=EXCLUDED.input_hash,payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at", [input.requestId, session.id, hash(input), prepared]);
  return { ...preview, previewHash };
}
async function inventoryHistory(db: PoolClient, tenantId: string, item: InventoryItem, title: string, detail: string) {
  const history: InventoryHistory = { id: randomUUID(), itemId: item.id, version: item.version, at: new Date().toISOString(), title, detail };
  await db.query("INSERT INTO wk_inventory_history(id,tenant_id,item_id,version,payload) VALUES($1,$2,$3,$4,$5)", [history.id, tenantId, item.id, item.version, history]);
}
export async function confirmInventory(session: Session, input: InventoryConfirmation, previewHash: string): Promise<InventoryItem> {
  return transaction(async db => {
    const sessionRow = await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>now() FOR UPDATE", [session.id]);
    if (!sessionRow.rowCount) throw new WorldKitError("forbidden", "This workspace has expired.", 401);
    const existing = await db.query("SELECT payload,input_hash,preview_hash FROM wk_inventory_confirmations WHERE tenant_id=$1 AND request_id=$2", [session.id, input.requestId]);
    if (existing.rows[0]) { if (existing.rows[0].input_hash !== hash(input) || existing.rows[0].preview_hash !== previewHash) throw new WorldKitError("stale_revision", "This confirmation was already used for another item or preview.", 409); return InventoryItemSchema.parse(existing.rows[0].payload); }
    await confirmedSnapshot(session.id, input, db);
    const proposal = await db.query("SELECT payload FROM wk_inventory_proposals WHERE tenant_id=$1 AND id=$2 AND input_hash=$3 AND expires_at>now() FOR UPDATE", [session.id, input.requestId, hash(input)]);
    const prepared = proposal.rows[0]?.payload as Prepared | undefined;
    if (!prepared || prepared.previewHash !== previewHash) throw new WorldKitError("stale_revision", "Review this exact model and its effect on the plan before saving it.", 409);
    const current = await db.query("SELECT id,current_revision_id FROM wk_kits WHERE tenant_id=$1 ORDER BY created_at LIMIT 1 FOR UPDATE", [session.id]);
    if (current.rows[0]?.current_revision_id !== input.expectedRevisionId) throw new WorldKitError("stale_revision", "This plan changed after the preview. Check the replacement again.", 409);
    const item = prepared.item;
    if (input.correctItemId) {
      const changed = await db.query("UPDATE wk_inventory_items SET version=$3,payload=$4,request_id=$5,request_hash=$6 WHERE tenant_id=$1 AND id=$2 AND version=$7 RETURNING id", [session.id, input.correctItemId, item.version, item, input.requestId, hash(input), input.expectedItemVersion]);
      if (!changed.rowCount) throw new WorldKitError("stale_revision", "This equipment entry changed after the preview.", 409);
    } else {
      const count = await db.query("SELECT count(*)::int AS count FROM wk_inventory_items WHERE tenant_id=$1", [session.id]);
      if (count.rows[0].count >= 100) throw new WorldKitError("rate_limited", "This workspace has reached its equipment-entry limit.", 429);
      await db.query("INSERT INTO wk_inventory_items(id,tenant_id,version,request_id,request_hash,payload) VALUES($1,$2,$3,$4,$5,$6)", [item.id, session.id, item.version, input.requestId, hash(input), item]);
    }
    if (prepared.bundle) {
      await saveRevision(db, session.id, prepared.bundle);
      await db.query("UPDATE wk_kits SET current_revision_id=$2 WHERE tenant_id=$1 AND id=$3", [session.id, prepared.bundle.kit.id, prepared.bundle.kit.kitId]);
    }
    await db.query("INSERT INTO wk_inventory_confirmations(tenant_id,request_id,input_hash,preview_hash,item_id,payload) VALUES($1,$2,$3,$4,$5,$6)", [session.id, input.requestId, hash(input), previewHash, item.id, item]);
    await inventoryHistory(db, session.id, item, input.correctItemId ? "Exact model corrected" : "Exact equipment confirmed", `${item.profile.manufacturer} ${item.profile.model} · ${item.profile.variant}. ${item.ownership === "owned" ? "You confirmed ownership." : "Saved as a planned purchase."} Engineering reviews remain unchanged.`);
    await appendEvent(db, session.id, input.correctItemId ? "inventory.corrected" : "inventory.confirmed", input.correctItemId ? "Equipment corrected and rechecked" : "Your exact equipment is saved", `${item.profile.manufacturer} ${item.profile.model}. ${prepared.bundle ? `Plan revision ${prepared.bundle.kit.revision} is saved with fresh checks.` : "Ready in your equipment passport."} Prior proofs and purchases remain in history.`, prepared.bundle?.kit.id ?? null, snapshotMode(item));
    return item;
  });
}
const snapshotMode = (item: InventoryItem) => item.snapshotId ? "live" as const : "modelled" as const;
export async function updateInventoryNotes(session: Session, id: string, expectedVersion: number, values: { notes: string; accessories: string[]; status: "active" | "archived" }) {
  return transaction(async db => {
    const result = await db.query("SELECT payload FROM wk_inventory_items WHERE tenant_id=$1 AND id=$2 AND version=$3 FOR UPDATE", [session.id, id, expectedVersion]);
    if (!result.rows[0]) throw new WorldKitError("stale_revision", "This equipment entry changed. Refresh before editing it.", 409);
    const previous = InventoryItemSchema.parse(result.rows[0].payload); const item = InventoryItemSchema.parse({ ...previous, ...values, version: previous.version + 1, updatedAt: new Date().toISOString() });
    await db.query("UPDATE wk_inventory_items SET version=$3,payload=$4 WHERE tenant_id=$1 AND id=$2", [session.id, id, item.version, item]);
    await inventoryHistory(db, session.id, item, item.status === "archived" ? "Archived from your passport" : "Equipment notes updated", "Historical kit revisions keep the exact equipment identity they used. Notes and accessories do not change technical facts.");
    return item;
  });
}
export async function previewPlacement(session: Session, itemId: string, target: string, expectedRevisionId: string, expectedGraphHash: string, confirmOwnedReplacement = false) {
  const [item, previous, snapshots, candidates] = await Promise.all([getInventoryItem(session.id, itemId), getRevision(session.id), getSnapshots(session.id), evidenceLibrary(session.id)]);
  if (item.status !== "active") throw new WorldKitError("invalid_request", "Restore this archived item before using it in the plan.", 409);
  if (previous.kit.id !== expectedRevisionId || previous.certificate.graphHash !== expectedGraphHash) throw new WorldKitError("stale_revision", "Refresh the plan before placing this equipment.", 409);
  return { item, ...placeProfile(previous, item, [target], confirmOwnedReplacement, snapshots, new Date().toISOString(), candidates.sources) };
}
export async function applyPlacement(session: Session, input: { itemId: string; target: string; expectedRevisionId: string; expectedGraphHash: string; previewGraphHash: string; confirmOwnedReplacement: boolean }) {
  const prepared = await previewPlacement(session, input.itemId, input.target, input.expectedRevisionId, input.expectedGraphHash, input.confirmOwnedReplacement);
  if (prepared.bundle.certificate.graphHash !== input.previewGraphHash) throw new WorldKitError("stale_revision", "The equipment changed after you checked it. Review the new result.", 409);
  await transaction(async db => {
    const kit = await db.query("SELECT id,current_revision_id FROM wk_kits WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [session.id, prepared.bundle.kit.kitId]);
    const item = await db.query("SELECT version FROM wk_inventory_items WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [session.id, input.itemId]);
    if (kit.rows[0]?.current_revision_id !== input.expectedRevisionId || item.rows[0]?.version !== prepared.item.version) throw new WorldKitError("stale_revision", "This plan or equipment entry changed. Review it again.", 409);
    await saveRevision(db, session.id, prepared.bundle); await db.query("UPDATE wk_kits SET current_revision_id=$1 WHERE id=$2", [prepared.bundle.kit.id, prepared.bundle.kit.kitId]);
    await appendEvent(db, session.id, "inventory.placed", "Equipment joined the plan", `${prepared.item.profile.model} is now in ${input.target}. Every requirement was rechecked.`, prepared.bundle.kit.id, snapshotMode(prepared.item));
  });
}
