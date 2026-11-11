import { randomUUID } from "node:crypto";
import type { AuthorizationDecision, PaymentCommand, ProviderAdapter } from "@fracture/paypal-core";
import type { CommerceOrder, FinancialAuthority } from "../../packages/commerce/contracts";
import { paymentNeedsReview } from "../../packages/commerce/observations";
import { hash, verifyKit } from "../../packages/compatibility";
import { WorldKitError, type Quote } from "../../packages/contracts";
import { architectures } from "../../packages/device-library";
import type { CompensationRequest, KitAmendment, RepairAuthorityContext } from "../../packages/living-repair/contracts";
import { criticalFactChecks, inStock, sameSelection, technicalState } from "../../packages/living-repair/planner";
import { authorityByOperation, captureCheckout, commandFor, insertAuthority, loadOrder, newOrder, purchaseAction, refreshOrder, saveOrder, syncOperation } from "./commerce";
import { database } from "./db";
import { catalogForRun, evidenceFor, type RepairCatalogRuntime } from "./living-repair";
import { repairTransaction } from "./living-repair-db";
import { authoritativeRefundBudget, getRepairEngine, repairClaims, retainRefundBudget, saveRepairClaim, type RepairEngine } from "./living-repair-payments";
import { loadAmendment, loadCommitment, loadRepair, ownedRepairRow, repairNotice, repairNow, saveAmendment, saveCommitmentVersion, type RepairDb } from "./living-repair-store";
import { unresolvedPaymentEvents } from "./payment-event-holds";
import { saveRevision, type Session } from "./repository";

const loadCompensation = (tenantId: string, id: string, db?: RepairDb, lock = false) => ownedRepairRow<CompensationRequest>("compensation", tenantId, id, db, lock);
const scope = (tenantId: string) => ({ tenantId, projectId: "worldkit" });
export function compensationDigest(value: CompensationRequest) {
  return hash({ id: value.id, tenantId: value.tenantId, amendmentId: value.amendmentId, commitmentId: value.commitmentId, expectedVersion: value.expectedVersion, kind: value.kind, expiresAt: value.expiresAt, restore: value.restore, restoreLines: value.restoreLines, restorationTotalMinor: value.restorationTotalMinor, supplementalMinor: value.supplementalMinor, refundMinor: value.refundMinor, creditShortfallMinor: value.creditShortfallMinor, orderId: value.orderId, paymentMode: value.paymentMode, sourceMode: value.sourceMode, balanceProof: value.balanceProof });
}
async function saveCompensation(db: RepairDb, request: CompensationRequest) {
  const current = await loadCompensation(request.tenantId, request.id, db, true);
  if (["completed", "partial_support_needed", "refused"].includes(current.state) || current.consentedAt && !request.consentedAt) return current;
  if (current.consentedAt && current.digest !== request.digest) throw new WorldKitError("stale_revision", "A separately accepted compensation cannot be replaced by another quote.", 409);
  request.refundedMinor = Math.max(current.refundedMinor, request.refundedMinor);
  await db.query("UPDATE wk_kit_compensations SET state=$3,payload=$4,updated_at=now() WHERE id=$1 AND tenant_id=$2", [request.id, request.tenantId, request.state, request]);
  return request;
}
async function freshRestoration(request: CompensationRequest, supplied?: RepairCatalogRuntime): Promise<CompensationRequest> {
  if (request.kind !== "undo" || !request.restore || !request.restoreLines) return request;
  const amendment = await loadAmendment(request.tenantId, request.amendmentId); const run = await loadRepair(request.tenantId, amendment.proposal.runId);
  const commitment = await loadCommitment(request.tenantId, request.commitmentId);
  if (commitment.version !== request.expectedVersion || commitment.latestAmendmentId !== request.amendmentId || commitment.lines.some(line => line.fulfillment !== "unfulfilled")) throw new WorldKitError("stale_revision", "A later amendment or shipment prevents this exact restoration.", 409);
  if (!amendment.undoUntil || Date.parse(amendment.undoUntil) <= Date.now()) throw new WorldKitError("capability_requires_approval", "The conditional 24-hour undo window has ended. Keep the payment history and request support review.", 409);
  const runtime = catalogForRun(run, "restore", supplied); const snapshots = []; const receipts = [];
  for (const line of request.restoreLines.filter(line => amendment.proposal.impact.changedComponentIds.includes(line.componentId))) {
    if (!line.productId) throw new WorldKitError("needs_evidence", "The original line has no exact current sourcing identity.", 409);
    const response = await runtime.refresh(line.productId, request.tenantId, Object.fromEntries(line.selectedOptions.map(option => [option.name, option.value]))); const snapshot = response.value.snapshot;
    const age = Date.now() - Date.parse(snapshot.observedAt); const offers = snapshot.offers.filter(offer => offer.domain.toLowerCase() === line.domain && (!line.offerId || offer.id === line.offerId) && (!line.condition || offer.condition === line.condition)); const offer = offers.length === 1 ? offers[0] : undefined;
    if (!snapshot.detailChecked || !snapshot.variantExact || snapshot.productId !== line.productId || !sameSelection(snapshot.selectedOptions, line.selectedOptions) || !Number.isFinite(age) || age > 120_000 || age < -5_000 || !offer?.price || offer.price.currency !== "USD" || !inStock(offer.availability)) throw new WorldKitError("needs_evidence", "The original item is not currently available in its exact variant. Undo cannot promise to restore it.", 409);
    if (request.consentedAt && offer.price.minor !== line.unitMinor) throw new WorldKitError("quote_expired", "The original item’s price changed after the restoration quote. Any refund already completed remains recorded; the graph cannot be restored at an unapproved price.", 409);
    line.unitMinor = offer.price.minor; snapshots.push(snapshot); receipts.push(response.receipt);
  }
  const certificate = verifyKit(request.restore.kit, request.restore.profiles, request.restore.sources, architectures, snapshots);
  if (technicalState({ ...request.restore, certificate }, run.catalogMode, criticalFactChecks(request.restore, run.catalogMode)) !== "satisfied") throw new WorldKitError("needs_evidence", "The original configuration no longer passes every critical technical premise. Restoration needs evidence review.", 409);
  request.originalCheck = evidenceFor(runtime.mode, snapshots, receipts, runtime.mode === "sample" ? "sample_fixture" : "same_variant", "Fresh exact original stock, cost and critical technical premises");
  request.restorationTotalMinor = request.restoreLines.reduce((sum, line) => sum + line.quantity * line.unitMinor, 0);
  if (request.restorationTotalMinor > request.restore.kit.goal.budgetMinor) throw new WorldKitError("infeasible", "The current restoration cost exceeds the original hard kit budget.", 409);
  return request;
}
export async function prepareKitCompensation(session: Session, amendmentId: string, kind: "undo" | "failed_commit", options: { engine?: RepairEngine; catalog?: RepairCatalogRuntime } = {}): Promise<CompensationRequest> {
  const amendment = await loadAmendment(session.id, amendmentId); const commitment = await loadCommitment(session.id, amendment.proposal.commitmentId);
  const prior = (await database().query("SELECT payload FROM wk_kit_compensations WHERE tenant_id=$1 AND amendment_id=$2 AND kind=$3", [session.id, amendmentId, kind])).rows[0]?.payload as CompensationRequest | undefined;
  if (prior?.consentedAt || prior && Date.parse(prior.expiresAt) > Date.now()) return prior;
  if (kind === "undo" && (amendment.status !== "committed" || commitment.latestAmendmentId !== amendmentId || commitment.version !== amendment.committedVersion)) throw new WorldKitError("invalid_request", "Only the latest successfully committed change can enter conditional undo.", 409);
  if (kind === "failed_commit" && !["compensation_required", "partial_support_needed"].includes(amendment.status)) throw new WorldKitError("invalid_request", "This change does not have a completed payment awaiting failed-commit compensation.", 409);
  const mode = amendment.paymentMode ?? "sample"; const order = amendment.orderId ? await loadOrder(session.id, amendment.orderId) : null;
  const engine = order ? await getRepairEngine(session.id, mode, options.engine) : null;
  const budget = order && engine ? await authoritativeRefundBudget(order, engine.provider) : null;
  if (order && budget) await retainRefundBudget(order, budget);
  const at = repairNow();
  const request: CompensationRequest = { id: prior?.id ?? randomUUID(), tenantId: session.id, amendmentId, commitmentId: commitment.id, expectedVersion: commitment.version, kind, state: "review", createdAt: at, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), consentedAt: null, digest: "", reason: "Review the separate compensation amount and conditional restoration before granting fresh authority.", originalCheck: null, restore: kind === "undo" ? structuredClone(amendment.proposal.before) : null, restoreLines: kind === "undo" ? structuredClone(amendment.proposal.quote.beforeLines) : null, restorationTotalMinor: null, supplementalMinor: 0, refundMinor: kind === "failed_commit" ? budget?.remainingMinor ?? 0 : 0, creditShortfallMinor: 0, orderId: order?.id ?? null, supplementalOrderId: null, refundOperationId: null, refundedMinor: 0, paymentMode: mode, sourceMode: amendment.proposal.sourceMode };
  if (budget) request.balanceProof = { captureId: budget.capture.id, capturedMinor: budget.capture.money!.minor, remainingMinor: budget.remainingMinor, observedAt: budget.capture.observedAt, refundIds: budget.refunds.map(refund => refund.id), digest: hash({ capture: budget.capture, refunds: budget.refunds }) };
  if (request.restore) { request.restore.kit.id = `restoration:${randomUUID()}`; request.restore.kit.parentRevisionId = commitment.current.kit.id; request.restore.kit.revision = commitment.current.kit.revision + 1; request.restore.kit.createdAt = at; request.restore.certificate = verifyKit(request.restore.kit, request.restore.profiles, request.restore.sources, architectures); }
  await freshRestoration(request, options.catalog);
  if (kind === "undo") {
    const difference = request.restorationTotalMinor! - commitment.currentTotalMinor;
    request.supplementalMinor = Math.max(0, difference);
    const credit = Math.max(0, -difference); request.refundMinor = Math.min(credit, budget?.remainingMinor ?? 0); request.creditShortfallMinor = Math.max(0, credit - request.refundMinor);
    request.reason = request.supplementalMinor ? "The original item now costs more than the current commitment. Restoring it requires a separately approved supplemental payment; the old allowance cannot authorize this undo." : request.refundMinor ? "Refund only this eligible captured amount, then restore the original exact graph if stock, price and fulfillment still permit it. A completed refund is never undone if restoration later fails." : "No refundable capture is implied by the Sample baseline. Restore the exact graph only after the current stock, price and technical checks pass.";
  }
  request.digest = compensationDigest(request);
  return repairTransaction(async db => {
    await loadCommitment(session.id, commitment.id, db, true);
    const existing = (await db.query("SELECT payload FROM wk_kit_compensations WHERE tenant_id=$1 AND amendment_id=$2 AND kind=$3 FOR UPDATE", [session.id, amendmentId, kind])).rows[0]?.payload as CompensationRequest | undefined;
    if (existing?.consentedAt) return existing;
    if (existing) { request.id = existing.id; request.digest = compensationDigest(request); await saveCompensation(db, request); }
    else await db.query("INSERT INTO wk_kit_compensations(id,tenant_id,amendment_id,kind,state,payload) VALUES($1,$2,$3,$4,$5,$6)", [request.id, session.id, amendmentId, kind, request.state, request]);
    return request;
  });
}
export async function authorizeRepairCompensation(input: { command: PaymentCommand; provider: ProviderAdapter; order: CommerceOrder; authority: FinancialAuthority; refuse: (reason: string) => AuthorizationDecision; amendment: KitAmendment; context: RepairAuthorityContext; decision: AuthorizationDecision }): Promise<AuthorizationDecision> {
  const { command, provider, order, refuse, amendment, context, decision } = input;
  const request = await loadCompensation(order.tenantId, context.compensationId!);
  if (request.digest !== compensationDigest(request) || !request.consentedAt || request.amendmentId !== amendment.proposal.id || request.commitmentId !== context.commitmentId || request.paymentMode !== provider.source || Date.parse(request.expiresAt) <= Date.now() || ["refused", "completed", "partial_support_needed"].includes(request.state)) return refuse("This exact compensation has no current separate consent.");
  if (request.kind === "undo") {
    const commitment = await loadCommitment(order.tenantId, request.commitmentId);
    if (commitment.version !== request.expectedVersion || commitment.latestAmendmentId !== request.amendmentId || commitment.lines.some(line => line.fulfillment !== "unfulfilled") || !amendment.undoUntil || Date.parse(amendment.undoUntil) <= Date.now()) return refuse("A later change, shipment or expired undo window prevents this restoration.");
    if (!request.originalCheck || Date.now() - Date.parse(request.originalCheck.checkedAt) > 90_000) return refuse("Refresh the original item’s exact stock and current restoration cost before dispatch.");
  }
  const action = command.action;
  if (action.kind === "refund_capture") {
    if (request.orderId !== order.id || request.refundOperationId !== command.operationId || action.money.currency !== "USD" || action.money.minor !== request.refundMinor || action.captureId !== order.captureId || action.orderId !== order.providerOrderId || command.approval.digest !== request.digest) return refuse("This refund does not match the separately accepted compensation.");
    const budget = await authoritativeRefundBudget(order, provider);
    if (action.money.minor > budget.remainingMinor) return refuse("The remaining confirmed capture balance is smaller than this compensation. Review a fresh amount.");
    decision.reservation = budget.reservation; return decision;
  }
  if (!["create_order", "capture_order"].includes(action.kind) || request.supplementalOrderId !== order.id || action.money.currency !== "USD" || action.money.minor !== request.supplementalMinor || order.quote.quoteHash !== request.digest || command.approval.digest !== request.digest || order.walletConsentId) return refuse("This supplemental restoration payment does not match its fresh buyer approval.");
  return decision;
}
export async function acceptKitCompensation(session: Session, id: string, expectedDigest: string, origin: string, options: { engine?: RepairEngine; catalog?: RepairCatalogRuntime } = {}) {
  let request = await loadCompensation(session.id, id);
  if (request.digest !== expectedDigest || compensationDigest(request) !== expectedDigest) throw new WorldKitError("stale_revision", "This compensation differs from the reviewed exact amount and restoration.", 409);
  if (request.consentedAt) return request;
  if (Date.parse(request.expiresAt) <= Date.now()) throw new WorldKitError("quote_expired", "This compensation quote expired. Review the current stock and balance again.", 409);
  // Setting consent on this local copy makes a changed restoration price fail
  // instead of silently substituting it into the reviewed quote.
  request.consentedAt = repairNow(); await freshRestoration(request, options.catalog);
  const engine = request.refundMinor || request.supplementalMinor ? await getRepairEngine(session.id, request.paymentMode, options.engine) : null;
  const prepared = await repairTransaction(async db => {
    const commitment = await loadCommitment(session.id, request.commitmentId, db, true);
    const amendment = await loadAmendment(session.id, request.amendmentId, db, true);
    const latest = await loadCompensation(session.id, id, db, true);
    if (latest.consentedAt) return { request: latest, command: null, orderId: null };
    if (latest.digest !== expectedDigest || request.digest !== compensationDigest(request) || commitment.version !== request.expectedVersion) throw new WorldKitError("stale_revision", "The merchant commitment or compensation quote changed during review.", 409);
    let command: PaymentCommand | null = null; let orderId: string | null = null;
    if (request.refundMinor) {
      const order = await loadOrder(session.id, request.orderId!, db);
      if (!order.captureId || !order.providerOrderId || !order.livingRepair) throw new WorldKitError("needs_evidence", "The original owned capture must be confirmed first.", 409);
      command = commandFor(order, "refund", { kind: "refund_capture", money: { currency: "USD", minor: request.refundMinor }, captureId: order.captureId, orderId: order.providerOrderId }, { id: `kit-compensation:${request.id}`, version: 1, digest: request.digest, expiresAt: request.expiresAt });
      command.operationId = command.businessKey = command.intentId = `kit-refund:${request.id}`;
      request.refundOperationId = command.operationId;
      await insertAuthority(db, { ...order, livingRepair: { ...order.livingRepair, compensationId: request.id } }, "refund", command);
      order.operationIds.push(command.operationId); await saveOrder(db, order); orderId = order.id; request.state = "refund_pending";
    } else if (request.supplementalMinor) {
      const quote: Quote = { id: randomUUID(), tenantId: session.id, revisionId: request.restore!.kit.id, verificationId: request.restore!.certificate.id, graphHash: request.restore!.certificate.graphHash, quoteHash: request.digest, merchantId: "worldkit-studio", merchantName: "WorldKit Studio", items: [{ sku: `kit-restoration:${request.id}`, name: "Controlled kit restoration supplement", quantity: 1, unitMinor: request.supplementalMinor, profileId: null }], total: { currency: "USD", minor: request.supplementalMinor }, createdAt: repairNow(), expiresAt: request.expiresAt, policyVersion: "controlled-kit-sandbox.v1", source: "sample", checkoutRequired: true };
      const order = newOrder(session.id, quote, commitment.kitId, origin, null); order.kind = "amendment"; order.sourceMode = request.paymentMode;
      order.approval = { id: `kit-restoration:${request.id}`, version: 1, digest: request.digest, expiresAt: request.expiresAt };
      order.livingRepair = { amendmentId: amendment.proposal.id, commitmentId: commitment.id, proposalDigest: amendment.proposal.digest, claimId: null, policyId: null, compensationId: request.id, paymentMode: request.paymentMode };
      command = commandFor(order, "purchase", purchaseAction(order)); order.operationIds.push(command.operationId);
      await db.query("INSERT INTO wk_commerce_orders(id,tenant_id,quote_id,payload) VALUES($1,$2,$3,$4)", [order.id, session.id, quote.id, order]); await insertAuthority(db, order, "purchase", command);
      request.supplementalOrderId = order.id; orderId = order.id; request.state = "payment_pending";
    } else request.state = "restoring";
    amendment.status = request.kind === "undo" ? "undo_pending" : "compensating"; amendment.reason = "The separate compensation consent is saved. Its original payment operation and any subsequent restoration are reconciled independently.";
    await saveAmendment(db, session.id, amendment); await saveCompensation(db, request);
    return { request, command, orderId };
  });
  request = prepared.request;
  if (prepared.command && prepared.orderId && engine) {
    const operation = await engine.core.execute(prepared.command); const order = await syncOperation(session, prepared.orderId, operation);
    if (request.supplementalMinor && request.paymentMode === "sample" && operation.status === "succeeded" && !order.capturedMinor && order.providerOrderId) await captureCheckout(session, order.id, Promise.resolve(engine));
  }
  return refreshKitCompensation(session, request.id, { ...options, engine: engine ?? undefined });
}
export async function refreshKitCompensation(session: Session, id: string, options: { engine?: RepairEngine; catalog?: RepairCatalogRuntime; capture?: boolean } = {}): Promise<CompensationRequest> {
  let request = await loadCompensation(session.id, id);
  if (!request.consentedAt || ["completed", "refused", "partial_support_needed"].includes(request.state)) return request;
  const engine = request.orderId || request.supplementalOrderId ? await getRepairEngine(session.id, request.paymentMode, options.engine) : null;
  if (request.orderId && engine && request.refundOperationId) {
    const order = await refreshOrder(session, request.orderId, Promise.resolve(engine));
    const operation = await engine.store.get(scope(session.id), request.refundOperationId);
    const refunds = operation?.receipt?.resources.filter(resource => resource.kind === "refund" && resource.status === "COMPLETED" && resource.money?.currency === "USD" && resource.money.minor === request.refundMinor) ?? [];
    if (operation?.status === "succeeded" && refunds.length === 1) {
      request.refundedMinor = refunds[0]!.money!.minor;
      const held = paymentNeedsReview(order) || (await unresolvedPaymentEvents([order])).has(order.id);
      request.state = held ? "refund_pending" : "restoring";
      if (held) request.reason = "The refund is recorded, but a current payment observation still needs review. Restoration stays paused while the original financial evidence is reconciled.";
    }
    else if (operation && ["refused", "not_sent"].includes(operation.status)) { request.state = "refused"; request.reason = "The compensation was positively refused or never sent. The committed kit stays unchanged; the retained operation requires a fresh support decision before another write."; }
    else { request.state = "refund_pending"; request.reason = "The original refund operation remains pending. Its full amount stays reserved; no speculative replacement refund or graph rollback is permitted."; }
    const claims = await repairClaims(session.id, request.commitmentId);
    const claim = claims.find(claim => claim.amendmentId === request.amendmentId);
    if (claim && order.capturedMinor > 0 && order.refundedMinor >= order.capturedMinor) { claim.state = "refunded"; await repairTransaction(db => saveRepairClaim(db, claim)); }
  }
  if (request.supplementalOrderId && engine) {
    let order = await refreshOrder(session, request.supplementalOrderId, Promise.resolve(engine));
    if (options.capture && !order.capturedMinor) {
      await freshRestoration(request, options.catalog); await repairTransaction(db => saveCompensation(db, request));
      order = await captureCheckout(session, order.id, Promise.resolve(engine));
    }
    if (order.capturedMinor === request.supplementalMinor && !order.refundedMinor && !paymentNeedsReview(order) && !(await unresolvedPaymentEvents([order])).has(order.id)) request.state = "restoring";
    else if (order.state === "refused") { request.state = "refused"; request.reason = "The supplemental restoration payment was refused. The current kit remains saved."; }
    else { request.state = order.approvalUrl ? "requires_payment_approval" : "payment_pending"; request.reason = "Approve and reconcile the exact supplemental payment before restoring the graph."; }
  }
  request = await repairTransaction(db => saveCompensation(db, request));
  if (request.state !== "restoring") return request;
  try {
    await freshRestoration(request, options.catalog);
    return await repairTransaction(async db => {
      const commitment = await loadCommitment(session.id, request.commitmentId, db, true);
      const amendment = await loadAmendment(session.id, request.amendmentId, db, true);
      const latest = await loadCompensation(session.id, request.id, db, true);
      if (["completed", "partial_support_needed", "refused"].includes(latest.state)) return latest;
      if (request.refundMinor && request.orderId) {
        await db.query("SELECT id FROM wk_commerce_orders WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [request.orderId, session.id]);
        const order = await loadOrder(session.id, request.orderId, db);
        if (order.refundedMinor < request.refundMinor || paymentNeedsReview(order) || (await unresolvedPaymentEvents([order], db)).has(order.id)) {
          latest.state = "refund_pending"; latest.reason = "The payment history needs reconciliation before restoration can be committed. Any completed refund remains recorded.";
          return saveCompensation(db, latest);
        }
      }
      if (request.kind === "undo") {
        if (commitment.version !== request.expectedVersion || commitment.latestAmendmentId !== request.amendmentId || commitment.lines.some(line => line.fulfillment !== "unfulfilled") || !request.restore || !request.restoreLines) throw new WorldKitError("stale_revision", "The merchant commitment changed after the money operation. A refund cannot promise a graph rollback.", 409);
        if (commitment.branch === "workspace") {
          const current = (await db.query("SELECT current_revision_id FROM wk_kits WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [commitment.kitId, session.id])).rows[0];
          if (!current || current.current_revision_id !== commitment.current.kit.id) throw new WorldKitError("stale_revision", "A later workbench edit prevents the original graph from being restored.", 409);
          await saveRevision(db, session.id, request.restore); await db.query("UPDATE wk_kits SET current_revision_id=$3 WHERE id=$1 AND tenant_id=$2", [commitment.kitId, session.id, request.restore.kit.id]);
        }
        commitment.current = request.restore; commitment.lines = request.restoreLines; commitment.currentTotalMinor = request.restorationTotalMinor!; commitment.version++; commitment.updatedAt = repairNow(); commitment.latestAmendmentId = null;
        await saveCommitmentVersion(db, commitment, "undo", amendment.proposal.id);
        amendment.status = request.creditShortfallMinor ? "partial_support_needed" : "undone";
        amendment.reason = request.creditShortfallMinor ? "The original controlled graph is restored and the eligible capture was refunded. The remaining demonstration credit has no funded capture and needs support review; no extra refund is claimed." : "The original controlled graph was restored after current stock, cost, technical checks and any required money operation were confirmed. Gross spending and both historical versions remain recorded.";
      } else { amendment.status = "compensated"; amendment.reason = "The failed merchant change was compensated against its actual eligible capture. The original graph was never replaced."; }
      request.state = request.creditShortfallMinor ? "partial_support_needed" : "completed"; request.reason = amendment.reason;
      await saveAmendment(db, session.id, amendment); await saveCompensation(db, request);
      await repairNotice(db, session.id, `compensation:${request.id}:complete`, { kind: "kit-compensation", title: request.kind === "undo" ? "The conditional restoration is resolved" : "The failed change is compensated", detail: request.reason, sourceMode: request.sourceMode, amendmentId: request.amendmentId }); return request;
    });
  } catch (error) {
    return repairTransaction(async db => {
      await loadCommitment(session.id, request.commitmentId, db, true);
      const amendment = await loadAmendment(session.id, request.amendmentId, db, true);
      const latest = await loadCompensation(session.id, request.id, db, true);
      if (["completed", "partial_support_needed", "refused"].includes(latest.state)) return latest;
      request.state = "partial_support_needed"; request.reason = `${request.refundedMinor ? "The refund completed. " : request.supplementalMinor ? "The supplemental payment remains recorded. " : ""}${error instanceof WorldKitError ? error.message : "The restoration could not be committed."} The current saved graph remains authoritative; support review is required.`;
      await saveCompensation(db, request); amendment.status = "partial_support_needed"; amendment.reason = request.reason; await saveAmendment(db, session.id, amendment);
      await repairNotice(db, session.id, `compensation:${request.id}:partial`, { kind: "kit-support", title: "Money and restoration need separate review", detail: request.reason, sourceMode: request.sourceMode, amendmentId: request.amendmentId }); return request;
    });
  }
}
export async function resumeKitCompensation(session: Session, id: string, expectedDigest: string, options: { engine?: RepairEngine; catalog?: RepairCatalogRuntime } = {}) {
  let request = await loadCompensation(session.id, id);
  if (!request.consentedAt || request.digest !== expectedDigest || compensationDigest(request) !== expectedDigest) throw new WorldKitError("stale_revision", "Continue only the exact separately accepted compensation.", 409);
  request = await refreshKitCompensation(session, id, options);
  if (["completed", "refused", "partial_support_needed"].includes(request.state)) return request;
  const orderId = request.refundOperationId ? request.orderId : request.supplementalOrderId;
  const operationId = request.refundOperationId ?? (orderId ? `purchase:${orderId}` : null);
  if (!orderId || !operationId) return request;
  const engine = await getRepairEngine(session.id, request.paymentMode, options.engine);
  if (!await engine.store.get(scope(session.id), operationId)) {
    await freshRestoration(request, options.catalog); request = await repairTransaction(db => saveCompensation(db, request));
    const authority = await authorityByOperation(session.id, operationId);
    if (!authority || authority.orderId !== orderId) throw new WorldKitError("needs_evidence", "The original compensation command is unavailable. Keep this record for support review.", 409);
    const order = await syncOperation(session, orderId, await engine.core.execute(authority.command));
    if (request.supplementalMinor && request.paymentMode === "sample" && !order.capturedMinor && order.providerOrderId) await captureCheckout(session, order.id, Promise.resolve(engine));
  } else if (request.supplementalOrderId && request.paymentMode === "sample") {
    const order = await loadOrder(session.id, orderId);
    const purchase = await engine.store.get(scope(session.id), operationId);
    const capture = await engine.store.get(scope(session.id), `capture:${orderId}`);
    if (purchase?.status === "succeeded" && !capture && !order.capturedMinor && order.providerOrderId) {
      await freshRestoration(request, options.catalog); request = await repairTransaction(db => saveCompensation(db, request));
      await captureCheckout(session, order.id, Promise.resolve(engine));
    }
  }
  return refreshKitCompensation(session, id, { ...options, engine });
}
export async function saveRepairSupportRequest(session: Session, amendmentId: string, requestId: string, message: string) {
  const amendment = await loadAmendment(session.id, amendmentId);
  const detail = message.trim();
  if (detail.length < 10 || detail.length > 2000) throw new WorldKitError("invalid_request", "Describe the review you need in 10 to 2,000 characters.", 400);
  const reason = "Your review request is saved in this private workspace with its amendment and payment history. No external message was sent, and no payment or kit state changed.";
  await repairTransaction(db => repairNotice(db, session.id, `support:${requestId}`, { kind: "kit-support-request", title: "A kit review request is saved", detail: `${detail}\n\n${reason}`, sourceMode: amendment.proposal.sourceMode, runId: amendment.proposal.runId, amendmentId }));
  return { reason, amendmentId, requestId };
}
export async function simulateKitShipment(session: Session, commitmentId: string, expectedVersion: number) {
  return repairTransaction(async db => {
    const commitment = await loadCommitment(session.id, commitmentId, db, true);
    if (commitment.branch !== "sample_demonstration") throw new WorldKitError("forbidden", "Shipment simulation belongs only to the explicitly Sample demonstration branch.", 403);
    if (commitment.version !== expectedVersion) throw new WorldKitError("stale_revision", "Refresh the controlled commitment before simulating shipment.", 409);
    if (commitment.lines.every(line => line.fulfillment === "shipped")) return commitment;
    commitment.lines = commitment.lines.map(line => ({ ...line, fulfillment: "shipped" })); commitment.version++; commitment.updatedAt = repairNow();
    await saveCommitmentVersion(db, commitment, "shipment", commitment.latestAmendmentId);
    await db.query("UPDATE wk_kit_repair_policies SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb($3::text)) WHERE tenant_id=$1 AND commitment_id=$2 AND payload->>'revokedAt' IS NULL", [session.id, commitment.id, repairNow()]);
    await repairNotice(db, session.id, `shipment:${commitment.id}`, { kind: "sample-shipment", title: "The Sample kit entered fulfillment", detail: "This is an explicit controlled-merchant simulation. Automatic authority and conditional undo have ended. No retailer shipment is claimed.", sourceMode: "sample" }); return commitment;
  });
}
