import { randomUUID } from "node:crypto";
import { retrieveProduct, searchProducts, similarProducts } from "../../packages/channel3/client";
import { hash } from "../../packages/compatibility";
import { WorldKitError, type CatalogReceipt, type CatalogSnapshot, type DeviceProfile, type Source } from "../../packages/contracts";
import { profiles as libraryProfiles, sources as librarySources } from "../../packages/device-library";
import { candidateProfiles, candidateSources } from "../../packages/device-library/candidates";
import { catalogIdentityMatches } from "../../packages/inventory/identity";
import type { LivingIncident } from "../../packages/living-kit/contracts";
import { SAMPLE_SCENARIOS, type AmendmentProposal, type CommitmentLine, type KitCommitment, type MerchantQuote, type RepairBundle, type RepairCandidate, type RepairEvidence, type RepairRun, type SampleScenario } from "../../packages/living-repair/contracts";
import { affectedClosure, semanticCause } from "../../packages/living-repair/impact";
import { inStock, makeCandidate, repairQuery, sameSelection } from "../../packages/living-repair/planner";
import { sampleAlternativeProfile, sampleCatalog, sampleRepairBundle, sampleUnitPrice } from "../../packages/living-repair/sample";
import { database } from "./db";
import { initializeLivingRepair, repairTransaction } from "./living-repair-db";
import { insertAmendment, loadAmendment, loadCandidate, loadCommitment, loadRepair, repairNotice, repairNow, saveAmendment, saveCommitmentVersion, saveRepair, type RepairDb } from "./living-repair-store";
import { getRevision, reserveUsage, saveCatalogResultInTransaction, type Session } from "./repository";

export type RepairCatalogRuntime = {
  mode: "live" | "sample";
  refresh: (productId: string, tenantId: string, selection: Record<string, string>) => Promise<{ value: { snapshot: CatalogSnapshot }; receipt: CatalogReceipt }>;
  similar: (productId: string, tenantId: string) => Promise<{ value: CatalogSnapshot[]; receipt: CatalogReceipt }>;
  search: (query: string, tenantId: string) => Promise<{ value: CatalogSnapshot[]; receipt: CatalogReceipt }>;
};
const liveCatalog: RepairCatalogRuntime = { mode: "live", refresh: retrieveProduct, similar: similarProducts, search: searchProducts };
export function catalogForRun(run: RepairRun, stage: "repair" | "restore" | "commit" = "repair", supplied?: RepairCatalogRuntime): RepairCatalogRuntime {
  if (supplied) { if (supplied.mode !== run.catalogMode) throw new WorldKitError("forbidden", "Repair evidence sources cannot cross namespaces.", 403); return supplied; }
  if (run.catalogMode === "live") return liveCatalog;
  const scenario = run.scenario ?? "available-alternative";
  const refresh: RepairCatalogRuntime["refresh"] = async productId => {
    const response = sampleCatalog(productId, scenario, stage); const snapshot = response.value.snapshot;
    const delta = SAMPLE_SCENARIOS.find(value => value.id === scenario)?.deltaMinor ?? 800;
    snapshot.offers[0]!.domain = productId === run.productId ? run.affectedDomain : "original.example.invalid";
    snapshot.offers[0]!.price!.minor = run.sampleBaseUnitMinor ?? 24800; snapshot.offers[1]!.price!.minor = (run.sampleBaseUnitMinor ?? 24800) + delta;
    snapshot.responseHash = hash({ ...snapshot, responseHash: undefined }); return response;
  };
  const discover = async () => { const value = await refresh("sample-recorder-b", run.tenantId, {}); return { value: [value.value.snapshot], receipt: value.receipt }; };
  return { mode: "sample", refresh, similar: discover, search: discover };
}
export function evidenceFor(mode: "live" | "sample", snapshots: CatalogSnapshot[], receipts: CatalogReceipt[], method: RepairEvidence["method"], query: string): RepairEvidence {
  const at = repairNow(); return { mode, snapshots, receipts, checkedAt: at, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), query, method };
}
function freshSnapshot(snapshot: CatalogSnapshot, productId: string, options: { name: string; value: string }[]) {
  const age = Date.now() - Date.parse(snapshot.observedAt);
  if (!snapshot.detailChecked || !snapshot.variantExact || snapshot.productId !== productId || !sameSelection(snapshot.selectedOptions, options) || !Number.isFinite(age) || age > 120_000 || age < -5_000) throw new WorldKitError("needs_evidence", "The exact product refresh did not establish a fresh, matching variant.", 409);
}
function newRun(input: Pick<RepairRun, "tenantId" | "base" | "sourceMode" | "catalogMode" | "causeKey" | "commitmentId" | "scenario" | "itemId" | "productId" | "selectedOptions" | "affectedDomain" | "impact" | "incidentIds">): RepairRun {
  const at = repairNow(); const absent = input.impact.changedComponentIds.length === 0;
  const protectedItem = input.impact.changedComponentIds.some(id => input.impact.protectedComponentIds.includes(id));
  return { ...input, id: randomUUID(), kitId: input.base.kit.kitId, phase: absent ? "not_in_kit" : protectedItem ? "protected" : "queued", title: input.scenario ? SAMPLE_SCENARIOS.find(scenario => scenario.id === input.scenario)!.title : "Keep this kit working", reason: absent ? "This watched item is not placed in the saved kit. Add its exact identity in Equipment before preparing a repair." : protectedItem ? "This is owned equipment. A retailer stock change cannot replace something you already own." : "The market update is retained. Refresh the exact offer, trace its dependencies and inspect sourced alternatives.", createdAt: at, updatedAt: at, steps: [{ id: "event", title: input.sourceMode === "sample" ? "Sample scenario saved" : "Market update retained", detail: "Duplicate deliveries share one repair cause. No payment or graph change has been made.", at, state: "complete" }], candidateIds: [], selectedCandidateId: null, amendmentId: null, original: null, discovery: [], discoveryCursor: 0, attempts: 0, nextAttemptAt: at, error: null };
}
async function insertRun(db: RepairDb, run: RepairRun): Promise<RepairRun> {
  const inserted = await db.query("INSERT INTO wk_living_repairs(id,tenant_id,cause_key,source_mode,phase,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,source_mode,cause_key) DO NOTHING RETURNING id", [run.id, run.tenantId, run.causeKey, run.sourceMode, run.phase, run]);
  if (inserted.rowCount) return run;
  const prior = (await db.query("SELECT payload FROM wk_living_repairs WHERE tenant_id=$1 AND source_mode=$2 AND cause_key=$3 FOR UPDATE", [run.tenantId, run.sourceMode, run.causeKey])).rows[0].payload as RepairRun;
  prior.incidentIds = [...new Set([...prior.incidentIds, ...run.incidentIds])]; await saveRepair(db, prior); return prior;
}
export async function enqueueIncidentRepair(db: RepairDb, tenantId: string, incident: LivingIncident): Promise<RepairRun> {
  const record = (await db.query("SELECT r.kit,r.certificate,r.profiles,r.sources FROM wk_kits k JOIN wk_revisions r ON r.id=k.current_revision_id WHERE k.tenant_id=$1 LIMIT 1", [tenantId])).rows[0];
  if (!record) throw new WorldKitError("not_found", "The watched workspace has no saved kit.", 404);
  const base = record as RepairBundle;
  const changed = base.kit.components.filter(component => component.inventoryItemId === incident.itemId || base.profiles.some(profile => profile.id === component.profileId && profile.catalogBinding?.productId === incident.refreshed.productId && sameSelection(profile.selectedOptions, incident.refreshed.selectedOptions))).map(component => component.id);
  const domain = incident.signal.domain ?? incident.refreshed.offers[0]?.domain ?? "unknown";
  const commitment = (await db.query("SELECT payload FROM wk_kit_commitments WHERE tenant_id=$1 AND kit_id=$2 AND payload->>'branch'='workspace' AND payload->'current'->'certificate'->>'graphHash'=$3 AND payload->'current'->'kit'->>'id'=$4 ORDER BY created_at DESC LIMIT 1", [tenantId, base.kit.kitId, base.certificate.graphHash, base.kit.id])).rows[0]?.payload as KitCommitment | undefined;
  const causeKey = semanticCause({ tenantId, namespace: incident.sourceMode, kitId: base.kit.kitId, baseGraphHash: hash({ graph: base.certificate.graphHash, commitment: commitment?.id ?? null, version: commitment?.version ?? null }), itemId: incident.itemId, productId: incident.refreshed.productId, selectedOptions: incident.refreshed.selectedOptions, domain, condition: incident.impact.state === "needs_repair_review" ? "unavailable" : "review" });
  const relevant = commitment ? changed.filter(id => commitment.lines.some(line => line.componentId === id && line.productId === incident.refreshed.productId && line.domain === domain)) : changed;
  const run = newRun({ tenantId, base, sourceMode: incident.sourceMode, catalogMode: incident.catalogSource, causeKey, commitmentId: commitment?.id ?? null, scenario: null, itemId: incident.itemId, productId: incident.refreshed.productId, selectedOptions: incident.refreshed.selectedOptions, affectedDomain: domain, impact: affectedClosure(base, relevant), incidentIds: [incident.id] });
  if (commitment?.lines.some(line => line.fulfillment !== "unfulfilled")) { run.phase = "stale"; run.reason = "This controlled commitment entered fulfillment. A stock event cannot restart its automatic authority or change shipped lines."; }
  else if (commitment && changed.length && !relevant.length) { run.phase = "resolved"; run.reason = "The current controlled commitment already uses a different sourcing offer. This earlier retailer observation does not require another amendment."; }
  return insertRun(db, run);
}
export async function startIncidentRepair(session: Session, incidentId: string) {
  return repairTransaction(async db => {
    const incident = (await db.query("SELECT payload FROM wk_living_incidents WHERE id=$1 AND tenant_id=$2", [incidentId, session.id])).rows[0]?.payload as LivingIncident | undefined;
    if (!incident) throw new WorldKitError("not_found", "This market update does not belong to your workspace.", 404);
    return enqueueIncidentRepair(db, session.id, incident);
  });
}
function baselineCommitment(tenantId: string, bundle: RepairBundle, workspaceRevisionId: string, branch: KitCommitment["branch"], productId: string, selectedOptions: RepairRun["selectedOptions"], domain: string, changed: string[]): KitCommitment {
  const at = repairNow();
  const lines: CommitmentLine[] = bundle.kit.components.filter(component => !component.owned).map(component => {
    const profile = bundle.profiles.find(profile => profile.id === component.profileId)!;
    return { componentId: component.id, profileId: profile.id, model: profile.model, quantity: component.quantity, unitMinor: sampleUnitPrice(profile.kind), productId: changed.includes(component.id) ? productId : profile.catalogBinding?.productId ?? null, selectedOptions: changed.includes(component.id) ? selectedOptions : profile.selectedOptions, domain: changed.includes(component.id) ? domain : "controlled.example.invalid", offerId: changed.includes(component.id) && branch === "sample_demonstration" ? `${productId}:original` : null, condition: "new", category: profile.kind, fulfillment: "unfulfilled" };
  });
  const total = lines.reduce((sum, line) => sum + line.unitMinor * line.quantity, 0);
  return { id: randomUUID(), tenantId, kitId: bundle.kit.kitId, version: 1, branch, current: bundle, original: bundle, workspaceRevisionId, lines, merchantId: "worldkit-studio", createdAt: at, updatedAt: at, acceptedTermsAt: at, baseline: "sample_commitment_no_payment", baselineTotalMinor: total, currentTotalMinor: total, shippingMinor: 0, taxMinor: 0, currency: "USD", latestAmendmentId: null, returnPolicy: "unfulfilled_24h_conditional" };
}
export async function startSampleRepair(session: Session, scenario: SampleScenario, requestId: string): Promise<RepairRun> {
  const current = await getRevision(session.id); const causeKey = hash({ tenant: session.id, requestId, scenario, source: "sample" });
  return repairTransaction(async db => {
    await db.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [session.id]);
    const prior = (await db.query("SELECT payload FROM wk_living_repairs WHERE tenant_id=$1 AND source_mode='sample' AND cause_key=$2", [session.id, causeKey])).rows[0]?.payload as RepairRun | undefined;
    if (prior) return prior;
    const count = (await db.query("SELECT count(*)::int AS count FROM wk_living_repairs WHERE tenant_id=$1 AND source_mode='sample'", [session.id])).rows[0].count;
    if (count >= 30) throw new WorldKitError("rate_limited", "This private workspace has 30 saved Sample repairs. Review an existing scenario.", 429);
    const bundle = sampleRepairBundle(randomUUID(), repairNow());
    const commitment = baselineCommitment(session.id, bundle, current.kit.id, "sample_demonstration", "sample-recorder-a", [], "original.example.invalid", ["audio"]);
    await saveCommitmentVersion(db, commitment, "baseline", null);
    const run = newRun({ tenantId: session.id, base: bundle, sourceMode: "sample", catalogMode: "sample", causeKey, commitmentId: commitment.id, scenario, itemId: null, productId: "sample-recorder-a", selectedOptions: [], affectedDomain: "original.example.invalid", impact: affectedClosure(bundle, ["audio"]), incidentIds: [] });
    await insertRun(db, run);
    await repairNotice(db, session.id, `sample:${run.id}`, { kind: "repair-sample", title: "A Sample repair is ready to trace", detail: "Its kit branch, merchant baseline and payment simulator are separate from your workbench and real provider evidence.", sourceMode: "sample", runId: run.id });
    return run;
  });
}
export async function createRepairCommitment(session: Session, runId: string, expectedGraphHash: string): Promise<KitCommitment> {
  return repairTransaction(async db => {
    const run = await loadRepair(session.id, runId, db, true);
    if (run.commitmentId) return loadCommitment(session.id, run.commitmentId, db);
    if (run.base.certificate.graphHash !== expectedGraphHash || !run.impact.changedComponentIds.length || run.impact.changedComponentIds.some(id => run.impact.protectedComponentIds.includes(id))) throw new WorldKitError("stale_revision", "This repair has no current, changeable exact kit component.", 409);
    const current = await getRevision(session.id);
    if (current.certificate.graphHash !== expectedGraphHash || current.kit.id !== run.base.kit.id) throw new WorldKitError("stale_revision", "Your workbench changed. Prepare a repair from the current saved version.", 409);
    await db.query("SELECT id FROM wk_kits WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [session.id, current.kit.kitId]);
    const existing = (await db.query("SELECT payload FROM wk_kit_commitments WHERE tenant_id=$1 AND kit_id=$2 AND payload->>'branch'='workspace' AND payload->'current'->'certificate'->>'graphHash'=$3 AND payload->'current'->'kit'->>'id'=$4 ORDER BY created_at DESC LIMIT 1", [session.id, current.kit.kitId, expectedGraphHash, current.kit.id])).rows[0]?.payload as KitCommitment | undefined;
    if (existing) { run.commitmentId = existing.id; await saveRepair(db, run); return existing; }
    const commitment = baselineCommitment(session.id, run.base, current.kit.id, "workspace", run.productId, run.selectedOptions, run.affectedDomain, run.impact.changedComponentIds);
    await saveCommitmentVersion(db, commitment, "baseline", null); run.commitmentId = commitment.id; await saveRepair(db, run); return commitment;
  });
}
export async function startNextSampleRepair(session: Session, commitmentId: string, expectedVersion: number, requestId: string): Promise<RepairRun> {
  return repairTransaction(async db => {
    const commitment = await loadCommitment(session.id, commitmentId, db, true);
    const causeKey = hash({ tenant: session.id, commitment: commitment.id, requestId, source: "sample" });
    const repeat = (await db.query("SELECT payload FROM wk_living_repairs WHERE tenant_id=$1 AND cause_key=$2 AND source_mode='sample'", [session.id, causeKey])).rows[0]?.payload as RepairRun | undefined;
    if (repeat) return repeat;
    if (commitment.branch !== "sample_demonstration" || commitment.version !== expectedVersion || commitment.lines.some(line => line.fulfillment !== "unfulfilled")) throw new WorldKitError("stale_revision", "Choose the current unfulfilled Sample commitment for the next scenario.", 409);
    const line = commitment.lines.find(line => line.componentId === "audio");
    if (!line?.productId) throw new WorldKitError("needs_evidence", "This branch has no exact recorder line for the follow-up scenario.", 409);
    const run = newRun({ tenantId: session.id, base: commitment.current, sourceMode: "sample", catalogMode: "sample", causeKey, commitmentId: commitment.id, scenario: "followup-change", itemId: null, productId: line.productId, selectedOptions: line.selectedOptions, affectedDomain: line.domain, impact: affectedClosure(commitment.current, [line.componentId]), incidentIds: [] });
    run.sampleBaseUnitMinor = line.unitMinor;
    return insertRun(db, run);
  });
}
type RepairLease = { id: string; tenantId: string; token: string; run: RepairRun; attempts: number };
const activePhases = ["queued", "refreshing", "discovering", "verifying"];
export async function claimRepair(tenantId?: string, onlyId?: string): Promise<RepairLease | null> {
  return repairTransaction(async db => {
    const row = (await db.query("SELECT r.* FROM wk_living_repairs r JOIN wk_sessions s ON s.id=r.tenant_id WHERE r.phase=ANY($1::text[]) AND r.next_attempt_at<=now() AND (r.lease_until IS NULL OR r.lease_until<now()) AND s.expires_at>now() AND ($2::text IS NULL OR r.tenant_id=$2) AND ($3::text IS NULL OR r.id=$3) ORDER BY r.created_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED", [activePhases, tenantId ?? null, onlyId ?? null])).rows[0];
    if (!row) return null;
    const token = randomUUID(); await db.query("UPDATE wk_living_repairs SET lease_token=$2,lease_until=now()+interval '180 seconds',attempts=attempts+1 WHERE id=$1", [row.id, token]);
    return { id: row.id, tenantId: row.tenant_id, token, run: row.payload, attempts: row.attempts + 1 };
  });
}
async function finishRepairLease(lease: RepairLease, run: RepairRun, candidates: RepairCandidate[] = [], records: { snapshots: CatalogSnapshot[]; receipts: CatalogReceipt[] } = { snapshots: [], receipts: [] }) {
  return repairTransaction(async db => {
    const held = (await db.query("SELECT id FROM wk_living_repairs WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND phase=ANY($3::text[]) FOR UPDATE", [lease.id, lease.token, activePhases])).rows[0];
    if (!held) return false;
    for (const candidate of candidates) await db.query("INSERT INTO wk_repair_candidates(id,tenant_id,run_id,digest,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", [candidate.id, run.tenantId, run.id, candidate.digest, candidate]);
    if (run.catalogMode === "live") for (let index = 0; index < records.receipts.length; index++) await saveCatalogResultInTransaction(db, run.tenantId, index === 0 ? records.snapshots : [], { ...records.receipts[index]!, id: randomUUID() });
    run.attempts = lease.attempts; await saveRepair(db, run); await db.query("UPDATE wk_living_repairs SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2", [lease.id, lease.token]);
    if (["ready", "needs_evidence", "no_alternative", "failed", "stale", "resolved"].includes(run.phase)) await repairNotice(db, run.tenantId, `repair-result:${run.id}:${run.candidateIds.join(":")}:${run.phase}`, { kind: "repair-ready", title: run.phase === "ready" ? "An alternative is ready to review" : "Your repair has a clear next step", detail: run.reason, sourceMode: run.sourceMode, runId: run.id });
    return true;
  });
}
function step(run: RepairRun, id: string, title: string, detail: string, state: "complete" | "open" | "blocked" = "complete") {
  run.steps = [...run.steps.filter(value => value.id !== id), { id, title, detail, at: repairNow(), state }];
}
function profilesFor(run: RepairRun) {
  return run.catalogMode === "sample" ? { profiles: [...run.base.profiles, sampleAlternativeProfile(run.base, run.scenario === "unknown-evidence")], sources: run.base.sources } : { profiles: [...run.base.profiles, ...libraryProfiles, ...candidateProfiles], sources: [...run.base.sources, ...librarySources, ...candidateSources] };
}
function candidatesFrom(run: RepairRun, snapshot: CatalogSnapshot, evidence: RepairEvidence): RepairCandidate[] {
  const library = profilesFor(run); const original = run.base.profiles.find(profile => profile.id === run.base.kit.components.find(component => component.id === run.impact.changedComponentIds[0])?.profileId);
  const exact = snapshot.productId === run.productId && sameSelection(snapshot.selectedOptions, run.selectedOptions);
  const matched = exact ? original : library.profiles.find(profile => run.catalogMode === "sample" ? profile.catalogId === snapshot.productId : catalogIdentityMatches(snapshot, profile));
  const profile: DeviceProfile = matched ?? { id: `unreviewed:${hash({ product: snapshot.productId, options: snapshot.selectedOptions }).slice(0, 24)}`, manufacturer: snapshot.brand ?? "Unconfirmed", model: snapshot.title, shortName: snapshot.title, variant: snapshot.selectedOptions.map(option => `${option.name}: ${option.value}`).join(" · ") || "Exact technical variant requires review", kind: original?.kind ?? "recorder", version: 1, description: "Catalog identity only. An exact source-backed engineering profile is needed.", ports: [], facts: { technicalScope: { id: `unknown:${snapshot.productId}`, property: "technicalScope", value: null, unit: null, sourceIds: [], scope: snapshot.title, conditions: [], state: "unknown", critical: true, review: { status: "pending", reviewer: null, date: null } } }, catalogId: snapshot.productId, selectedOptions: snapshot.selectedOptions, reviewState: "candidate", portMapStatus: "pending", art: "original_line_art", accent: "#d8e5e1" };
  return snapshot.offers.filter(offer => offer.price && inStock(offer.availability) && (!exact || offer.domain.toLowerCase() !== run.affectedDomain.toLowerCase()) && !(run.scenario === "unknown-evidence" && exact)).flatMap((offer, index) => {
    const candidate = makeCandidate({ run, snapshot, domain: offer.domain, profile, sources: library.sources, evidence, rank: (exact ? 0 : 100) + index }); return candidate ? [candidate] : [];
  });
}
export async function executeRepairLease(lease: RepairLease, supplied?: RepairCatalogRuntime): Promise<void> {
  const run = structuredClone(lease.run); const runtime = catalogForRun(run, "repair", supplied);
  try {
    const current = run.commitmentId ? (await loadCommitment(run.tenantId, run.commitmentId)).current : await getRevision(run.tenantId);
    if (current.certificate.graphHash !== run.base.certificate.graphHash || current.kit.id !== run.base.kit.id) { run.phase = "stale"; run.reason = "The saved kit changed during discovery. Start a repair from its current version; the old evidence remains available."; await finishRepairLease(lease, run); return; }
    if (run.phase === "queued" || run.phase === "refreshing") {
      const response = await runtime.refresh(run.productId, run.tenantId, Object.fromEntries(run.selectedOptions.map(option => [option.name, option.value])));
      freshSnapshot(response.value.snapshot, run.productId, run.selectedOptions);
      run.original = evidenceFor(runtime.mode, [response.value.snapshot], [response.receipt], runtime.mode === "sample" ? "sample_fixture" : "same_variant", "Exact watched product and selected options");
      step(run, "refresh", "Refreshed the exact product", "A market event is a signal to read current state. This fresh detail response establishes the current exact variant.");
      step(run, "impact", "Traced the affected paths", run.impact.explanation);
      if (runtime.mode === "live" && response.value.snapshot.offers.some(offer => offer.domain.toLowerCase() === run.affectedDomain.toLowerCase() && inStock(offer.availability))) {
        run.phase = "resolved"; run.reason = "The exact watched retailer currently reports this variant in stock. The earlier shortage does not force a replacement or grant payment authority.";
        await finishRepairLease(lease, run, [], { snapshots: [response.value.snapshot], receipts: [response.receipt] }); return;
      }
      run.phase = "discovering"; run.reason = "The exact offer was refreshed. Comparing other retailers before considering a different technical variant.";
      await finishRepairLease(lease, run, [], { snapshots: [response.value.snapshot], receipts: [response.receipt] }); return;
    }
    if (run.phase === "discovering") {
      const query = repairQuery(run);
      if (runtime.mode === "live") await reserveUsage(run.tenantId, "discovery");
      const discoveries = await Promise.allSettled([runtime.similar(run.productId, run.tenantId), runtime.search(query, run.tenantId)]);
      const successes = discoveries.flatMap(value => value.status === "fulfilled" ? [value.value] : []);
      if (!successes.length && runtime.mode === "live" && !run.original?.snapshots[0]?.offers.some(offer => offer.domain !== run.affectedDomain && inStock(offer.availability))) throw new WorldKitError("provider_unavailable", "Alternative discovery is unavailable. The retained exact-product response remains visible; retry discovery later.", 503);
      run.discovery = [...new Map(successes.flatMap(value => value.value).filter(snapshot => snapshot.productId !== run.productId).map(snapshot => [hash({ id: snapshot.productId, selection: snapshot.selectedOptions }), { productId: snapshot.productId, selectedOptions: snapshot.selectedOptions }])).values()].slice(0, 8);
      const candidates = run.original ? candidatesFrom(run, run.original.snapshots[0]!, run.original) : [];
      run.candidateIds = [...new Set([...run.candidateIds, ...candidates.map(candidate => candidate.id)])];
      run.phase = "verifying"; run.reason = "Checking exact product details, typed connections and critical facts for each alternative.";
      step(run, "discover", "Found graph-aware alternatives", `${run.discovery.length} different exact product identities queued; ${candidates.length} same-product retailer alternatives. The query includes the original input and simultaneous-recording constraints.${discoveries.some(value => value.status === "rejected") ? " One discovery source is unavailable; the other results are retained." : ""}`);
      await finishRepairLease(lease, run, candidates, { snapshots: successes.flatMap(value => value.value), receipts: successes.map(value => value.receipt) }); return;
    }
    if (run.phase === "verifying") {
      const candidates: RepairCandidate[] = []; const snapshots: CatalogSnapshot[] = []; const receipts: CatalogReceipt[] = [];
      const next = run.discovery.slice(run.discoveryCursor, run.discoveryCursor + 2);
      for (const target of next) {
        const response = await runtime.refresh(target.productId, run.tenantId, Object.fromEntries(target.selectedOptions.map(option => [option.name, option.value])));
        freshSnapshot(response.value.snapshot, target.productId, target.selectedOptions);
        snapshots.push(response.value.snapshot); receipts.push(response.receipt);
        const evidence = evidenceFor(runtime.mode, [response.value.snapshot], [response.receipt], runtime.mode === "sample" ? "sample_fixture" : "similar_and_constraints", repairQuery(run));
        candidates.push(...candidatesFrom(run, response.value.snapshot, evidence));
        run.discoveryCursor++;
      }
      run.candidateIds = [...new Set([...run.candidateIds, ...candidates.map(candidate => candidate.id)])];
      if (run.discoveryCursor >= run.discovery.length) {
        const retained = run.candidateIds.length ? (await database().query("SELECT payload FROM wk_repair_candidates WHERE tenant_id=$1 AND id=ANY($2::text[])", [run.tenantId, run.candidateIds])).rows.map(row => row.payload as RepairCandidate) : [];
        const all = [...retained, ...candidates]; const ready = all.filter(candidate => candidate.technicalState === "satisfied");
        run.phase = ready.length ? "ready" : all.length ? "needs_evidence" : "no_alternative";
        run.reason = ready.length ? `${ready.length} ${ready.length === 1 ? "alternative preserves" : "alternatives preserve"} the hard brief and owned equipment. Review a controlled merchant proposal before granting any payment authority.` : all.length ? "Alternatives were found, but critical evidence or technical constraints remain open. No payment or kit change is allowed." : "No available exact alternative was established. Keep the saved kit and retry discovery when availability changes.";
        step(run, "verify", "Rechecked the whole technical promise", run.reason, ready.length ? "complete" : "blocked");
      } else run.reason = `${run.discoveryCursor} of ${run.discovery.length} alternative identities checked. Saved progress will resume here.`;
      await finishRepairLease(lease, run, candidates, { snapshots, receipts });
    }
  } catch (error) {
    const retryable = error instanceof WorldKitError ? error.status >= 500 || error.code === "rate_limited" : true;
    run.error = error instanceof WorldKitError ? error.message : "Discovery could not finish. The saved step can be retried without changing the kit or sending money.";
    run.reason = run.error; run.nextAttemptAt = new Date(Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(lease.attempts, 5))).toISOString();
    if (!retryable || lease.attempts >= 8) run.phase = "failed";
    await finishRepairLease(lease, run);
  }
}
export async function processRepairQueue(tenantId?: string, runId?: string, supplied?: RepairCatalogRuntime): Promise<number> {
  const lease = await claimRepair(tenantId, runId); if (!lease) return 0; await executeRepairLease(lease, supplied); return 1;
}
export async function retryRepair(session: Session, id: string): Promise<RepairRun> {
  return repairTransaction(async db => {
    const run = await loadRepair(session.id, id, db, true);
    if (["not_in_kit", "protected", "stale"].includes(run.phase)) throw new WorldKitError("stale_revision", run.reason, 409);
    if (run.amendmentId) { const amendment = await loadAmendment(session.id, run.amendmentId, db); if (amendment.acceptedAt) throw new WorldKitError("invalid_request", "An accepted amendment must be reconciled or compensated. Its source run cannot be reset.", 409); }
    run.phase = "queued"; run.error = null; run.attempts = 0; run.discovery = []; run.discoveryCursor = 0; run.candidateIds = []; run.amendmentId = null; run.selectedCandidateId = null; run.nextAttemptAt = repairNow();
    await saveRepair(db, run); await db.query("UPDATE wk_living_repairs SET lease_token=NULL,lease_until=NULL,attempts=0 WHERE id=$1", [run.id]); return run;
  });
}
export async function cancelRepairRun(session: Session, id: string): Promise<RepairRun> {
  return repairTransaction(async db => {
    const run = await loadRepair(session.id, id, db, true);
    if (run.amendmentId) {
      const amendment = await loadAmendment(session.id, run.amendmentId, db, true);
      if (amendment.acceptedAt) throw new WorldKitError("invalid_request", "An accepted change retains its original financial operation. Reconcile or compensate it before closing this repair.", 409);
      amendment.status = "cancelled"; amendment.reason = "This unaccepted proposal was closed with its repair. No payment authority was granted."; await saveAmendment(db, session.id, amendment);
    }
    run.phase = "cancelled"; run.reason = "Discovery is stopped. Its retained observations remain available, and no payment or kit change was made.";
    await saveRepair(db, run); await db.query("UPDATE wk_living_repairs SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND tenant_id=$2", [id, session.id]); return run;
  });
}
export async function proposeKitAmendment(session: Session, runId: string, candidateId: string, expectedDigest: string) {
  return repairTransaction(async db => {
    const run = await loadRepair(session.id, runId, db, true); const candidate = await loadCandidate(session.id, candidateId, db);
    if (!run.commitmentId) throw new WorldKitError("capability_requires_approval", "Accept the controlled demonstration commitment before requesting its quote.", 409);
    const commitment = await loadCommitment(session.id, run.commitmentId, db, true);
    if (!run.candidateIds.includes(candidate.id) || candidate.runId !== run.id || candidate.digest !== expectedDigest) throw new WorldKitError("stale_revision", "This candidate does not match the reviewed discovery result.", 409);
    if (run.amendmentId) { const prior = await loadAmendment(session.id, run.amendmentId, db); if (prior.proposal.candidateId === candidateId && prior.status !== "cancelled") return prior; if (prior.acceptedAt) throw new WorldKitError("invalid_request", "Reconcile the accepted change before selecting another replacement.", 409); prior.status = "cancelled"; prior.reason = "A newer reviewed candidate superseded this unaccepted proposal."; await saveAmendment(db, session.id, prior); }
    if (commitment.current.certificate.graphHash !== run.base.certificate.graphHash || commitment.current.kit.id !== run.base.kit.id || commitment.lines.some(line => line.fulfillment !== "unfulfilled")) throw new WorldKitError("stale_revision", "This controlled merchant commitment changed or entered fulfillment.", 409);
    if (Date.parse(candidate.evidence.expiresAt) <= Date.now()) throw new WorldKitError("quote_expired", "Refresh the discovery before preparing a new quote.", 409);
    const at = repairNow(); const expiresAt = new Date(Math.min(Date.parse(candidate.evidence.expiresAt), Date.now() + 10 * 60_000)).toISOString();
    const afterLines = commitment.lines.map(line => {
      if (!candidate.impact.changedComponentIds.includes(line.componentId)) return line;
      const component = candidate.bundle.kit.components.find(component => component.id === line.componentId)!;
      const profile = candidate.bundle.profiles.find(profile => profile.id === component.profileId)!;
      return { ...line, profileId: profile.id, model: profile.model, productId: candidate.offer.productId, selectedOptions: candidate.offer.selectedOptions, domain: candidate.offer.domain, offerId: candidate.offer.offerId, condition: candidate.offer.condition, unitMinor: candidate.offer.unitMinor, category: profile.kind };
    });
    const afterTotal = afterLines.reduce((sum, line) => sum + line.unitMinor * line.quantity, 0);
    const quoteValue = { id: randomUUID(), commitmentId: commitment.id, commitmentVersion: commitment.version, merchantId: "worldkit-studio" as const, beforeTotalMinor: commitment.currentTotalMinor, afterTotalMinor: afterTotal, deltaMinor: afterTotal - commitment.currentTotalMinor, currency: "USD" as const, beforeLines: commitment.lines, afterLines, shippingMinor: 0 as const, taxMinor: 0 as const, createdAt: at, expiresAt, policyVersion: "controlled-kit-sandbox.v1" as const, boundary: "Controlled demonstration only. No retailer reservation, order, shipment or refund is made." as const };
    const quote: MerchantQuote = { ...quoteValue, digest: hash(quoteValue) };
    const value = { id: randomUUID(), runId, candidateId, commitmentId: commitment.id, commitmentVersion: commitment.version, before: commitment.current, after: candidate.bundle, impact: candidate.impact, criticalChecks: candidate.criticalChecks, evidence: candidate.evidence, quote, kind: candidate.kind, sourceMode: run.sourceMode, createdAt: at, expiresAt, preserveOwned: true as const, preserveHardRequirements: true as const, technicalState: candidate.technicalState };
    const proposal: AmendmentProposal = { ...value, digest: hash(value) };
    const amendment = await insertAmendment(db, session.id, proposal); run.amendmentId = proposal.id; run.selectedCandidateId = candidate.id; await saveRepair(db, run);
    await repairNotice(db, session.id, `proposal:${proposal.id}`, { kind: "repair-proposal", title: "Your exact kit change is saved", detail: "Before and after graphs, critical checks and the controlled merchant quote are immutable. A fresh consent decision is still required.", sourceMode: run.sourceMode, runId: run.id, amendmentId: proposal.id });
    return amendment;
  });
}
