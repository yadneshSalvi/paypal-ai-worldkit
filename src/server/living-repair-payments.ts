import { randomUUID } from "node:crypto";
import { SqlPaymentStore, canonicalJson, type AuthorizationDecision, type PaymentCommand, type ProviderAdapter, type ProviderResource } from "@fracture/paypal-core";
import type { CommerceOrder, FinancialAuthority, WalletConsent } from "../../packages/commerce/contracts";
import { paymentNeedsReview, projectPaymentResources } from "../../packages/commerce/observations";
import { hash, verifyKit } from "../../packages/compatibility";
import { WorldKitError, type CatalogSnapshot, type Quote } from "../../packages/contracts";
import { architectures } from "../../packages/device-library";
import type { CompensationRequest, KitAmendment, KitRepairClaim, KitRepairPolicy, RepairAuthorityContext } from "../../packages/living-repair/contracts";
import { preservedIntent } from "../../packages/living-repair/impact";
import { criticalFactChecks, inStock, sameSelection, technicalState } from "../../packages/living-repair/planner";
import { evaluateKitPolicy, grossAllowance } from "../../packages/living-repair/policy";
import { authorityByOperation, captureCheckout, commandFor, createCommerceEngine, insertAuthority, loadOrder, newOrder, paymentEngine, purchaseAction, refreshOrder, saveOrder, syncOperation } from "./commerce";
import { paymentDatabase } from "./commerce-db";
import { database } from "./db";
import { catalogForRun, type RepairCatalogRuntime } from "./living-repair";
import { initializeLivingRepair, repairTransaction } from "./living-repair-db";
import { LivingRepairSampleProvider } from "./living-repair-sample-payment";
import { loadAmendment, loadCommitment, loadRepair, ownedRepairRow, repairNotice, repairNow, saveAmendment, saveCommitmentVersion, type RepairDb } from "./living-repair-store";
import { unresolvedPaymentEvents } from "./payment-event-holds";
import { orderResources, storeOwnedPaymentResource } from "./payment-resources";
import { appendEvent, getRevision, saveRevision, type Session } from "./repository";
import { loadWallet } from "./wallets";

export type RepairEngine = ReturnType<typeof createCommerceEngine>;
export function paypalRepairReady() { return process.env.PAYPAL_ENVIRONMENT === "sandbox" && process.env.PAYPAL_API_BASE_URL === "https://api-m.sandbox.paypal.com" && Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && process.env.PAYPAL_PROJECT_ISOLATED); }
export async function getRepairEngine(tenantId: string, mode: "sample" | "live_sandbox", supplied?: RepairEngine): Promise<RepairEngine> {
  if (supplied) { if (supplied.provider.source !== mode) throw new WorldKitError("forbidden", "Payment evidence cannot cross Sample and PayPal namespaces.", 403); return supplied; }
  if (mode === "live_sandbox") {
    if (!paypalRepairReady()) throw new WorldKitError("provider_unavailable", "PayPal sandbox is unavailable in this environment. Your proposal remains saved; no payment has been sent.", 503);
    return paymentEngine();
  }
  await initializeLivingRepair(); const store = new SqlPaymentStore(paymentDatabase); await store.initialize();
  return createCommerceEngine(new LivingRepairSampleProvider(tenantId), store);
}
const scope = (tenantId: string) => ({ tenantId, projectId: "worldkit" });
export async function repairClaims(tenantId: string, commitmentId: string, db: RepairDb = database()): Promise<KitRepairClaim[]> {
  return (await db.query("SELECT payload FROM wk_kit_repair_claims WHERE tenant_id=$1 AND commitment_id=$2", [tenantId, commitmentId])).rows.map(row => row.payload);
}
export async function saveRepairClaim(db: RepairDb, claim: KitRepairClaim) { await db.query("UPDATE wk_kit_repair_claims SET state=$3,order_id=$4,payload=$5 WHERE id=$1 AND tenant_id=$2", [claim.id, claim.tenantId, claim.state, claim.orderId, claim]); }
function validProposal(amendment: KitAmendment) {
  const { digest, ...proposal } = amendment.proposal; const { digest: quoteDigest, ...quote } = proposal.quote;
  return hash(proposal) === digest && hash(quote) === quoteDigest && preservedIntent(proposal.before, proposal.after).preserved;
}
export async function checkAmendmentNow(tenantId: string, id: string, stage: "repair" | "commit" = "repair", supplied?: RepairCatalogRuntime): Promise<KitAmendment> {
  await initializeLivingRepair(); const amendment = await loadAmendment(tenantId, id); const proposal = amendment.proposal;
  if (!validProposal(amendment)) throw new WorldKitError("invalid_request", "The exact saved proposal is inconsistent. No action is authorized.", 409);
  const run = await loadRepair(tenantId, proposal.runId); const commitment = await loadCommitment(tenantId, proposal.commitmentId);
  if (commitment.version !== proposal.commitmentVersion || commitment.current.certificate.graphHash !== proposal.before.certificate.graphHash || commitment.lines.some(line => line.fulfillment !== "unfulfilled")) throw new WorldKitError("stale_revision", "The controlled kit changed or entered fulfillment after this proposal.", 409);
  if (commitment.branch === "workspace") {
    const current = await getRevision(tenantId);
    if (current.certificate.graphHash !== proposal.before.certificate.graphHash || current.kit.id !== proposal.before.kit.id) throw new WorldKitError("stale_revision", "Your current workbench changed after this proposal. Its paid history, if any, must be resolved separately.", 409);
  }
  if (proposal.technicalState !== "satisfied" || run.sourceMode === "replay") throw new WorldKitError("needs_evidence", "Critical technical evidence must pass before this proposal can authorize a change. Replay evidence grants no payment authority.", 409);
  if (proposal.quote.afterTotalMinor > proposal.after.kit.goal.budgetMinor) throw new WorldKitError("infeasible", "The controlled merchant total exceeds the original hard equipment budget. A spending allowance cannot relax that goal.", 409);
  if (stage === "repair" && Date.parse(proposal.expiresAt) <= Date.now()) throw new WorldKitError("quote_expired", "This exact proposal expired. Refresh the catalog and review a new proposal.", 409);
  const changed = proposal.quote.afterLines.filter(line => proposal.impact.changedComponentIds.includes(line.componentId));
  const runtime = catalogForRun(run, stage, supplied); const snapshots: CatalogSnapshot[] = [];
  for (const line of changed) {
    if (!line.productId) throw new WorldKitError("needs_evidence", "The changed line has no exact product identity.", 409);
    const response = await runtime.refresh(line.productId, tenantId, Object.fromEntries(line.selectedOptions.map(option => [option.name, option.value])));
    const snapshot = response.value.snapshot; const age = Date.now() - Date.parse(snapshot.observedAt);
    if (!snapshot.detailChecked || !snapshot.variantExact || snapshot.productId !== line.productId || !sameSelection(snapshot.selectedOptions, line.selectedOptions) || !Number.isFinite(age) || age > 120_000 || age < -5_000) throw new WorldKitError("needs_evidence", "The current product response does not prove the exact accepted identity.", 409);
    const offers = snapshot.offers.filter(offer => offer.domain.toLowerCase() === line.domain && (!line.offerId || offer.id === line.offerId) && (!line.condition || offer.condition === line.condition));
    const offer = offers.length === 1 ? offers[0] : undefined;
    if (!offer?.price || offer.price.currency !== "USD" || offer.price.minor !== line.unitMinor || !inStock(offer.availability)) throw new WorldKitError("quote_expired", "Current stock or price no longer matches the accepted replacement. Keep the original graph and resolve any completed payment separately.", 409);
    snapshots.push(snapshot);
  }
  const certificate = verifyKit(proposal.after.kit, proposal.after.profiles, proposal.after.sources, architectures, snapshots);
  const checked = { ...proposal.after, certificate }; const critical = criticalFactChecks(checked, run.catalogMode);
  if (certificate.graphHash !== proposal.after.certificate.graphHash || technicalState(checked, run.catalogMode, critical) !== "satisfied") throw new WorldKitError("needs_evidence", "Fresh critical-fact verification no longer supports the proposed graph.", 409);
  return repairTransaction(async db => {
    const latestCommitment = await loadCommitment(tenantId, proposal.commitmentId, db, true);
    const latest = await loadAmendment(tenantId, id, db, true);
    if (latestCommitment.version !== proposal.commitmentVersion || latest.proposal.digest !== proposal.digest) throw new WorldKitError("stale_revision", "The commitment changed during the fresh checks.", 409);
    latest.dispatchCheck = { proposalDigest: proposal.digest, checkedAt: repairNow(), expiresAt: new Date(Date.now() + 90_000).toISOString(), sourceHash: hash(snapshots), technicalHash: hash({ certificate: certificate.sourceHash, critical }) };
    await saveAmendment(db, tenantId, latest); return latest;
  });
}
export async function createKitRepairPolicy(session: Session, input: { commitmentId: string; expectedVersion: number; capMinor: number; paymentMode: "sample" | "live_sandbox"; walletId?: string; walletDigest?: string; amendmentId?: string; proposalDigest?: string; origin?: string; requestId?: string }) {
  const identity = input.requestId ? hash({ tenant: session.id, request: input.requestId }) : null;
  const policyId = identity ? `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}` : randomUUID();
  return repairTransaction(async db => {
    const commitment = await loadCommitment(session.id, input.commitmentId, db, true);
    const repeat = (await db.query("SELECT payload FROM wk_kit_repair_policies WHERE id=$1 AND tenant_id=$2", [policyId, session.id])).rows[0]?.payload as KitRepairPolicy | undefined;
    if (repeat) return repeat;
    if (commitment.version !== input.expectedVersion || commitment.lines.some(line => line.fulfillment !== "unfulfilled")) throw new WorldKitError("stale_revision", "Review the current, unfulfilled controlled commitment before granting authority.", 409);
    if (!Number.isSafeInteger(input.capMinor) || input.capMinor < 100 || input.capMinor > 100_000) throw new WorldKitError("invalid_request", "Choose a fresh kit-change limit from $1 to $1,000.", 400);
    if (input.paymentMode === "sample" && commitment.branch !== "sample_demonstration") throw new WorldKitError("forbidden", "The Sample instrument is only available inside the Sample demonstration branch.", 403);
    const wallet = input.paymentMode === "live_sandbox" && input.walletId ? await loadWallet(session.id, input.walletId, db) : null;
    if (input.paymentMode === "live_sandbox" && (!wallet || wallet.state !== "active" || !wallet.tokenId || !wallet.verifiedAt || wallet.revokedAt || Date.parse(wallet.expiresAt) <= Date.now() || wallet.digest !== input.walletDigest)) throw new WorldKitError("capability_requires_approval", "Connect and confirm a current PayPal wallet before granting automatic kit-change authority. You can also approve one exact amendment instead.", 409);
    const selectedId = input.amendmentId ?? (await db.query("SELECT id FROM wk_kit_amendments WHERE tenant_id=$1 AND commitment_id=$2 ORDER BY created_at DESC LIMIT 1", [session.id, commitment.id])).rows[0]?.id;
    if (!selectedId) throw new WorldKitError("invalid_request", "Review an exact proposal before defining its automatic scope.", 409);
    const selected = await loadAmendment(session.id, selectedId, db);
    const currentProposal = selected.proposal.commitmentVersion === commitment.version && selected.proposal.before.certificate.graphHash === commitment.current.certificate.graphHash && !selected.acceptedAt;
    const currentCommitted = selected.status === "committed" && selected.committedVersion === commitment.version && selected.proposal.after.certificate.graphHash === commitment.current.certificate.graphHash && commitment.latestAmendmentId === selected.proposal.id;
    if (selected.proposal.commitmentId !== commitment.id || (!currentProposal && !currentCommitted) || input.proposalDigest && input.proposalDigest !== selected.proposal.digest) throw new WorldKitError("stale_revision", "The proposal defining this allowance changed. Review its exact retailer and category scope.", 409);
    const vendors = [...new Set([...selected.proposal.quote.beforeLines, ...selected.proposal.quote.afterLines].map(line => line.domain))].sort();
    const categories = [...new Set([...selected.proposal.quote.beforeLines, ...selected.proposal.quote.afterLines].map(line => line.category))].sort();
    const conditions = [...new Set([...selected.proposal.quote.beforeLines, ...selected.proposal.quote.afterLines].map(line => line.condition ?? "new"))].sort();
    if (selected.proposal.quote.afterLines.some(line => !line.condition || line.condition.toLowerCase() === "unknown")) throw new WorldKitError("needs_evidence", "Confirm each equipment line’s condition before granting automatic scope.", 409);
    const id = policyId; const at = repairNow();
    const value = { id, tenantId: session.id, commitmentId: commitment.id, scope: "controlled_kit_amendments" as const, version: 1, capMinor: input.capMinor, currency: "USD" as const, merchantIds: ["worldkit-studio"] as ["worldkit-studio"], vendorDomains: vendors, categories, preserveOwned: true as const, preserveHardRequirements: true as const, stopAfterFulfillment: true as const, createdAt: at, expiresAt: new Date(Math.min(Date.parse(session.expiresAt), Date.now() + 24 * 3600_000)).toISOString(), revokedAt: null, paymentMode: input.paymentMode, walletConsentId: wallet?.id ?? null, walletConsentVersion: wallet?.version ?? null, walletConsentDigest: wallet?.digest ?? null, sampleInstrumentConsent: input.paymentMode === "sample" ? hash({ id, scope: "controlled_kit_amendments", commitmentId: commitment.id, paymentMode: "sample" }) : null, origin: input.origin ?? process.env.WORLDKIT_PUBLIC_URL ?? "http://127.0.0.1:4506", automatic: true as const, acceptedProposalDigest: selected.proposal.digest };
    const policy: KitRepairPolicy = { ...value, conditions, digest: hash({ ...value, conditions }) };
    await db.query("UPDATE wk_kit_repair_policies SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb($3::text)) WHERE tenant_id=$1 AND commitment_id=$2 AND payload->>'revokedAt' IS NULL", [session.id, commitment.id, at]);
    await db.query("INSERT INTO wk_kit_repair_policies(id,tenant_id,commitment_id,payload) VALUES($1,$2,$3,$4)", [id, session.id, commitment.id, policy]);
    await repairNotice(db, session.id, `kit-policy:${id}`, { kind: "kit-policy", title: "A fresh kit-change allowance is active", detail: `Up to $${(policy.capMinor / 100).toFixed(2)} in additional gross changes, including pending payments. Only this controlled commitment, its listed categories and sourcing retailers are included. Refunds do not restore the limit.`, sourceMode: policy.paymentMode === "sample" ? "sample" : "live" });
    return policy;
  });
}
export async function revokeKitRepairPolicy(session: Session, id: string) {
  return repairTransaction(async db => {
    const policy = await ownedRepairRow<KitRepairPolicy>("policy", session.id, id, db, true); policy.revokedAt ??= repairNow();
    await db.query("UPDATE wk_kit_repair_policies SET payload=$3 WHERE id=$1 AND tenant_id=$2", [id, session.id, policy]); return policy;
  });
}
export async function authorizeLivingRepair(input: { command: PaymentCommand; provider: ProviderAdapter; order: CommerceOrder; authority: FinancialAuthority; refuse: (reason: string) => AuthorizationDecision }): Promise<AuthorizationDecision> {
  const { command, provider, order, authority, refuse } = input; const context = authority.livingRepair ?? order.livingRepair!;
  await initializeLivingRepair();
  if (!authority.livingRepair || context.amendmentId !== order.livingRepair!.amendmentId || context.commitmentId !== order.livingRepair!.commitmentId || context.proposalDigest !== order.livingRepair!.proposalDigest || context.paymentMode !== provider.source || context.paymentMode !== order.sourceMode || !context.compensationId && canonicalJson(context) !== canonicalJson(order.livingRepair)) return refuse("The exact kit amendment and payment evidence source do not match this authority.");
  const amendment = await loadAmendment(order.tenantId, context.amendmentId);
  if (!validProposal(amendment) || amendment.proposal.digest !== context.proposalDigest || amendment.proposal.commitmentId !== context.commitmentId) return refuse("The immutable kit amendment does not match this payment.");
  const decision: AuthorizationDecision = { allowed: true, reason: "Fresh exact kit amendment and separate scoped payment authority verified.", resourceIds: [order.providerOrderId, order.captureId].filter((value): value is string => Boolean(value)), currency: "USD", maximumMinor: command.action.money.minor, approvalId: command.approval.id, approvalVersion: command.approval.version, approvalDigest: command.approval.digest, checkoutOrigins: [order.origin] };
  if (context.compensationId) {
    const { authorizeRepairCompensation } = await import("./living-repair-compensation");
    return authorizeRepairCompensation({ ...input, amendment, context, decision });
  }
  if (!["create_order", "capture_order"].includes(command.action.kind)) return refuse("A separate compensation consent is required for any refund.");
  if (amendment.orderId !== order.id || !amendment.acceptedAt || ["cancelled", "refused", "compensation_required", "compensated", "undone", "partial_support_needed"].includes(amendment.status)) return refuse("This amendment has no active accepted payment authority.");
  if (Date.parse(amendment.proposal.expiresAt) <= Date.now()) return refuse("The exact amendment quote expired before dispatch.");
  if (!amendment.dispatchCheck || amendment.dispatchCheck.proposalDigest !== context.proposalDigest || Date.parse(amendment.dispatchCheck.expiresAt) <= Date.now()) return refuse("Refresh exact stock, price and critical facts before this payment action.");
  const commitment = await loadCommitment(order.tenantId, context.commitmentId);
  if (commitment.version !== amendment.proposal.commitmentVersion || commitment.current.certificate.graphHash !== amendment.proposal.before.certificate.graphHash || commitment.lines.some(line => line.fulfillment !== "unfulfilled")) return refuse("The commitment changed or entered fulfillment after this approval.");
  if (commitment.branch === "workspace") {
    const current = await getRevision(order.tenantId);
    if (current.certificate.graphHash !== amendment.proposal.before.certificate.graphHash || current.kit.id !== amendment.proposal.before.kit.id) return refuse("The current workbench changed after this approval.");
  }
  if (amendment.proposal.technicalState !== "satisfied" || amendment.proposal.quote.afterTotalMinor > amendment.proposal.after.kit.goal.budgetMinor) return refuse("Critical technical constraints or the original hard budget are not satisfied.");
  if (command.action.money.currency !== "USD" || command.action.money.minor !== amendment.proposal.quote.deltaMinor || order.quote.quoteHash !== amendment.proposal.digest || order.graphHash !== amendment.proposal.after.certificate.graphHash) return refuse("The requested payment differs from the exact accepted amendment.");
  const claim = (await database().query("SELECT payload FROM wk_kit_repair_claims WHERE id=$1 AND tenant_id=$2 AND amendment_id=$3", [context.claimId, order.tenantId, amendment.proposal.id])).rows[0]?.payload as KitRepairClaim | undefined;
  if (!claim || claim.orderId !== order.id || claim.acceptedDigest !== amendment.proposal.digest || claim.state === "refused" || claim.additionalMinor !== command.action.money.minor || claim.paymentMode !== context.paymentMode) return refuse("A current gross payment claim is required before dispatch.");
  if (context.policyId) {
    const policy = await ownedRepairRow<KitRepairPolicy>("policy", order.tenantId, context.policyId);
    const wallet = policy.walletConsentId ? await loadWallet(order.tenantId, policy.walletConsentId) : null;
    const evaluation = evaluateKitPolicy({ policy, commitment, proposal: amendment.proposal, claims: await repairClaims(order.tenantId, commitment.id), wallet, claimId: claim.id });
    if (!evaluation.allowed || policy.paymentMode !== context.paymentMode) return refuse(evaluation.reason);
    if (command.action.kind === "create_order" && command.action.savedWallet) {
      if (!wallet?.tokenId) return refuse("A current owned saved wallet is required.");
      decision.resourceIds.push(wallet.tokenId);
      decision.savedWalletConsent = { vaultId: wallet.tokenId, consentId: wallet.id, consentVersion: wallet.version, consentDigest: wallet.digest, paymentInitiator: "MERCHANT", usagePattern: "IMMEDIATE", usage: "DERIVED", expiresAt: wallet.expiresAt };
    }
  } else if (order.walletConsentId || command.action.kind === "create_order" && command.action.savedWallet) return refuse("Buyer approval does not authorize a saved-wallet charge.");
  return decision;
}
export async function acceptKitAmendment(session: Session, input: { amendmentId: string; proposalDigest: string; paymentMode: "sample" | "live_sandbox"; authority: "buyer" | "policy"; policyId?: string; origin: string }, supplied?: RepairEngine, catalog?: RepairCatalogRuntime) {
  await initializeLivingRepair();
  const initial = await loadAmendment(session.id, input.amendmentId);
  if (initial.proposal.digest !== input.proposalDigest) throw new WorldKitError("stale_revision", "The exact proposal changed. Review its current quote and digest.", 409);
  if (initial.acceptedAt) return initial;
  if (!["proposed", "awaiting_consent", "requires_payment_approval"].includes(initial.status)) throw new WorldKitError("invalid_request", "This proposal is closed. Review a current, unaccepted proposal.", 409);
  if (input.paymentMode === "sample" && initial.proposal.sourceMode !== "sample") throw new WorldKitError("forbidden", "A real market proposal cannot use the Sample simulator.", 403);
  if (input.paymentMode === "live_sandbox" && !supplied && !paypalRepairReady()) throw new WorldKitError("provider_unavailable", "PayPal sandbox is not configured in this environment. No payment authority was consumed.", 503);
  await checkAmendmentNow(session.id, input.amendmentId, "repair", catalog);
  const prepared = await repairTransaction(async db => {
    const commitment = await loadCommitment(session.id, initial.proposal.commitmentId, db, true);
    const amendment = await loadAmendment(session.id, input.amendmentId, db, true);
    if (amendment.acceptedAt) return { amendment, command: null };
    if (!["proposed", "awaiting_consent", "requires_payment_approval"].includes(amendment.status)) throw new WorldKitError("invalid_request", "This proposal was closed while the checks ran.", 409);
    if (amendment.proposal.digest !== input.proposalDigest || !validProposal(amendment) || commitment.version !== amendment.proposal.commitmentVersion || commitment.lines.some(line => line.fulfillment !== "unfulfilled")) throw new WorldKitError("stale_revision", "The controlled commitment changed while you reviewed this proposal.", 409);
    let wallet: WalletConsent | null = null; let policy: KitRepairPolicy | null = null;
    if (input.authority === "policy") {
      if (!input.policyId) throw new WorldKitError("invalid_request", "Select the exact current kit-change allowance.", 400);
      policy = await ownedRepairRow<KitRepairPolicy>("policy", session.id, input.policyId, db, true);
      wallet = policy.walletConsentId ? await loadWallet(session.id, policy.walletConsentId, db) : null;
      const evaluation = evaluateKitPolicy({ policy, commitment, proposal: amendment.proposal, claims: await repairClaims(session.id, commitment.id, db), wallet });
      if (!evaluation.allowed || policy.paymentMode !== input.paymentMode) {
        amendment.status = evaluation.next === "authorized" ? "awaiting_consent" : evaluation.next; amendment.reason = policy.paymentMode !== input.paymentMode ? "The allowance and chosen payment instrument use different evidence modes." : evaluation.reason;
        await saveAmendment(db, session.id, amendment); return { amendment, command: null };
      }
    }
    const additionalMinor = Math.max(0, amendment.proposal.quote.deltaMinor);
    const claim: KitRepairClaim = { id: randomUUID(), tenantId: session.id, amendmentId: amendment.proposal.id, commitmentId: commitment.id, policyId: policy?.id ?? null, orderId: null, additionalMinor, paymentMode: input.paymentMode, acceptedDigest: amendment.proposal.digest, createdAt: repairNow(), state: additionalMinor ? "reserved" : "paid" };
    amendment.claimId = claim.id; amendment.policyId = policy?.id ?? null; amendment.paymentMode = input.paymentMode; amendment.acceptedAt = repairNow();
    let command: PaymentCommand | null = null;
    if (additionalMinor) {
      const quote: Quote = { id: randomUUID(), tenantId: session.id, revisionId: amendment.proposal.after.kit.id, verificationId: amendment.proposal.after.certificate.id, graphHash: amendment.proposal.after.certificate.graphHash, quoteHash: amendment.proposal.digest, merchantId: "worldkit-studio", merchantName: "WorldKit Studio", items: [{ sku: `kit-amendment:${amendment.proposal.id}`, name: "Controlled kit demonstration amendment", quantity: 1, unitMinor: additionalMinor, profileId: null }], total: { currency: "USD", minor: additionalMinor }, createdAt: repairNow(), expiresAt: amendment.proposal.expiresAt, policyVersion: "controlled-kit-sandbox.v1", source: "sample", checkoutRequired: true };
      const order = newOrder(session.id, quote, commitment.kitId, input.origin, wallet?.id ?? null);
      order.kind = "amendment"; order.sourceMode = input.paymentMode;
      order.approval = { id: `kit-change:${claim.id}`, version: 1, digest: hash({ proposal: amendment.proposal.digest, claim: claim.id, authority: input.authority, policy: policy?.digest ?? null, paymentMode: input.paymentMode, tenantId: session.id, origin: input.origin }), expiresAt: amendment.proposal.expiresAt };
      order.livingRepair = { amendmentId: amendment.proposal.id, commitmentId: commitment.id, proposalDigest: amendment.proposal.digest, claimId: claim.id, policyId: policy?.id ?? null, compensationId: null, paymentMode: input.paymentMode };
      command = commandFor(order, "purchase", purchaseAction(order, wallet)); order.operationIds.push(command.operationId);
      await db.query("INSERT INTO wk_commerce_orders(id,tenant_id,quote_id,payload) VALUES($1,$2,$3,$4)", [order.id, session.id, quote.id, order]);
      await insertAuthority(db, order, "purchase", command);
      amendment.orderId = order.id; claim.orderId = order.id; amendment.status = "payment_pending"; amendment.reason = "Your exact approval and gross claim are saved. The original graph stays in place until payment and merchant commitment both succeed.";
    } else { amendment.status = "ready_to_commit"; amendment.reason = "The controlled quote needs no additional payment. A lower Sample baseline is not a cash refund."; }
    await db.query("INSERT INTO wk_kit_repair_claims(id,tenant_id,amendment_id,commitment_id,policy_id,order_id,state,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [claim.id, session.id, claim.amendmentId, claim.commitmentId, claim.policyId, claim.orderId, claim.state, claim]);
    await saveAmendment(db, session.id, amendment); return { amendment, command };
  });
  if (prepared.command && prepared.amendment.orderId) {
    const engine = await getRepairEngine(session.id, input.paymentMode, supplied);
    const operation = await engine.core.execute(prepared.command); let order = await syncOperation(session, prepared.amendment.orderId, operation);
    if ((input.paymentMode === "sample" || input.authority === "policy") && operation.status === "succeeded" && !order.capturedMinor && order.providerOrderId) order = await captureCheckout(session, order.id, Promise.resolve(engine));
    await syncRepairFinancialState(session.id, prepared.amendment.proposal.id, order);
  }
  return finishAcceptedAmendment(session, prepared.amendment.proposal.id, catalog);
}
export async function syncRepairFinancialState(tenantId: string, amendmentId: string, suppliedOrder?: CommerceOrder) {
  const initial = await loadAmendment(tenantId, amendmentId); if (!initial.orderId) return initial;
  if (suppliedOrder && (suppliedOrder.id !== initial.orderId || suppliedOrder.tenantId !== tenantId)) throw new WorldKitError("forbidden", "This payment belongs to another amendment.", 403);
  return repairTransaction(async db => {
    const amendment = await loadAmendment(tenantId, amendmentId, db, true);
    // A caller may hold an older receipt while a refund or webhook is reconciled.
    // Project only the currently persisted, tenant-owned order under its lock.
    await db.query("SELECT id FROM wk_commerce_orders WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [amendment.orderId, tenantId]);
    const order = await loadOrder(tenantId, amendment.orderId!, db);
    const claim = (await db.query("SELECT payload FROM wk_kit_repair_claims WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [amendment.claimId, tenantId])).rows[0]?.payload as KitRepairClaim | undefined;
    if (claim) { claim.state = order.refundedMinor >= order.capturedMinor && order.capturedMinor > 0 ? "refunded" : order.capturedMinor > 0 ? "paid" : order.state === "refused" ? "refused" : "payment_pending"; await saveRepairClaim(db, claim); }
    if (["payment_pending", "requires_payment_approval", "ready_to_commit"].includes(amendment.status)) {
      if (order.capturedMinor === amendment.proposal.quote.deltaMinor && order.refundedMinor === 0 && !paymentNeedsReview(order) && !(await unresolvedPaymentEvents([order], db)).has(order.id)) { amendment.status = "ready_to_commit"; amendment.reason = "The exact payment is confirmed. Rechecking stock and the merchant commitment before applying the graph."; }
      else if (order.state === "refused") { amendment.status = "refused"; amendment.reason = "The provider positively refused this operation. No kit change was committed. The retained operation remains available for review."; }
      else { amendment.status = order.approvalUrl ? "requires_payment_approval" : "payment_pending"; amendment.reason = order.approvalUrl ? "Approve this exact sandbox amendment in PayPal. The original kit stays in place until capture and commitment finish." : "The original payment operation is being reconciled. Its gross claim remains reserved; no duplicate payment is allowed."; }
    }
    await saveAmendment(db, tenantId, amendment); return amendment;
  });
}
export async function finishAcceptedAmendment(session: Session, id: string, catalog?: RepairCatalogRuntime): Promise<KitAmendment> {
  let amendment = await loadAmendment(session.id, id);
  if (amendment.status !== "ready_to_commit") return amendment;
  try {
    await checkAmendmentNow(session.id, id, "commit", catalog);
    return await repairTransaction(async db => {
      const commitment = await loadCommitment(session.id, amendment.proposal.commitmentId, db, true);
      amendment = await loadAmendment(session.id, id, db, true);
      if (amendment.status !== "ready_to_commit") return amendment;
      if (commitment.version !== amendment.proposal.commitmentVersion || commitment.lines.some(line => line.fulfillment !== "unfulfilled") || !amendment.dispatchCheck || Date.parse(amendment.dispatchCheck.expiresAt) <= Date.now()) throw new WorldKitError("stale_revision", "The merchant commitment changed before it could be applied.", 409);
      if (amendment.orderId) {
        const order = await loadOrder(session.id, amendment.orderId, db);
        if (order.capturedMinor !== amendment.proposal.quote.deltaMinor || order.refundedMinor || paymentNeedsReview(order) || (await unresolvedPaymentEvents([order], db)).has(order.id)) throw new WorldKitError("needs_evidence", "The authoritative payment state does not permit this commitment.", 409);
      }
      if (commitment.branch === "workspace") {
        const current = (await db.query("SELECT current_revision_id FROM wk_kits WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [commitment.kitId, session.id])).rows[0];
        if (!current || current.current_revision_id !== amendment.proposal.before.kit.id) throw new WorldKitError("stale_revision", "A newer workbench revision prevents this exact amendment from being applied.", 409);
        await saveRevision(db, session.id, amendment.proposal.after);
        await db.query("UPDATE wk_kits SET current_revision_id=$3 WHERE id=$1 AND tenant_id=$2", [commitment.kitId, session.id, amendment.proposal.after.kit.id]);
      }
      commitment.current = amendment.proposal.after; commitment.lines = amendment.proposal.quote.afterLines; commitment.currentTotalMinor = amendment.proposal.quote.afterTotalMinor;
      commitment.version++; commitment.updatedAt = repairNow(); commitment.latestAmendmentId = amendment.proposal.id;
      await saveCommitmentVersion(db, commitment, "amendment", id);
      amendment.status = "committed"; amendment.committedAt = repairNow(); amendment.committedVersion = commitment.version; amendment.undoUntil = new Date(Date.now() + 24 * 3600_000).toISOString();
      amendment.reason = "The controlled merchant commitment and its saved graph changed together. The original quote, graph, certificate and gross payment history remain immutable. No retailer order or shipment was made.";
      await saveAmendment(db, session.id, amendment);
      await appendEvent(db, session.id, "kit.amendment_committed", "A controlled kit change is complete", amendment.reason, commitment.branch === "workspace" ? commitment.current.kit.id : null, amendment.proposal.sourceMode);
      await repairNotice(db, session.id, `committed:${id}`, { kind: "kit-commitment", title: "Your controlled kit is updated", detail: amendment.reason, sourceMode: amendment.proposal.sourceMode, runId: amendment.proposal.runId, amendmentId: id });
      return amendment;
    });
  } catch (error) {
    return repairTransaction(async db => {
      const latest = await loadAmendment(session.id, id, db, true); if (latest.status !== "ready_to_commit") return latest;
      const order = latest.orderId ? await loadOrder(session.id, latest.orderId, db) : null;
      latest.status = order?.capturedMinor ? "compensation_required" : "stale";
      latest.reason = error instanceof WorldKitError ? error.message : "The merchant commitment could not be saved. The original graph and any completed payment remain recorded separately.";
      await saveAmendment(db, session.id, latest);
      await repairNotice(db, session.id, `commit-failed:${id}`, { kind: "kit-compensation", title: order?.capturedMinor ? "A paid change needs compensation" : "This change needs a fresh proposal", detail: latest.reason, sourceMode: latest.proposal.sourceMode, amendmentId: id }); return latest;
    });
  }
}
export async function refreshKitAmendment(session: Session, id: string, options: { capture?: boolean; engine?: RepairEngine; catalog?: RepairCatalogRuntime } = {}) {
  const amendment = await loadAmendment(session.id, id);
  if (amendment.orderId && amendment.paymentMode) {
    const engine = await getRepairEngine(session.id, amendment.paymentMode, options.engine);
    let order = await refreshOrder(session, amendment.orderId, Promise.resolve(engine));
    if (options.capture && !order.capturedMinor) { await checkAmendmentNow(session.id, id, "repair", options.catalog); order = await captureCheckout(session, order.id, Promise.resolve(engine)); }
    await syncRepairFinancialState(session.id, id, order);
  }
  return finishAcceptedAmendment(session, id, options.catalog);
}
export async function resumeKitAmendment(session: Session, id: string, expectedDigest: string, options: { engine?: RepairEngine; catalog?: RepairCatalogRuntime } = {}) {
  const amendment = await loadAmendment(session.id, id);
  if (amendment.proposal.digest !== expectedDigest || !amendment.acceptedAt) throw new WorldKitError("stale_revision", "Only the exact saved approval can be continued.", 409);
  if (!amendment.orderId || !amendment.paymentMode || !["payment_pending", "requires_payment_approval", "ready_to_commit"].includes(amendment.status)) return refreshKitAmendment(session, id, options);
  const engine = await getRepairEngine(session.id, amendment.paymentMode, options.engine);
  let order = await refreshOrder(session, amendment.orderId, Promise.resolve(engine));
  const operationId = `purchase:${order.id}`;
  if (!await engine.store.get(scope(session.id), operationId)) {
    // Recover the gap between domain consent and the core's first claim. Reuse
    // the encrypted command, request id and authority; never invent a retry.
    await checkAmendmentNow(session.id, id, "repair", options.catalog);
    const authority = await authorityByOperation(session.id, operationId);
    if (!authority || authority.orderId !== order.id) throw new WorldKitError("needs_evidence", "The original payment command is unavailable. Preserve this record for support review.", 409);
    order = await syncOperation(session, order.id, await engine.core.execute(authority.command));
  }
  const purchase = await engine.store.get(scope(session.id), operationId);
  const capture = await engine.store.get(scope(session.id), `capture:${order.id}`);
  if (!order.capturedMinor && order.providerOrderId && purchase?.status === "succeeded" && !capture && (amendment.paymentMode === "sample" || amendment.policyId)) {
    await checkAmendmentNow(session.id, id, "repair", options.catalog);
    order = await captureCheckout(session, order.id, Promise.resolve(engine));
  }
  await syncRepairFinancialState(session.id, id, order);
  return finishAcceptedAmendment(session, id, options.catalog);
}
export async function cancelKitAmendment(session: Session, id: string) {
  const initial = await loadAmendment(session.id, id);
  return repairTransaction(async db => {
    await loadCommitment(session.id, initial.proposal.commitmentId, db, true); const amendment = await loadAmendment(session.id, id, db, true);
    if (amendment.acceptedAt) throw new WorldKitError("invalid_request", "An accepted amendment has a retained financial claim. Reconcile it or request compensation; cancellation cannot release uncertain money.", 409);
    amendment.status = "cancelled"; amendment.reason = "This unaccepted proposal was cancelled. Its evidence and original kit remain saved."; await saveAmendment(db, session.id, amendment); return amendment;
  });
}
export async function authoritativeRefundBudget(order: CommerceOrder, provider: ProviderAdapter) {
  if (!order.captureId || !order.providerOrderId || !order.capturedMinor || provider.source !== order.sourceMode) throw new WorldKitError("needs_evidence", "A completed owned capture is required before compensation.", 409);
  const [captureResources, orderState, known] = await Promise.all([provider.read("capture", order.captureId), provider.read("order", order.providerOrderId), orderResources(database(), order)]);
  const captureMatches = captureResources.filter(resource => resource.kind === "capture");
  const capture = captureMatches.length === 1 && captureMatches[0]!.id === order.captureId ? captureMatches[0] : undefined;
  const ownedOrder = orderState.filter(resource => resource.kind === "order");
  const orderCaptures = orderState.filter(resource => resource.kind === "capture");
  if (!capture || capture.source !== order.sourceMode || capture.money?.currency !== "USD" || capture.money.minor !== order.capturedMinor || !["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(capture.status) || ownedOrder.length !== 1 || ownedOrder[0]!.id !== order.providerOrderId || ownedOrder[0]!.source !== order.sourceMode || ownedOrder[0]!.customId && ownedOrder[0]!.customId !== order.id) throw new WorldKitError("needs_evidence", "Fresh provider reads did not establish the exact owned capture and order.", 409);
  if (orderCaptures.length !== 1 || orderCaptures[0]!.id !== order.captureId || orderCaptures[0]!.money?.currency !== "USD" || orderCaptures[0]!.money?.minor !== order.capturedMinor || orderCaptures[0]!.source !== order.sourceMode) throw new WorldKitError("needs_evidence", "The order read did not establish one exact owned capture for refund attribution.", 409);
  if (capture.parentId && capture.parentId !== order.providerOrderId || orderCaptures[0]!.parentId && orderCaptures[0]!.parentId !== order.providerOrderId) throw new WorldKitError("needs_evidence", "The capture’s reported parent conflicts with this owned order.", 409);
  const refundIds = [...new Set([...known, ...orderState].filter(resource => resource.kind === "refund").map(resource => resource.id))];
  const refunds: ProviderResource[] = [];
  for (const id of refundIds) {
    const found = (await provider.read("refund", id)).filter(resource => resource.kind === "refund" && resource.id === id);
    const hint = [...known, ...orderState].find(resource => resource.kind === "refund" && resource.id === id);
    const refund = found[0];
    if (found.length !== 1 || !refund || refund.source !== order.sourceMode || !refund.money || refund.money.currency !== "USD" || !Number.isSafeInteger(refund.money.minor) || refund.money.minor <= 0 || refund.parentId && ![order.captureId, order.providerOrderId].includes(refund.parentId) || !hint || hint.parentId && ![order.captureId, order.providerOrderId].includes(hint.parentId)) throw new WorldKitError("needs_evidence", "An individual refund identity or amount could not be confirmed.", 409);
    if (!["COMPLETED", "FAILED", "CANCELLED"].includes(refund.status)) throw new WorldKitError("needs_evidence", "An existing refund is still pending or unknown. Keep its full reservation until reconciliation finishes.", 409);
    refunds.push(refund);
  }
  const completed = refunds.filter(refund => refund.status === "COMPLETED"); const refundedMinor = completed.reduce((sum, refund) => sum + refund.money!.minor, 0);
  if (refundedMinor > order.capturedMinor || refundedMinor < order.refundedMinor || capture.status === "PARTIALLY_REFUNDED" && !(refundedMinor > 0 && refundedMinor < order.capturedMinor) || capture.status === "REFUNDED" && refundedMinor !== order.capturedMinor || capture.status === "COMPLETED" && refundedMinor > 0) throw new WorldKitError("needs_evidence", "The capture status and individually confirmed refund total do not establish a remaining balance.", 409);
  for (const resource of [capture, ownedOrder[0]!, ...refunds]) {
    const age = Date.now() - Date.parse(resource.observedAt); if (!Number.isFinite(age) || age > 120_000 || age < -5_000) throw new WorldKitError("needs_evidence", "The remaining capture balance was not observed recently.", 409);
  }
  return { capture, refunds, remainingMinor: order.capturedMinor - refundedMinor, reservation: { resourceKey: `capture:${order.captureId}`, currency: "USD", totalMinor: order.capturedMinor, externallyConsumedMinor: refundedMinor, observedProviderIds: completed.map(refund => refund.id), observedAt: capture.observedAt } };
}
export async function retainRefundBudget(order: CommerceOrder, budget: Awaited<ReturnType<typeof authoritativeRefundBudget>>) {
  return repairTransaction(async db => {
    await db.query("SELECT id FROM wk_commerce_orders WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [order.id, order.tenantId]);
    const current = await loadOrder(order.tenantId, order.id, db);
    for (const resource of [budget.capture, ...budget.refunds]) await storeOwnedPaymentResource(db, current, resource);
    const projected = projectPaymentResources(current, await orderResources(db, current)); await saveOrder(db, projected); return projected;
  });
}
