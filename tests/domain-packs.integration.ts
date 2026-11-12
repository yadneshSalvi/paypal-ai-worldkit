import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DeviceSchema, WorldKitError, type Principal } from "../packages/contracts";
import { hash } from "../packages/compatibility";
import { packProfiles, packSources } from "../packages/domain-packs/catalog";
import { assertPackEdition } from "../packages/domain-packs/compiler";
import type { PackHome, PackId, PackOwnership, PackPreview, PackState } from "../packages/domain-packs/contracts";
import { ConfirmationSchema, InventoryItemSchema, type InventoryItem } from "../packages/inventory/contracts";
import { domainCommand, domainHome, listScopedDomains, readScopedDomain } from "../src/server/domain-packs";
import { closeDatabase, database } from "../src/server/db";
import { authenticateAccess, createAccessToken, createSession, getRevision, type Session } from "../src/server/repository";
import { handleMcp } from "../src/server/mcp";
import { confirmInventory, getInventoryProfileChoices, previewInventory, updateInventoryNotes } from "../src/server/inventory";
import { requireIsolatedDatabase } from "./support/isolated-database";

// This must run before any database call, including createSession. The stage9
// launcher permits only its new role/database on the dedicated loopback port.
requireIsolatedDatabase();
after(closeDatabase);

type Selected = NonNullable<PackHome["selected"]>;
type Fixture = { session: Session; home: Selected };
const current = (selected: Selected) => ({ projectId: selected.project.id, expectedEditionId: selected.project.currentEditionId, expectedVersion: selected.project.version, expectedGraphHash: selected.currentGraphHash });
async function fixture(packId: PackId = "podcast-classroom", session?: Session): Promise<Fixture> {
  const owner = session ?? (await createSession()).session;
  const result = await domainCommand(owner, { kind: "create", requestId: randomUUID(), packId, title: `Independent ${packId} validation` });
  const home = (await domainHome(owner, result.projectId)).selected;
  assert.ok(home);
  return { session: owner, home };
}
function podcastState(home: Selected): PackState {
  const state = structuredClone(home.edition.graph.state);
  assert.equal(state.config.packId, "podcast-classroom");
  if (state.config.packId === "podcast-classroom") Object.assign(state.config, { recorder: "podtrak-p8", storageConfirmed: true, powerConfirmed: true, keepTrackFiles: true, destination: "sd_card" });
  return state;
}
async function preview(f: Fixture, state = podcastState(f.home)): Promise<PackPreview> {
  const result = await domainCommand(f.session, { kind: "preview", requestId: randomUUID(), ...current(f.home), state, reason: "Independent review of the exact saved plan" });
  assert.ok(result.preview);
  return result.preview;
}
async function apply(f: Fixture, prepared: PackPreview, requestId = randomUUID()) {
  return domainCommand(f.session, { kind: "apply", requestId, ...current(f.home), previewId: prepared.id, previewHash: prepared.hash });
}
async function refresh(f: Fixture): Promise<Fixture> {
  const selected = (await domainHome(f.session, f.home.project.id)).selected;
  assert.ok(selected);
  return { session: f.session, home: selected };
}
async function grant(f: Fixture) {
  const result = await domainCommand(f.session, { kind: "grant", requestId: randomUUID(), ...current(f.home), confirmedReadOnly: true });
  assert.ok(result.grant?.token);
  const principal = await authenticateAccess(result.grant.token);
  assert.ok(principal);
  return { ...result.grant, token: result.grant.token, principal };
}
const rejected = (code: string, httpStatus?: number) => (error: unknown) => error instanceof WorldKitError && error.code === code && (httpStatus === undefined || error.status === httpStatus);
async function exactItem(f: Fixture, componentId = "voice-1", quantity = 1, changes: Partial<InventoryItem> = {}): Promise<InventoryItem> {
  const component = f.home.edition.graph.components.find(component => component.id === componentId)!;
  const target = f.home.edition.profiles.find(profile => profile.id === component.profileId)!;
  const id = `domain_inventory_${randomUUID()}`; const at = new Date().toISOString();
  const profile = DeviceSchema.parse({ ...structuredClone(target), id: `inventory:${id}:v1`, baseProfileId: target.id });
  const item = InventoryItemSchema.parse({ id, version: 1, profile, ownership: "owned", quantity, condition: "used", accessories: [], notes: "Fresh isolated domain validation item", status: "active", origin: "manual", snapshotId: null, photoId: null, regionId: null, confirmedAt: at, createdAt: at, updatedAt: at, ...changes });
  await database().query("INSERT INTO wk_inventory_items(id,tenant_id,version,request_id,request_hash,payload) VALUES($1,$2,$3,$4,$5,$6)", [item.id, f.session.id, item.version, randomUUID(), hash(item), item]);
  return item;
}
function binding(item: InventoryItem, componentId: string, quantity = 1): PackOwnership {
  return { componentId, inventoryItemId: item.id, inventoryVersion: item.version, profileHash: hash(item.profile), quantity };
}
async function replaceItem(f: Fixture, item: InventoryItem, changes: Partial<InventoryItem>): Promise<InventoryItem> {
  const next = InventoryItemSchema.parse({ ...item, ...changes, version: item.version + 1, updatedAt: new Date().toISOString() });
  await database().query("UPDATE wk_inventory_items SET version=$3,payload=$4 WHERE tenant_id=$1 AND id=$2", [f.session.id, item.id, next.version, next]);
  return next;
}

test("fresh sessions have no domain projects until explicitly created, and never rewrite the creator graph", async () => {
  const { session } = await createSession(); const creator = await getRevision(session.id);
  const empty = await domainHome(session);
  assert.deepEqual(empty.projects, []); assert.equal(empty.selected, null); assert.equal(empty.manifests.length, 2);
  const f = await fixture("desk-displays", session);
  assert.equal(f.home.project.version, 1); assert.equal(f.home.edition.number, 1);
  assert.equal(f.home.edition.graph.parentEditionId, null);
  assert.equal(f.home.edition.graph.state.config.packId, "desk-displays");
  assert.deepEqual(await getRevision(session.id), creator);
  assertPackEdition(f.home.edition);
});
test("a request identity is idempotent and cannot be reused with a changed create or preview payload", async () => {
  const { session } = await createSession(); const requestId = randomUUID();
  const command = { kind: "create", requestId, packId: "podcast-classroom", title: "One explicitly created system" };
  const first = await domainCommand(session, command);
  assert.deepEqual(await domainCommand(session, command), first);
  await assert.rejects(() => domainCommand(session, { ...command, title: "Changed payload" }), rejected("stale_revision", 409));
  const selected = (await domainHome(session, first.projectId)).selected!;
  const change = { kind: "preview", requestId: randomUUID(), ...current(selected), state: podcastState(selected), reason: "Review a six voice SD plan" };
  const prepared = await domainCommand(session, change);
  assert.deepEqual(await domainCommand(session, change), prepared);
  await assert.rejects(() => domainCommand(session, { ...change, reason: "A different reason under the same identity" }), rejected("stale_revision", 409));
  assert.equal((await domainHome(session)).projects.length, 1);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_domain_editions WHERE tenant_id=$1", [session.id])).rows[0].n, 1);
});
test("reviewing a preview changes no saved edition; applying saves exactly its reviewed bytes and identities", async () => {
  const f = await fixture(); const historical = JSON.stringify(f.home.edition); const prepared = await preview(f);
  assert.equal(prepared.expectedGraphHash, f.home.currentGraphHash); assert.equal(prepared.expectedEditionId, f.home.edition.id);
  assert.equal(prepared.expectedVersion, 1); assert.equal(prepared.edition.number, 2);
  assert.equal(prepared.edition.graph.parentEditionId, f.home.edition.id);
  assert.ok(Date.parse(prepared.expiresAt) <= Date.parse(f.session.expiresAt));
  assert.equal((await refresh(f)).home.project.version, 1);
  const result = await apply(f, prepared); const saved = (await refresh(f)).home;
  assert.equal(result.editionId, prepared.edition.id); assert.equal(saved.project.version, 2);
  assert.deepEqual(saved.edition, prepared.edition); assertPackEdition(saved.edition);
  assert.equal(JSON.stringify((await domainHome(f.session, f.home.project.id, f.home.edition.id)).selected!.edition), historical);
  assert.equal(saved.history.length, 2); assert.equal(saved.freshness.current, true);
});
test("stale edition, version, graph and preview hashes are denied without saving another edition", async () => {
  const f = await fixture(); const prepared = await preview(f);
  const command = { kind: "apply", requestId: randomUUID(), ...current(f.home), previewId: prepared.id, previewHash: prepared.hash };
  for (const changes of [{ expectedEditionId: "packrev_other" }, { expectedVersion: 2 }, { expectedGraphHash: "0".repeat(64) }, { previewHash: "0".repeat(64) }]) {
    await assert.rejects(() => domainCommand(f.session, { ...command, requestId: randomUUID(), ...changes }), rejected("stale_revision", 409));
  }
  assert.equal((await refresh(f)).home.history.length, 1);
});
test("concurrent apply requests save one new edition and leave the other exact preview stale", async () => {
  const f = await fixture(); const prepared = await preview(f);
  const results = await Promise.allSettled([apply(f, prepared), apply(f, prepared)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failure = results.find(result => result.status === "rejected");
  assert.ok(failure && failure.status === "rejected" && rejected("stale_revision", 409)(failure.reason));
  const saved = (await refresh(f)).home;
  assert.equal(saved.project.version, 2); assert.equal(saved.history.length, 2);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_domain_events WHERE tenant_id=$1 AND project_id=$2 AND kind='edition_saved'", [f.session.id, f.home.project.id])).rows[0].n, 1);
});
test("concurrent retries of the same apply identity return the single committed receipt", async () => {
  const f = await fixture(); const prepared = await preview(f); const requestId = randomUUID();
  const [one, two] = await Promise.all([apply(f, prepared, requestId), apply(f, prepared, requestId)]);
  assert.deepEqual(one, two); assert.equal((await refresh(f)).home.history.length, 2);
  await assert.rejects(() => domainCommand(f.session, { kind: "apply", requestId, ...current(f.home), previewId: prepared.id, previewHash: "f".repeat(64) }), rejected("stale_revision", 409));
});
test("a newer applied edition invalidates all previously reviewed sibling previews", async () => {
  const f = await fixture(); const one = await preview(f); const alternative = podcastState(f.home);
  alternative.budgetMinor += 100;
  const two = await preview(f, alternative);
  await apply(f, one);
  await assert.rejects(() => apply(f, two), rejected("stale_revision", 409));
  assert.equal((await refresh(f)).home.edition.hash, one.edition.hash);
});
test("expired reviewed previews cannot be applied even with an otherwise exact saved basis", async () => {
  const f = await fixture(); const prepared = await preview(f);
  const { hash: _hash, ...content } = { ...prepared, id: `packpreview_expired_${randomUUID()}`, expiresAt: "2026-01-01T00:00:00.000Z" };
  const expired: PackPreview = { ...content, hash: hash(content) };
  await database().query("INSERT INTO wk_domain_previews(id,tenant_id,project_id,content_hash,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6)", [expired.id, f.session.id, f.home.project.id, expired.hash, expired, expired.expiresAt]);
  await assert.rejects(() => apply(f, expired), rejected("stale_revision", 409));
  assert.equal((await refresh(f)).home.project.version, 1);
});
test("project, edition, preview and restore identities never cross tenant or project boundaries", async () => {
  const own = await fixture(); const sibling = await fixture("podcast-classroom", own.session); const foreign = await fixture(); const prepared = await preview(own);
  await assert.rejects(() => domainHome(foreign.session, own.home.project.id), rejected("not_found", 404));
  await assert.rejects(() => domainHome(own.session, sibling.home.project.id, own.home.edition.id), rejected("not_found", 404));
  await assert.rejects(() => apply(sibling, prepared), rejected("stale_revision", 409));
  await assert.rejects(() => apply(foreign, prepared), rejected("stale_revision", 409));
  await assert.rejects(() => domainCommand(own.session, { kind: "restore_preview", requestId: randomUUID(), ...current(sibling.home), restoreEditionId: own.home.edition.id }), rejected("not_found", 404));
  await assert.rejects(() => domainCommand(foreign.session, { kind: "archive", requestId: randomUUID(), ...current(own.home) }), rejected("not_found", 404));
});
test("a project cannot switch packs under an existing graph identity", async () => {
  const desk = await fixture("desk-displays"); const podcast = await fixture();
  await assert.rejects(() => preview(desk, podcastState(podcast.home)), rejected("invalid_request", 400));
  assert.equal((await refresh(desk)).home.project.packId, "desk-displays");
});
test("restoring history creates a new reviewed descendant and retains every old byte", async () => {
  const f = await fixture(); const oldBytes = JSON.stringify(f.home.edition); const first = await preview(f); await apply(f, first);
  const next = await refresh(f);
  const result = await domainCommand(next.session, { kind: "restore_preview", requestId: randomUUID(), ...current(next.home), restoreEditionId: f.home.edition.id });
  assert.ok(result.preview); assert.equal(result.preview.edition.number, 3);
  assert.equal(result.preview.edition.graph.parentEditionId, next.home.edition.id);
  assert.deepEqual(result.preview.state, f.home.edition.graph.state);
  assert.notEqual(result.preview.edition.id, f.home.edition.id);
  await apply(next, result.preview);
  assert.equal((await refresh(next)).home.history.length, 3);
  assert.equal(JSON.stringify((await domainHome(f.session, f.home.project.id, f.home.edition.id)).selected!.edition), oldBytes);
});
test("source fingerprint drift marks historical proofs stale and blocks an old preview without rewriting history", async () => {
  const f = await fixture("desk-displays"); const access = await grant(f); const prepared = await preview(f, structuredClone(f.home.edition.graph.state));
  const bytes = JSON.stringify(f.home.edition); const source = packSources.find(source => source.id === "apple-air-m2")!; const original = source.contentHash;
  try {
    source.contentHash = original === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    const historical = (await refresh(f)).home;
    assert.equal(historical.freshness.current, false);
    assert.ok(historical.freshness.issues.some(issue => issue.kind === "pack"));
    assert.ok(historical.freshness.issues.some(issue => issue.kind === "source"));
    assert.equal(JSON.stringify(historical.edition), bytes);
    const exact = await readScopedDomain(access.principal, f.home.edition.id, f.home.currentGraphHash, "certificate", "historical");
    assert.deepEqual(exact.certificate, f.home.edition.certificate);
    const fresh = await readScopedDomain(access.principal, f.home.edition.id, f.home.currentGraphHash, "certificate", "current_sources");
    assert.equal(fresh.certificate.results.find(result => result.requirementId === "D1")!.status, "unknown");
    assert.equal(fresh.freshness.current, false);
    await assert.rejects(() => apply(f, prepared), rejected("stale_revision", 409));
    const refreshed = await domainCommand(f.session, { kind: "refresh_preview", requestId: randomUUID(), ...current(f.home) });
    assert.ok(refreshed.preview); assert.notEqual(refreshed.preview.packHash, f.home.edition.packHash);
    assert.equal((await refresh(f)).home.project.version, 1);
  } finally { source.contentHash = original; }
  assert.equal((await refresh(f)).home.freshness.current, true);
});

test("an exact owned passport entry binds only its confirmed quantity of matching positions", async () => {
  const f = await fixture(); const item = await exactItem(f, "voice-1", 2); const state = podcastState(f.home);
  state.ownership = [binding(item, "voice-1"), binding(item, "voice-2")];
  const prepared = await preview(f, state); await apply(f, prepared);
  const saved = (await refresh(f)).home;
  assert.equal(saved.edition.graph.components.filter(component => component.owned).length, 2);
  assert.ok(saved.inventory.find(entry => entry.id === item.id)?.compatibleComponents.includes("voice-6"));
  assert.equal(saved.freshness.current, true);
  const excessive = structuredClone(saved.edition.graph.state); excessive.ownership.push(binding(item, "voice-3"));
  await assert.rejects(() => preview({ session: f.session, home: saved }, excessive), rejected("invalid_identity", 409));
});
test("one passport item cannot be allocated twice and a binding quantity must match its exact graph position", async () => {
  const f = await fixture(); const item = await exactItem(f); const state = podcastState(f.home);
  state.ownership = [binding(item, "voice-1"), binding(item, "voice-2")];
  await assert.rejects(() => preview(f, state), rejected("invalid_identity", 409));
  state.ownership = [binding(item, "voice-1", 2)];
  await assert.rejects(() => preview(f, state), rejected("invalid_identity", 409));
});
test("foreign, planned and archived passport items cannot be promoted to owned equipment", async () => {
  const f = await fixture(); const foreign = await fixture();
  const cases = [await exactItem(foreign), await exactItem(f, "voice-1", 1, { ownership: "planned" }), await exactItem(f, "voice-1", 1, { status: "archived" })];
  for (const item of cases) {
    const state = podcastState(f.home); state.ownership = [binding(item, "voice-1")];
    await assert.rejects(() => preview(f, state), rejected("invalid_identity", 409));
  }
  assert.equal((await refresh(f)).home.inventory.length, 0);
});
test("a shared engineering family cannot hide a different manufacturer, model, variant or equipment kind", async () => {
  const f = await fixture(); const original = await exactItem(f); const targetProfile = original.profile;
  for (const changes of [{ manufacturer: "Other manufacturer" }, { model: "Other model" }, { variant: "Different hardware revision" }, { kind: "headphones" }, { baseProfileId: "different-engineering-family" }] as const) {
    const item = await exactItem(f, "voice-1", 1, { profile: { ...targetProfile, ...changes } });
    const state = podcastState(f.home); state.ownership = [binding(item, "voice-1")];
    await assert.rejects(() => preview(f, state), rejected("invalid_identity", 409));
  }
});
test("current inventory version and profile bytes are required even when the old identity still looks correct", async () => {
  const f = await fixture(); const item = await exactItem(f); const state = podcastState(f.home);
  state.ownership = [{ ...binding(item, "voice-1"), inventoryVersion: item.version + 1 }];
  await assert.rejects(() => preview(f, state), rejected("invalid_identity", 409));
  state.ownership = [{ ...binding(item, "voice-1"), profileHash: "a".repeat(64) }];
  await assert.rejects(() => preview(f, state), rejected("invalid_identity", 409));
});
test("an inventory change between preview and apply invalidates that ownership claim", async () => {
  const f = await fixture(); const item = await exactItem(f); const state = podcastState(f.home); state.ownership = [binding(item, "voice-1")];
  const prepared = await preview(f, state);
  await replaceItem(f, item, { status: "archived" });
  await assert.rejects(() => apply(f, prepared), rejected("invalid_identity", 409));
  assert.equal((await refresh(f)).home.project.version, 1);
});
test("later inventory archive creates explicit freshness issues while immutable historical ownership stays inspectable", async () => {
  const f = await fixture(); const item = await exactItem(f); const state = podcastState(f.home); state.ownership = [binding(item, "voice-1")];
  await apply(f, await preview(f, state)); const saved = (await refresh(f)).home; const bytes = JSON.stringify(saved.edition);
  await replaceItem(f, item, { status: "archived" });
  const stale = (await refresh(f)).home;
  assert.equal(stale.freshness.current, false); assert.equal(stale.inventory.length, 0);
  assert.ok(stale.freshness.issues.some(issue => issue.kind === "inventory" && issue.componentIds.includes("voice-1")));
  assert.equal(JSON.stringify(stale.edition), bytes);
});

for (const [profileId, packId, componentId] of [
  ["pack-air-m2-2022", "desk-displays", "host"],
  ["pack-air-m3-2024", "desk-displays", "host"],
  ["pack-dell-u2723qe", "desk-displays", "display-1"],
  ["pack-air-magsafe-set", "desk-displays", "power"],
  ["pack-podtrak-p4", "podcast-classroom", "recorder"],
  ["pack-podtrak-p8", "podcast-classroom", "recorder"],
] as const) {
  test(`the real equipment-passport preview and confirmation bind ${profileId} to its domain position`, async () => {
    const f = await fixture(packId); const profile = packProfiles.find(profile => profile.id === profileId)!;
    const choices = await getInventoryProfileChoices(f.session);
    const choice = choices.find(choice => choice.id === profile.id);
    assert.ok(choice); assert.equal(choice.kind, profile.kind);
    const creator = await getRevision(f.session.id);
    const input = ConfirmationSchema.parse({ requestId: randomUUID(), identity: { libraryProfileId: choice.id, manufacturer: choice.manufacturer, model: choice.model, variant: choice.variant, deviceKind: choice.kind, ownership: "owned", quantity: profileId === "pack-dell-u2723qe" ? 2 : 1, condition: "used", accessories: [], notes: "Fresh isolated manual confirmation; no provider request or physical inspection", confirmedExactIdentity: true, confirmedOwnership: true }, snapshotId: null, selectedOptions: [], photoId: null, regionId: null, targetComponentId: null, expectedRevisionId: creator.kit.id, expectedGraphHash: creator.certificate.graphHash });
    const inventoryPreview = await previewInventory(f.session, input);
    assert.equal(inventoryPreview.certificate, null);
    assert.equal(inventoryPreview.profile.baseProfileId, profile.id);
    const item = await confirmInventory(f.session, input, inventoryPreview.previewHash);
    assert.equal(item.ownership, "owned"); assert.equal(item.status, "active");
    assert.deepEqual(item.profile.facts, profile.facts);
    assert.equal(item.profile.reviewState, profile.reviewState);
    const state = structuredClone(f.home.edition.graph.state);
    if (state.config.packId === "desk-displays" && profileId === "pack-air-m3-2024") Object.assign(state.config, { host: "air-m3", lid: "closed", externalInputs: true });
    if (state.config.packId === "podcast-classroom" && profileId === "pack-podtrak-p8") Object.assign(state.config, { recorder: "podtrak-p8", storageConfirmed: true, powerConfirmed: true });
    state.ownership = [binding(item, componentId)];
    if (profileId === "pack-dell-u2723qe") state.ownership.push(binding(item, "display-2"));
    const reviewed = await preview(f, state); await apply(f, reviewed);
    const saved = (await refresh(f)).home;
    assert.ok(saved.inventory.some(entry => entry.id === item.id && entry.compatibleComponents.includes(componentId)));
    assert.equal(saved.edition.graph.components.find(component => component.id === componentId)!.inventoryItemId, item.id);
    assert.equal(saved.edition.certificate.review.reviewed, 0);
    assert.equal(saved.edition.certificate.physicalTest, "not_performed");
    assert.deepEqual(await getRevision(f.session.id), creator);
    const bytes = JSON.stringify(saved.edition);
    await updateInventoryNotes(f.session, item.id, item.version, { notes: "Archived by real passport API for isolated freshness validation", accessories: [], status: "archived" });
    const stale = (await refresh(f)).home;
    assert.equal(stale.freshness.current, false); assert.equal(JSON.stringify(stale.edition), bytes);
    assert.ok(stale.freshness.issues.some(issue => issue.kind === "inventory" && issue.componentIds.includes(componentId)));
  });
}

test("a domain grant is one-project read-only access and its bearer appears only in the initial response", async () => {
  const f = await fixture(); const requestId = randomUUID(); const command = { kind: "grant", requestId, ...current(f.home), confirmedReadOnly: true };
  const result = await domainCommand(f.session, command); assert.ok(result.grant?.token);
  const principal = await authenticateAccess(result.grant.token); assert.ok(principal);
  assert.deepEqual(principal.scopes, ["kit:verify"]); assert.deepEqual(principal.allowedKitIds, [f.home.project.id]);
  assert.ok(Date.parse(result.grant.expiresAt) <= Date.parse(f.session.expiresAt));
  const retry = await domainCommand(f.session, command);
  assert.equal(retry.grant?.token, undefined); assert.equal(retry.grant?.id, result.grant.id);
  const receipts = (await database().query("SELECT response FROM wk_domain_commands WHERE tenant_id=$1", [f.session.id])).rows;
  const events = (await database().query("SELECT payload FROM wk_domain_events WHERE tenant_id=$1", [f.session.id])).rows;
  assert.equal(JSON.stringify([receipts, events]).includes(result.grant.token), false);
});
test("scoped readers return the saved exact certificate and guide and list only their granted project", async () => {
  const f = await fixture(); const other = await fixture("desk-displays", f.session); const access = await grant(f);
  const certificate = await readScopedDomain(access.principal, f.home.edition.id, f.home.currentGraphHash, "certificate");
  assert.deepEqual(certificate.certificate, f.home.edition.certificate);
  assert.equal(certificate.editionHash, f.home.edition.hash); assert.equal(certificate.physicalTest, "not_performed");
  const resources = await listScopedDomains(access.principal, "assembly");
  assert.equal(resources.resources.length, 1);
  assert.ok(resources.resources.every(resource => resource.uri.includes(f.home.project.id) && !resource.uri.includes(access.token)));
  await assert.rejects(() => readScopedDomain(access.principal, other.home.edition.id, other.home.currentGraphHash, "assembly"), rejected("forbidden", 403));
  const creator = await getRevision(f.session.id);
  assert.equal(access.principal.allowedKitIds.includes(creator.kit.kitId), false);
});
test("foreign grants, wrong project URIs, wrong hashes and missing scope cannot read a saved domain edition", async () => {
  const f = await fixture(); const foreign = await fixture(); const own = await grant(f); const other = await grant(foreign);
  await assert.rejects(() => readScopedDomain(other.principal, f.home.edition.id, f.home.currentGraphHash, "certificate"), rejected("forbidden", 403));
  await assert.rejects(() => readScopedDomain(own.principal, f.home.edition.id, f.home.currentGraphHash, "certificate", "historical", foreign.home.project.id), rejected("forbidden", 403));
  await assert.rejects(() => readScopedDomain(own.principal, f.home.edition.id, "0".repeat(64), "assembly"), rejected("stale_revision", 409));
  const quoteOnly = await createAccessToken(f.session, ["kit:quote"]); const quotePrincipal = await authenticateAccess(quoteOnly.token); assert.ok(quotePrincipal);
  await assert.rejects(() => readScopedDomain(quotePrincipal, f.home.edition.id, f.home.currentGraphHash, "certificate"), rejected("forbidden", 403));
  await assert.rejects(() => readScopedDomain({ ...own.principal, scopes: [] }, f.home.edition.id, f.home.currentGraphHash, "certificate"), rejected("forbidden", 403));
  await assert.rejects(() => readScopedDomain({ ...own.principal, expiresAt: "2026-01-01T00:00:00.000Z" }, f.home.edition.id, f.home.currentGraphHash, "certificate"), rejected("forbidden", 403));
});
test("current scope and project narrowing override a previously authenticated principal", async () => {
  const f = await fixture(); const access = await grant(f);
  await database().query("UPDATE wk_access_tokens SET kit_ids='[]' WHERE tenant_id=$1 AND id=$2", [f.session.id, access.id]);
  await assert.rejects(() => readScopedDomain(access.principal, f.home.edition.id, f.home.currentGraphHash, "assembly"), rejected("forbidden", 403));
  assert.deepEqual((await listScopedDomains(access.principal, "certificate")).resources, []);
  const scope = await grant(f);
  await database().query("UPDATE wk_access_tokens SET scopes='[]' WHERE tenant_id=$1 AND id=$2", [f.session.id, scope.id]);
  await assert.rejects(() => readScopedDomain(scope.principal, f.home.edition.id, f.home.currentGraphHash, "certificate"), rejected("forbidden", 403));
  await assert.rejects(() => listScopedDomains(scope.principal, "assembly"), rejected("forbidden", 403));
});
test("revocation, token expiry and owner-session expiry end read access through existing principals", async () => {
  const revoked = await fixture(); const revokeAccess = await grant(revoked);
  await domainCommand(revoked.session, { kind: "revoke_grant", requestId: randomUUID(), projectId: revoked.home.project.id, grantId: revokeAccess.id });
  assert.equal(await authenticateAccess(revokeAccess.token), null);
  await assert.rejects(() => readScopedDomain(revokeAccess.principal, revoked.home.edition.id, revoked.home.currentGraphHash, "certificate"), rejected("forbidden", 403));
  const expired = await fixture(); const tokenAccess = await grant(expired);
  await database().query("UPDATE wk_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [expired.session.id, tokenAccess.id]);
  await assert.rejects(() => listScopedDomains(tokenAccess.principal, "certificate"), rejected("forbidden", 403));
  const owner = await fixture(); const ownerAccess = await grant(owner);
  await database().query("UPDATE wk_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [owner.session.id]);
  await assert.rejects(() => readScopedDomain(ownerAccess.principal, owner.home.edition.id, owner.home.currentGraphHash, "assembly"), rejected("forbidden", 403));
  await assert.rejects(() => domainHome(owner.session, owner.home.project.id), rejected("forbidden", 401));
  await assert.rejects(() => domainCommand(owner.session, { kind: "create", requestId: randomUUID(), packId: "desk-displays", title: "Expired owner cannot create" }), rejected("forbidden", 401));
});
test("one project's revocation and archive never operate on a sibling grant", async () => {
  const f = await fixture(); const sibling = await fixture("podcast-classroom", f.session); const own = await grant(f); const other = await grant(sibling);
  await assert.rejects(() => domainCommand(f.session, { kind: "revoke_grant", requestId: randomUUID(), projectId: f.home.project.id, grantId: other.id }), rejected("not_found", 404));
  const bytes = JSON.stringify(f.home.edition);
  await domainCommand(f.session, { kind: "archive", requestId: randomUUID(), ...current(f.home) });
  assert.equal(await authenticateAccess(own.token), null); assert.ok(await authenticateAccess(other.token));
  await assert.rejects(() => listScopedDomains(own.principal, "assembly"), rejected("forbidden", 403));
  const archived = (await domainHome(f.session, f.home.project.id)).selected!;
  assert.ok(archived.project.archivedAt); assert.equal(JSON.stringify(archived.edition), bytes);
  await assert.rejects(() => domainCommand(f.session, { kind: "grant", requestId: randomUUID(), ...current(archived), confirmedReadOnly: true }), rejected("forbidden", 403));
  await assert.rejects(() => preview({ session: f.session, home: archived }), rejected("forbidden", 403));
});
test("saved editions, previews, commands, events and grant bindings are append-only at the database boundary", async () => {
  const f = await fixture(); await preview(f); await grant(f);
  for (const table of ["wk_domain_editions", "wk_domain_previews", "wk_domain_commands", "wk_domain_events", "wk_domain_grants"]) {
    for (const query of [`UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1`, `DELETE FROM ${table} WHERE tenant_id=$1`]) {
      await assert.rejects(() => database().query(query, [f.session.id]), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23514");
    }
  }
  await assert.rejects(() => database().query("UPDATE wk_domain_projects SET title='rewritten identity',version=version+1 WHERE tenant_id=$1 AND id=$2", [f.session.id, f.home.project.id]), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23514");
  await assert.rejects(() => database().query("DELETE FROM wk_domain_projects WHERE tenant_id=$1 AND id=$2", [f.session.id, f.home.project.id]), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23514");
  assertPackEdition((await refresh(f)).home.edition);
});

async function listenMcp(): Promise<{ server: Server; url: URL }> {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const body = Buffer.concat(chunks);
      const response = await handleMcp(new Request(`http://127.0.0.1${incoming.url ?? "/api/mcp"}`, { method: incoming.method, headers, ...(body.length ? { body: new Uint8Array(body) } : {}) }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end("Isolated MCP adapter failed"); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  return { server, url: new URL(`http://127.0.0.1:${port}/api/mcp`) };
}
async function closeServer(server: Server) { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
async function mcpClient(f: Fixture, run: (client: Client, principal: Principal) => Promise<void>) {
  const access = await grant(f); const listening = await listenMcp(); const client = new Client({ name: "worldkit-domain-independent-qa", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(listening.url, { requestInit: { headers: { Authorization: `Bearer ${access.token}` } } }));
    await run(client, access.principal);
  } finally { await client.close().catch(() => {}); await closeServer(listening.server); }
}
test("an actual SDK client over loopback HTTP reads the same domain certificate, guide and graph hash", async () => {
  const f = await fixture(); await apply(f, await preview(f)); const saved = await refresh(f);
  await mcpClient(saved, async client => {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["quote_kit", "repair_kit", "verify_kit"]);
    const templates = await client.listResourceTemplates();
    assert.equal(templates.resourceTemplates.filter(template => template.uriTemplate.startsWith("worldkit://domains/")).length, 2);
    const resources = (await client.listResources()).resources.filter(resource => resource.uri.startsWith("worldkit://domains/"));
    assert.equal(resources.length, 4);
    for (const kind of ["certificate", "assembly"]) {
      const resource = resources.find(resource => resource.uri.includes(saved.home.edition.id) && resource.uri.endsWith(`/${kind}`));
      assert.ok(resource);
      const result = await client.readResource({ uri: resource.uri });
      const block = result.contents[0]; assert.ok(block && "text" in block);
      const value = JSON.parse(block.text);
      assert.equal(value.graphHash, saved.home.currentGraphHash); assert.equal(value.editionHash, saved.home.edition.hash);
      assert.equal(value.physicalTest, "not_performed"); assert.deepEqual(value.certificate, saved.home.edition.certificate);
      if (kind === "assembly") { assert.deepEqual(value.graph, saved.home.edition.graph); assert.ok(value.assembly.length); }
    }
    const response = await client.callTool({ name: "verify_kit", arguments: { kit_revision_id: saved.home.edition.id, expected_graph_hash: saved.home.currentGraphHash, requirement_ids: ["P1", "P2"], freshness_policy: "historical" } });
    assert.notEqual(response.isError, true);
    const value = response.structuredContent as { certificate: unknown; selectedResults: { requirementId: string }[] };
    assert.deepEqual(value.certificate, saved.home.edition.certificate);
    assert.deepEqual(value.selectedResults.map(result => result.requirementId), ["P1", "P2"]);
    const invalid = await client.callTool({ name: "verify_kit", arguments: { kit_revision_id: saved.home.edition.id, expected_graph_hash: saved.home.currentGraphHash, requirement_ids: ["unrelated_requirement"] } });
    assert.equal(invalid.isError, true);
  });
});
test("the real HTTP MCP path denies foreign systems, stale hashes, resource URI swaps and financial or repair tools", async () => {
  const f = await fixture(); const foreign = await fixture();
  await mcpClient(f, async client => {
    for (const args of [
      { kit_revision_id: foreign.home.edition.id, expected_graph_hash: foreign.home.currentGraphHash },
      { kit_revision_id: f.home.edition.id, expected_graph_hash: "0".repeat(64) },
    ]) assert.equal((await client.callTool({ name: "verify_kit", arguments: args })).isError, true);
    const swapped = `worldkit://domains/${foreign.home.project.id}/${f.home.edition.id}/${f.home.currentGraphHash}/assembly`;
    await assert.rejects(() => client.readResource({ uri: swapped }), /outside|grant|system/);
    const repair = await client.callTool({ name: "repair_kit", arguments: { kit_revision_id: f.home.edition.id, expected_graph_hash: f.home.currentGraphHash, failed_requirement_ids: ["P1"], constraints: { preserve_hard_requirements: true, preserve_owned: true } } });
    assert.equal(repair.isError, true);
    const quote = await client.callTool({ name: "quote_kit", arguments: { kit_revision_id: f.home.edition.id, verification_id: f.home.edition.certificate.id, expected_graph_hash: f.home.currentGraphHash, merchant_id: "worldkit-studio", currency: "USD", locale: "en-US" } });
    assert.equal(quote.isError, true);
    for (const table of ["wk_quotes", "wk_jobs", "wk_provider_receipts"]) assert.equal((await database().query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [f.session.id])).rows[0].n, 0);
  });
});
test("revoking an authenticated HTTP MCP grant immediately ends its next request", async () => {
  const f = await fixture();
  await mcpClient(f, async (client, principal) => {
    assert.ok((await client.listResources()).resources.some(resource => resource.uri.startsWith("worldkit://domains/")));
    await domainCommand(f.session, { kind: "revoke_grant", requestId: randomUUID(), projectId: f.home.project.id, grantId: principal.id });
    await assert.rejects(() => client.listResources(), /401|active scoped|Unauthorized/);
  });
});
test("HTTP MCP rejects an unauthenticated request and a foreign browser origin", async () => {
  const request = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "isolated-negative-qa", version: "1" } } };
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const missing = await handleMcp(new Request("http://127.0.0.1:4565/api/mcp", { method: "POST", headers, body: JSON.stringify(request) }));
  assert.equal(missing.status, 401); assert.equal(missing.headers.get("Cache-Control"), "no-store");
  const wrongOrigin = await handleMcp(new Request("http://127.0.0.1:4565/api/mcp", { method: "POST", headers: { ...headers, origin: "https://unrelated.invalid" }, body: JSON.stringify(request) }));
  assert.equal(wrongOrigin.status, 403);
});
