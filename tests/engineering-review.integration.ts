import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { database, closeDatabase, transaction } from "../src/server/db";
import { authenticateReviewer, engineeringCommand, engineeringDetail, engineeringHome, engineeringSourcePage, inspectInvitation, qualifyEngineeringPrincipal, redeemInvitation, reviewedProfileLibrary } from "../src/server/engineering-review";
import { seedEngineeringFixture, acceptTargets, sourceSnapshot } from "./support/engineering-review-fixture";
import { requireIsolatedDatabase } from "./support/isolated-database";
import { hash, verifyKit } from "../packages/compatibility";
import { architectures } from "../packages/device-library";
import { ConfirmationSchema } from "../packages/inventory/contracts";
import { confirmInventory, previewInventory } from "../src/server/inventory";
import { getRevision, saveRevision } from "../src/server/repository";

requireIsolatedDatabase();
after(closeDatabase);
const denied = async (work: Promise<unknown>, code?: string) => assert.rejects(work, (error: any) => !code || error.code === code);
const expected = (f: Awaited<ReturnType<typeof seedEngineeringFixture>>) => ({ proposalId: f.proposalId, expectedVersion: f.detail.edition.version, expectedHash: f.detail.edition.hash });

// Only fictional qualifications are inserted here. The actual operator attestation
// seam refuses this isolated runtime and is never used to create synthetic people.
async function sampleQualification(f: Awaited<ReturnType<typeof seedEngineeringFixture>>, actorId: string, expiresAt: string, expertise: string[]) {
  const actor = (await engineeringHome(f.owner)).actors.find(value => value.id === actorId)!;
  assert.equal(actor.provenance, "sample");
  const value = { ...actor.qualification!, id: randomUUID(), expiresAt, expertise };
  await database().query("INSERT INTO wk_review_qualifications(id,tenant_id,actor_id,identity_hash,evidence_hash,payload) VALUES($1,$2,$3,$4,$5,$6)", [value.id, f.session.id, actorId, value.identityHash, value.evidenceHash, value]);
  await database().query("UPDATE wk_review_actors SET qualification_id=$2,version=version+1 WHERE id=$1", [actorId, value.id]);
}

test("reviewer capabilities isolate tenants, actors, exact kits and sources; source reading is scoped", async () => {
  const a = await seedEngineeringFixture(), b = await seedEngineeringFixture(), actor = await a.addActor("Sample scoped reviewer");
  assert.equal((await engineeringHome(actor.access)).candidates.length, 1);
  await denied(engineeringDetail(actor.access, b.proposalId), "not_found");
  await denied(engineeringHome({ ...actor.access, actorId: a.owner.actorId }), "forbidden");
  await denied(engineeringHome({ ...a.owner, tenantId: b.session.id }), "forbidden");
  const page = await engineeringSourcePage(actor.access, a.proposalId, a.detail.edition.id, 1, 0, 50);
  assert.equal(page.anchor?.excerptHash.length, 64);
  await denied(engineeringSourcePage(actor.access, b.proposalId, b.detail.edition.id, 1, 0), "not_found");
  await denied(a.command(actor.access, { kind: "invite", actorId: actor.actorId, role: "adjudicator", kitId: a.kit.kitId, profileId: a.profileId, documentId: a.documentId, expiresAt: new Date(Date.now() + 60000).toISOString() }), "forbidden");
  await denied(a.command(actor.access, { kind: "create", candidateId: a.candidateId, kitId: b.kit.kitId, expectedRevisionId: b.kit.id, expectedGraphHash: b.certificate.graphHash, provenance: "sample" }), "forbidden");
});

test("invitation redemption is one-time; revocation closes credentials and in-flight saved access", async () => {
  const f = await seedEngineeringFixture(), actor = await f.addActor("Sample revocation reviewer");
  await denied(redeemInvitation(actor.invitation.token));
  assert.ok(await authenticateReviewer(actor.credential));
  const cap = (await engineeringHome(f.owner)).capabilities.find(cap => cap.id === actor.invitation.capabilityId)!;
  await f.command(f.owner, { kind: "revoke", capabilityId: cap.id, expectedVersion: cap.version, reason: "Sample deliberate capability revocation." });
  assert.equal(await authenticateReviewer(actor.credential), null);
  await denied(engineeringDetail(actor.access, f.proposalId), "forbidden");
  await denied(inspectInvitation(actor.invitation.token), "not_found");
});

test("two distinct principals are required; invitation duplication cannot multiply a review", async () => {
  const f = await seedEngineeringFixture(), first = await f.addActor("Sample first reviewer"), second = await f.addActor("Sample second reviewer");
  await acceptTargets(first.access, f.detail);
  let detail = await engineeringDetail(f.owner, f.proposalId);
  assert.equal(detail.assessment.targets.find(target => target.id === "claim-2")!.accepted, 1);
  await denied(f.command(f.owner, { kind: "promote", ...expected(f), acknowledgeScope: true }), "needs_evidence");
  const another = await f.command(f.owner, { kind: "invite", actorId: first.actorId, role: "adjudicator", kitId: f.kit.kitId, profileId: f.profileId, documentId: f.documentId, expiresAt: new Date(Date.now() + 60000).toISOString() });
  const samePerson = await redeemInvitation(another.token);
  await denied(f.command(samePerson.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "A second link must never count as another person." }), "stale_revision");
  await f.command(second.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "Separate fictional reviewer of the same sample assertion." });
  detail = await engineeringDetail(f.owner, f.proposalId);
  assert.equal(detail.assessment.eligible, true);
  assert.equal(detail.assessment.actualReviewed, 0);
  assert.ok(detail.assessment.sampleReviewed > 0);
});

test("an unqualified person and the author cannot approve; Sample actors cannot become human reviewers", async () => {
  const f = await seedEngineeringFixture(), human = await f.addActor("Unqualified person", "reviewer", "human"), sample = await f.addActor("Sample proposal author");
  await denied(f.command(human.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "Possession of this invitation does not establish expertise." }), "forbidden");
  await denied(f.command(f.owner, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "Creator authority does not provide independent review." }), "forbidden");
  await denied(qualifyEngineeringPrincipal(f.session.id, sample.actorId, { identityHash: "a".repeat(64), evidenceHash: "b".repeat(64), expertise: ["engineering"], method: "This synthetic record must not manufacture a human qualification.", issuer: "Sample test", expiresAt: new Date(Date.now() + 60000).toISOString() }), "needs_evidence");
  await f.command(sample.access, { kind: "revise", ...expected(f), content: f.content, reason: "This sample reviewer authored a corrected version.", rebase: false });
  const next = await engineeringDetail(sample.access, f.proposalId);
  await denied(f.command(sample.access, { kind: "decide", proposalId: f.proposalId, expectedVersion: next.edition.version, expectedHash: next.edition.hash, targetId: "claim-2", outcome: "accept", reason: "The proposal author may not review its own edition." }), "forbidden");
});

test("disagreement cannot be voted away; exact-set two-principal adjudication preserves every reason", async () => {
  const f = await seedEngineeringFixture(), a = await f.addActor("Sample reviewer A"), b = await f.addActor("Sample reviewer B"), c = await f.addActor("Sample adjudicator C");
  await acceptTargets(a.access, f.detail);
  await f.command(b.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "reject", reason: "Sample disagreement: the stated firmware condition needs explicit adjudication." });
  await f.command(c.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "An extra acceptance must not erase the retained rejection." });
  let detail = await engineeringDetail(f.owner, f.proposalId), target = detail.assessment.targets.find(target => target.id === "claim-2")!;
  assert.equal(target.status, "conflicted");
  await denied(f.command(c.access, { kind: "adjudicate", ...expected(f), targetId: target.id, outcome: "accept", decisionSetHash: "0".repeat(64), reason: "Wrong decision set must fail closed without replacing votes." }), "stale_revision");
  for (const actor of [b, c]) await f.command(actor.access, { kind: "adjudicate", ...expected(f), targetId: target.id, outcome: "accept", decisionSetHash: target.decisionSetHash, reason: "Sample adjudication confirms the fictional firmware 1.0 condition against the exact retained disagreement." });
  detail = await engineeringDetail(f.owner, f.proposalId);
  assert.equal(detail.assessment.eligible, true);
  assert.equal(detail.decisions.filter(decision => decision.targetId === "claim-2").length, 5);
  assert.ok(detail.decisions.some(decision => decision.outcome === "reject"));
});

test("stale source head, normalized text, candidate, kit and asset crop each block decisions", async () => {
  for (const change of ["head", "text", "candidate", "kit", "asset"] as const) {
    const f = await seedEngineeringFixture(), a = await f.addActor(`Sample stale ${change}`);
    if (change === "head") await database().query("UPDATE wk_source_heads SET version=version+1 WHERE tenant_id=$1", [f.session.id]);
    if (change === "text") await database().query("UPDATE wk_source_documents SET payload=jsonb_set(payload,'{pages,0,text}',to_jsonb('Changed fictional text'::text)) WHERE id=$1", [f.documentId]);
    if (change === "candidate") await database().query("UPDATE wk_source_profile_versions SET payload=jsonb_set(payload,'{variant}',to_jsonb('Different variant'::text)) WHERE id=$1", [f.candidateId]);
    if (change === "kit") await database().query("UPDATE wk_kits SET current_revision_id=$2 WHERE id=$1", [f.kit.kitId, f.kit.parentRevisionId]);
    if (change === "asset") {
      const newId = randomUUID(), changed = { ...f.asset, id: newId, crop: { x: 0, y: 0, width: .9, height: 1 }, cropHash: hash("sample changed crop") };
      await database().query("INSERT INTO wk_review_assets(id,tenant_id,profile_id,image_hash,crop_hash,payload,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [newId, f.session.id, f.profileId, changed.imageHash, changed.cropHash, changed, f.owner.actorId]);
      await database().query("UPDATE wk_review_asset_heads SET asset_id=$2,version=version+1 WHERE tenant_id=$1", [f.session.id, newId]);
    }
    await denied(f.command(a.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "Any changed authority binding must stop this sample decision." }), "stale_revision");
    assert.equal((await engineeringDetail(f.owner, f.proposalId)).assessment.state, "stale");
  }
});

test("critical requirements, exact model and exact source anchors cannot be removed or weakened", async () => {
  const f = await seedEngineeringFixture();
  for (const mutate of [
    (content: typeof f.content) => { content.claims = content.claims.filter(claim => claim.id !== "claim-2"); },
    (content: typeof f.content) => { content.claims.find(claim => claim.id === "claim-2")!.critical = false; },
    (content: typeof f.content) => { content.scope.variant = "Related model manual"; },
    (content: typeof f.content) => { content.claims[0]!.evidence[0]!.excerptHash = "0".repeat(64); },
    (content: typeof f.content) => { content.ports[0]!.fields.connector = "claim-1"; },
  ]) {
    const content = structuredClone(f.content); mutate(content);
    await denied(f.command(f.owner, { kind: "revise", ...expected(f), content, reason: "This invalid sample edit must preserve the previous edition.", rebase: false }), "needs_evidence");
  }
  assert.equal((await engineeringDetail(f.owner, f.proposalId)).edition.version, 2);
});

test("duplicate and racing decisions and revisions serialize without overwriting history", async () => {
  const f = await seedEngineeringFixture(), actor = await f.addActor("Sample racing reviewer");
  const input = { kind: "decide", requestId: randomUUID(), ...expected(f), targetId: "claim-2", outcome: "accept", reason: "One immutable sample decision even when the request races." };
  const same = await Promise.all([engineeringCommand(actor.access, input), engineeringCommand(actor.access, input)]);
  assert.equal(same[0].decisionId, same[1].decisionId);
  await denied(engineeringCommand(actor.access, { ...input, outcome: "reject" }), "stale_revision");
  const races = await Promise.allSettled([f.command(f.owner, { kind: "revise", ...expected(f), content: f.content, reason: "First parallel immutable proposal correction.", rebase: false }), f.command(f.owner, { kind: "revise", ...expected(f), content: f.content, reason: "Second parallel immutable proposal correction.", rebase: false })]);
  assert.equal(races.filter(result => result.status === "fulfilled").length, 1);
  const detail = await engineeringDetail(f.owner, f.proposalId);
  assert.equal(detail.history.length, 3);
  assert.equal(detail.decisions.length, 0);
  const historical = await engineeringDetail(f.owner, f.proposalId, f.detail.edition.id);
  assert.equal(historical.decisions.length, 1);
});

test("promotion retains original extractions and certificates, exposes impacts and keeps Sample coverage zero", async () => {
  const f = await seedEngineeringFixture(), a = await f.addActor("Sample promotion A"), b = await f.addActor("Sample promotion B"), before = await sourceSnapshot(f.session.id);
  await acceptTargets(a.access, f.detail);
  await f.command(b.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "Independent Sample software principal; no actual human review." });
  const input = { kind: "promote", requestId: randomUUID(), ...expected(f), acknowledgeScope: true };
  const promoted = await Promise.all([engineeringCommand(f.owner, input), engineeringCommand(f.owner, input)]);
  assert.equal(promoted[0].promotionId, promoted[1].promotionId);
  assert.equal(await sourceSnapshot(f.session.id), before);
  const detail = await engineeringDetail(f.owner, f.proposalId);
  assert.equal(detail.assessment.actualReviewed, 0);
  assert.equal(detail.promotions.length, 1);
  assert.equal(detail.promotions[0]!.profile.reviewState, "review_pending");
  assert.ok(Object.values(detail.promotions[0]!.profile.facts).every(fact => fact.review.status === "pending"));
  assert.ok(detail.affected.some(impact => impact.revisionId === f.kit.id));
  assert.equal((await reviewedProfileLibrary(f.session.id)).profiles.length, 1);
  await f.command(f.owner, { kind: "withdraw", promotionId: promoted[0].promotionId, expectedHeadId: promoted[0].promotionId, reason: "Withdraw the sample profile without altering any historical proof." });
  assert.equal((await reviewedProfileLibrary(f.session.id)).profiles.length, 0);
  assert.equal((await engineeringDetail(f.owner, f.proposalId)).promotions[0]!.withdrawn, true);
  assert.equal(await sourceSnapshot(f.session.id), before);
});

test("database rejects evidence edits and deletes; authority expiry and revocation prevent promotion", async () => {
  const f = await seedEngineeringFixture(), a = await f.addActor("Sample expiry A"), b = await f.addActor("Sample expiry B");
  await acceptTargets(a.access, f.detail);
  await f.command(b.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "Sample second principal before an authority withdrawal." });
  for (const sql of ["UPDATE wk_review_editions SET content_hash='changed' WHERE tenant_id=$1", "DELETE FROM wk_review_decisions WHERE tenant_id=$1", "DELETE FROM wk_review_qualifications WHERE tenant_id=$1", "DELETE FROM wk_review_events WHERE tenant_id=$1"]) await assert.rejects(database().query(sql, [f.session.id]));
  const actor = (await engineeringHome(f.owner)).actors.find(actor => actor.id === b.actorId)!;
  await f.command(f.owner, { kind: "revoke_actor", actorId: actor.id, expectedVersion: actor.version, reason: "The Sample review principal has been revoked before promotion." });
  await denied(f.command(f.owner, { kind: "promote", ...expected(f), acknowledgeScope: true }), "needs_evidence");
  await database().query("UPDATE wk_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [f.session.id]);
  await denied(engineeringHome(f.owner), "forbidden");
  assert.equal(await authenticateReviewer(a.credential), null);
});

test("invited and redeemed capabilities expire without extending the workspace or reviving retries", async () => {
  const f = await seedEngineeringFixture(), actor = await f.addActor("Sample short-lived authority");
  const invite = () => f.command(f.owner, { kind: "invite", actorId: actor.actorId, role: "reviewer", kitId: f.kit.kitId, profileId: f.profileId, documentId: f.documentId, expiresAt: new Date(Date.now() + 1000).toISOString() });
  const pending = await invite(), active = await invite(), redeemed = await redeemInvitation(active.token);
  const input = { kind: "decide", requestId: randomUUID(), ...expected(f), targetId: "claim-2", outcome: "accept", reason: "Sample decision retained only while this short-lived authority is valid." };
  await engineeringCommand(redeemed.access, input);
  await delay(1100);
  await denied(inspectInvitation(pending.token), "not_found");
  await denied(redeemInvitation(pending.token), "not_found");
  assert.equal(await authenticateReviewer(redeemed.credential), null);
  await denied(engineeringCommand(redeemed.access, input), "forbidden");
  const detail = await engineeringDetail(f.owner, f.proposalId);
  assert.equal(detail.decisions[0]!.active, false);
  assert.equal(detail.assessment.targets.find(target => target.id === "claim-2")!.accepted, 0);
  await denied(f.command(f.owner, { kind: "invite", actorId: actor.actorId, role: "reviewer", kitId: f.kit.kitId, profileId: f.profileId, documentId: f.documentId, expiresAt: new Date(Date.now() + 8 * 86400000).toISOString() }), "invalid_request");
});

test("qualification expiry removes current acceptance without erasing its exact historical decision", async () => {
  const f = await seedEngineeringFixture(), a = await f.addActor("Sample durable qualifier"), b = await f.addActor("Sample expiring qualifier");
  await acceptTargets(a.access, f.detail);
  await sampleQualification(f, b.actorId, new Date(Date.now() + 1000).toISOString(), ["engineering", "simultaneous", "geometry"]);
  await f.command(b.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "A fictional qualification that expires during this software check." });
  assert.equal((await engineeringDetail(f.owner, f.proposalId)).assessment.eligible, true);
  await delay(1100);
  const detail = await engineeringDetail(f.owner, f.proposalId);
  assert.equal(detail.assessment.eligible, false);
  assert.equal(detail.decisions.find(value => value.actorId === b.actorId)!.active, false);
  await denied(f.command(b.access, { kind: "decide", ...expected(f), targetId: "claim-1", outcome: "accept", reason: "An expired qualification must not accept another assertion." }), "forbidden");
  await denied(f.command(f.owner, { kind: "promote", ...expected(f), acknowledgeScope: true }), "needs_evidence");
});

test("role and qualification domains are exact; unknown port fields cannot be declared reviewed", async () => {
  const f = await seedEngineeringFixture(), reader = await f.addActor("Sample reader", "reader"), editor = await f.addActor("Sample editor", "editor"), reviewer = await f.addActor("Sample limited reviewer", "reviewer");
  await denied(f.command(reader.access, { kind: "revise", ...expected(f), content: f.content, reason: "A reader cannot become an editor by posting a command." }), "forbidden");
  await denied(f.command(editor.access, { kind: "decide", ...expected(f), targetId: "claim-1", outcome: "accept", reason: "An editor cannot become a reviewer by posting a command." }), "forbidden");
  await sampleQualification(f, reviewer.actorId, new Date(Date.now() + 60000).toISOString(), ["engineering"]);
  await f.command(reviewer.access, { kind: "decide", ...expected(f), targetId: "claim-1", outcome: "accept", reason: "A fictional general engineering decision within the limited qualification." });
  for (const targetId of ["claim-2", "$port-map"]) await denied(f.command(reviewer.access, { kind: "decide", ...expected(f), targetId, outcome: "accept", reason: "A general qualification cannot supply simultaneous or geometry expertise." }), "forbidden");
  const content = structuredClone(f.content); content.ports[0]!.fields.connector = null;
  await f.command(f.owner, { kind: "revise", ...expected(f), content, reason: "Keep a missing connector field explicit in a corrected Sample map." });
  const detail = await engineeringDetail(f.owner, f.proposalId), full = await f.addActor("Sample full map reviewer");
  await denied(f.command(full.access, { kind: "decide", proposalId: f.proposalId, expectedVersion: detail.edition.version, expectedHash: detail.edition.hash, targetId: "$port-map", outcome: "accept", reason: "Missing connector evidence must remain unknown despite an attractive illustration." }), "needs_evidence");
});

test("revocation races serialize with decisions, preserve receipts and leave no active authority", async () => {
  const f = await seedEngineeringFixture(), actor = await f.addActor("Sample concurrent revocation");
  const cap = (await engineeringHome(f.owner)).capabilities.find(value => value.id === actor.access.capabilityId)!;
  const results = await Promise.allSettled([
    f.command(f.owner, { kind: "revoke", capabilityId: cap.id, expectedVersion: cap.version, reason: "Revoke this Sample capability while a competing decision is in flight." }),
    f.command(actor.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "The database lock determines whether this preceded revocation." }),
  ]);
  assert.equal(results[0]!.status, "fulfilled");
  assert.equal(await authenticateReviewer(actor.credential), null);
  const detail = await engineeringDetail(f.owner, f.proposalId);
  assert.ok(detail.decisions.every(value => !value.active));
  assert.equal(detail.assessment.eligible, false);
  await denied(f.command(actor.access, { kind: "decide", ...expected(f), targetId: "claim-1", outcome: "accept", reason: "No command may begin with authority after the revocation completed." }), "forbidden");
  for (const sql of ["UPDATE wk_review_capabilities SET expires_at=expires_at+interval '1 day',version=version+1 WHERE tenant_id=$1", "UPDATE wk_review_actors SET provenance='human',version=version+1 WHERE tenant_id=$1 AND kind='specialist'", "UPDATE wk_review_proposals SET current_edition_id=NULL,version=version+1 WHERE tenant_id=$1", "DELETE FROM wk_review_asset_heads WHERE tenant_id=$1"]) await assert.rejects(database().query(sql, [f.session.id]));
});

test("profile withdrawal makes a later bound edition stale and historical promotions remain immutable", async () => {
  const f = await seedEngineeringFixture(), a = await f.addActor("Sample profile A"), b = await f.addActor("Sample profile B");
  await acceptTargets(a.access, f.detail);
  await f.command(b.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "Second fictional principal for the initial exact profile." });
  const original = await sourceSnapshot(f.session.id), first = await f.command(f.owner, { kind: "promote", ...expected(f), acknowledgeScope: true });
  await f.command(f.owner, { kind: "revise", ...expected(f), content: f.content, reason: "Start a new immutable edition bound to the current promoted profile." });
  const next = await engineeringDetail(f.owner, f.proposalId);
  assert.equal(next.edition.binding.profileHeadId, first.promotionId);
  await f.command(f.owner, { kind: "withdraw", promotionId: first.promotionId, expectedHeadId: first.promotionId, reason: "Withdrawing the current head must invalidate this later edition binding." });
  await denied(f.command(a.access, { kind: "decide", proposalId: f.proposalId, expectedVersion: next.edition.version, expectedHash: next.edition.hash, targetId: "claim-2", outcome: "accept", reason: "A changed profile head cannot inherit the earlier review binding." }), "stale_revision");
  assert.equal((await engineeringDetail(f.owner, f.proposalId)).assessment.state, "stale");
  await assert.rejects(database().query("UPDATE wk_review_profiles SET payload='{}' WHERE tenant_id=$1", [f.session.id]));
  assert.equal(await sourceSnapshot(f.session.id), original);
});

test("a corrected rejection needs two adjudicators and a new proposal cannot bypass the retained chain", async () => {
  const f = await seedEngineeringFixture(), a = await f.addActor("Sample correction A"), b = await f.addActor("Sample correction B"), ordinary = await f.addActor("Sample ordinary reviewer", "reviewer");
  await f.command(a.access, { kind: "decide", ...expected(f), targetId: "claim-1", outcome: "reject", reason: "A Sample rejection requires a properly reviewed correction of this predicate." });
  await f.command(f.owner, { kind: "revise", ...expected(f), content: f.content, reason: "Retain the predicate and clarify the exact fictional operating condition." });
  const next = await engineeringDetail(f.owner, f.proposalId), exact = { proposalId: f.proposalId, expectedVersion: next.edition.version, expectedHash: next.edition.hash };
  assert.equal(next.assessment.targets.find(value => value.id === "claim-1")!.required, 2);
  await denied(f.command(ordinary.access, { kind: "decide", ...exact, targetId: "claim-1", outcome: "accept", reason: "The corrected conflict requires adjudicator authority." }), "forbidden");
  await acceptTargets(a.access, next);
  assert.equal((await engineeringDetail(f.owner, f.proposalId)).assessment.eligible, false);
  for (const targetId of ["claim-1", "claim-2"]) await f.command(b.access, { kind: "decide", ...exact, targetId, outcome: "accept", reason: "Second distinct Sample adjudicator confirms the corrected exact assertion." });
  assert.equal((await engineeringDetail(f.owner, f.proposalId)).assessment.eligible, true);
  const duplicate = await f.command(f.owner, { kind: "create", candidateId: f.candidateId, kitId: f.kit.kitId, expectedRevisionId: f.kit.id, expectedGraphHash: f.certificate.graphHash, provenance: "sample" });
  assert.equal(duplicate.proposalId, f.proposalId); assert.equal(duplicate.existing, true);
  assert.equal((await engineeringDetail(f.owner, f.proposalId, f.detail.edition.id)).decisions[0]!.outcome, "reject");
});

test("even optional disputed predicates remain blocking and cannot be omitted, renamed or relabelled", async () => {
  const f = await seedEngineeringFixture(), a = await f.addActor("Sample optional dissent"), b = await f.addActor("Sample optional acceptance");
  const content = structuredClone(f.content);
  content.claims.push({ ...content.claims[0]!, id: "context", predicate: "sampleContext", target: "device", category: "fact", value: "Fictional context", critical: false, originalAssertionId: null });
  await f.command(f.owner, { kind: "revise", ...expected(f), content, reason: "Introduce a noncritical context claim that still needs honest conflict handling." });
  const next = await engineeringDetail(f.owner, f.proposalId), exact = { proposalId: f.proposalId, expectedVersion: next.edition.version, expectedHash: next.edition.hash };
  await f.command(a.access, { kind: "decide", ...exact, targetId: "context", outcome: "reject", reason: "Fictional context disputed; a noncritical label cannot hide the disagreement." });
  await acceptTargets(b.access, next);
  const disputed = await engineeringDetail(f.owner, f.proposalId);
  assert.equal(disputed.assessment.targets.find(value => value.id === "context")!.blocking, true);
  for (const rename of [false, true]) {
    const changed = structuredClone(content);
    if (rename) changed.claims.find(value => value.id === "context")!.predicate = "differentName";
    else changed.claims = changed.claims.filter(value => value.id !== "context");
    await denied(f.command(f.owner, { kind: "revise", ...exact, content: changed, reason: "An unresolved predicate must not disappear behind a renamed correction." }), "needs_evidence");
  }
  await f.command(f.owner, { kind: "revise", ...exact, content, reason: "Retain the disputed optional predicate explicitly in its correction chain." });
  const corrected = await engineeringDetail(f.owner, f.proposalId);
  const target = corrected.assessment.targets.find(value => value.id === "context")!;
  assert.equal(target.required, 2); assert.equal(target.blocking, true);
});

test("candidate source provenance and current document identity participate in the immutable binding", async () => {
  for (const field of ["publisher", "url", "kind"] as const) {
    const f = await seedEngineeringFixture(), actor = await f.addActor(`Sample source identity ${field}`);
    const value = field === "kind" ? "catalog" : field === "url" ? "https://example.invalid/related-model" : "Changed source publisher";
    await database().query("UPDATE wk_source_profile_versions SET source=jsonb_set(source,$2::text[],to_jsonb($3::text)) WHERE id=$1", [f.candidateId, [field], value]);
    await denied(f.command(actor.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "An altered source identity cannot borrow the exact prior review fingerprint." }), "stale_revision");
  }
});

test("a cached equipment preview cannot adopt a profile after its engineering authority is revoked", async () => {
  const f = await seedEngineeringFixture(), a = await f.addActor("Sample cached adoption A"), b = await f.addActor("Sample cached adoption B");
  await acceptTargets(a.access, f.detail);
  await f.command(b.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "Second Sample principal before the equipment adoption preview." });
  const promoted = await f.command(f.owner, { kind: "promote", ...expected(f), acknowledgeScope: true });
  const input = ConfirmationSchema.parse({ requestId: randomUUID(), identity: { libraryProfileId: promoted.promotionId, manufacturer: f.profile.manufacturer, model: f.profile.model, variant: f.profile.variant, deviceKind: "recorder", ownership: "planned", quantity: 1, condition: "unknown", accessories: [], notes: "Sample software fixture; no ownership asserted.", confirmedExactIdentity: true, confirmedOwnership: false }, snapshotId: null, selectedOptions: [], photoId: null, regionId: null, targetComponentId: null, expectedRevisionId: f.kit.id, expectedGraphHash: f.certificate.graphHash });
  const preview = await previewInventory(f.session, input), before = await sourceSnapshot(f.session.id);
  const cap = (await engineeringHome(f.owner)).capabilities.find(value => value.id === b.access.capabilityId)!;
  await f.command(f.owner, { kind: "revoke", capabilityId: cap.id, expectedVersion: cap.version, reason: "Revoked after the cached preview but before equipment confirmation." });
  await denied(confirmInventory(f.session, input, preview.previewHash), "stale_revision");
  assert.equal((await database().query("SELECT count(*)::int n FROM wk_inventory_items WHERE tenant_id=$1", [f.session.id])).rows[0].n, 0);
  assert.equal(await sourceSnapshot(f.session.id), before);
});

test("new graph use rechecks the immutable profile while valid adoption keeps the scoped facts available", async () => {
  const f = await seedEngineeringFixture(), a = await f.addActor("Sample graph adoption A"), b = await f.addActor("Sample graph adoption B");
  await acceptTargets(a.access, f.detail);
  await f.command(b.access, { kind: "decide", ...expected(f), targetId: "claim-2", outcome: "accept", reason: "Second distinct Sample principal before new graph use." });
  const promoted = await f.command(f.owner, { kind: "promote", ...expected(f), acknowledgeScope: true });
  const old = await getRevision(f.session.id), profile = (await reviewedProfileLibrary(f.session.id)).profiles.find(value => value.id === promoted.promotionId)!;
  const kit = { ...old.kit, id: randomUUID(), parentRevisionId: old.kit.id, revision: old.kit.revision + 1, components: old.kit.components.map(value => value.role === "audio" ? { ...value, profileId: profile.id } : value) };
  const profiles = [...old.profiles, profile], certificate = verifyKit(kit, profiles, old.sources, architectures), bundle = { kit, profiles, sources: old.sources, certificate };
  await transaction(async db => { await saveRevision(db, f.session.id, bundle); await db.query("UPDATE wk_kits SET current_revision_id=$2 WHERE id=$1", [kit.kitId, kit.id]); });
  assert.equal((await reviewedProfileLibrary(f.session.id)).profiles.length, 1);
  assert.equal(hash(await getRevision(f.session.id, old.kit.id)), hash(old));
  assert.ok(Object.values(profile.facts).every(value => value.review.status === "pending"));
  await f.command(f.owner, { kind: "withdraw", promotionId: promoted.promotionId, expectedHeadId: promoted.promotionId, reason: "Withdraw a profile already used in an immutable historical graph." });
  const before = await sourceSnapshot(f.session.id), nextKit = { ...kit, id: randomUUID(), revision: kit.revision + 1, parentRevisionId: kit.id };
  await denied(transaction(db => saveRevision(db, f.session.id, { ...bundle, kit: nextKit, certificate: verifyKit(nextKit, profiles, old.sources, architectures) })), "stale_revision");
  assert.equal(await sourceSnapshot(f.session.id), before);
  assert.equal(hash(await getRevision(f.session.id, old.kit.id)), hash(old));
});
