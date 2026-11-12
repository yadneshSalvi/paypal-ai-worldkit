import { createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { canonical, hash } from "../../packages/compatibility";
import { BENCH_POLICY, BENCH_SCHEMA, BenchCommandSchema, type BenchAccess, type BenchCommand, type BenchCommandResult, type BenchDecision, type BenchDetail, type BenchEdition, type BenchHome } from "../../packages/physical-notebook/contracts";
import { assessBench, initialBenchConditions } from "../../packages/physical-notebook/policy";
import { transaction } from "./db";
import { initializePhysicalNotebook } from "./physical-notebook-db";
import { authorizeBench, benchActor, benchEvent, benchFail, benchGrantDto, benchIso, benchPrincipal, benchRun, createBenchGrant, type BenchRow } from "./physical-notebook-authority";
import { benchAssets, benchUploadDto, createBenchSamples, createBenchUpload, assertBenchRights } from "./physical-notebook-assets";
import { benchSubjects, resolveBenchBinding } from "./physical-notebook-binding";
import { benchStorageMode } from "./physical-notebook-storage";
import { seal, unseal } from "./secrets";

function assertEdition(edition: BenchEdition) {
  const { hash: fingerprint, ...content } = edition;
  const { hash: bindingHash, ...binding } = edition.binding;
  if (hash(content) !== fingerprint || hash(binding) !== bindingHash) benchFail("The immutable report fingerprint is inconsistent.", "needs_evidence");
}
function currentEdition(row: BenchRow, edition: BenchEdition, command: { expectedEditionId: string; expectedVersion: number; expectedEditionHash: string }) {
  assertEdition(edition);
  if (row.version !== command.expectedVersion || row.current_edition_id !== command.expectedEditionId || edition.hash !== command.expectedEditionHash) benchFail("This report changed. Refresh and review its exact current edition before acting.", "stale_revision");
}
async function appendEdition(db: PoolClient, access: BenchAccess, edition: BenchEdition, patch: Partial<BenchEdition>, reason: string): Promise<BenchEdition> {
  if (edition.phase === "sealed") benchFail("The sealed manifest is immutable. Start a new report to record another test.", "stale_revision");
  if (edition.number >= 600) benchFail("This report has reached its edition allowance. Preserve it and open a new, clearly scoped report.", "needs_evidence");
  const { hash: _oldHash, ...prior } = edition;
  const content = { ...prior, ...patch, id: randomUUID(), number: edition.number + 1, parentId: edition.id, createdAt: new Date().toISOString(), reason };
  const next = { ...content, hash: hash(content) }; assertEdition(next);
  await insertEdition(db, access, next);
  await db.query("UPDATE wk_bench_runs SET current_edition_id=$2,version=$3 WHERE id=$1 AND tenant_id=$4", [edition.runId, next.id, next.number, access.tenantId]);
  await benchEvent(db, access, edition.runId, "edition.saved", reason, { editionId: next.id, number: next.number, hash: next.hash, parentId: edition.id, phase: next.phase });
  return next;
}
async function insertEdition(db: PoolClient, access: BenchAccess, edition: BenchEdition) {
  assertEdition(edition);
  await db.query("INSERT INTO wk_bench_editions(id,run_id,tenant_id,number,content_hash,payload) VALUES($1,$2,$3,$4,$5,$6)", [edition.id, edition.runId, access.tenantId, edition.number, edition.hash, edition]);
}
async function decisionsFor(db: PoolClient, access: BenchAccess, edition: BenchEdition): Promise<BenchDecision[]> {
  const rows = (await db.query("SELECT d.payload,g.status,g.version AS grant_version,g.expires_at FROM wk_bench_decisions d JOIN wk_bench_grants g ON g.id=d.grant_id AND g.tenant_id=d.tenant_id WHERE d.tenant_id=$1 AND d.run_id=$2 AND d.edition_id=$3 ORDER BY d.created_at,d.id", [access.tenantId, edition.runId, edition.id])).rows;
  const result: BenchDecision[] = [];
  for (const row of rows) {
    const payload = row.payload as BenchDecision;
    const current = await benchPrincipal(db, { tenantId: access.tenantId, actorId: payload.actorId, kind: "reviewer", grantId: payload.grantId }, edition.binding);
    result.push({ ...payload, currentlyQualified: current.qualified && current.qualificationId === payload.qualificationId && current.principalHash === payload.principalHash, currentAuthority: row.status === "active" && row.grant_version === payload.grantVersion && Date.parse(benchIso(row.expires_at)) > Date.now() && !current.actor.revoked_at });
  }
  return result;
}
async function detailFor(db: PoolClient, access: BenchAccess, runId: string, editionId?: string): Promise<BenchDetail> {
  const auth = await authorizeBench(db, access, runId); const { row, edition: current } = await benchRun(db, access, runId);
  let edition = current;
  if (editionId && editionId !== current.id) {
    if (access.kind === "reviewer") benchFail("This invitation covers only its exact sealed manifest.", "not_found");
    const saved = (await db.query("SELECT payload FROM wk_bench_editions WHERE id=$1 AND run_id=$2 AND tenant_id=$3", [editionId, runId, access.tenantId])).rows[0];
    if (!saved) benchFail("That report edition is outside this workspace.", "not_found"); edition = saved.payload;
  }
  assertEdition(edition);
  const history = (await db.query("SELECT id,number,content_hash,payload->>'phase' AS phase,payload->>'reason' AS reason,created_at FROM wk_bench_editions WHERE tenant_id=$1 AND run_id=$2 ORDER BY number DESC", [access.tenantId, runId])).rows.map(value => ({ id: value.id, number: value.number, hash: value.content_hash, phase: value.phase, reason: value.reason, createdAt: benchIso(value.created_at) }));
  const assets = (await benchAssets(db, access.tenantId, runId)).filter(asset => access.kind === "owner" || edition.attachments.some(link => link.assetId === asset.id && link.assetHash === asset.sha256));
  const uploads = access.kind === "owner" ? (await db.query("SELECT * FROM wk_bench_uploads WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at,id", [access.tenantId, runId])).rows.map(benchUploadDto) : [];
  const grantRows = (await db.query("SELECT * FROM wk_bench_grants WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at,id", [access.tenantId, runId])).rows.filter(grant => access.kind === "owner" || grant.id === access.grantId);
  const grants = []; for (const grant of grantRows) grants.push(await benchGrantDto(db, grant, edition.binding));
  const decisions = await decisionsFor(db, access, edition);
  const state = await resolveBenchBinding(db, access.tenantId, edition.binding);
  if (state.binding.hash !== edition.binding.hash) state.issues.push("The current software's bound profile, source or protocol snapshot differs. The immutable report retains its original basis.");
  const serials = (await db.query("SELECT id,component_id,serial_hash FROM wk_bench_serials WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at,id", [access.tenantId, runId])).rows.filter(value => edition.conditions.hardware.some(hardware => hardware.serialRecordId === value.id)).map(value => ({ id: value.id, componentId: value.component_id, hash: value.serial_hash }));
  const events = (await db.query("SELECT id,kind,summary,created_at FROM wk_bench_events WHERE tenant_id=$1 AND run_id=$2 AND ($3::text IS NULL OR (payload->>'grantId'=$3) OR (kind='review.recorded' AND payload->>'editionId'=$4)) ORDER BY created_at DESC,id LIMIT 200", [access.tenantId, runId, access.kind === "reviewer" ? access.grantId : null, edition.id])).rows.map(value => ({ id: value.id, kind: value.kind, summary: value.summary, at: benchIso(value.created_at) }));
  const reviewer = access.kind === "reviewer" ? await benchPrincipal(db, access, edition.binding) : null;
  await authorizeBench(db, access, runId);
  return { runId, currentEditionId: current.id, currentVersion: row.version, currentEditionHash: current.hash, edition, historical: edition.id !== current.id, subjectCurrent: state.current && !state.issues.length, subjectIssues: state.issues,
    history: access.kind === "owner" ? history : history.filter(value => value.id === edition.id), assets, uploads, grants, decisions, serials, assessment: assessBench(edition, assets, decisions), role: access.kind,
    reviewer: reviewer ? { name: reviewer.actor.name, provenance: reviewer.actor.provenance, qualified: reviewer.qualified, expiresAt: auth.expiresAt } : null, events };
}
export async function physicalNotebookHome(access: BenchAccess, runId?: string, editionId?: string): Promise<BenchHome> {
  await initializePhysicalNotebook();
  return transaction(async db => {
    const auth = await authorizeBench(db, access, runId);
    if (access.kind === "reviewer") runId = auth.grant!.run_id;
    const rows = (await db.query("SELECT r.id,r.source_mode,r.version,e.payload,e.created_at FROM wk_bench_runs r JOIN wk_bench_editions e ON e.id=r.current_edition_id AND e.run_id=r.id AND e.tenant_id=r.tenant_id WHERE r.tenant_id=$1 ORDER BY e.created_at DESC,r.id LIMIT 40", [access.tenantId])).rows.filter(row => access.kind === "owner" || row.id === runId);
    const selectedId = runId ?? rows[0]?.id;
    const reviewers: BenchHome["reviewers"] = [];
    if (access.kind === "owner") for (const value of (await db.query("SELECT id FROM wk_review_actors WHERE tenant_id=$1 AND kind='specialist' AND revoked_at IS NULL ORDER BY created_at,id LIMIT 80", [access.tenantId])).rows) {
      const actor = (await benchActor(db, access.tenantId, value.id))!;
      reviewers.push({ id: actor.id, name: actor.name, provenance: actor.provenance, qualification: actor.provenance === "sample" ? "sample" : actor.qualification && Date.parse(actor.qualification.expiresAt) <= Date.now() ? "expired" : "unestablished" });
    }
    const selected = selectedId ? await detailFor(db, access, selectedId, editionId) : null;
    if (selected && access.kind === "owner") for (const reviewer of reviewers) if (reviewer.provenance === "human") {
      const principal = await benchPrincipal(db, { tenantId: access.tenantId, actorId: reviewer.id, kind: "reviewer", grantId: null }, selected.edition.binding);
      if (principal.qualified) reviewer.qualification = "current";
    }
    const home: BenchHome = { workspaceKey: hash(["physical-notebook-workspace", access.tenantId, access.actorId, access.kind, access.grantId]), expiresAt: auth.expiresAt, policy: BENCH_POLICY, storage: benchStorageMode(), subjects: access.kind === "owner" ? await benchSubjects(db, access.tenantId) : [], reviewers,
      runs: rows.map(row => ({ id: row.id, title: row.payload.title, sourceMode: row.source_mode, phase: row.payload.phase, version: row.version, updatedAt: benchIso(row.created_at) })), selected };
    await authorizeBench(db, access, selectedId); return home;
  });
}

export async function physicalNotebookCommand(access: BenchAccess, value: unknown): Promise<BenchCommandResult> {
  const command = BenchCommandSchema.parse(value); await initializePhysicalNotebook();
  return transaction(async db => {
    const runId = "runId" in command ? command.runId : undefined;
    const auth = await authorizeBench(db, access, runId, command.kind === "review" ? "review" : "owner");
    if (command.kind === "review") {
      const found = await benchRun(db, access, command.runId); const principal = await benchPrincipal(db, access, found.edition.binding);
      if (principal.actor.provenance === "human" && !principal.qualified) benchFail(principal.reason);
    }
    const inputHash = command.kind === "private_serial" ? createHmac("sha256", process.env.AUTH_SECRET!).update(canonical(command)).digest("hex") : hash(command);
    const previous = (await db.query("SELECT input_hash,response_sealed FROM wk_bench_commands WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3", [access.tenantId, access.actorId, command.requestId])).rows[0];
    const scope = `physical-command:${access.tenantId}:${access.actorId}:${command.requestId}`;
    if (previous) {
      if (previous.input_hash !== inputHash) benchFail("This operation identity was already used for different details.", "stale_revision");
      const result = unseal<BenchCommandResult>(scope, previous.response_sealed);
      if (result.grant) {
        const grant = (await db.query("SELECT * FROM wk_bench_grants WHERE id=$1 AND tenant_id=$2", [result.grant.id, access.tenantId])).rows[0];
        if (!grant || grant.status === "revoked" || Date.parse(benchIso(grant.expires_at)) <= Date.now()) benchFail("That invitation has ended; it cannot be recovered or renewed.");
        const invitation = grant.status === "invited" ? result.grant.invitation : undefined;
        result.grant = { ...await benchGrantDto(db, grant, (await benchRun(db, access, result.runId)).edition.binding), ...(invitation ? { invitation } : {}) };
      }
      await authorizeBench(db, access, result.runId, command.kind === "review" ? "review" : "owner"); return result;
    }
    if (Number((await db.query("SELECT count(*) AS count FROM wk_bench_commands WHERE tenant_id=$1", [access.tenantId])).rows[0].count) >= 5000) benchFail("This private notebook has reached its operation allowance.", "needs_evidence");
    let result: BenchCommandResult;
    if (command.kind === "create") {
      if (Number((await db.query("SELECT count(*) AS count FROM wk_bench_runs WHERE tenant_id=$1", [access.tenantId])).rows[0].count) >= 40) benchFail("This workspace has reached its report allowance.", "needs_evidence");
      const { binding } = await resolveBenchBinding(db, access.tenantId, command.subject, true); const id = randomUUID(), editionId = randomUUID(), at = new Date().toISOString();
      await db.query("INSERT INTO wk_review_actors(id,tenant_id,name,kind,provenance) VALUES($1,$1,'Workspace creator','owner','human') ON CONFLICT(id) DO NOTHING", [access.tenantId]);
      const content = { schema: BENCH_SCHEMA, id: editionId, runId: id, number: 1, parentId: null, title: command.title, sourceMode: command.sourceMode, phase: "planning" as const, binding, conditions: initialBenchConditions(binding), observations: [], attachments: [], declaredAt: null, startedAt: null, finishedAt: null, sealedAt: null, createdAt: at, reason: command.sourceMode === "sample" ? "A generated Sample rehearsal was opened; physical execution is not claimed." : "A physical test plan was opened against an exact saved graph; execution is not yet recorded." };
      const edition = { ...content, hash: hash(content) };
      await db.query("INSERT INTO wk_bench_runs(id,tenant_id,creator_id,subject_kind,subject_id,revision_id,graph_hash,binding_hash,source_mode,current_edition_id,version) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,1)", [id, access.tenantId, binding.kind, binding.subjectId, binding.revisionId, binding.graphHash, binding.hash, command.sourceMode, editionId]);
      await insertEdition(db, access, edition); await benchEvent(db, access, id, "report.created", edition.reason, { editionId, graphHash: binding.graphHash, bindingHash: binding.hash }); result = { runId: id, editionId };
    } else {
      const { row, edition } = await benchRun(db, access, command.runId, true);
      if ("expectedEditionId" in command) currentEdition(row, edition, command);
      result = { runId: edition.runId };
      if (command.kind === "plan") {
        if (edition.phase !== "planning") benchFail("Exact conditions are fixed once recording begins.", "stale_revision");
        const hardware = command.conditions.hardware;
        if (hardware.length !== edition.binding.components.length || new Set(hardware.map(item => item.componentId)).size !== hardware.length || edition.binding.components.some(component => !hardware.some(item => item.componentId === component.id && item.model === component.model))) benchFail("Keep every exact bound hardware model. A substitution needs a newly verified system graph and report.", "invalid_request");
        for (const item of hardware) if (item.serialRecordId && !(await db.query("SELECT id FROM wk_bench_serials WHERE id=$1 AND run_id=$2 AND tenant_id=$3 AND component_id=$4", [item.serialRecordId, edition.runId, access.tenantId, item.componentId])).rowCount) benchFail("A private serial record belongs to a different component or report.", "not_found");
        result.editionId = (await appendEdition(db, access, edition, { conditions: command.conditions, declaredAt: new Date().toISOString() }, command.reason)).id;
      } else if (command.kind === "private_serial") {
        if (edition.phase !== "planning") benchFail("Private equipment identity is fixed once recording begins.", "stale_revision");
        if (!edition.binding.components.some(component => component.id === command.componentId)) benchFail("That component is not in this graph.", "not_found");
        const id = randomUUID(), serialHash = createHmac("sha256", process.env.AUTH_SECRET!).update(canonical(["physical-serial", access.tenantId, edition.runId, command.componentId, command.serial])).digest("hex");
        await db.query("INSERT INTO wk_bench_serials(id,run_id,tenant_id,component_id,serial_hash,sealed) VALUES($1,$2,$3,$4,$5,$6)", [id, edition.runId, access.tenantId, command.componentId, serialHash, seal(`physical-serial:${access.tenantId}:${id}`, { serial: command.serial })]);
        result.editionId = (await appendEdition(db, access, edition, { conditions: { ...edition.conditions, hardware: edition.conditions.hardware.map(item => item.componentId === command.componentId ? { ...item, serialRecordId: id } : item) } }, "A private equipment serial was sealed; only its keyed fingerprint appears in the manifest.")).id;
      } else if (command.kind === "start") {
        if (edition.phase !== "planning" || !edition.declaredAt) benchFail("Save exact conditions and the declared interval before starting.", "needs_evidence");
        if (edition.conditions.hardware.some(item => !item.matchesBoundModel)) benchFail("Confirm each exact hardware model before starting; substitutions need a new graph.", "needs_evidence");
        const current = await resolveBenchBinding(db, access.tenantId, edition.binding, true);
        if (current.binding.hash !== edition.binding.hash) benchFail("The bound source/protocol basis changed. Start a new report against the current saved system.", "stale_revision");
        result.editionId = (await appendEdition(db, access, edition, { phase: "running", startedAt: new Date().toISOString() }, "Recording began under the predeclared conditions. The clock is not proof of hardware operation.")).id;
      } else if (command.kind === "observe") {
        if (!["running", "recorded"].includes(edition.phase) || !edition.startedAt) benchFail("Record observations after Start and before sealing.", "stale_revision");
        if (!edition.binding.steps.some(step => step.id === command.observation.stepId)) benchFail("That protocol step is outside this manifest.", "not_found");
        const observed = Date.parse(command.observation.observedAt), maximum = edition.finishedAt ? Date.parse(edition.finishedAt) : Date.now() + 60_000;
        if (observed < Date.parse(edition.startedAt) || observed > maximum) benchFail("The observed time must be inside the recorded test interval.", "invalid_request");
        if (edition.observations.length >= 200) benchFail("This report has reached its observation allowance.", "needs_evidence");
        result.editionId = (await appendEdition(db, access, edition, { observations: [...edition.observations, { ...command.observation, id: randomUUID(), recordedAt: new Date().toISOString(), actorId: access.actorId }] }, `An operator observation was appended: ${command.observation.outcome.replaceAll("_", " ")}. Earlier observations remain retained.`)).id;
      } else if (command.kind === "finish") {
        if (edition.phase !== "running") benchFail("Only an active recording can finish.", "stale_revision");
        result.editionId = (await appendEdition(db, access, edition, { phase: "recorded", finishedAt: new Date().toISOString() }, `Recording finished: ${command.note}`)).id;
      } else if (command.kind === "upload_intent") result.upload = await createBenchUpload(db, access, edition, command.file);
      else if (command.kind === "sample_originals") result.sampleUploadIds = await createBenchSamples(db, access, edition);
      else if (command.kind === "verify_upload") {
        if (!(await db.query("SELECT id FROM wk_bench_uploads WHERE id=$1 AND run_id=$2 AND tenant_id=$3", [command.uploadId, edition.runId, access.tenantId])).rowCount) benchFail("That upload intent is outside this report.", "not_found"); result.verifyUploadId = command.uploadId;
      } else if (command.kind === "withdraw_upload") {
        const upload = (await db.query("SELECT * FROM wk_bench_uploads WHERE id=$1 AND run_id=$2 AND tenant_id=$3 FOR UPDATE", [command.uploadId, edition.runId, access.tenantId])).rows[0];
        if (!upload) benchFail("That upload is outside this report.", "not_found");
        if (upload.asset_id) benchFail("This original has been verified. Withdraw the saved original instead.", "stale_revision");
        if (!upload.withdrawn_at) {
          await db.query("UPDATE wk_bench_uploads SET phase='rejected',withdrawn_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,failure='Upload withdrawn. Private access is denied; original removal is pending.' WHERE id=$1", [upload.id]);
          await benchEvent(db, access, edition.runId, "upload.withdrawn", "An unverified or rejected upload was withdrawn. Its declaration and fingerprint history remain; no original evidence was attached.", { uploadId: upload.id, reason: command.reason });
        } result.withdrawn = true;
      } else if (command.kind === "attach") {
        const step = edition.binding.steps.find(value => value.id === command.stepId), asset = (await benchAssets(db, access.tenantId, edition.runId)).find(value => value.id === command.assetId);
        if (!step || !asset || asset.availability !== "available") benchFail("Choose an available original from this exact report.", "not_found");
        assertBenchRights(asset);
        if (!step.evidenceKinds.includes(asset.kind)) benchFail("That file kind does not support the selected protocol step.", "invalid_request");
        if (edition.attachments.some(link => link.assetId === asset.id && link.stepId === step.id)) benchFail("This original is already linked to that step.", "stale_revision");
        if (edition.attachments.length >= 120) benchFail("This report has reached its attachment allowance.", "needs_evidence");
        result.editionId = (await appendEdition(db, access, edition, { attachments: [...edition.attachments, { id: randomUUID(), assetId: asset.id, assetHash: asset.sha256, stepId: step.id, note: command.note, attachedAt: new Date().toISOString() }] }, "A verified original was explicitly linked to a protocol step; its byte identity is retained.")).id;
      } else if (command.kind === "withdraw_asset") {
        const asset = (await benchAssets(db, access.tenantId, edition.runId)).find(value => value.id === command.assetId); if (!asset) benchFail("That original is outside this report.", "not_found");
        if (asset.availability === "available") {
          await db.query("UPDATE wk_bench_asset_access SET state='withdrawn',reason=$2,withdrawn_at=clock_timestamp() WHERE asset_id=$1 AND tenant_id=$3 AND state='available'", [asset.id, command.reason, access.tenantId]);
          await db.query("UPDATE wk_bench_uploads SET withdrawn_at=COALESCE(withdrawn_at,clock_timestamp()) WHERE id=$1 AND tenant_id=$2", [asset.uploadId, access.tenantId]);
          await benchEvent(db, access, edition.runId, "original.withdrawn", "Private access to an original was withdrawn. Immutable manifests retain its fingerprint, but the missing original cannot support current review.", { assetId: asset.id, reason: command.reason });
        } result.withdrawn = true;
      } else if (command.kind === "seal") {
        if (edition.phase !== "recorded") benchFail("Finish the recorded interval before sealing the manifest. Incomplete or failed tests remain visible.", "needs_evidence");
        result.editionId = (await appendEdition(db, access, edition, { phase: "sealed", sealedAt: new Date().toISOString() }, "The exact report was sealed for scoped review; its observations, originals and limitations cannot be rewritten.")).id;
      } else if (command.kind === "invite_reviewer") {
        if (Number((await db.query("SELECT count(*) AS count FROM wk_bench_grants WHERE tenant_id=$1 AND run_id=$2", [access.tenantId, edition.runId])).rows[0].count) >= 30) benchFail("This report has reached its reviewer-invitation allowance.", "needs_evidence");
        result.grant = await createBenchGrant(db, access, edition, command);
      } else if (command.kind === "revoke_reviewer") {
        const grant = (await db.query("SELECT * FROM wk_bench_grants WHERE id=$1 AND run_id=$2 AND tenant_id=$3 FOR UPDATE", [command.grantId, edition.runId, access.tenantId])).rows[0]; if (!grant) benchFail("That invitation is outside this report.", "not_found");
        if (grant.status !== "revoked") { await db.query("UPDATE wk_bench_grants SET status='revoked',version=version+1,revoked_at=clock_timestamp() WHERE id=$1", [grant.id]); await benchEvent(db, access, edition.runId, "reviewer.revoked", "This review grant was revoked. Original decisions and contradictions remain retained, while current support loses this authority.", { grantId: grant.id }); } result.revoked = true;
      } else if (command.kind === "review") {
        if (edition.phase !== "sealed") benchFail("Only an exact sealed manifest can be reviewed.", "needs_evidence");
        const principal = await benchPrincipal(db, access, edition.binding); if (principal.actor.provenance === "human" && !principal.qualified) benchFail(principal.reason);
        const assets = await benchAssets(db, access.tenantId, edition.runId);
        for (const id of command.decision.inspectedAssetIds) {
          const asset = assets.find(value => value.id === id && value.availability === "available");
          if (!asset || !edition.attachments.some(link => link.assetId === id && link.assetHash === asset.sha256)) benchFail("Review only currently permitted originals attached to this exact sealed manifest.", "not_found"); assertBenchRights(asset);
        }
        if (new Set(command.decision.inspectedAssetIds).size !== command.decision.inspectedAssetIds.length) benchFail("List each inspected original only once.", "invalid_request");
        const prior = (await db.query("SELECT id FROM wk_bench_decisions WHERE edition_id=$1 AND principal_hash=$2 AND grant_id=$3", [edition.id, principal.principalHash, access.grantId])).rows[0]; if (prior) benchFail("This grant already recorded its immutable decision. The owner may issue a new scoped invitation for another review.", "stale_revision");
        const id = randomUUID();
        const decision: BenchDecision = { ...command.decision, id, editionId: edition.id, editionHash: edition.hash, actorId: access.actorId, actorName: principal.actor.name, principalHash: principal.principalHash, qualificationId: principal.qualificationId, grantId: access.grantId!, grantVersion: auth.grant!.version, provenance: principal.actor.provenance, createdAt: new Date().toISOString(), currentlyQualified: principal.qualified, currentAuthority: true };
        await db.query("INSERT INTO wk_bench_decisions(id,run_id,tenant_id,edition_id,actor_id,grant_id,principal_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, edition.runId, access.tenantId, edition.id, access.actorId, access.grantId, principal.principalHash, decision]);
        await benchEvent(db, access, edition.runId, "review.recorded", `${principal.actor.provenance === "sample" ? "A Sample" : "An independently qualified"} reviewer recorded an immutable decision against the exact sealed report. Existing compatibility certificates remain unchanged.`, { decisionId: id, editionId: edition.id, outcome: decision.outcome, provenance: decision.provenance }); result.decisionId = id;
      }
    }
    await authorizeBench(db, access, result.runId, command.kind === "review" ? "review" : "owner");
    if (command.kind === "review") { const { edition } = await benchRun(db, access, result.runId); const principal = await benchPrincipal(db, access, edition.binding); if (principal.actor.provenance === "human" && !principal.qualified) benchFail(principal.reason); }
    await db.query("INSERT INTO wk_bench_commands(tenant_id,actor_id,request_id,kind,input_hash,response_sealed) VALUES($1,$2,$3,$4,$5,$6)", [access.tenantId, access.actorId, command.requestId, command.kind, inputHash, seal(scope, result)]); return result;
  });
}
