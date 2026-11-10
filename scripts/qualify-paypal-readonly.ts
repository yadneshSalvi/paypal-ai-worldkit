import { writeFile } from "node:fs/promises";
import { canonicalJson, fromProviderMoney, sha256 } from "@fracture/paypal-core";
import { database, closeDatabase } from "../src/server/db";
import { paymentEngine } from "../src/server/commerce";
import { paymentProvider, vaultProvider } from "../src/server/payment-provider";
import { loadWallet } from "../src/server/wallets";
import { walletView, type CommerceOrder, type RepairClaim, type RepairPolicy } from "../packages/commerce/contracts";
import { getRevision } from "../src/server/repository";
import { VaultFault } from "../packages/commerce/vault";

// Read-only corroboration after the official buyer UI has completed the flow.
// No create, capture, refund, token exchange, revocation or policy mutation occurs.
const baseId = process.argv[2];
function requireFact(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
try {
  requireFact(baseId && /^[a-zA-Z0-9-]{1,128}$/.test(baseId), "Supply the known owned domain order ID.");
  const first = (await database().query("SELECT tenant_id,payload FROM wk_commerce_orders WHERE id=$1", [baseId])).rows[0];
  requireFact(first, "The owned qualification order is unavailable.");
  const tenantId = first.tenant_id as string;
  const orders = (await database().query("SELECT payload FROM wk_commerce_orders WHERE tenant_id=$1 ORDER BY created_at", [tenantId])).rows.map(r => r.payload as CommerceOrder);
  requireFact(orders.length === 2, "This qualification expects one original order and one approved amendment.");
  const base = orders.find(o => o.id === baseId)!; const amendment = orders.find(o => o.parentOrderId === baseId)!;
  requireFact(base && amendment && base.kind === "initial" && amendment.kind === "amendment", "The amendment does not belong to the original order.");
  requireFact(base.capturedMinor === 1200 && amendment.capturedMinor === 800, "Captured domain amounts do not match the reviewed scenario.");
  requireFact(base.refundedMinor === 1200 && amendment.refundedMinor === 800, "The full compensating refunds have not been observed.");
  const runtime = await paymentEngine(); const operations = await runtime.store.list({ tenantId, projectId: "worldkit" });
  requireFact(operations.every(o => o.status === "succeeded" && o.receipt?.source === "live_sandbox" && o.receipt.transport === "apimatic_sdk"), "Every qualified operation needs an actual successful sandbox SDK receipt.");
  const provider = paymentProvider(); const observed = [];
  for (const order of orders) {
    requireFact(order.providerOrderId && order.captureId, "An exact owned provider order and capture are required.");
    const result = await provider.client.orders.getOrder({ id: order.providerOrderId! }, { signal: AbortSignal.timeout(25000) }).asApiResult();
    requireFact(result.ok, "The current order reread did not succeed."); if (!result.ok) throw new Error("The order reread failed.");
    const unit = result.value.purchaseUnits?.[0]; const total = unit?.amount && fromProviderMoney(unit.amount);
    requireFact(result.value.id === order.providerOrderId && result.value.purchaseUnits?.length === 1 && unit?.customId === order.id && total?.currency === "USD" && total.minor === order.quote.total.minor, "The provider order does not match the exact domain quote.");
    const returnedItems = (unit?.items ?? []).map(item => ({ sku: item.sku ?? null, name: item.name, quantity: Number(item.quantity), unitMinor: fromProviderMoney(item.unitAmount).minor }));
    requireFact(canonicalJson(returnedItems) === canonicalJson(order.quote.items.map(item => ({ sku: item.sku, name: item.name, quantity: item.quantity, unitMinor: item.unitMinor }))), "The current provider itemization differs from the accepted quote.");
    const [capture] = await provider.read("capture", order.captureId!);
    requireFact(capture?.id === order.captureId && capture.status === "REFUNDED" && capture.money?.minor === order.capturedMinor && capture.money.currency === "USD", "The current provider capture does not confirm the full refund.");
    const refundResources = operations.filter(op => op.command.businessKey === `refund:${order.id}`).flatMap(op => op.receipt?.resources.filter(r => r.kind === "refund") ?? []);
    requireFact(refundResources.length === 1, "One correlated refund resource is required for each order.");
    const [refund] = await provider.read("refund", refundResources[0]!.id);
    requireFact(refund?.status === "COMPLETED" && refund.money?.minor === order.capturedMinor && refund.money.currency === "USD", "The current provider refund is not complete for the exact captured amount.");
    const revision = await getRevision(tenantId, order.revisionId);
    requireFact(revision.certificate.graphHash === order.graphHash && order.quote.graphHash === order.graphHash, "The receipt no longer matches the immutable certificate.");
    observed.push({ domainOrderId: order.id, kind: order.kind, providerOrderId: order.providerOrderId, providerStatus: result.value.status, items: returnedItems, captureId: capture.id, captureStatus: capture.status, capturedMinor: order.capturedMinor, refundId: refund!.id, refundStatus: refund!.status, refundedMinor: order.refundedMinor, currency: "USD", graphHash: order.graphHash, verificationId: order.quote.verificationId, sourceHash: revision.certificate.sourceHash, sourceMode: "live_sandbox", transport: "apimatic_sdk" });
  }
  requireFact(base.walletConsentId, "First-purchase wallet consent is required.");
  const wallet = await loadWallet(tenantId, base.walletConsentId!);
  requireFact(wallet.method === "during_purchase" && wallet.verifiedAt && wallet.tokenId && wallet.customerId && wallet.revokedAt && wallet.state === "revoked", "The saved-on-purchase wallet must have its own ownership observation and current revocation.");
  const firstCreate = operations.find(o => o.command.businessKey === `purchase:${base.id}`)!;
  const amendmentCreate = operations.find(o => o.command.businessKey === `purchase:${amendment.id}`)!;
  requireFact(firstCreate.command.action.kind === "create_order" && firstCreate.command.action.saveWalletOnSuccess?.consentDigest === wallet.digest, "First-purchase saving must match the exact recorded consent.");
  requireFact(amendmentCreate.command.action.kind === "create_order" && amendmentCreate.command.action.savedWallet?.vaultId === wallet.tokenId && amendmentCreate.command.action.savedWallet.consentDigest === wallet.digest && amendmentCreate.command.action.savedWallet.paymentInitiator === "MERCHANT", "The amendment must use this buyer's exact consent-bound wallet.");
  requireFact(!operations.some(o => o.command.businessKey === `capture:${amendment.id}`), "An immediately completed wallet create must never be captured twice.");
  let providerDeletionConfirmed = false;
  try { await vaultProvider().readToken(wallet.tokenId!); }
  catch (error) { if (error instanceof VaultFault && error.status === 404) providerDeletionConfirmed = true; else throw error; }
  requireFact(providerDeletionConfirmed, "The provider has not confirmed deletion of the saved token.");
  const policies = (await database().query("SELECT payload FROM wk_repair_policies WHERE tenant_id=$1", [tenantId])).rows.map(r => r.payload as RepairPolicy);
  const claims = (await database().query("SELECT payload FROM wk_repair_claims WHERE tenant_id=$1 ORDER BY created_at", [tenantId])).rows.map(r => r.payload as RepairClaim);
  requireFact(policies.length === 1 && policies[0]!.revokedAt && policies[0]!.endedReason === "base_refunded", "The refunded original must have a retired repair policy.");
  const grossConsumedMinor = claims.filter(c => !["refused", "escalated"].includes(c.state)).reduce((sum, c) => sum + c.additionalMinor, 0);
  requireFact(grossConsumedMinor === 800, "Refunds must not erase gross repair allowance consumption.");
  requireFact(claims.some(c => c.additionalMinor === 2000 && c.state === "escalated" && !c.orderId) && claims.some(c => c.additionalMinor === 6000 && c.state === "escalated" && !c.orderId), "The +20 and +60 scenarios must escalate without a new payment order.");
  const walletRows = await database().query("SELECT payload FROM wk_wallet_consents WHERE tenant_id=$1", [tenantId]);
  const authorityRows = await database().query("SELECT payload FROM wk_financial_authorities WHERE tenant_id=$1", [tenantId]);
  const coreRows = await database().query("SELECT document FROM paycore_operations WHERE tenant_id=$1", [tenantId]);
  const persisted = JSON.stringify([walletRows.rows, authorityRows.rows, coreRows.rows]);
  for (const identity of [wallet.tokenId, wallet.customerId, wallet.payerId].filter((value): value is string => Boolean(value))) requireFact(!persisted.includes(identity), "A private wallet identity was stored without encryption.");
  requireFact(!JSON.stringify(walletView(wallet)).includes(wallet.tokenId!), "A private wallet token entered the browser DTO.");
  const evidence = { recordedAt: new Date().toISOString(), project: "WorldKit", environment: "sandbox", source: "live_sandbox", sdk: { package: "paypal", version: "2.29.0", commit: "5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2", core: "0.2.3" }, mode: "Official buyer UI completed first; this script made read-only provider calls.", observed, wallet: { method: wallet.method, independentOwnershipReadAt: wallet.verifiedAt, sameCustomerVerified: true, firstPurchaseConsentBound: true, laterMerchantInitiatedUse: true, immediateCreateCaptureNotCapturedAgain: true, consentRevoked: true, providerDeletionConfirmed, privateIdentifiersEncrypted: true, privateIdentifiersAbsentFromBrowser: true, tokenIdentifierPublished: false }, repairAuthority: { originalCapMinor: 2500, grossConsumedMinor, availableBeforeClosureMinor: 1700, currentlyAvailableMinor: 0, state: "ended", endedReason: policies[0]!.endedReason, scenarios: claims.map(c => ({ additionalMinor: c.additionalMinor, state: c.state, createdFinancialOrder: Boolean(c.orderId), eventSource: c.sourceMode })), refundDoesNotReplenish: true }, totals: { capturedMinor: 2000, refundedMinor: 2000, currency: "USD", domainOrders: orders.length, providerOperations: operations.length }, limitations: ["Sandbox digital service, not physical gear procurement or retailer fulfillment.", "Merchant scenario triggers are Sample; payment resources are live sandbox.", "Independent human source review and physical rig testing remain pending.", "No claim of production eligibility or first-ever payer wallet enrollment.", "Authentic deployed webhook qualification remains separate."] };
  const output = "docs/evidence/paypal-worldkit-qualification.json"; await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ status: "passed", output, orders: orders.length, capturedMinor: 2000, refundedMinor: 2000, walletDeleted: providerDeletionConfirmed, policyClosed: true, retainedGrossRepairSpendMinor: grossConsumedMinor, evidenceHash: sha256(canonicalJson(evidence)) }));
} catch (error) {
  process.stderr.write(JSON.stringify({ status: "failed", reason: error instanceof VaultFault ? error.message : error instanceof Error && error.name === "Error" ? error.message : "A provider or storage observation could not be safely confirmed." })); process.exitCode = 1;
} finally { await closeDatabase(); }
