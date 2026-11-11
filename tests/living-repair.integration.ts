import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createSession, getRevision } from "../src/server/repository";
import { closeDatabase, database } from "../src/server/db";
import { acceptKitAmendment, createKitRepairPolicy, getRepairEngine, refreshKitAmendment, resumeKitAmendment, revokeKitRepairPolicy } from "../src/server/living-repair-payments";
import { acceptKitCompensation, prepareKitCompensation, refreshKitCompensation, resumeKitCompensation, saveRepairSupportRequest, simulateKitShipment } from "../src/server/living-repair-compensation";
import { cancelRepairRun, claimRepair, enqueueIncidentRepair, executeRepairLease, processRepairQueue, proposeKitAmendment, startNextSampleRepair, startSampleRepair, type RepairCatalogRuntime } from "../src/server/living-repair";
import { drainRepairNotices, loadAmendment, loadCommitment, loadRepair } from "../src/server/living-repair-store";
import { livingRepairView } from "../src/server/living-repair-view";
import { sampleCatalog } from "../packages/living-repair/sample";
import type { SampleScenario } from "../packages/living-repair/contracts";
import { processAutomaticKitRepairs } from "../src/server/living-repair-automatic";
import { authorityByOperation, commerceView, createCommerceEngine, loadOrder, saveOrder } from "../src/server/commerce";
import { hash, verifyKit } from "../packages/compatibility";
import { ProviderError, type ProviderAdapter, type ProviderReceipt } from "@fracture/paypal-core";
import { repairTransaction } from "../src/server/living-repair-db";
import { saveRevision } from "../src/server/repository";
import { architectures } from "../packages/device-library";
import type { LivingIncident } from "../packages/living-kit/contracts";

after(closeDatabase);
const origin = "http://127.0.0.1:4506";
async function fixture(scenario: SampleScenario = "available-alternative") {
  const { session } = await createSession(); const original = await getRevision(session.id); const requestId = randomUUID();
  const run = await startSampleRepair(session, scenario, requestId);
  for (let index = 0; index < 4; index++) await processRepairQueue(session.id, run.id);
  const view = await livingRepairView(session, run.id); const candidate = view.candidates.find(candidate => candidate.technicalState === "satisfied") ?? view.candidates[0]!;
  const amendment = candidate ? await proposeKitAmendment(session, run.id, candidate.id, candidate.digest) : null;
  return { session, original, run, candidate, amendment: amendment!, view, requestId };
}
const accept = (f: Awaited<ReturnType<typeof fixture>>, authority: "buyer" | "policy" = "buyer", policyId?: string) => acceptKitAmendment(f.session, { amendmentId: f.amendment.proposal.id, proposalDigest: f.amendment.proposal.digest, paymentMode: "sample", authority, policyId, origin });
test("Sample discovery is persisted, idempotent and isolated from the live catalog and workbench", async () => {
  const f = await fixture(); assert.equal((await loadRepair(f.session.id, f.run.id)).phase, "ready");
  const duplicate = await startSampleRepair(f.session, "available-alternative", f.requestId); assert.equal(duplicate.id, f.run.id);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_catalog WHERE tenant_id=$1", [f.session.id])).rows[0].n, 0);
  assert.deepEqual(await getRevision(f.session.id), f.original);
  assert.equal(f.amendment.proposal.quote.deltaMinor, 800); assert.equal(f.amendment.proposal.quote.policyVersion, "controlled-kit-sandbox.v1");
});
test("duplicate acceptance produces one gross claim, one create, one capture and one commitment version", async () => {
  const f = await fixture(); await Promise.all([accept(f), accept(f)]);
  const amendment = await loadAmendment(f.session.id, f.amendment.proposal.id); assert.equal(amendment.status, "committed");
  const claims = await database().query("SELECT payload FROM wk_kit_repair_claims WHERE amendment_id=$1", [amendment.proposal.id]); assert.equal(claims.rowCount, 1);
  const payments = await database().query("SELECT operation_id FROM wk_kit_sample_payments WHERE tenant_id=$1", [f.session.id]); assert.equal(payments.rowCount, 2);
  const commitment = await loadCommitment(f.session.id, f.run.commitmentId!); assert.equal(commitment.version, 2);
  assert.deepEqual(await getRevision(f.session.id), f.original);
});
test("unknown critical evidence prevents payment and keeps the immutable proposal reviewable", async () => {
  const f = await fixture("unknown-evidence"); assert.equal((await loadRepair(f.session.id, f.run.id)).phase, "needs_evidence");
  assert.equal(f.amendment.proposal.technicalState, "unknown"); await assert.rejects(accept(f), /Critical technical evidence/);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_kit_repair_claims WHERE tenant_id=$1", [f.session.id])).rows[0].n, 0);
});
test("a fresh $25 kit allowance authorizes the $8 change without borrowing the legacy service policy", async () => {
  const f = await fixture(); const policy = await createKitRepairPolicy(f.session, { commitmentId: f.run.commitmentId!, expectedVersion: 1, capMinor: 2500, paymentMode: "sample" });
  const amendment = await accept(f, "policy", policy.id); assert.equal(amendment.status, "committed");
  const view = await livingRepairView(f.session, f.run.id); assert.equal(view.policies[0]!.consumedMinor, 800); assert.equal(view.policies[0]!.remainingMinor, 1700);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_repair_policies WHERE tenant_id=$1", [f.session.id])).rows[0].n, 0);
});
test("above-cap proposals await fresh consent without reserving money", async () => {
  const f = await fixture("above-cap"); const policy = await createKitRepairPolicy(f.session, { commitmentId: f.run.commitmentId!, expectedVersion: 1, capMinor: 2500, paymentMode: "sample" });
  const amendment = await accept(f, "policy", policy.id); assert.equal(amendment.status, "awaiting_consent"); assert.equal(amendment.acceptedAt, null);
  assert.equal((await livingRepairView(f.session)).claims.length, 0);
});
test("revoked authority blocks before dispatch and cannot be replaced by a wallet identifier", async () => {
  const f = await fixture(); const policy = await createKitRepairPolicy(f.session, { commitmentId: f.run.commitmentId!, expectedVersion: 1, capMinor: 2500, paymentMode: "sample" });
  await revokeKitRepairPolicy(f.session, policy.id); const amendment = await accept(f, "policy", policy.id);
  assert.equal(amendment.status, "awaiting_consent"); assert.equal((await livingRepairView(f.session)).orders.length, 0);
});
test("a lost capture response retains the same operation and is recovered without a second financial write", async () => {
  const f = await fixture("lost-payment-response"); const pending = await accept(f); assert.equal(pending.status, "payment_pending");
  const before = (await database().query("SELECT operation_id FROM wk_kit_sample_payments WHERE tenant_id=$1 ORDER BY operation_id", [f.session.id])).rows;
  const recovered = await refreshKitAmendment(f.session, pending.proposal.id); assert.equal(recovered.status, "committed");
  const after = (await database().query("SELECT operation_id FROM wk_kit_sample_payments WHERE tenant_id=$1 ORDER BY operation_id", [f.session.id])).rows; assert.deepEqual(after, before); assert.equal(after.length, 2);
});
test("paid-but-uncommittable changes require distinct compensation consent", async () => {
  const f = await fixture("commit-failure"); const failed = await accept(f); assert.equal(failed.status, "compensation_required");
  assert.equal((await loadCommitment(f.session.id, f.run.commitmentId!)).version, 1);
  const request = await prepareKitCompensation(f.session, failed.proposal.id, "failed_commit"); assert.equal(request.refundMinor, 800); assert.equal(request.consentedAt, null);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_kit_sample_payments WHERE tenant_id=$1", [f.session.id])).rows[0].n, 2);
  const finished = await acceptKitCompensation(f.session, request.id, request.digest, origin); assert.equal(finished.state, "completed");
  assert.equal((await loadAmendment(f.session.id, failed.proposal.id)).status, "compensated");
});
test("undo refunds the eligible capture and restores a new version without replenishing gross allowance", async () => {
  const f = await fixture(); const policy = await createKitRepairPolicy(f.session, { commitmentId: f.run.commitmentId!, expectedVersion: 1, capMinor: 2500, paymentMode: "sample" }); await accept(f, "policy", policy.id);
  const request = await prepareKitCompensation(f.session, f.amendment.proposal.id, "undo"); const finished = await acceptKitCompensation(f.session, request.id, request.digest, origin);
  assert.equal(finished.state, "completed"); assert.equal(finished.refundedMinor, 800);
  const commitment = await loadCommitment(f.session.id, f.run.commitmentId!); assert.equal(commitment.version, 3); assert.equal(commitment.current.certificate.graphHash, commitment.original.certificate.graphHash);
  const view = await livingRepairView(f.session); assert.equal(view.policies[0]!.consumedMinor, 800); assert.equal(view.policies[0]!.remainingMinor, 1700);
  const duplicate = await acceptKitCompensation(f.session, request.id, request.digest, origin); assert.equal(duplicate.state, "completed");
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_kit_sample_payments WHERE tenant_id=$1", [f.session.id])).rows[0].n, 3);
});
test("unavailable original equipment and simulated shipment prevent undo before any refund", async () => {
  const unavailable = await fixture("original-unavailable"); await accept(unavailable);
  await assert.rejects(prepareKitCompensation(unavailable.session, unavailable.amendment.proposal.id, "undo"), /not currently available/);
  const shipped = await fixture("shipment"); await accept(shipped); await simulateKitShipment(shipped.session, shipped.run.commitmentId!, 2);
  await assert.rejects(prepareKitCompensation(shipped.session, shipped.amendment.proposal.id, "undo"), /latest successfully committed/);
  for (const f of [unavailable, shipped]) assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_kit_sample_payments WHERE tenant_id=$1", [f.session.id])).rows[0].n, 2);
});
test("a refund followed by failed restoration remains partial support, never a fictitious rollback", async () => {
  const f = await fixture(); await accept(f); let reads = 0;
  const runtime: RepairCatalogRuntime = { mode: "sample", refresh: async productId => { reads++; return sampleCatalog(productId, reads > 2 ? "original-unavailable" : "available-alternative", "restore"); }, similar: async () => { throw new Error("not used"); }, search: async () => { throw new Error("not used"); } };
  const request = await prepareKitCompensation(f.session, f.amendment.proposal.id, "undo", { catalog: runtime });
  const finished = await acceptKitCompensation(f.session, request.id, request.digest, origin, { catalog: runtime });
  assert.equal(finished.refundedMinor, 800); assert.equal(finished.state, "partial_support_needed");
  assert.equal((await loadCommitment(f.session.id, f.run.commitmentId!)).version, 2);
  assert.equal((await refreshKitCompensation(f.session, request.id)).state, "partial_support_needed");
});
test("lost worker leases cannot publish discovery or mutate a cancelled run", async () => {
  const { session } = await createSession(); const run = await startSampleRepair(session, "available-alternative", randomUUID()); const lease = await claimRepair(session.id, run.id); assert.ok(lease);
  await database().query("UPDATE wk_living_repairs SET lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1", [run.id, randomUUID()]);
  await executeRepairLease(lease); assert.equal((await loadRepair(session.id, run.id)).phase, "queued");
  assert.equal((await livingRepairView(session)).candidates.length, 0);
});
test("tenant boundaries protect candidates, commitments, proposals and compensation", async () => {
  const f = await fixture(); const other = (await createSession()).session;
  await assert.rejects(loadRepair(other.id, f.run.id), /does not belong/);
  await assert.rejects(proposeKitAmendment(other, f.run.id, f.candidate.id, f.candidate.digest), /does not belong/);
  await assert.rejects(acceptKitAmendment(other, { amendmentId: f.amendment.proposal.id, proposalDigest: f.amendment.proposal.digest, paymentMode: "sample", authority: "buyer", origin }), /does not belong/);
  await assert.rejects(loadCommitment(other.id, f.run.commitmentId!), /does not belong/);
});
test("the durable notice outbox is idempotent and never dispatches money", async () => {
  const f = await fixture(); await drainRepairNotices(f.session.id); const count = (await database().query("SELECT count(*)::int AS n FROM wk_notifications WHERE tenant_id=$1", [f.session.id])).rows[0].n;
  assert.ok(count > 0); assert.equal(await drainRepairNotices(f.session.id), 0);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_notifications WHERE tenant_id=$1", [f.session.id])).rows[0].n, count);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_kit_sample_payments WHERE tenant_id=$1", [f.session.id])).rows[0].n, 0);
});
test("automatic authority applies $8 once, then a $20 follow-up on the same kit exceeds the retained $25 gross cap", async () => {
  const f = await fixture(); const policy = await createKitRepairPolicy(f.session, { commitmentId: f.run.commitmentId!, expectedVersion: 1, capMinor: 2500, paymentMode: "sample", amendmentId: f.amendment.proposal.id, proposalDigest: f.amendment.proposal.digest, requestId: randomUUID(), origin });
  assert.equal(await processAutomaticKitRepairs(f.session.id), 1); assert.equal(await processAutomaticKitRepairs(f.session.id), 0);
  assert.equal((await loadAmendment(f.session.id, f.amendment.proposal.id)).status, "committed");
  const requestId = randomUUID(); const next = await startNextSampleRepair(f.session, f.run.commitmentId!, 2, requestId);
  for (let i = 0; i < 4; i++) await processRepairQueue(f.session.id, next.id);
  assert.equal((await loadRepair(f.session.id, next.id)).phase, "ready");
  assert.equal(await processAutomaticKitRepairs(f.session.id), 1);
  const pendingRun = await loadRepair(f.session.id, next.id); const pending = await loadAmendment(f.session.id, pendingRun.amendmentId!);
  assert.equal(pending.proposal.quote.deltaMinor, 2000); assert.equal(pending.status, "awaiting_consent"); assert.equal(pending.acceptedAt, null);
  const view = await livingRepairView(f.session, next.id); assert.equal(view.claims.length, 1); assert.equal(view.policies.find(p => p.id === policy.id)!.remainingMinor, 1700);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_kit_sample_payments WHERE tenant_id=$1", [f.session.id])).rows[0].n, 2);
  assert.equal((await startNextSampleRepair(f.session, f.run.commitmentId!, 2, requestId)).id, next.id);
});
test("a future allowance can bind the current committed proposal without charging that change twice", async () => {
  const f = await fixture(); await accept(f); const requestId = randomUUID();
  const input = { commitmentId: f.run.commitmentId!, expectedVersion: 2, capMinor: 2500, paymentMode: "sample" as const, amendmentId: f.amendment.proposal.id, proposalDigest: f.amendment.proposal.digest, requestId, origin };
  const policy = await createKitRepairPolicy(f.session, input); const repeat = await createKitRepairPolicy(f.session, input); assert.equal(policy.id, repeat.id);
  assert.equal(await processAutomaticKitRepairs(f.session.id), 0); assert.equal((await livingRepairView(f.session)).claims.length, 1);
});
test("a saved amendment authority survives a stop before the payment core claim and resumes its original command once", async () => {
  const f = await fixture(); const engine = await getRepairEngine(f.session.id, "sample");
  const interrupted = { ...engine, core: Object.assign(Object.create(engine.core), { execute: async () => { throw new Error("Stopped before core claim"); } }) };
  await assert.rejects(acceptKitAmendment(f.session, { amendmentId: f.amendment.proposal.id, proposalDigest: f.amendment.proposal.digest, paymentMode: "sample", authority: "buyer", origin }, interrupted), /Stopped before core claim/);
  const pending = await loadAmendment(f.session.id, f.amendment.proposal.id); const authority = await authorityByOperation(f.session.id, `purchase:${pending.orderId}`); assert.ok(authority);
  assert.equal((await livingRepairView(f.session)).claims.length, 1);
  const resumed = await resumeKitAmendment(f.session, pending.proposal.id, pending.proposal.digest); assert.equal(resumed.status, "committed");
  assert.deepEqual((await authorityByOperation(f.session.id, authority.command.operationId))!.command, authority.command);
  await resumeKitAmendment(f.session, pending.proposal.id, pending.proposal.digest);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_kit_sample_payments WHERE tenant_id=$1", [f.session.id])).rows[0].n, 2);
});
test("a separately accepted refund survives a stop before core claim and concurrent continuation never restores twice", async () => {
  const f = await fixture(); await accept(f); const request = await prepareKitCompensation(f.session, f.amendment.proposal.id, "undo");
  const engine = await getRepairEngine(f.session.id, "sample"); const interrupted = { ...engine, core: Object.assign(Object.create(engine.core), { execute: async () => { throw new Error("Stopped before refund claim"); } }) };
  await assert.rejects(acceptKitCompensation(f.session, request.id, request.digest, origin, { engine: interrupted }), /Stopped before refund claim/);
  const results = await Promise.all([resumeKitCompensation(f.session, request.id, request.digest), resumeKitCompensation(f.session, request.id, request.digest)]);
  const finished = await refreshKitCompensation(f.session, request.id); assert.equal(finished.state, "completed"); assert.ok(results.every(value => value.state !== "partial_support_needed"));
  assert.equal((await loadCommitment(f.session.id, f.run.commitmentId!)).version, 3);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_kit_sample_payments WHERE tenant_id=$1", [f.session.id])).rows[0].n, 3);
});
async function externalSampleRefund(f: Awaited<ReturnType<typeof fixture>>, minor: number, status = "COMPLETED") {
  const amendment = await loadAmendment(f.session.id, f.amendment.proposal.id); const order = await loadOrder(f.session.id, amendment.orderId!); const at = new Date().toISOString(); const operationId = `sample-external-refund:${randomUUID()}`;
  const receipt: ProviderReceipt = { id: randomUUID(), operationId, providerRequestId: randomUUID(), source: "sample", transport: "local_fixture", status: 200, observedAt: at, debugId: null, bodyHash: hash({ minor, status }), reconciled: true, resources: [{ kind: "refund", id: `sample-refund-${randomUUID()}`, status, parentId: order.captureId, money: { currency: "USD", minor }, customId: operationId, links: [], source: "sample", observedAt: at }] };
  await database().query("INSERT INTO wk_kit_sample_payments(operation_id,tenant_id,order_id,command_digest,receipt) VALUES($1,$2,$3,$4,$5)", [operationId, f.session.id, order.id, hash({ operationId }), receipt]); return receipt;
}
test("compensation reads and retains prior partial refunds, then refunds only the exact remaining balance", async () => {
  const f = await fixture("commit-failure"); await accept(f); const external = await externalSampleRefund(f, 500);
  const request = await prepareKitCompensation(f.session, f.amendment.proposal.id, "failed_commit"); assert.equal(request.refundMinor, 300); assert.equal(request.balanceProof!.remainingMinor, 300); assert.deepEqual(request.balanceProof!.refundIds, [external.resources[0]!.id]);
  assert.equal((await loadOrder(f.session.id, request.orderId!)).refundedMinor, 500);
  const finished = await acceptKitCompensation(f.session, request.id, request.digest, origin); assert.equal(finished.state, "completed"); assert.equal(finished.refundedMinor, 300);
  const view = await livingRepairView(f.session); assert.equal(view.orders[0]!.capturedMinor, 800); assert.equal(view.orders[0]!.refundedMinor, 800); assert.equal(view.claims[0]!.additionalMinor, 800);
});
test("a pending prior refund blocks a new compensation before any new write", async () => {
  const f = await fixture("commit-failure"); await accept(f); await externalSampleRefund(f, 500, "PENDING");
  await assert.rejects(prepareKitCompensation(f.session, f.amendment.proposal.id, "failed_commit"), /pending|unresolved/i);
  assert.equal((await livingRepairView(f.session)).compensations.length, 0);
});
test("a more expensive original item requires a fresh restoration supplement and preserves both payment histories", async () => {
  const f = await fixture(); await accept(f);
  const catalog: RepairCatalogRuntime = { mode: "sample", refresh: async productId => { const response = sampleCatalog(productId, "available-alternative", "restore"); response.value.snapshot.offers[0]!.price!.minor = 25800; return response; }, similar: async () => { throw new Error("not used"); }, search: async () => { throw new Error("not used"); } };
  const request = await prepareKitCompensation(f.session, f.amendment.proposal.id, "undo", { catalog }); assert.equal(request.supplementalMinor, 200); assert.equal(request.refundMinor, 0);
  assert.equal((await livingRepairView(f.session)).orders.length, 1);
  const finished = await acceptKitCompensation(f.session, request.id, request.digest, origin, { catalog }); assert.equal(finished.state, "completed");
  const orders = (await livingRepairView(f.session)).orders; assert.equal(orders.length, 2); assert.deepEqual(orders.map(order => order.capturedMinor).sort((a, b) => a - b), [200, 800]); assert.ok(orders.every(order => !order.walletConsentId));
});
test("an expired browser or revoked allowance still permits read-only reconciliation of an already sent payment", async () => {
  const f = await fixture("lost-payment-response"); const policy = await createKitRepairPolicy(f.session, { commitmentId: f.run.commitmentId!, expectedVersion: 1, capMinor: 2500, paymentMode: "sample" });
  await accept(f, "policy", policy.id); await revokeKitRepairPolicy(f.session, policy.id); await database().query("UPDATE wk_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1", [f.session.id]);
  const reconciled = await refreshKitAmendment(f.session, f.amendment.proposal.id); assert.equal(reconciled.status, "committed");
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_kit_sample_payments WHERE tenant_id=$1", [f.session.id])).rows[0].n, 2);
});
test("private support requests retain their cause once and the legacy Studio view excludes kit amendment money", async () => {
  const f = await fixture(); await accept(f); const requestId = randomUUID();
  await saveRepairSupportRequest(f.session, f.amendment.proposal.id, requestId, "Please review the current restoration conditions."); await saveRepairSupportRequest(f.session, f.amendment.proposal.id, requestId, "Please review the current restoration conditions.");
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_kit_repair_outbox WHERE tenant_id=$1 AND cause_key=$2", [f.session.id, `support:${requestId}`])).rows[0].n, 1);
  const legacy = await commerceView(f.session); assert.equal(legacy.orders.length, 0); assert.equal(legacy.operations.length, 0); assert.equal((await livingRepairView(f.session)).orders.length, 1);
});
test("two concurrent $15 claims cannot both use one $25 allowance", async () => {
  const f = await fixture();
  const catalog: RepairCatalogRuntime = { mode: "sample", refresh: async productId => { const response = sampleCatalog(productId, "available-alternative"); response.value.snapshot.offers[1]!.price!.minor = 26300; return response; }, similar: async () => ({ value: [], receipt: sampleCatalog("sample-recorder-a", "available-alternative").receipt }), search: async () => ({ value: [], receipt: sampleCatalog("sample-recorder-a", "available-alternative").receipt }) };
  const changes = [];
  for (let i = 0; i < 2; i++) {
    const run = await startNextSampleRepair(f.session, f.run.commitmentId!, 1, randomUUID());
    for (let step = 0; step < 3; step++) await processRepairQueue(f.session.id, run.id, catalog);
    const candidate = (await livingRepairView(f.session, run.id)).candidates[0]!;
    changes.push(await proposeKitAmendment(f.session, run.id, candidate.id, candidate.digest));
  }
  const policy = await createKitRepairPolicy(f.session, { commitmentId: f.run.commitmentId!, expectedVersion: 1, capMinor: 2500, paymentMode: "sample", amendmentId: changes[0]!.proposal.id, proposalDigest: changes[0]!.proposal.digest });
  const results = await Promise.allSettled(changes.map(amendment => acceptKitAmendment(f.session, { amendmentId: amendment.proposal.id, proposalDigest: amendment.proposal.digest, paymentMode: "sample", authority: "policy", policyId: policy.id, origin }, undefined, catalog)));
  assert.equal(results.filter(result => result.status === "fulfilled" && result.value.status === "committed").length, 1);
  const view = await livingRepairView(f.session); assert.equal(view.claims.length, 1); assert.equal(view.claims[0]!.additionalMinor, 1500); assert.equal(view.policies[0]!.remainingMinor, 1000);
  assert.equal((await database().query("SELECT count(*)::int AS n FROM wk_kit_sample_payments WHERE tenant_id=$1", [f.session.id])).rows[0].n, 2);
});
test("cancelling discovery fences a late catalog response and keeps the retained run resumable", async () => {
  const { session } = await createSession(); const run = await startSampleRepair(session, "available-alternative", randomUUID()); const lease = await claimRepair(session.id, run.id); assert.ok(lease);
  const cancelled = await cancelRepairRun(session, run.id); assert.equal(cancelled.phase, "cancelled");
  await executeRepairLease(lease); assert.equal((await loadRepair(session.id, run.id)).phase, "cancelled"); assert.equal((await livingRepairView(session)).candidates.length, 0);
});
test("a later incident reuses the exact workspace commitment and equivalent deliveries share one repair cause", async () => {
  // This isolated setup is explicitly synthetic. It does not turn Sample facts
  // into reviewed manufacturer evidence or write the user's hosted workbench.
  const f = await fixture(); const commitment = await loadCommitment(f.session.id, f.run.commitmentId!); const bundle = structuredClone(commitment.current); const itemId = randomUUID(); bundle.kit.components.find(component => component.id === "audio")!.inventoryItemId = itemId;
  bundle.kit.kitId = f.original.kit.kitId; bundle.kit.id = `fixture:${randomUUID()}`; bundle.kit.revision = f.original.kit.revision + 1; bundle.kit.parentRevisionId = f.original.kit.id; bundle.certificate = verifyKit(bundle.kit, bundle.profiles, bundle.sources, architectures);
  commitment.branch = "workspace"; commitment.kitId = bundle.kit.kitId; commitment.current = bundle; commitment.original = bundle;
  await repairTransaction(async db => { await saveRevision(db, f.session.id, bundle); await db.query("UPDATE wk_kits SET current_revision_id=$3 WHERE id=$1 AND tenant_id=$2", [bundle.kit.kitId, f.session.id, bundle.kit.id]); await db.query("UPDATE wk_kit_commitments SET kit_id=$3,payload=$4 WHERE id=$1 AND tenant_id=$2", [commitment.id, f.session.id, commitment.kitId, commitment]); });
  const snapshot = sampleCatalog("sample-recorder-a", "available-alternative").value.snapshot;
  const incident: LivingIncident = { id: randomUUID(), webhookId: `sample-only:${randomUUID()}`, watchId: randomUUID(), itemId, model: "Sample recorder", sourceMode: "sample", catalogSource: "sample", signal: { eventId: `sample-only:${randomUUID()}`, committedAt: new Date().toISOString(), subscriptionId: "sample-subscription-only", locale: { language: "en", country: "US", currency: "USD" }, type: "offer.availability.changed", productId: snapshot.productId, selection: [], domain: "original.example.invalid", current: "OutOfStock", previous: "InStock" }, impact: { state: "needs_repair_review", reason: "Explicit Sample shortage", title: "Sample", currentPriceMinor: 24800 }, refreshed: snapshot, snapshotHash: hash(snapshot), observedAt: new Date().toISOString(), revisionId: bundle.kit.id, createdAt: new Date().toISOString(), dismissedAt: null };
  const first = await repairTransaction(db => enqueueIncidentRepair(db, f.session.id, incident)); const next = await repairTransaction(db => enqueueIncidentRepair(db, f.session.id, { ...incident, id: randomUUID() }));
  assert.equal(first.commitmentId, commitment.id); assert.equal(first.id, next.id); assert.equal(next.incidentIds.length, 2); assert.deepEqual(next.impact.changedComponentIds, ["audio"]);
  const fixtureRuntime: RepairCatalogRuntime = { mode: "live", refresh: async () => { const response = sampleCatalog(snapshot.productId, "available-alternative", "restore"); return response; }, similar: async () => { throw new Error("resolved events must not discover"); }, search: async () => { throw new Error("resolved events must not discover"); } };
  // A live-runtime namespace can be exercised with a test-supplied adapter only;
  // the retained event remains Sample, and no provider call is made.
  await database().query("UPDATE wk_living_repairs SET payload=jsonb_set(payload,'{catalogMode}','\"live\"'::jsonb) WHERE id=$1", [first.id]);
  await processRepairQueue(f.session.id, first.id, fixtureRuntime); assert.equal((await loadRepair(f.session.id, first.id)).phase, "resolved"); assert.equal((await livingRepairView(f.session)).orders.length, 0);
});
test("a completed refund with a newer unresolved payment observation pauses restoration without erasing the money", async () => {
  const f = await fixture(); await accept(f); const request = await prepareKitCompensation(f.session, f.amendment.proposal.id, "undo"); const normal = await getRepairEngine(f.session.id, "sample");
  const provider: ProviderAdapter = { source: "sample", read: normal.provider.read.bind(normal.provider), reconcile: normal.provider.reconcile.bind(normal.provider), execute: async command => {
    const receipt = await normal.provider.execute(command);
    if (command.action.kind === "refund_capture") await repairTransaction(async db => { const order = await loadOrder(f.session.id, request.orderId!, db); order.paymentHealth = { status: "needs_review", reason: "Explicit Sample observation needs review", observedAt: new Date().toISOString(), webhookId: null }; await saveOrder(db, order); });
    return receipt;
  } };
  const pending = await acceptKitCompensation(f.session, request.id, request.digest, origin, { engine: createCommerceEngine(provider, normal.store) });
  assert.equal(pending.refundedMinor, 800); assert.equal(pending.state, "refund_pending"); assert.equal((await loadCommitment(f.session.id, f.run.commitmentId!)).version, 2);
  await repairTransaction(async db => { const order = await loadOrder(f.session.id, request.orderId!, db); order.paymentHealth = { status: "clear", reason: "Sample review resolved by fixture", observedAt: new Date().toISOString(), webhookId: null }; await saveOrder(db, order); });
  assert.equal((await refreshKitCompensation(f.session, request.id)).state, "completed");
});
test("refund attribution rejects a conflicting capture parent and stale individual refund evidence", async () => {
  const f = await fixture("commit-failure"); await accept(f); const normal = await getRepairEngine(f.session.id, "sample");
  const parentMismatch: ProviderAdapter = { ...normal.provider, source: "sample", execute: normal.provider.execute.bind(normal.provider), reconcile: normal.provider.reconcile.bind(normal.provider), read: async (kind, id) => (await normal.provider.read(kind, id)).map(resource => kind === "capture" ? { ...resource, parentId: "sample-foreign-order" } : resource) };
  await assert.rejects(prepareKitCompensation(f.session, f.amendment.proposal.id, "failed_commit", { engine: { ...normal, provider: parentMismatch } }), /parent conflicts/);
  await externalSampleRefund(f, 250);
  const stale: ProviderAdapter = { ...parentMismatch, read: async (kind, id) => (await normal.provider.read(kind, id)).map(resource => kind === "refund" ? { ...resource, observedAt: new Date(Date.now() - 600_000).toISOString() } : resource) };
  await assert.rejects(prepareKitCompensation(f.session, f.amendment.proposal.id, "failed_commit", { engine: { ...normal, provider: stale } }), /not observed recently/);
  assert.equal((await livingRepairView(f.session)).compensations.length, 0);
});
test("a lost refund response reconciles one original operation without a speculative second refund", async () => {
  const f = await fixture(); await accept(f); const request = await prepareKitCompensation(f.session, f.amendment.proposal.id, "undo"); const normal = await getRepairEngine(f.session.id, "sample"); let missingReads = 2;
  const provider: ProviderAdapter = { source: "sample", read: normal.provider.read.bind(normal.provider), execute: async command => { const receipt = await normal.provider.execute(command); if (command.action.kind === "refund_capture") throw new ProviderError("timeout", "Explicit Sample lost refund response", "unknown", 502); return receipt; }, reconcile: async operation => { if (operation.command.action.kind === "refund_capture" && missingReads-- > 0) return null; return normal.provider.reconcile(operation); } };
  const engine = createCommerceEngine(provider, normal.store); const pending = await acceptKitCompensation(f.session, request.id, request.digest, origin, { engine }); assert.equal(pending.state, "refund_pending");
  const before = (await database().query("SELECT operation_id FROM wk_kit_sample_payments WHERE tenant_id=$1 ORDER BY operation_id", [f.session.id])).rows;
  const recovered = await resumeKitCompensation(f.session, request.id, request.digest, { engine }); assert.equal(recovered.state, "completed"); assert.equal(recovered.refundedMinor, 800);
  assert.deepEqual((await database().query("SELECT operation_id FROM wk_kit_sample_payments WHERE tenant_id=$1 ORDER BY operation_id", [f.session.id])).rows, before); assert.equal(before.length, 3);
});
test("old exact repair links remain addressable while history sends summaries instead of every full graph", async () => {
  const f = await fixture(); const before = await livingRepairView(f.session, f.run.id); const size = JSON.stringify(before).length;
  for (let i = 0; i < 31; i++) await startNextSampleRepair(f.session, f.run.commitmentId!, 1, randomUUID());
  const view = await livingRepairView(f.session, f.run.id);
  assert.equal(view.run!.id, f.run.id); assert.equal(view.amendments[0]!.proposal.id, f.amendment.proposal.id); assert.equal(view.runs.length, 31);
  assert.ok(view.runs.every(run => !("base" in run))); assert.ok(JSON.stringify(view).length < size + 50_000);
  const other = (await createSession()).session; await assert.rejects(livingRepairView(other, f.run.id), /does not belong/);
});
