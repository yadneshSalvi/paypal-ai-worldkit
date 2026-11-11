import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { WorldKitError, type CatalogSnapshot, type DeviceProfile, type Source } from "../../packages/contracts";
import { graphHash, hash } from "../../packages/compatibility";
import { profiles as referenceProfiles, sources as referenceSources } from "../../packages/device-library";
import { candidateProfiles, candidateSources } from "../../packages/device-library/candidates";
import type { InventoryItem } from "../../packages/inventory/contracts";
import type { KitCommitment } from "../../packages/living-repair/contracts";
import { catalogObservations, offerCurrent } from "../../packages/synthesis/cost";
import { SYNTHESIS_VERSION, SynthesisCommandSchema, type Basis, type Bundle, type Choice, type ComparisonDetail, type ComparisonEdition, type Freshness, type OfferObservation, type SynthesisCommandResult, type SynthesisHome, type SynthesisInput, type UpgradeJourney } from "../../packages/synthesis/contracts";
import { makeComparison, makeJourney } from "../../packages/synthesis/solver";
import { verifySystem } from "../../packages/synthesis/validation";
import { database, transaction } from "./db";
import { assertEngineeringProfilesCurrent } from "./engineering-review";
import { initializeSynthesis } from "./synthesis-db";
import { appendEvent, saveRevision, type Session } from "./repository";

export type SynthesisAccess = { tenantId: string; actorId: string; kind: "owner" };
export const synthesisOwner = (session: Session): SynthesisAccess => ({ tenantId: session.id, actorId: session.id, kind: "owner" });
const deny = (message: string, code: "forbidden" | "stale_revision" | "needs_evidence" | "invalid_request" = "stale_revision"): never => { throw new WorldKitError(code, message, code === "forbidden" ? 403 : code === "invalid_request" ? 400 : 409, code === "stale_revision" ? "Rebase this comparison; your saved draft is retained" : null); };
async function authorize(db: PoolClient, access: SynthesisAccess, lock = false) {
  if (access.kind !== "owner" || access.actorId !== access.tenantId) deny("Only the current workspace owner can change a comparison. A verifier or reviewer grant does not authorize this action.", "forbidden");
  if (!(await db.query(`SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp()${lock ? " FOR UPDATE" : ""}`, [access.tenantId])).rowCount) deny("This workspace access has expired. Earlier comparisons remain saved.", "forbidden");
}
const deduplicate = <T extends { id: string }>(values: T[]) => [...new Map([...values].reverse().map(value => [value.id, value])).values()].sort((a, b) => a.id.localeCompare(b.id));

/** One transaction reads the version vector and every candidate premise. It
 * calls no catalog, model, merchant, payment or subscription provider. */
export async function loadSynthesisInput(db: PoolClient, tenantId: string, lock = false): Promise<SynthesisInput> {
  const row = (await db.query(`SELECT r.kit,r.certificate,r.profiles,r.sources FROM wk_kits k JOIN wk_revisions r ON r.id=k.current_revision_id AND r.tenant_id=k.tenant_id WHERE k.tenant_id=$1 ORDER BY k.created_at LIMIT 1${lock ? " FOR UPDATE OF k" : ""}`, [tenantId])).rows[0] as Bundle | undefined;
  if (!row) throw new WorldKitError("not_found", "This workspace has no saved kit.", 404);
  const inventoryRows = (await db.query(`SELECT id,version,payload FROM wk_inventory_items WHERE tenant_id=$1 ORDER BY id${lock ? " FOR SHARE" : ""}`, [tenantId])).rows;
  const snapshots = (await db.query("SELECT snapshot FROM wk_catalog WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 80", [tenantId])).rows.map(value => value.snapshot as CatalogSnapshot);
  const sourceHeads = (await db.query(`SELECT h.profile_id,h.version,h.document_id,d.content_hash,d.text_hash,d.status,d.source_url FROM wk_source_heads h JOIN wk_source_documents d ON d.id=h.document_id AND d.tenant_id=h.tenant_id WHERE h.tenant_id=$1 ORDER BY h.profile_id${lock ? " FOR SHARE OF h,d" : ""}`, [tenantId])).rows;
  const sourceProfiles = (await db.query("SELECT payload,source FROM wk_source_profile_versions WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 120", [tenantId])).rows;
  const reviewed = (await db.query(`SELECT p.payload,p.source,h.profile_id,h.version,h.promotion_id FROM wk_review_profile_heads h LEFT JOIN wk_review_profiles p ON p.id=h.promotion_id AND p.tenant_id=h.tenant_id WHERE h.tenant_id=$1 ORDER BY h.profile_id${lock ? " FOR SHARE OF h" : ""}`, [tenantId])).rows;
  const actors = (await db.query(`SELECT id,version,qualification_id,revoked_at FROM wk_review_actors WHERE tenant_id=$1 ORDER BY id${lock ? " FOR SHARE" : ""}`, [tenantId])).rows;
  const capabilities = (await db.query(`SELECT id,actor_id,version,status,expires_at,revoked_at FROM wk_review_capabilities WHERE tenant_id=$1 ORDER BY id${lock ? " FOR SHARE" : ""}`, [tenantId])).rows;
  const qualifications = (await db.query("SELECT id,actor_id,payload->>'expiresAt' AS expires_at FROM wk_review_qualifications WHERE tenant_id=$1 ORDER BY id", [tenantId])).rows;
  const assets = (await db.query(`SELECT h.profile_id,h.version,h.asset_id,a.image_hash,a.crop_hash,p.status AS photo_status FROM wk_review_asset_heads h JOIN wk_review_assets a ON a.id=h.asset_id AND a.tenant_id=h.tenant_id LEFT JOIN wk_inventory_photos p ON p.id=a.photo_id AND p.tenant_id=a.tenant_id WHERE h.tenant_id=$1 ORDER BY h.profile_id${lock ? " FOR SHARE OF h,a" : ""}`, [tenantId])).rows;
  const decisions = (await db.query("SELECT id,edition_id,payload FROM wk_review_decisions WHERE tenant_id=$1 ORDER BY id", [tenantId])).rows;
  const commitmentRows = (await db.query(`SELECT id,version,payload FROM wk_kit_commitments WHERE tenant_id=$1 AND kit_id=$2 ORDER BY id${lock ? " FOR SHARE" : ""}`, [tenantId, row.kit.kitId])).rows;
  const commerce = (await db.query("SELECT id,payload->>'status' AS status,payload->>'graphHash' AS graph_hash,payload->>'revisionId' AS revision_id FROM wk_commerce_orders WHERE tenant_id=$1 AND payload->>'kitId'=$2 ORDER BY id", [tenantId, row.kit.kitId])).rows;
  const sample = (await db.query("SELECT payload FROM wk_synthesis_sample_catalogs WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [tenantId])).rows[0]?.payload as { profiles: DeviceProfile[]; sources: Source[] } | undefined;
  const fixture = Boolean(sample && row.kit.sourceMode === "sample" && row.sources.length && row.sources.every(source => source.kind === "sample") && row.kit.components.every(component => row.profiles.find(profile => profile.id === component.profileId)?.manufacturer === "WorldKit Sample Studio"));
  const inventory = inventoryRows.map(value => value.payload as InventoryItem);
  const profiles = deduplicate(fixture ? [...sample!.profiles, ...inventory.map(item => item.profile), ...row.profiles] : [...reviewed.flatMap(value => value.payload ? [value.payload as DeviceProfile] : []), ...inventory.map(item => item.profile), ...sourceProfiles.map(value => value.payload as DeviceProfile), ...row.profiles, ...referenceProfiles, ...candidateProfiles]);
  const sources = deduplicate(fixture ? [...sample!.sources, ...row.sources] : [...reviewed.flatMap(value => value.source ? [value.source as Source] : []), ...sourceProfiles.map(value => value.source as Source), ...row.sources, ...referenceSources, ...candidateSources]);
  const savedOffers = fixture ? (await db.query("SELECT payload FROM wk_synthesis_observations WHERE tenant_id=$1 ORDER BY created_at DESC,id", [tenantId])).rows.map(value => value.payload as OfferObservation).filter(value => value.mode === "sample") : [];
  const offers = [...catalogObservations(profiles, snapshots), ...savedOffers].sort((a, b) => a.id.localeCompare(b.id));
  const invalidProfileIds: string[] = [];
  for (const profile of profiles.filter(profile => profile.engineeringReview)) {
    try { await assertEngineeringProfilesCurrent(db, tenantId, [profile]); }
    catch (error) { if (error instanceof WorldKitError && ["stale_revision", "forbidden", "needs_evidence"].includes(error.code)) invalidProfileIds.push(profile.id); else throw error; }
  }
  const sourceProblems = profiles.flatMap(profile => {
    const head = sourceHeads.find(value => value.profile_id === (profile.corpusId ?? profile.baseProfileId ?? profile.id));
    if (!head) return [];
    const current = profile.sourceVersion && profile.sourceVersion === head.content_hash && head.status === "available";
    return current ? [] : [{ profileId: profile.id, reason: head.status !== "available" ? "The current source document is unavailable. Its historical excerpt does not establish current availability." : "This profile does not bind the current exact source-document version. Complete a new source/engineering review before claiming it current." }];
  });
  const purchased = commitmentRows.map(value => { const commitment = value.payload as KitCommitment; return { id: commitment.id, version: commitment.version, graphHash: commitment.current.certificate.graphHash,
    components: commitment.current.kit.components.filter(component => commitment.lines.some(line => line.componentId === component.id)) }; });
  const now = new Date().toISOString();
  const basis: Basis = { revisionId: row.kit.id, graphHash: graphHash(row.kit, row.profiles), goalHash: hash(row.kit.goal), goalVersion: row.kit.goal.version,
    profilesHash: hash(profiles), sourcesHash: hash(sources), sourceHeadsHash: hash(sourceHeads), engineeringHash: hash({ reviewed, actors, capabilities, qualifications, assets, decisions, invalidProfileIds }),
    inventoryHash: hash(inventoryRows), offersHash: hash(offers), commitmentsHash: hash({ commitmentRows, commerce }), ruleVersion: SYNTHESIS_VERSION };
  return { base: row, profiles, sources, inventory, snapshots, offers, basis, purchased, invalidProfileIds, sourceProblems, fixture, now };
}

export function comparisonFreshness(edition: ComparisonEdition, current: SynthesisInput): Freshness {
  const titles: Record<keyof Basis, string> = { revisionId: "The saved graph revision changed", graphHash: "The graph identity changed", goalHash: "The goal changed", goalVersion: "The goal version changed", profilesHash: "An exact profile or variant changed", sourcesHash: "The saved source library changed", sourceHeadsHash: "A source document changed or became unavailable", engineeringHash: "An engineering edition, review or reviewer authority changed", inventoryHash: "Your equipment passport changed", offersHash: "An observed offer changed", commitmentsHash: "The purchased or merchant commitment history changed", ruleVersion: "The system rules changed" };
  const changes: Freshness["changes"] = (Object.keys(edition.basis) as (keyof Basis)[]).filter(key => edition.basis[key] !== current.basis[key]).map(field => ({ field, title: titles[field] }));
  if (edition.candidates.some(candidate => candidate.cost.lines.some(line => line.state === "current" && line.observation && !offerCurrent(line.observation, current.now)))) changes.push({ field: "offers_expired", title: "An exact offer observation expired" });
  return { current: !changes.length, changes, checkedAt: current.now };
}
async function editionRow(db: PoolClient, tenantId: string, id: string): Promise<ComparisonEdition> {
  const row = (await db.query("SELECT payload,content_hash FROM wk_synthesis_editions WHERE id=$1 AND tenant_id=$2", [id, tenantId])).rows[0];
  if (!row) throw new WorldKitError("not_found", "That comparison does not belong to this workspace.", 404);
  const edition = row.payload as ComparisonEdition; const { hash: claimed, ...payload } = edition;
  if (claimed !== row.content_hash || hash(payload) !== claimed) deny("This immutable comparison no longer matches its recorded identity.");
  return edition;
}
async function choiceRow(db: PoolClient, tenantId: string, editionId: string, lock = false): Promise<Choice> {
  const row = (await db.query(`SELECT edition_id,version,candidate_id,applied_revision_id,applied_at FROM wk_synthesis_choices WHERE tenant_id=$1 AND edition_id=$2${lock ? " FOR UPDATE" : ""}`, [tenantId, editionId])).rows[0];
  if (!row) throw new WorldKitError("not_found", "This comparison has no saved choice record.", 404);
  return { editionId: row.edition_id, version: row.version, candidateId: row.candidate_id, appliedRevisionId: row.applied_revision_id, appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null };
}
async function detail(db: PoolClient, tenantId: string, id: string, input: SynthesisInput): Promise<ComparisonDetail> {
  const edition = await editionRow(db, tenantId, id), choice = await choiceRow(db, tenantId, id);
  const journeys = (await db.query("SELECT payload FROM wk_synthesis_journeys WHERE tenant_id=$1 AND edition_id=$2 ORDER BY created_at,id", [tenantId, id])).rows.map(value => value.payload as UpgradeJourney);
  const choiceHistory = (await db.query("SELECT version,candidate_id,applied_revision_id,kind,created_at FROM wk_synthesis_choice_events WHERE tenant_id=$1 AND edition_id=$2 ORDER BY version", [tenantId, id])).rows.map(value => ({ version: value.version, candidateId: value.candidate_id, appliedRevisionId: value.applied_revision_id, kind: value.kind, createdAt: new Date(value.created_at).toISOString() }));
  return { edition, choice, choiceHistory, freshness: comparisonFreshness(edition, input), journeys };
}
export async function synthesisHome(access: SynthesisAccess, id?: string): Promise<SynthesisHome> {
  await initializeSynthesis();
  return transaction(async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); await authorize(db, access);
    const input = await loadSynthesisInput(db, access.tenantId);
    const rows = (await db.query("SELECT e.id,e.sequence,e.created_at,e.previous_edition_id,e.payload->>'outcome' AS outcome,e.payload->'goal'->>'title' AS goal,e.payload->>'sourceMode' AS source_mode,jsonb_array_length(e.payload->'candidates') AS candidate_count,c.candidate_id,c.applied_revision_id FROM wk_synthesis_editions e JOIN wk_synthesis_choices c ON c.edition_id=e.id AND c.tenant_id=e.tenant_id WHERE e.tenant_id=$1 ORDER BY e.sequence DESC LIMIT 60", [access.tenantId])).rows;
    const active = id ?? rows[0]?.id;
    const current = active ? await detail(db, access.tenantId, active, input) : null;
    await authorize(db, access);
    return { history: rows.map(row => ({ id: row.id, sequence: row.sequence, createdAt: new Date(row.created_at).toISOString(), previousEditionId: row.previous_edition_id, outcome: row.outcome, goal: row.goal, candidateCount: row.candidate_count, selectedCandidateId: row.candidate_id, appliedRevisionId: row.applied_revision_id, sourceMode: row.source_mode })), current, currentRevisionId: input.base.kit.id, currentGraphHash: input.basis.graphHash };
  });
}
async function insertEdition(db: PoolClient, access: SynthesisAccess, input: SynthesisInput, previous?: ComparisonEdition, preference?: string | null, goal?: ComparisonEdition["goal"], changes?: ComparisonEdition["goalChanges"]): Promise<ComparisonEdition> {
  const sequence = Number((await db.query("SELECT coalesce(max(sequence),0)+1 AS next FROM wk_synthesis_editions WHERE tenant_id=$1 AND kit_id=$2", [access.tenantId, input.base.kit.kitId])).rows[0].next);
  const edition = makeComparison(input, { id: randomUUID(), sequence, createdBy: access.actorId, previous, preferredCandidateId: preference, goal, changes });
  await db.query("INSERT INTO wk_synthesis_editions(id,tenant_id,kit_id,sequence,previous_edition_id,content_hash,payload,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [edition.id, access.tenantId, edition.kitId, sequence, edition.previousEditionId, edition.hash, edition, access.actorId]);
  await db.query("INSERT INTO wk_synthesis_choices(edition_id,tenant_id,candidate_id) VALUES($1,$2,$3)", [edition.id, access.tenantId, edition.rebasedPreference?.matchedCandidateId ?? null]);
  await db.query("INSERT INTO wk_synthesis_choice_events(tenant_id,edition_id,version,candidate_id,kind) VALUES($1,$2,1,$3,'opened')", [access.tenantId, edition.id, edition.rebasedPreference?.matchedCandidateId ?? null]);
  await appendEvent(db, access.tenantId, previous ? "synthesis.rebased" : "synthesis.compared", previous ? "Comparison rebased for review" : "Complete systems compared", `Edition ${sequence} checked ${edition.candidates.length} complete configurations. ${edition.candidates.filter(candidate => candidate.feasible).length} satisfy this exact brief. Earlier editions remain unchanged; no purchase is approved.`, input.base.kit.id, input.fixture ? "sample" : "modelled");
  return edition;
}

export async function synthesisCommand(access: SynthesisAccess, raw: unknown): Promise<SynthesisCommandResult> {
  const command = SynthesisCommandSchema.parse(raw); await initializeSynthesis();
  try { return await transaction(async db => {
    // Owner and kit locks establish a single application boundary. A racing
    // graph edit or second comparison command receives a reviewable conflict.
    await authorize(db, access, true);
    const prior = (await db.query("SELECT input_hash,response FROM wk_synthesis_commands WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3", [access.tenantId, access.actorId, command.requestId])).rows[0];
    if (prior) { if (prior.input_hash !== hash(command)) deny("This request identity already belongs to another exact action."); return prior.response as SynthesisCommandResult; }
    const input = await loadSynthesisInput(db, access.tenantId, true);
    let response: SynthesisCommandResult;
    if (command.kind === "compare") {
      if (command.expectedRevisionId !== input.basis.revisionId || command.expectedGraphHash !== input.basis.graphHash) deny("The current kit changed before this comparison started. Refresh it and recompute.");
      const edition = await insertEdition(db, access, input); response = { editionId: edition.id, choiceVersion: 1 };
    } else {
      const edition = await editionRow(db, access.tenantId, command.editionId), choice = await choiceRow(db, access.tenantId, edition.id, true);
      if (edition.hash !== command.expectedEditionHash || choice.version !== command.expectedChoiceVersion) deny("Another view updated this choice. Your draft remains saved; reload it before continuing.");
      const freshness = comparisonFreshness(edition, input);
      if (!["prefer", "rebase"].includes(command.kind) && !freshness.current) deny(`${freshness.changes[0]!.title}. Rebase this saved comparison before applying it.`);
      const candidate = (id: string) => { const value = edition.candidates.find(candidate => candidate.id === id); if (!value) throw new WorldKitError("not_found", "This candidate does not belong to the exact comparison edition.", 404); return value; };
      if (command.kind === "rebase") {
        if (command.expectedRevisionId !== input.basis.revisionId || command.expectedGraphHash !== input.basis.graphHash) deny("The current graph changed again. Reload the current revision before rebasing.");
        const rebased = await insertEdition(db, access, input, edition, choice.candidateId);
        response = { editionId: rebased.id, choiceVersion: 1 };
      } else if (command.kind === "relax") {
        const relaxation = edition.relaxations.find(value => value.id === command.relaxationId);
        if (!relaxation) throw new WorldKitError("not_found", "This exact relaxation is not in the saved comparison.", 404);
        const proposed = await insertEdition(db, access, input, edition, null, relaxation.proposedGoal, relaxation.changes);
        response = { editionId: proposed.id, choiceVersion: 1 };
      } else if (command.kind === "journey") {
        const first = candidate(command.firstCandidateId), later = candidate(command.laterCandidateId);
        if (first.id === later.id || first.architecture === later.architecture) deny("Choose a genuinely different later architecture for this upgrade journey.", "invalid_request");
        if (first.state === "violated" || later.state === "violated") deny("A proposed stage still violates the hard brief. Resolve its exact conflict or review an explicit relaxation first.", "needs_evidence");
        if (!((later.objectives.spareInputs ?? -1) > (first.objectives.spareInputs ?? -1) || later.objectives.externalRecordingDependencies < first.objectives.externalRecordingDependencies)) deny("The later stage must add sourced input capacity or remove a recording dependency. Choose a meaningful upgrade.", "invalid_request");
        const journey = makeJourney(input, edition, first, later, randomUUID());
        await db.query("INSERT INTO wk_synthesis_journeys(id,tenant_id,kit_id,edition_id,content_hash,payload) VALUES($1,$2,$3,$4,$5,$6)", [journey.id, access.tenantId, edition.kitId, edition.id, journey.hash, journey]);
        await appendEvent(db, access.tenantId, "synthesis.journey_planned", "A staged upgrade is saved", "Two independently checked system proposals retain the original graph. Later reuse is conditional on acquisition. No funding, fulfillment, refund or repair permission is created.", input.base.kit.id, input.fixture ? "sample" : "modelled");
        response = { editionId: edition.id, choiceVersion: choice.version, journeyId: journey.id };
      } else {
        const selected = candidate(command.candidateId);
        if (choice.appliedRevisionId) deny("This choice was already applied. Rebase it into a new edition to consider another graph.");
        if (command.kind === "prefer") {
          await db.query("UPDATE wk_synthesis_choices SET candidate_id=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND edition_id=$2", [access.tenantId, edition.id, selected.id]);
          await db.query("INSERT INTO wk_synthesis_choice_events(tenant_id,edition_id,version,candidate_id,kind) VALUES($1,$2,$3,$4,'preferred')", [access.tenantId, edition.id, choice.version + 1, selected.id]);
          await appendEvent(db, access.tenantId, "synthesis.preference_saved", "System preference saved", `${selected.title} is saved for comparison. The current graph, purchase and repair authority have not changed.`, input.base.kit.id, input.fixture ? "sample" : "modelled");
          response = { editionId: edition.id, choiceVersion: choice.version + 1 };
        } else {
          if (choice.candidateId !== selected.id) deny("Save this exact candidate as your preference before applying its graph.", "invalid_request");
          if (edition.goalChanges.length && !command.acknowledgeGoalChanges) deny("Review and explicitly accept the displayed hard-goal changes before applying this graph.", "invalid_request");
          const recheckInput = { ...input, profiles: deduplicate([...input.profiles, ...selected.bundle.profiles.filter(profile => profile.id.startsWith("unresolved:"))]) };
          const recheck = verifySystem(selected.bundle.kit, recheckInput);
          if (recheck.certificate.graphHash !== selected.bundle.certificate.graphHash || recheck.certificate.sourceHash !== selected.bundle.certificate.sourceHash) deny("The exact profile, source or offer proof changed. Rebase this candidate before applying it.");
          if (recheck.certificate.status === "violated") deny("This graph violates a hard constraint. Review a different complete system or an explicit relaxation first.", "needs_evidence");
          if (recheck.certificate.status === "unknown" && !command.acknowledgeOpenQuestions) deny("This is a research plan. Acknowledge its unresolved premises before saving it as the current graph.", "needs_evidence");
          await assertEngineeringProfilesCurrent(db, access.tenantId, selected.bundle.profiles);
          await authorize(db, access);
          // Existing rows are held through application; this second read also
          // detects immutable offer/source rows appended during the evaluation.
          const finalInput = await loadSynthesisInput(db, access.tenantId, true);
          if (!comparisonFreshness(edition, finalInput).current) deny("Evidence changed while this candidate was under review. Rebase before applying it.");
          const kit = { ...structuredClone(selected.bundle.kit), id: randomUUID(), parentRevisionId: input.base.kit.id, revision: input.base.kit.revision + 1, createdAt: new Date().toISOString() };
          const bundle = { ...selected.bundle, kit, certificate: { ...recheck.certificate, revisionId: kit.id } };
          await saveRevision(db, access.tenantId, bundle);
          const updated = await db.query("UPDATE wk_kits SET current_revision_id=$1 WHERE id=$2 AND tenant_id=$3 AND current_revision_id=$4", [kit.id, kit.kitId, access.tenantId, input.base.kit.id]);
          if (!updated.rowCount) deny("Another graph was saved while this choice was under review.");
          await db.query("UPDATE wk_synthesis_choices SET version=version+1,applied_revision_id=$3,applied_at=now(),updated_at=now() WHERE tenant_id=$1 AND edition_id=$2", [access.tenantId, edition.id, kit.id]);
          await db.query("INSERT INTO wk_synthesis_choice_events(tenant_id,edition_id,version,candidate_id,applied_revision_id,kind) VALUES($1,$2,$3,$4,$5,'applied')", [access.tenantId, edition.id, choice.version + 1, selected.id, kit.id]);
          await appendEvent(db, access.tenantId, "synthesis.graph_applied", "Your chosen graph is saved", `Revision ${kit.revision} uses ${selected.title} ${recheck.certificate.status === "satisfied" ? "with the complete modeled checks satisfied" : "as an explicitly acknowledged research plan"}. Original graphs, certificates and purchase history are retained. No payment or repair authority was granted.`, kit.id, input.fixture ? "sample" : "modelled");
          response = { editionId: edition.id, choiceVersion: choice.version + 1, appliedRevisionId: kit.id };
        }
      }
    }
    await authorize(db, access);
    await db.query("INSERT INTO wk_synthesis_commands(tenant_id,actor_id,request_id,kind,input_hash,response) VALUES($1,$2,$3,$4,$5,$6)", [access.tenantId, access.actorId, command.requestId, command.kind, hash(command), response]);
    return response;
  }); } catch (error) {
    if (typeof error === "object" && error && "code" in error && ["40001", "40P01"].includes(String(error.code))) deny("A concurrent change interrupted this command. The earlier edition is intact; reload and review it.");
    throw error;
  }
}
