import { randomUUID } from "node:crypto";
import { PaymentCore, SqlPaymentStore, PaymentError, canonicalJson, payloadHash, sha256, type AuthorizationDecision, type PaymentAction, type PaymentCommand, type PaymentOperation, type ProviderAdapter, type ProviderResource } from "@fracture/paypal-core";
import type { PoolClient } from "pg";
import { WorldKitError, type Quote } from "../../packages/contracts/index";
import { PROJECT_ID, REPAIR_CAP_MINOR, repairScenarios, walletView, type CommerceOrder, type CommerceView, type FinancialAuthority, type RepairClaim, type RepairPolicy, type WalletConsent } from "../../packages/commerce/contracts";
import { evaluateRepair, safeApprovalUrl } from "../../packages/commerce/policy";
import { database } from "./db";
import { commerceTransaction, initializeCommerce, paymentDatabase } from "./commerce-db";
import { getRevision, type Session, type RevisionBundle } from "./repository";
import { paymentProvider } from "./payment-provider";
import { adoptCheckoutWallet, createWalletConsent, loadWallet } from "./wallets";
import { seal, unseal } from "./secrets";

type Db = Pick<PoolClient, "query">;
const now = () => new Date().toISOString();
const scope = (tenantId: string) => ({ tenantId, projectId: PROJECT_ID });
export async function loadOrder(tenantId: string, id: string, db: Db = database()): Promise<CommerceOrder> {
  await initializeCommerce(); const row = (await db.query("SELECT payload FROM wk_commerce_orders WHERE id=$1 AND tenant_id=$2", [id, tenantId])).rows[0];
  if (!row) throw new WorldKitError("not_found", "That order does not belong to this workspace.", 404); return row.payload;
}
async function saveOrder(db: Db, order: CommerceOrder) { await db.query("UPDATE wk_commerce_orders SET payload=$1 WHERE id=$2 AND tenant_id=$3", [{ ...order, updatedAt: now() }, order.id, order.tenantId]); }
async function event(db: Db, tenantId: string, type: string, title: string, detail: string, revisionId: string | null, sourceMode: "live" | "sample" = "live") {
  const payload = { id: randomUUID(), type, at: now(), title, detail, revisionId, sourceMode }; await db.query("INSERT INTO wk_events(id,tenant_id,payload) VALUES($1,$2,$3)", [payload.id, tenantId, payload]);
}
async function authorityByOperation(tenantId: string, operationId: string, db: Db = database()): Promise<FinancialAuthority | null> {
  const row = (await db.query("SELECT payload FROM wk_financial_authorities WHERE tenant_id=$1 AND operation_id=$2", [tenantId, operationId])).rows[0];
  return row ? unseal(tenantId, row.payload) : null;
}
function commandFor(order: CommerceOrder, kind: FinancialAuthority["kind"], action: PaymentAction, approval = order.approval): PaymentCommand {
  const id = `${kind}:${order.id}`;
  return { scope: scope(order.tenantId), operationId: id, businessKey: id, intentId: id, providerRequestId: randomUUID(), payloadHash: payloadHash(action), action, approval };
}
async function insertAuthority(db: Db, order: CommerceOrder, kind: FinancialAuthority["kind"], command: PaymentCommand, policyId: string | null = null) {
  const authority: FinancialAuthority = { id: command.intentId, tenantId: order.tenantId, orderId: order.id, kind, command, createdAt: now(), revokedAt: null, repairPolicyId: policyId, repairClaimId: order.repairClaimId };
  await db.query("INSERT INTO wk_financial_authorities(id,tenant_id,order_id,operation_id,payload) VALUES($1,$2,$3,$4,$5)", [authority.id, order.tenantId, order.id, command.operationId, seal(order.tenantId, authority)]); return authority;
}
function newOrder(tenantId: string, quote: Quote, kitId: string, origin: string, walletConsentId: string | null): CommerceOrder {
  const id = randomUUID(); const createdAt = now();
  const approval = { id: `checkout:${id}`, version: 1, digest: sha256(canonicalJson({ id, quoteHash: quote.quoteHash, tenantId, graphHash: quote.graphHash, walletConsentId, origin })), expiresAt: new Date(Date.now() + 30 * 60000).toISOString() };
  return { id, tenantId, kitId, revisionId: quote.revisionId, graphHash: quote.graphHash, quote, createdAt, updatedAt: createdAt, origin, state: "creating", kind: "initial", parentOrderId: null, repairClaimId: null, approval, walletConsentId, providerOrderId: null, captureId: null, approvalUrl: null, capturedMinor: 0, refundedMinor: 0, fulfilledAt: null, operationIds: [], error: null, sourceMode: "live_sandbox" };
}
function purchaseAction(order: CommerceOrder, wallet?: WalletConsent | null): Extract<PaymentAction, { kind: "create_order" }> {
  return { kind: "create_order", money: order.quote.total, intent: "CAPTURE", customId: order.id,
    experience: { returnUrl: `${order.origin}/paypal/return?order=${order.id}`, cancelUrl: `${order.origin}/paypal/return?order=${order.id}&cancelled=1`, userAction: "PAY_NOW", shippingPreference: "NO_SHIPPING", brandName: "WorldKit Studio", locale: "en-US" },
    items: order.quote.items.map(item => ({ name: item.name, quantity: item.quantity, sku: item.sku, unitAmount: { currency: "USD", minor: item.unitMinor } })),
    ...(wallet && order.kind === "initial" ? { saveWalletOnSuccess: { consentId: wallet.id, consentVersion: wallet.version, consentDigest: wallet.digest, usageType: "MERCHANT" as const } } : {}),
    ...(wallet?.tokenId && order.kind === "amendment" ? { savedWallet: { vaultId: wallet.tokenId, consentId: wallet.id, consentVersion: wallet.version, consentDigest: wallet.digest, paymentInitiator: "MERCHANT" as const, usagePattern: "IMMEDIATE" as const, usage: "DERIVED" as const } } : {}),
  };
}
export function createCommerceEngine(provider: ProviderAdapter, store: SqlPaymentStore) {
  const core = new PaymentCore({ store, provider, policy: { authorize: command => authorizePayment(command, provider) } });
  return { core, store, provider };
}
type Engine = ReturnType<typeof createCommerceEngine>;
const state = globalThis as unknown as { worldkitCommerceEngine?: Promise<Engine> };
export function paymentEngine(): Promise<Engine> {
  return state.worldkitCommerceEngine ??= initializeCommerce().then(async () => { const store = new SqlPaymentStore(paymentDatabase); await store.initialize(); return createCommerceEngine(paymentProvider(), store); }).catch(error => { state.worldkitCommerceEngine = undefined; throw error; });
}

export async function authorizePayment(command: PaymentCommand, provider: ProviderAdapter): Promise<AuthorizationDecision> {
  await initializeCommerce();
  const rejected: AuthorizationDecision = { allowed: false, reason: "The current order does not authorize this payment.", resourceIds: [], currency: "USD", maximumMinor: 0, approvalId: "", approvalVersion: 0, approvalDigest: "" };
  const refuse = (reason: string) => ({ ...rejected, reason });
  if (command.scope.projectId !== PROJECT_ID) return refuse("This payment belongs to another project.");
  const authority = await authorityByOperation(command.scope.tenantId, command.operationId);
  if (!authority || authority.revokedAt || canonicalJson(authority.command) !== canonicalJson(command)) return refuse("The exact accepted payment details have changed or are no longer authorized.");
  const session = (await database().query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>now()", [command.scope.tenantId])).rows[0];
  if (!session) return refuse("This private workspace has expired.");
  const order = await loadOrder(command.scope.tenantId, authority.orderId); const action = command.action;
  if (order.state === "cancelled") return refuse("This order was cancelled.");
  if (action.kind !== "refund_capture") {
    const current = await getRevision(order.tenantId);
    if (current.certificate.graphHash !== order.graphHash) return refuse("The kit changed after this quote. Review a fresh quote before paying.");
    if (action.kind === "create_order" && Date.parse(order.quote.expiresAt) <= Date.now()) return refuse("This quote expired. Review a fresh quote before paying.");
    if (action.money.minor !== order.quote.total.minor || action.money.currency !== order.quote.total.currency) return refuse("The order total differs from the accepted quote.");
  }
  const decision: AuthorizationDecision = { allowed: true, reason: "Exact current domain approval and resource ownership verified.", resourceIds: [order.providerOrderId, order.captureId].filter((id): id is string => Boolean(id)), currency: "USD", maximumMinor: action.money.minor, approvalId: command.approval.id, approvalVersion: command.approval.version, approvalDigest: command.approval.digest, checkoutOrigins: [order.origin] };
  if (order.walletConsentId && action.kind !== "refund_capture") {
    const wallet = await loadWallet(order.tenantId, order.walletConsentId);
    if (wallet.revokedAt || Date.parse(wallet.expiresAt) <= Date.now()) return refuse("Wallet consent expired or was revoked. Review a fresh checkout without saving.");
    if (action.kind === "create_order" && action.saveWalletOnSuccess) decision.saveWalletConsent = { consentId: wallet.id, consentVersion: wallet.version, consentDigest: wallet.digest, usageType: "MERCHANT", expiresAt: wallet.expiresAt };
    if (order.kind === "amendment") {
      if (wallet.state !== "active" || !wallet.tokenId || !wallet.verifiedAt) return refuse("PayPal has not confirmed a usable saved wallet. Review this change in PayPal instead.");
      if (!authority.repairPolicyId || !authority.repairClaimId) return refuse("A current repair claim is required.");
      const policy = (await database().query("SELECT payload FROM wk_repair_policies WHERE id=$1 AND tenant_id=$2", [authority.repairPolicyId, order.tenantId])).rows[0]?.payload as RepairPolicy | undefined;
      const claim = (await database().query("SELECT payload FROM wk_repair_claims WHERE id=$1 AND tenant_id=$2", [authority.repairClaimId, order.tenantId])).rows[0]?.payload as RepairClaim | undefined;
      if (!policy || !claim || claim.orderId !== order.id || ["escalated", "refused"].includes(claim.state)) return refuse("This amendment has no reserved current authority.");
      const others = (await database().query("SELECT payload FROM wk_repair_claims WHERE policy_id=$1 AND id<>$2", [policy.id, claim.id])).rows.map(r => r.payload as RepairClaim);
      const consumedMinor = others.filter(c => !["refused", "escalated"].includes(c.state)).reduce((sum, c) => sum + c.additionalMinor, 0);
      const base = await loadOrder(order.tenantId, policy.baseOrderId);
      if (base.state !== "paid" || base.refundedMinor > 0) return refuse("The original Studio order is no longer an active paid purchase. Its repair authority has ended.");
      const [original, proposed] = await Promise.all([getRevision(order.tenantId, policy.baseRevisionId), getRevision(order.tenantId, order.revisionId)]);
      const evaluation = evaluateRepair({ policy, wallet, original: original.kit, proposed: proposed.kit, merchant: "worldkit-studio", category: "setup-service", additionalMinor: claim.additionalMinor, consumedMinor, fulfilled: Boolean(base.fulfilledAt) });
      if (!evaluation.allowed) return refuse(evaluation.reason);
      if (action.kind === "create_order" && action.savedWallet) {
        decision.resourceIds.push(wallet.tokenId);
        decision.savedWalletConsent = { vaultId: wallet.tokenId, consentId: wallet.id, consentVersion: wallet.version, consentDigest: wallet.digest, paymentInitiator: "MERCHANT", usagePattern: "IMMEDIATE", usage: "DERIVED", expiresAt: wallet.expiresAt };
      }
    }
  }
  if (action.kind === "refund_capture") {
    if (order.fulfilledAt || Date.now() - Date.parse(order.createdAt) > 24 * 3600000) return refuse("This refund requires support review after fulfillment or the 24-hour cancellation window.");
    if (!order.captureId || action.captureId !== order.captureId || !order.providerOrderId || action.orderId !== order.providerOrderId || action.money.minor !== order.capturedMinor || order.refundedMinor > 0) return refuse("This refund does not match the completed, unrefunded capture.");
    // This release offers a full compensation only. PARTIALLY_REFUNDED is not a
    // remaining-balance proof and must be handled by a scoped support review.
    const [capture] = await provider.read("capture", order.captureId);
    if (!capture?.money || capture.id !== order.captureId || capture.status !== "COMPLETED" || capture.money.currency !== "USD" || capture.money.minor !== order.capturedMinor) return refuse("PayPal’s capture state needs review before a full refund can be made.");
    decision.reservation = { resourceKey: `capture:${order.captureId}`, currency: "USD", totalMinor: capture.money.minor, externallyConsumedMinor: 0, observedProviderIds: [], observedAt: capture.observedAt };
  }
  return decision;
}

export async function acceptCheckout(session: Session, quoteId: string, expectedQuoteHash: string, saveWallet: boolean, origin: string, engine = paymentEngine()) {
  await initializeCommerce();
  const quoted = (await database().query("SELECT payload FROM wk_quotes WHERE id=$1 AND tenant_id=$2", [quoteId, session.id])).rows[0]?.payload as Quote | undefined;
  if (!quoted || quoted.quoteHash !== expectedQuoteHash) throw new WorldKitError("invalid_request", "This quote does not match the reviewed order.", 409);
  const prior = (await database().query("SELECT payload FROM wk_commerce_orders WHERE quote_id=$1 AND tenant_id=$2", [quoteId, session.id])).rows[0]?.payload as CommerceOrder | undefined;
  if (prior) return prior;
  if (Date.parse(quoted.expiresAt) <= Date.now()) throw new WorldKitError("stale_revision", "This quote expired. Refresh the quote before paying.", 409);
  const current = await getRevision(session.id);
  if (current.kit.id !== quoted.revisionId || current.certificate.id !== quoted.verificationId || current.certificate.graphHash !== quoted.graphHash) throw new WorldKitError("stale_revision", "The saved kit changed. Review a new quote before paying.", 409);
  const wallet = saveWallet ? await createWalletConsent(session, origin, "during_purchase") : null;
  const prepared = await commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [session.id]);
    const existing = (await db.query("SELECT payload FROM wk_commerce_orders WHERE quote_id=$1 AND tenant_id=$2", [quoteId, session.id])).rows[0]?.payload as CommerceOrder | undefined;
    if (existing) return { order: existing, authority: null };
    const order = newOrder(session.id, quoted, current.kit.kitId, origin, wallet?.id ?? null);
    const command = commandFor(order, "purchase", purchaseAction(order, wallet)); order.operationIds.push(command.operationId);
    await db.query("INSERT INTO wk_commerce_orders(id,tenant_id,quote_id,payload) VALUES($1,$2,$3,$4)", [order.id, session.id, quoted.id, order]);
    const authority = await insertAuthority(db, order, "purchase", command);
    await event(db, session.id, "checkout.accepted", "Studio quote accepted", `$${(quoted.total.minor / 100).toFixed(2)} USD for the digital routing dossier and setup guide. Exact kit ${quoted.graphHash.slice(0, 12)}. Physical equipment and retailer fulfillment are separate.`, quoted.revisionId);
    return { order, authority };
  });
  if (!prepared.authority) return prepared.order;
  const runtime = await engine;
  const operation = await runtime.core.execute(prepared.authority.command);
  return syncOperation(session, prepared.order.id, operation);
}

export async function syncOperation(session: Session, orderId: string, operation: PaymentOperation): Promise<CommerceOrder> {
  const order = await commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_commerce_orders WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [orderId, session.id]);
    const order = await loadOrder(session.id, orderId, db);
    if (!order.operationIds.includes(operation.command.operationId) || operation.command.scope.tenantId !== session.id) throw new WorldKitError("forbidden", "The payment observation is outside this order.", 403);
    for (const resource of operation.receipt?.resources ?? []) {
      const existing = (await db.query("SELECT tenant_id,order_id FROM wk_payment_resources WHERE provider_id=$1", [resource.id])).rows[0];
      if (existing && (existing.tenant_id !== session.id || existing.order_id !== orderId)) throw new WorldKitError("forbidden", "This payment resource already belongs to another order.", 403);
      await db.query("INSERT INTO wk_payment_resources(provider_id,tenant_id,order_id,kind,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()", [resource.id, session.id, orderId, resource.kind, resource]);
      if (resource.kind === "order") { order.providerOrderId = resource.id; order.approvalUrl = safeApprovalUrl(resource.links.find(l => ["approve", "payer-action"].includes(l.rel))?.href); }
      if (resource.kind === "capture" && resource.status === "COMPLETED" && resource.money?.minor === order.quote.total.minor && resource.money.currency === "USD") { order.captureId = resource.id; order.capturedMinor = resource.money.minor; order.approvalUrl = null; }
    }
    const refunds = (await db.query("SELECT payload FROM wk_payment_resources WHERE tenant_id=$1 AND order_id=$2 AND kind='refund'", [session.id, orderId])).rows.map(r => r.payload as ProviderResource);
    order.refundedMinor = refunds.filter(r => r.status === "COMPLETED" && r.money?.currency === "USD").reduce((sum, r) => sum + r.money!.minor, 0);
    order.error = operation.error?.message ?? null;
    order.state = order.refundedMinor >= order.capturedMinor && order.capturedMinor > 0 ? "refunded" : order.refundedMinor > 0 ? "partially_refunded" : order.capturedMinor > 0 ? "paid" : ["refused", "not_sent"].includes(operation.status) ? "refused" : order.approvalUrl ? "awaiting_approval" : "payment_pending";
    if (operation.command.action.kind === "refund_capture" && ["claimed", "dispatching", "pending_reconciliation"].includes(operation.status)) order.state = "payment_pending";
    await saveOrder(db, order);
    if (order.repairClaimId) {
      const row = (await db.query("SELECT payload FROM wk_repair_claims WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [order.repairClaimId, session.id])).rows[0];
      if (row) { const claim = row.payload as RepairClaim; claim.state = order.state === "refunded" ? "refunded" : order.capturedMinor > 0 ? "paid" : order.state === "refused" ? "refused" : "payment_pending"; if (claim.state === "refunded") claim.reversedAt = now(); await db.query("UPDATE wk_repair_claims SET payload=$1 WHERE id=$2", [claim, claim.id]); }
    }
    await event(db, session.id, `payment.${operation.status}`, order.state === "paid" ? "PayPal sandbox payment completed" : order.state === "refunded" ? "PayPal sandbox refund completed" : "Payment state saved", `The ${operation.command.action.kind.replaceAll("_", " ")} operation is ${operation.status}. Purchased graph ${order.graphHash.slice(0, 12)} remains immutable.`, order.revisionId);
    return order;
  });
  await retireIneligiblePolicies(session.id);
  if (order.state === "paid" && order.walletConsentId && operation.receipt?.source === "live_sandbox") {
    try { await adoptCheckoutWallet(session, order); }
    catch { /* Captured money is settled independently; wallet confirmation stays pending. */ }
  }
  return order;
}

export async function enableRepairPolicy(session: Session, orderId: string, walletId: string, walletDigest: string) {
  return commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_commerce_orders WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [orderId, session.id]);
    const order = await loadOrder(session.id, orderId, db); const wallet = await loadWallet(session.id, walletId, db);
    if (order.kind !== "initial" || order.state !== "paid" || order.fulfilledAt) throw new WorldKitError("invalid_request", "Choose a completed, unfulfilled Studio order before enabling repair authority.", 409);
    if (wallet.state !== "active" || wallet.revokedAt || wallet.digest !== walletDigest || !wallet.verifiedAt || !wallet.tokenId || Date.parse(wallet.expiresAt) <= Date.now()) throw new WorldKitError("forbidden", "A current verified wallet and its exact consent are required.", 403);
    const prior = (await db.query("SELECT payload FROM wk_repair_policies WHERE tenant_id=$1 AND payload->>'baseOrderId'=$2", [session.id, orderId])).rows[0]?.payload as RepairPolicy | undefined;
    if (prior) { if (prior.revokedAt || Date.parse(prior.expiresAt) <= Date.now()) throw new WorldKitError("forbidden", "This order’s repair authority ended. A new checkout and explicit policy are needed for another allowance.", 403); return prior; }
    const value = { id: randomUUID(), tenantId: session.id, kitId: order.kitId, baseOrderId: orderId, baseRevisionId: order.revisionId, walletConsentId: wallet.id, walletConsentDigest: wallet.digest, walletConsentVersion: wallet.version, version: 1, createdAt: now(), expiresAt: new Date(Math.min(Date.now() + 24 * 3600000, Date.parse(wallet.expiresAt))).toISOString(), revokedAt: null, capMinor: REPAIR_CAP_MINOR, currency: "USD" as const, merchants: ["worldkit-studio"], categories: ["setup-service"], scope: "digital_setup_amendments" as const, preserveOwned: true as const, preserveGoal: true as const, stopAfterFulfillment: true as const };
    const policy: RepairPolicy = { ...value, digest: sha256(canonicalJson(value)) };
    await db.query("INSERT INTO wk_repair_policies(id,tenant_id,payload) VALUES($1,$2,$3)", [policy.id, session.id, policy]);
    await event(db, session.id, "policy.accepted", "A $25 cumulative repair limit is active", "Only WorldKit Studio digital setup amendments, with the same hard requirements and owned equipment, for 24 hours or until fulfillment. Refunds do not restore this allowance.", order.revisionId);
    return policy;
  });
}
export async function revokeRepairPolicy(session: Session, id: string) {
  return commerceTransaction(async db => {
    const row = (await db.query("SELECT payload FROM wk_repair_policies WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [id, session.id])).rows[0];
    if (!row) throw new WorldKitError("not_found", "That repair authority does not belong to this workspace.", 404);
    const policy = { ...row.payload, revokedAt: row.payload.revokedAt ?? now(), endedReason: row.payload.endedReason ?? "owner_revoked" } as RepairPolicy;
    await db.query("UPDATE wk_repair_policies SET payload=$1 WHERE id=$2", [policy, id]);
    await event(db, session.id, "policy.revoked", "Automatic setup changes stopped", "Revocation is now committed. Existing captured payments and unknown operations remain recorded for reconciliation.", policy.baseRevisionId); return policy;
  });
}
/** Only server-owned, priced proposals reach this function. Browser routes use
 * repairScenarios, never a client-supplied amount or provider destination. */
export async function reserveRepair(session: Session, policyId: string, proposal: { scenarioId: string; title: string; detail: string; minor: number; businessKey: string; revision: RevisionBundle }) {
  return commerceTransaction(async db => {
    const row = (await db.query("SELECT payload FROM wk_repair_policies WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [policyId, session.id])).rows[0];
    if (!row) throw new WorldKitError("not_found", "That repair authority does not belong to this workspace.", 404);
    const policy = row.payload as RepairPolicy;
    const duplicate = (await db.query("SELECT payload FROM wk_repair_claims WHERE policy_id=$1 AND business_key=$2", [policy.id, proposal.businessKey])).rows[0]?.payload as RepairClaim | undefined;
    if (duplicate) { if (duplicate.additionalMinor !== proposal.minor || duplicate.revisionId !== proposal.revision.kit.id || duplicate.scenarioId !== proposal.scenarioId) throw new WorldKitError("invalid_request", "The same repair event arrived with changed details.", 409); return { claim: duplicate, authority: null }; }
    const wallet = await loadWallet(session.id, policy.walletConsentId, db); const base = await loadOrder(session.id, policy.baseOrderId, db);
    const original = (await db.query("SELECT kit FROM wk_revisions WHERE id=$1 AND tenant_id=$2", [policy.baseRevisionId, session.id])).rows[0]?.kit;
    if (!original) throw new WorldKitError("not_found", "The original purchased revision is unavailable.", 404);
    const latest = (await db.query("SELECT r.certificate FROM wk_kits k JOIN wk_revisions r ON r.id=k.current_revision_id WHERE k.id=$1 AND k.tenant_id=$2", [policy.kitId, session.id])).rows[0];
    if (!latest || latest.certificate.graphHash !== proposal.revision.certificate.graphHash) throw new WorldKitError("stale_revision", "Refresh this repair against the current saved graph.", 409);
    const other = (await db.query("SELECT payload FROM wk_repair_claims WHERE policy_id=$1", [policy.id])).rows.map(r => r.payload as RepairClaim);
    const consumedMinor = other.filter(c => !["refused", "escalated"].includes(c.state)).reduce((sum, c) => sum + c.additionalMinor, 0);
    const evaluation = base.state !== "paid" || base.refundedMinor > 0
      ? { allowed: false, reason: "The original Studio order is no longer an active paid purchase. Its repair authority has ended.", remainingMinor: Math.max(0, policy.capMinor - consumedMinor) }
      : evaluateRepair({ policy, wallet, original, proposed: proposal.revision.kit, merchant: "worldkit-studio", category: "setup-service", additionalMinor: proposal.minor, consumedMinor, fulfilled: Boolean(base.fulfilledAt) });
    const claim: RepairClaim = { id: randomUUID(), tenantId: session.id, policyId, orderId: null, revisionId: proposal.revision.kit.id, scenarioId: proposal.scenarioId, additionalMinor: proposal.minor, state: evaluation.allowed ? "reserved" : "escalated", createdAt: now(), explanation: evaluation.reason, sourceMode: "sample", reversedAt: null };
    let authority: FinancialAuthority | null = null;
    if (evaluation.allowed) {
      const value = { ...base.quote, tenantId: session.id, id: randomUUID(), revisionId: proposal.revision.kit.id, verificationId: proposal.revision.certificate.id, graphHash: proposal.revision.certificate.graphHash, items: [{ sku: `wk-${proposal.scenarioId}`, name: `WorldKit Studio · ${proposal.title}`, quantity: 1, unitMinor: proposal.minor, profileId: null }], total: { currency: "USD" as const, minor: proposal.minor }, createdAt: now(), expiresAt: new Date(Date.now() + 15 * 60000).toISOString() };
      const quote = { ...value, quoteHash: sha256(canonicalJson({ ...value, quoteHash: undefined })) };
      const order = { ...newOrder(session.id, quote, policy.kitId, base.origin, wallet.id), kind: "amendment" as const, parentOrderId: base.id, repairClaimId: claim.id };
      claim.orderId = order.id;
      const command = commandFor(order, "purchase", purchaseAction(order, wallet)); order.operationIds.push(command.operationId);
      await db.query("INSERT INTO wk_quotes(id,tenant_id,payload) VALUES($1,$2,$3)", [quote.id, session.id, quote]);
      await db.query("INSERT INTO wk_commerce_orders(id,tenant_id,quote_id,payload) VALUES($1,$2,$3,$4)", [order.id, session.id, quote.id, order]);
      authority = await insertAuthority(db, order, "purchase", command, policy.id);
    }
    await db.query("INSERT INTO wk_repair_claims(id,tenant_id,policy_id,business_key,payload) VALUES($1,$2,$3,$4,$5)", [claim.id, session.id, policyId, proposal.businessKey, claim]);
    await event(db, session.id, "repair.authority_checked", evaluation.allowed ? "Setup amendment reserved" : "This setup amendment needs your review", `${proposal.detail} ${evaluation.reason}`, claim.revisionId, "sample");
    return { claim, authority };
  });
}
export async function executeRepair(session: Session, policyId: string, scenarioId: string, expectedRevisionId: string, expectedGraphHash: string, engine = paymentEngine()) {
  const scenario = repairScenarios.find(s => s.id === scenarioId);
  if (!scenario) throw new WorldKitError("invalid_request", "Choose a documented merchant scenario.", 400);
  const revision = await getRevision(session.id);
  if (revision.kit.id !== expectedRevisionId || revision.certificate.graphHash !== expectedGraphHash) throw new WorldKitError("stale_revision", "Refresh the kit before applying this scenario.", 409);
  const prepared = await reserveRepair(session, policyId, { scenarioId: scenario.id, title: scenario.title, detail: scenario.detail, minor: scenario.minor, businessKey: `${scenario.id}:${revision.kit.id}`, revision });
  if (prepared.authority && prepared.claim.orderId) {
    const runtime = await engine; const operation = await runtime.core.execute(prepared.authority.command);
    await syncOperation(session, prepared.claim.orderId, operation);
    await database().query("INSERT INTO wk_notifications(id,tenant_id,kind,payload) VALUES($1,$2,'repair-result',$3)", [randomUUID(), session.id, { repairId: prepared.claim.id, orderId: prepared.claim.orderId, title: "Your setup amendment has a payment update", source: "live_sandbox", createdAt: now() }]);
  }
  return prepared.claim;
}

export async function captureCheckout(session: Session, orderId: string, engine = paymentEngine()) {
  const runtime = await engine; const order = await loadOrder(session.id, orderId);
  if (order.capturedMinor > 0) return order;
  if (!order.providerOrderId) throw new WorldKitError("invalid_request", "The original order is still being confirmed. Refresh its payment status first.", 409);
  const create = await runtime.store.get(scope(session.id), `purchase:${order.id}`);
  if (create?.receipt?.resources.some(r => r.kind === "capture" && r.status === "COMPLETED")) return syncOperation(session, order.id, create);
  const authority = await commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_commerce_orders WHERE id=$1 FOR UPDATE", [order.id]);
    const prior = await authorityByOperation(session.id, `capture:${order.id}`, db); if (prior) return prior;
    const latest = await loadOrder(session.id, order.id, db); const purchase = await authorityByOperation(session.id, `purchase:${order.id}`, db);
    const command = commandFor(latest, "capture", { kind: "capture_order", money: latest.quote.total, orderId: latest.providerOrderId! });
    const value = await insertAuthority(db, latest, "capture", command, purchase?.repairPolicyId ?? null); latest.operationIds.push(command.operationId); await saveOrder(db, latest); return value;
  });
  const operation = await runtime.core.execute(authority.command); return syncOperation(session, order.id, operation);
}
export async function refundCheckout(session: Session, id: string, engine = paymentEngine()) {
  const runtime = await engine; const order = await loadOrder(session.id, id);
  const prior = await authorityByOperation(session.id, `refund:${id}`);
  if (prior) { const saved = await runtime.store.get(scope(session.id), prior.command.operationId); return saved ? syncOperation(session, id, await runtime.core.reconcile(scope(session.id), saved.command.operationId)) : syncOperation(session, id, await runtime.core.execute(prior.command)); }
  if (!order.captureId || !order.capturedMinor || order.refundedMinor) throw new WorldKitError("invalid_request", "A completed, unrefunded Studio capture is required.", 409);
  if (order.fulfilledAt || Date.now() - Date.parse(order.createdAt) > 24 * 3600000) throw new WorldKitError("invalid_request", "This order needs support review because it was fulfilled or its 24-hour cancellation window ended.", 409, "Open a support request");
  const authority = await commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_commerce_orders WHERE id=$1 FOR UPDATE", [id]);
    const previous = await authorityByOperation(session.id, `refund:${id}`, db); if (previous) return previous;
    const latest = await loadOrder(session.id, id, db);
    const approval = { id: `compensation:${id}`, version: 1, digest: sha256(canonicalJson({ tenantId: session.id, orderId: id, captureId: latest.captureId, amount: latest.capturedMinor, policy: "digital-service-24h.v1" })), expiresAt: new Date(Date.now() + 3600000).toISOString() };
    const command = commandFor(latest, "refund", { kind: "refund_capture", money: { currency: "USD", minor: latest.capturedMinor }, captureId: latest.captureId!, orderId: latest.providerOrderId! }, approval);
    const value = await insertAuthority(db, latest, "refund", command); latest.operationIds.push(command.operationId); await saveOrder(db, latest); return value;
  });
  return syncOperation(session, id, await runtime.core.execute(authority.command));
}
export async function refreshOrder(session: Session, id: string, engine = paymentEngine()) {
  const runtime = await engine; let order = await loadOrder(session.id, id);
  for (const operationId of order.operationIds) {
    const operation = await runtime.store.get(scope(session.id), operationId); if (!operation) continue;
    order = await syncOperation(session, id, await runtime.core.reconcile(scope(session.id), operationId));
  }
  return order;
}
export async function commerceView(session: Session): Promise<CommerceView> {
  await initializeCommerce(); const runtime = await paymentEngine();
  const [orders, wallets, policies, repairs, operations] = await Promise.all([
    database().query("SELECT payload FROM wk_commerce_orders WHERE tenant_id=$1 ORDER BY created_at DESC", [session.id]),
    database().query("SELECT payload FROM wk_wallet_consents WHERE tenant_id=$1 ORDER BY created_at DESC", [session.id]),
    database().query("SELECT payload FROM wk_repair_policies WHERE tenant_id=$1 ORDER BY created_at DESC", [session.id]),
    database().query("SELECT payload FROM wk_repair_claims WHERE tenant_id=$1 ORDER BY created_at DESC", [session.id]),
    runtime.store.list(scope(session.id)),
  ]);
  const claims = repairs.rows.map(r => r.payload as RepairClaim);
  return { orders: orders.rows.map(r => r.payload), wallets: wallets.rows.map(r => walletView(unseal<WalletConsent>(session.id, r.payload))), policies: policies.rows.map(r => { const p = r.payload as RepairPolicy; const active = claims.filter(c => c.policyId === p.id && !["escalated", "refused"].includes(c.state)); return { ...p, consumedMinor: active.reduce((sum, c) => sum + c.additionalMinor, 0), pendingMinor: active.filter(c => ["reserved", "payment_pending"].includes(c.state)).reduce((sum, c) => sum + c.additionalMinor, 0) }; }), repairs: claims,
    receipts: operations.flatMap(o => o.receipt ? [o.receipt] : []), operations: operations.map(o => ({ id: o.command.operationId, kind: o.command.action.kind, status: o.status, observedAt: o.updatedAt, message: o.error?.message ?? null })),
    merchant: { name: "WorldKit Studio", offer: "Digital routing dossier + connection guide", environment: "sandbox", currency: "USD", automaticRepairCapMinor: REPAIR_CAP_MINOR, scope: "A complete source-linked setup dossier. Physical equipment, retailer procurement and a physical compatibility guarantee are not included." }, scenarios: repairScenarios };
}

export async function cancelCheckout(session: Session, id: string) {
  return commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_commerce_orders WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [id, session.id]);
    const order = await loadOrder(session.id, id, db);
    if (order.capturedMinor || order.state === "payment_pending") throw new WorldKitError("invalid_request", "Refresh this payment first. A completed payment needs a refund, and an uncertain payment needs reconciliation.", 409);
    await saveOrder(db, { ...order, state: "cancelled", approvalUrl: null });
    await event(db, session.id, "checkout.cancelled", "Checkout cancelled", "This saved order will no longer authorize capture. Its original quote and payment history remain available.", order.revisionId);
  });
}
export async function deliverDossier(session: Session, id: string) {
  const order = await loadOrder(session.id, id);
  if (order.state !== "paid" || order.capturedMinor !== order.quote.total.minor || order.refundedMinor) throw new WorldKitError("forbidden", "A completed, unrefunded Studio purchase is required to deliver this dossier.", 403);
  const bundle = await getRevision(session.id, order.revisionId);
  const { generateAssembly } = await import("../../packages/compatibility/index");
  const content = { format: "worldkit-studio-dossier.v1", merchant: "WorldKit Studio", createdAt: now(), scope: "Digital source-linked planning dossier; physical performance not tested. Open evidence is preserved.", order: { id: order.id, graphHash: order.graphHash, quote: order.quote, payment: { providerOrderId: order.providerOrderId, captureId: order.captureId, capturedMinor: order.capturedMinor, currency: "USD", environment: "sandbox" } }, ...bundle, assembly: generateAssembly(bundle.kit, bundle.profiles) };
  await commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_commerce_orders WHERE id=$1 FOR UPDATE", [id]); const latest = await loadOrder(session.id, id, db);
    if (latest.state !== "paid" || latest.refundedMinor) throw new WorldKitError("forbidden", "Refresh the order before opening its dossier.", 409);
    await saveOrder(db, { ...latest, fulfilledAt: latest.fulfilledAt ?? now() });
    await event(db, session.id, "dossier.delivered", "Your purchased dossier was delivered", `Immutable kit ${order.graphHash.slice(0, 12)} with its certificate, sources and connection guide. Automatic changes and automatic cancellation are now closed for this order.`, order.revisionId);
  });
  await retireIneligiblePolicies(session.id);
  return { filename: `worldkit-studio-${order.id.slice(0, 8)}-dossier.json`, content };
}
export async function retireIneligiblePolicies(tenantId: string) {
  return commerceTransaction(async db => {
    const rows = await db.query("SELECT payload FROM wk_repair_policies WHERE tenant_id=$1 AND payload->>'revokedAt' IS NULL FOR UPDATE", [tenantId]);
    let retired = 0;
    for (const row of rows.rows) {
      const policy = row.payload as RepairPolicy; const base = await loadOrder(tenantId, policy.baseOrderId, db); const wallet = await loadWallet(tenantId, policy.walletConsentId, db);
      const reason: RepairPolicy["endedReason"] = base.refundedMinor > 0 || base.state === "refunded" || base.state === "cancelled" ? "base_refunded" : base.fulfilledAt ? "base_fulfilled" : wallet.revokedAt ? "wallet_revoked" : Date.parse(policy.expiresAt) <= Date.now() ? "expired" : undefined;
      if (!reason) continue;
      const ended = { ...policy, revokedAt: now(), endedReason: reason };
      await db.query("UPDATE wk_repair_policies SET payload=$1 WHERE id=$2", [ended, policy.id]);
      await event(db, tenantId, "policy.ended", "Automatic setup changes ended", reason === "base_refunded" ? "The original Studio purchase was refunded. Its repair policy is closed; gross spent and pending history remains preserved." : reason === "base_fulfilled" ? "The purchased dossier was delivered. Its automatic repair policy is closed." : reason === "wallet_revoked" ? "Wallet consent was revoked. Its automatic repair policy is closed." : "The repair authority expired.", policy.baseRevisionId);
      retired++;
    }
    return retired;
  });
}
export async function openSupportRequest(session: Session, orderId: string, message: string) {
  const order = await loadOrder(session.id, orderId); const id = randomUUID();
  const payload = { id, orderId, message: message.slice(0, 2000), state: "needs_review", createdAt: now(), scope: "Saved in this workspace. No message was sent outside WorldKit." };
  await commerceTransaction(async db => { await db.query("INSERT INTO wk_notifications(id,tenant_id,kind,payload) VALUES($1,$2,'support-request',$3)", [id, session.id, payload]); await event(db, session.id, "support.requested", "Support request saved", "Your order, payment history and request are preserved here for review. No external support delivery is claimed.", order.revisionId); });
  return payload;
}
