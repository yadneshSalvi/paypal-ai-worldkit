import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hash } from "../packages/compatibility";
import type { ComparisonDetail, SynthesisCommand } from "../packages/synthesis/contracts";
import { closeDatabase, database } from "../src/server/db";
import { authenticateAccess, commitEdit, createAccessToken, getRevision, revokeAccessToken } from "../src/server/repository";
import { createMcpServer, readScopedSynthesis } from "../src/server/mcp";
import { synthesisCommand, synthesisHome } from "../src/server/synthesis";
import { appendSampleCatalog, appendSampleObservation, expectedChoice, inventoryFixture, preservationSnapshot, seedSynthesisFixture } from "./support/synthesis-fixture";
import { requireIsolatedDatabase } from "./support/isolated-database";

requireIsolatedDatabase(); after(closeDatabase);
type Fixture = Awaited<ReturnType<typeof seedSynthesisFixture>>;
const preferred = async (fixture: Fixture, detail: ComparisonDetail, label = "balanced") => {
  const candidate = detail.edition.candidates.find(value => value.labels.includes(label as "balanced")) ?? detail.edition.candidates.find(value => value.state !== "violated")!;
  await synthesisCommand(fixture.owner, { kind: "prefer", requestId: randomUUID(), ...expectedChoice(detail), candidateId: candidate.id });
  return (await synthesisHome(fixture.owner, detail.edition.id)).current!;
};
const apply = (detail: ComparisonDetail): SynthesisCommand => ({ kind: "apply", requestId: randomUUID(), ...expectedChoice(detail), candidateId: detail.choice.candidateId!, acknowledgeOpenQuestions: false, acknowledgeGoalChanges: false, acknowledgePlanningOnly: true });
const rebase = async (fixture: Fixture, detail: ComparisonDetail) => {
  const current = await getRevision(fixture.session.id);
  const response = await synthesisCommand(fixture.owner, { kind: "rebase", requestId: randomUUID(), ...expectedChoice(detail), expectedRevisionId: current.kit.id, expectedGraphHash: current.certificate.graphHash });
  return (await synthesisHome(fixture.owner, response.editionId)).current!;
};

test("PG: preference, independently checked upgrade stages and application preserve original evidence and nonempty Sample financial history", async () => {
  const f = await seedSynthesisFixture();
  const orderId = randomUUID(), quoteId = randomUUID();
  await database().query("INSERT INTO wk_commerce_orders(id,tenant_id,quote_id,payload) VALUES($1,$2,$3,$4)", [orderId, f.session.id, quoteId, { id: orderId, kitId: f.input.base.kit.kitId, revisionId: f.input.base.kit.id, graphHash: f.input.base.certificate.graphHash, status: "sample_fixture_only", sourceMode: "sample", noProviderOperation: true }]);
  for (const kind of ["capture", "refund"]) await database().query("INSERT INTO wk_payment_resources(provider_id,tenant_id,order_id,kind,payload) VALUES($1,$2,$3,$4,$5)", [`sample-no-provider:${randomUUID()}`, f.session.id, orderId, kind, { sourceMode: "sample", kind, fixtureOnly: true, actualProviderEffect: false }]);
  const original = await getRevision(f.session.id), originalHash = hash(original), financial = await preservationSnapshot(f.session.id);
  let detail = await f.compare(); assert.equal(detail.freshness.current, true); assert.equal(detail.edition.sourceMode, "sample");
  assert.equal(detail.edition.candidates.filter(value => value.labels.length).length, 3);
  const editionHash = hash(detail.edition);
  detail = await preferred(f, detail, "budget");
  assert.equal(hash(await getRevision(f.session.id)), originalHash, "saving a preference cannot apply a graph");
  const first = detail.edition.candidates.find(value => value.id === detail.choice.candidateId)!, later = detail.edition.candidates.find(value => value.labels.includes("upgrade"))!;
  const journey = await synthesisCommand(f.owner, { kind: "journey", requestId: randomUUID(), ...expectedChoice(detail), firstCandidateId: first.id, laterCandidateId: later.id, acknowledgePlanningOnly: true });
  assert.ok(journey.journeyId); assert.equal(hash(await getRevision(f.session.id)), originalHash);
  detail = (await synthesisHome(f.owner, detail.edition.id)).current!;
  assert.equal(detail.journeys.length, 1); assert.ok(detail.journeys[0]!.stages.every(stage => stage.bundle.certificate.status === "satisfied" && stage.status === "proposed" && stage.funding === "not_approved" && stage.fulfillment === "not_performed"));
  const command = apply(detail), response = await synthesisCommand(f.owner, command), replay = await synthesisCommand(f.owner, command);
  assert.deepEqual(replay, response); assert.ok(response.appliedRevisionId);
  const current = await getRevision(f.session.id); assert.equal(current.kit.parentRevisionId, original.kit.id); assert.equal(current.kit.templateId, first.architecture);
  assert.equal(current.certificate.graphHash, first.bundle.certificate.graphHash); assert.equal(current.certificate.sourceHash, first.bundle.certificate.sourceHash);
  assert.equal(hash(await getRevision(f.session.id, original.kit.id)), originalHash);
  assert.deepEqual(await preservationSnapshot(f.session.id), financial);
  const retained = (await synthesisHome(f.owner, detail.edition.id)).current!; assert.equal(hash(retained.edition), editionHash);
  assert.deepEqual(retained.choiceHistory.map(event => event.kind), ["opened", "preferred", "applied"]);
  assert.equal(retained.freshness.current, false); assert.equal(retained.choice.appliedRevisionId, current.kit.id);
  await assert.rejects(() => synthesisCommand(f.owner, { kind: "prefer", requestId: randomUUID(), ...expectedChoice(retained), candidateId: later.id }), /already applied/);
});

test("PG: comparison editions, choice audit and journeys reject SQL update or deletion", async () => {
  const f = await seedSynthesisFixture(); let detail = await f.compare(); detail = await preferred(f, detail, "budget");
  const first = detail.edition.candidates.find(value => value.labels.includes("budget"))!, later = detail.edition.candidates.find(value => value.labels.includes("upgrade"))!;
  await synthesisCommand(f.owner, { kind: "journey", requestId: randomUUID(), ...expectedChoice(detail), firstCandidateId: first.id, laterCandidateId: later.id, acknowledgePlanningOnly: true });
  for (const table of ["wk_synthesis_editions", "wk_synthesis_choice_events", "wk_synthesis_commands", "wk_synthesis_journeys", "wk_synthesis_observations", "wk_synthesis_sample_catalogs"]) {
    await assert.rejects(() => database().query(`DELETE FROM ${table} WHERE tenant_id=$1`, [f.session.id]), /append-only/);
  }
  await assert.rejects(() => database().query("UPDATE wk_synthesis_editions SET content_hash='changed' WHERE id=$1", [detail.edition.id]), /append-only/);
  await assert.rejects(() => database().query("UPDATE wk_synthesis_choices SET candidate_id='foreign',version=version+1 WHERE edition_id=$1", [detail.edition.id]), /outside its exact/);
  await assert.rejects(() => database().query("UPDATE wk_synthesis_choices SET version=version+2 WHERE edition_id=$1", [detail.edition.id]), /new comparison edition/);
});

test("PG: simultaneous duplicate commands have one durable effect, and distinct racing applies have one winner", async () => {
  const f = await seedSynthesisFixture(), detail = await f.compare();
  const candidate = detail.edition.candidates.find(value => value.labels.includes("budget"))!, request: SynthesisCommand = { kind: "prefer", requestId: randomUUID(), ...expectedChoice(detail), candidateId: candidate.id };
  const values = await Promise.all([synthesisCommand(f.owner, request), synthesisCommand(f.owner, request)]); assert.deepEqual(values[0], values[1]);
  const saved = (await synthesisHome(f.owner, detail.edition.id)).current!; assert.equal(saved.choice.version, 2); assert.equal(saved.choiceHistory.length, 2);
  const changed = { ...request, candidateId: detail.edition.candidates.find(value => value.labels.includes("upgrade"))!.id };
  await assert.rejects(() => synthesisCommand(f.owner, changed), /identity already belongs/);
  const raced = await Promise.allSettled([synthesisCommand(f.owner, apply(saved)), synthesisCommand(f.owner, apply(saved))]);
  assert.equal(raced.filter(value => value.status === "fulfilled").length, 1); assert.equal(raced.filter(value => value.status === "rejected").length, 1);
  const final = (await synthesisHome(f.owner, detail.edition.id)).current!; assert.equal(final.choice.version, 3); assert.equal(final.choiceHistory.length, 3);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_revisions WHERE tenant_id=$1", [f.session.id])).rows[0].n, 3);
});

test("PG: racing preferences preserve both the winner and the losing view's exact immutable candidate", async () => {
  const f = await seedSynthesisFixture(), detail = await f.compare(), original = hash(detail.edition);
  const candidates = detail.edition.candidates.filter(value => value.labels.length).slice(0, 2);
  const results = await Promise.allSettled(candidates.map(candidate => synthesisCommand(f.owner, { kind: "prefer", requestId: randomUUID(), ...expectedChoice(detail), candidateId: candidate.id })));
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  const current = (await synthesisHome(f.owner, detail.edition.id)).current!; assert.equal(hash(current.edition), original);
  assert.equal(current.choice.version, 2); assert.ok(current.edition.candidates.some(value => value.id === candidates[1]!.id));
  await synthesisCommand(f.owner, { kind: "prefer", requestId: randomUUID(), ...expectedChoice(current), candidateId: candidates[1]!.id });
  const refreshed = (await synthesisHome(f.owner, detail.edition.id)).current!;
  assert.equal(refreshed.choiceHistory.length, 3); assert.ok(refreshed.choiceHistory[1]!.candidateId);
});

test("PG: a concurrent workbench graph edit cannot be overwritten by an old comparison apply", async () => {
  const f = await seedSynthesisFixture(), original = await getRevision(f.session.id); let detail = await f.compare(); detail = await preferred(f, detail);
  const results = await Promise.allSettled([
    synthesisCommand(f.owner, apply(detail)),
    commitEdit(f.session, original.kit.id, original.certificate.graphHash, { kind: "connection", connectionId: "mic2-audio", enabled: false }),
  ]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  const saved = (await synthesisHome(f.owner, detail.edition.id)).current!; assert.equal(saved.freshness.current, false);
  const fresh = await rebase(f, saved); assert.equal(fresh.edition.previousEditionId, saved.edition.id); assert.equal(fresh.freshness.current, true);
  assert.equal(hash((await synthesisHome(f.owner, saved.edition.id)).current!.edition), hash(detail.edition));
});

test("PG: new exact offers stale the draft, rebase keeps intent, and a new stock-out cannot revive an old price", async () => {
  const f = await seedSynthesisFixture(); let detail = await f.compare(); detail = await preferred(f, detail, "budget");
  const offer = f.input.offers.find(value => value.profileId === "sample:interface")!;
  await appendSampleObservation(f.session.id, { ...offer, id: `new:${randomUUID()}`, observedAt: new Date().toISOString(), availability: "unavailable" });
  const stale = (await synthesisHome(f.owner, detail.edition.id)).current!; assert.ok(stale.freshness.changes.some(change => change.field === "offersHash"));
  await assert.rejects(() => synthesisCommand(f.owner, apply(detail)), /offer|Offer|evidence|Evidence/);
  const fresh = await rebase(f, stale); assert.equal(fresh.freshness.current, true); assert.ok(fresh.edition.rebasedPreference?.matchedCandidateId);
  const matched = fresh.edition.candidates.find(value => value.id === fresh.choice.candidateId)!;
  assert.equal(matched.architecture, "T1"); assert.equal(matched.feasible, false);
  assert.equal(matched.cost.lines.find(line => line.componentId === "audio")!.state, "unavailable");
  assert.equal((await getRevision(f.session.id)).kit.id, f.input.base.kit.id);
});

test("PG: exact profile/source changes, equipment quantity, review authority and source-head versions each require rebase", async () => {
  for (const change of ["profile", "inventory", "review", "source"] as const) {
    const f = await seedSynthesisFixture(); let detail = await f.compare(); detail = await preferred(f, detail);
    if (change === "profile") {
      const input = structuredClone(f.input), host = input.profiles.find(value => value.kind === "host")!;
      host.version++; host.facts.appVersion!.value = "Sample Studio 2"; input.sources[0]!.contentHash = hash("new fictional source edition");
      await appendSampleCatalog(f.session.id, input);
    } else if (change === "inventory") {
      const item = inventoryFixture(f.input.profiles.find(value => value.kind === "camera")!);
      await database().query("INSERT INTO wk_inventory_items(id,tenant_id,version,request_id,request_hash,payload) VALUES($1,$2,$3,$4,$5,$6)", [item.id, f.session.id, item.version, randomUUID(), hash(item), item]);
    } else if (change === "review") {
      await database().query("INSERT INTO wk_review_actors(id,tenant_id,name,kind,provenance,version,revoked_at) VALUES($1,$2,'Fictional retired reviewer','specialist','sample',2,now())", [randomUUID(), f.session.id]);
    } else {
      const document = randomUUID(), job = randomUUID();
      await database().query("INSERT INTO wk_jobs(id,tenant_id,kind,status,input) VALUES($1,$2,'sample_synthesis_source','succeeded',$3)", [job, f.session.id, { sourceMode: "sample" }]);
      await database().query("INSERT INTO wk_source_documents(id,tenant_id,profile_id,job_id,source_url,blob_path,content_hash,text_hash,media_type,bytes,payload,status) VALUES($1,$2,'sample:host',$3,'https://example.invalid/sample-synthesis','sample/never-an-actual-artifact',$4,$5,'text/plain',1,$6,'unavailable')", [document, f.session.id, job, hash("Sample source"), hash("Sample text"), { provenance: "sample", actualSourceRetrieval: false }]);
      await database().query("INSERT INTO wk_source_heads(tenant_id,profile_id,document_id,version) VALUES($1,'sample:host',$2,1)", [f.session.id, document]);
    }
    const stale = (await synthesisHome(f.owner, detail.edition.id)).current!;
    assert.equal(stale.freshness.current, false, change); assert.equal(hash(stale.edition), hash(detail.edition));
    await assert.rejects(() => synthesisCommand(f.owner, apply(detail)), error => (error as { status: number }).status === 409);
    const fresh = await rebase(f, stale); assert.equal(fresh.freshness.current, true);
    if (change === "source") assert.ok(fresh.edition.candidates.every(value => !value.feasible));
  }
});

test("PG: expired observations are detected by clock freshness without mutating their immutable rows", async () => {
  const f = await seedSynthesisFixture(), offer = f.input.offers.find(value => value.profileId === "sample:recorder")!;
  await appendSampleObservation(f.session.id, { ...offer, id: randomUUID(), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 550).toISOString() });
  const detail = await f.compare(); assert.equal(detail.freshness.current, true);
  await new Promise(resolve => setTimeout(resolve, 650));
  const expired = (await synthesisHome(f.owner, detail.edition.id)).current!; assert.ok(expired.freshness.changes.some(change => change.field === "offers_expired"));
  assert.equal(hash(expired.edition), hash(detail.edition));
});

test("PG: relaxing a hard goal is a separate reviewable edition; only explicit application changes the current goal", async () => {
  const f = await seedSynthesisFixture({ budgetMinor: 10000, name: "Sample impossible budget" }), original = await getRevision(f.session.id);
  const impossible = await f.compare(); assert.equal(impossible.edition.outcome, "infeasible");
  const relaxation = impossible.edition.relaxations[0]!; assert.equal(relaxation.changes[0]!.after, 25300);
  await assert.rejects(() => synthesisCommand(f.owner, { kind: "relax", requestId: randomUUID(), ...expectedChoice(impossible), relaxationId: relaxation.id, acknowledgeGoalChanges: false }));
  const response = await synthesisCommand(f.owner, { kind: "relax", requestId: randomUUID(), ...expectedChoice(impossible), relaxationId: relaxation.id, acknowledgeGoalChanges: true });
  let proposed = (await synthesisHome(f.owner, response.editionId)).current!;
  assert.equal((await getRevision(f.session.id)).kit.goal.budgetMinor, 10000); assert.equal(proposed.edition.originalGoal.budgetMinor, 10000); assert.equal(proposed.edition.goal.budgetMinor, 25300);
  proposed = await preferred(f, proposed, "budget");
  await assert.rejects(() => synthesisCommand(f.owner, apply(proposed)), /explicitly accept/);
  await synthesisCommand(f.owner, { ...apply(proposed), acknowledgeGoalChanges: true });
  assert.equal((await getRevision(f.session.id)).kit.goal.budgetMinor, 25300);
  assert.equal(hash(await getRevision(f.session.id, original.kit.id)), hash(original));
  assert.equal(hash((await synthesisHome(f.owner, impossible.edition.id)).current!.edition), hash(impossible.edition));
});

test("PG: research plans require acknowledgement, and a hard-conflict candidate cannot be applied", async () => {
  const f = await seedSynthesisFixture({ missingEvidence: true }); let detail = await f.compare(); detail = await preferred(f, detail);
  assert.equal(detail.edition.candidates.find(value => value.id === detail.choice.candidateId)!.state, "unknown");
  await assert.rejects(() => synthesisCommand(f.owner, apply(detail)), /research plan/);
  await synthesisCommand(f.owner, { ...apply(detail), acknowledgeOpenQuestions: true });
  assert.equal((await getRevision(f.session.id)).certificate.status, "unknown");
  const conflict = await seedSynthesisFixture(); let checked = await conflict.compare();
  const invalid = checked.edition.candidates.find(value => value.state === "violated")!;
  await synthesisCommand(conflict.owner, { kind: "prefer", requestId: randomUUID(), ...expectedChoice(checked), candidateId: invalid.id });
  checked = (await synthesisHome(conflict.owner, checked.edition.id)).current!;
  await assert.rejects(() => synthesisCommand(conflict.owner, { ...apply(checked), acknowledgeOpenQuestions: true }), /violates a hard constraint/);
});

test("PG: tenant, current actor, exact candidate and owner expiry boundaries are enforced", async () => {
  const f = await seedSynthesisFixture(), stranger = await seedSynthesisFixture(); const detail = await f.compare();
  await assert.rejects(() => synthesisHome(stranger.owner, detail.edition.id), /does not belong/);
  await assert.rejects(() => synthesisCommand({ ...f.owner, actorId: stranger.session.id }, { kind: "prefer", requestId: randomUUID(), ...expectedChoice(detail), candidateId: detail.edition.candidates[0]!.id }), /current workspace owner/);
  await assert.rejects(() => synthesisCommand(f.owner, { kind: "prefer", requestId: randomUUID(), ...expectedChoice(detail), candidateId: "candidate-from-another-edition" }), /does not belong/);
  await database().query("UPDATE wk_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [f.session.id]);
  await assert.rejects(() => synthesisHome(f.owner, detail.edition.id), /expired/);
  await assert.rejects(() => synthesisCommand(f.owner, { kind: "prefer", requestId: randomUUID(), ...expectedChoice(detail), candidateId: detail.edition.candidates[0]!.id }), /expired/);
  assert.equal((await getRevision(f.session.id)).kit.id, f.input.base.kit.id);
});

test("PG/MCP: an actual SDK client reads exact comparison and journey facts with scoped revocation, never edit authority", async () => {
  const f = await seedSynthesisFixture(), detail = await f.compare(), grant = await createAccessToken(f.session, ["kit:verify"]), principal = (await authenticateAccess(grant.token))!;
  const server = createMcpServer(principal), client = new Client({ name: "synthesis-resource-software-fixture", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
  const financial = await preservationSnapshot(f.session.id);
  try {
    const list = await client.listResources(), resources = list.resources.filter(resource => resource.uri.startsWith("worldkit://systems/")); assert.equal(resources.length, 2);
    const comparison = resources.find(resource => resource.uri.endsWith("/comparison"))!;
    const read = await client.readResource({ uri: comparison.uri }), value = JSON.parse((read.contents[0] as { text: string }).text);
    assert.equal(value.editionHash, detail.edition.hash); assert.deepEqual(value.edition, detail.edition); assert.equal(value.freshness.current, true); assert.equal(value.physicalTest, "not_performed");
    assert.equal(comparison.uri.includes(grant.token), false);
    assert.ok(!(await client.listTools()).tools.some(tool => /synthesis|apply_system|purchase/.test(tool.name)));
    const original = await getRevision(f.session.id); await commitEdit(f.session, original.kit.id, original.certificate.graphHash, { kind: "connection", connectionId: "mic2-audio", enabled: false });
    const stale = JSON.parse(((await client.readResource({ uri: comparison.uri })).contents[0] as { text: string }).text); assert.equal(stale.freshness.current, false); assert.deepEqual(stale.edition, value.edition);
    const foreign = await seedSynthesisFixture(), foreignGrant = await createAccessToken(foreign.session, ["kit:verify"]), foreignPrincipal = (await authenticateAccess(foreignGrant.token))!;
    await assert.rejects(() => readScopedSynthesis(foreignPrincipal, detail.edition.basis.revisionId, detail.edition.basis.graphHash, detail.edition.id, "comparison"), /does not belong/);
    const quoteOnly = await createAccessToken(f.session, ["kit:quote"]), quotePrincipal = (await authenticateAccess(quoteOnly.token))!;
    await assert.rejects(() => readScopedSynthesis(quotePrincipal, detail.edition.basis.revisionId, detail.edition.basis.graphHash, detail.edition.id, "upgrades"), /does not allow/);
    await assert.rejects(() => readScopedSynthesis(principal, detail.edition.basis.revisionId, "0".repeat(64), detail.edition.id, "comparison"), /does not match/);
    await revokeAccessToken(f.session, grant.id); await assert.rejects(() => client.readResource({ uri: comparison.uri }), /revoked|expired/); await assert.rejects(() => client.listResources(), /revoked|expired/);
    assert.deepEqual(await preservationSnapshot(f.session.id), financial);
  } finally { await client.close(); await server.close(); }
});
