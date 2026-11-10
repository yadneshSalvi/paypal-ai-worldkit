import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import type { WalletConsent, CommerceOrder } from "../../packages/commerce/contracts";
import { assertOwnedToken, VaultAdapter, VaultFault, type VaultObservation, type SetupIdentity, type TokenIdentity } from "../../packages/commerce/vault";
import { WorldKitError } from "../../packages/contracts/index";
import { database } from "./db";
import { commerceTransaction, initializeCommerce } from "./commerce-db";
import { seal, unseal } from "./secrets";
import { vaultProvider } from "./payment-provider";
import type { Session } from "./repository";

export async function loadWallet(tenantId: string, id: string, db: Pick<PoolClient, "query"> = database()): Promise<WalletConsent> {
  await initializeCommerce(); const row = (await db.query("SELECT payload FROM wk_wallet_consents WHERE id=$1 AND tenant_id=$2", [id, tenantId])).rows[0];
  if (!row) throw new WorldKitError("not_found", "That wallet consent does not belong to this workspace.", 404);
  return unseal(tenantId, row.payload);
}
export async function saveWallet(db: Pick<PoolClient, "query">, wallet: WalletConsent) {
  await db.query("UPDATE wk_wallet_consents SET payload=$1 WHERE id=$2 AND tenant_id=$3", [seal(wallet.tenantId, wallet), wallet.id, wallet.tenantId]);
}
function current(wallet: WalletConsent) {
  if (wallet.revokedAt || Date.parse(wallet.expiresAt) <= Date.now()) throw new WorldKitError("forbidden", "This wallet consent has expired or was revoked.", 403);
}
export async function createWalletConsent(session: Session, origin: string, method: WalletConsent["method"]): Promise<WalletConsent> {
  return commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>now() FOR UPDATE", [session.id]);
    const existing = (await db.query("SELECT payload FROM wk_wallet_consents WHERE tenant_id=$1 ORDER BY created_at DESC", [session.id])).rows.map(r => unseal<WalletConsent>(session.id, r.payload)).find(w => !w.revokedAt && Date.parse(w.expiresAt) > Date.now() && w.method === method && w.state !== "refused");
    if (existing) { if (existing.origin !== origin) throw new WorldKitError("forbidden", "Continue wallet approval from the address where it began.", 403); return existing; }
    const id = randomUUID(); const createdAt = new Date().toISOString(); const expiresAt = new Date(Math.min(Date.now() + 24 * 3600000, Date.parse(session.expiresAt))).toISOString();
    const intent = { id, tenantId: session.id, version: 1, createdAt, expiresAt, method, merchant: "worldkit-studio", usageType: "MERCHANT", purpose: "Save this PayPal wallet. Saving alone permits no automatic charges.", origin };
    const wallet: WalletConsent = { id, tenantId: session.id, version: 1, digest: sha256(canonicalJson(intent)), createdAt, expiresAt, revokedAt: null, state: "awaiting_approval", method, setupId: null, tokenId: null, customerId: null, payerId: null, merchantCustomerId: session.id, approvalUrl: null, verifiedAt: null, error: null, description: `WorldKit wallet consent ${id}`, origin };
    await db.query("INSERT INTO wk_wallet_consents(id,tenant_id,payload) VALUES($1,$2,$3)", [id, session.id, seal(session.id, wallet)]); return wallet;
  });
}
type VaultOperation = { id: string; tenant_id: string; consent_id: string; kind: string; state: string; body_hash: string; request_id: string; result: { sealed: string } | null; error: string | null };
async function claim(wallet: WalletConsent, kind: "setup" | "exchange" | "delete", body: unknown) {
  const digest = sha256(canonicalJson(body));
  return commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_wallet_consents WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [wallet.id, wallet.tenantId]);
    const latest = await loadWallet(wallet.tenantId, wallet.id, db); if (kind !== "delete") current(latest);
    const prior = (await db.query("SELECT * FROM wk_vault_operations WHERE consent_id=$1 AND kind=$2", [wallet.id, kind])).rows[0] as VaultOperation | undefined;
    if (prior) { if (prior.body_hash !== digest) throw new WorldKitError("invalid_request", "This wallet operation already has different approved details.", 409); return { won: false, operation: prior }; }
    const id = randomUUID(); const requestId = randomUUID();
    const row = (await db.query("INSERT INTO wk_vault_operations(id,tenant_id,consent_id,kind,state,body_hash,request_id) VALUES($1,$2,$3,$4,'dispatching',$5,$6) RETURNING *", [id, wallet.tenantId, wallet.id, kind, digest, requestId])).rows[0] as VaultOperation;
    return { won: true, operation: row };
  });
}
async function finish<T>(operation: VaultOperation, observed: VaultObservation<T>) {
  await database().query("UPDATE wk_vault_operations SET state='succeeded',result=$1,error=NULL,updated_at=now() WHERE id=$2", [seal(operation.tenant_id, observed), operation.id]);
}
async function fail(wallet: WalletConsent, operation: VaultOperation, error: unknown) {
  const failure = error instanceof VaultFault ? error : new VaultFault("The wallet operation was interrupted. We must confirm its state before another write.", "unknown", 502);
  await commerceTransaction(async db => {
    await db.query("UPDATE wk_vault_operations SET state=$1,error=$2,updated_at=now() WHERE id=$3", [failure.outcome === "unknown" ? "pending_reconciliation" : failure.outcome, failure.message, operation.id]);
    await db.query("SELECT id FROM wk_wallet_consents WHERE id=$1 FOR UPDATE", [wallet.id]);
    const latest = await loadWallet(wallet.tenantId, wallet.id, db);
    await saveWallet(db, { ...latest, state: latest.revokedAt ? "revoked" : failure.outcome === "unknown" ? "pending_reconciliation" : "refused", error: failure.message });
  });
  return loadWallet(wallet.tenantId, wallet.id);
}
async function applySetup(wallet: WalletConsent, observed: VaultObservation<SetupIdentity>) {
  if (observed.value.merchantCustomerId && observed.value.merchantCustomerId !== wallet.merchantCustomerId) throw new VaultFault("The setup identity belongs to another buyer.", "refused", 403);
  await commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_wallet_consents WHERE id=$1 FOR UPDATE", [wallet.id]);
    const latest = await loadWallet(wallet.tenantId, wallet.id, db);
    await saveWallet(db, { ...latest, setupId: observed.value.id, customerId: observed.value.customerId, payerId: observed.value.payerId, approvalUrl: observed.value.approvalUrl, state: latest.revokedAt ? "revoked" : "awaiting_approval", error: null });
  });
  return loadWallet(wallet.tenantId, wallet.id);
}
export async function beginWalletSetup(session: Session, consentId: string, adapter = vaultProvider()) {
  const wallet = await loadWallet(session.id, consentId); current(wallet);
  if (wallet.method !== "separate_setup") throw new WorldKitError("invalid_request", "This consent is reserved for saving during checkout.", 409);
  if (wallet.state === "active" || wallet.setupId) return wallet;
  const body = adapter.setupBody({ merchantCustomerId: wallet.merchantCustomerId, description: wallet.description, returnUrl: `${wallet.origin}/paypal/return?wallet=${wallet.id}`, cancelUrl: `${wallet.origin}/paypal/return?wallet=${wallet.id}&cancelled=1` });
  const taken = await claim(wallet, "setup", body);
  if (!taken.won) {
    if (taken.operation.state === "succeeded" && taken.operation.result) return applySetup(wallet, unseal(session.id, taken.operation.result));
    return wallet;
  }
  try { const observed = await adapter.createSetup(body, taken.operation.request_id); await finish(taken.operation, observed); return await applySetup(wallet, observed); }
  catch (error) { return fail(wallet, taken.operation, error); }
}
async function activate(wallet: WalletConsent, identity: TokenIdentity, adapter: VaultAdapter) {
  if (!wallet.customerId) throw new VaultFault("The wallet customer has not been established.", "unknown", 502);
  assertOwnedToken(identity, { id: identity.id, customerId: wallet.customerId, merchantCustomerId: wallet.merchantCustomerId, payerId: wallet.payerId });
  const checked = await adapter.readToken(identity.id);
  assertOwnedToken(checked.value, { id: identity.id, customerId: wallet.customerId, merchantCustomerId: wallet.merchantCustomerId, payerId: wallet.payerId ?? identity.payerId });
  await commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_wallet_consents WHERE id=$1 FOR UPDATE", [wallet.id]);
    const latest = await loadWallet(wallet.tenantId, wallet.id, db); current(latest);
    await saveWallet(db, { ...latest, tokenId: identity.id, payerId: checked.value.payerId, verifiedAt: checked.observedAt, state: "active", approvalUrl: null, error: null });
  });
  return loadWallet(wallet.tenantId, wallet.id);
}
export async function completeWalletSetup(session: Session, id: string, adapter = vaultProvider()) {
  let wallet = await loadWallet(session.id, id); current(wallet); if (wallet.state === "active") return wallet;
  if (!wallet.setupId) throw new WorldKitError("invalid_request", "The original wallet setup still needs to be confirmed. A second setup will not be created.", 409);
  const observed = await adapter.readSetup(wallet.setupId);
  if (observed.value.customerId !== wallet.customerId || (observed.value.merchantCustomerId && observed.value.merchantCustomerId !== wallet.merchantCustomerId)) throw new WorldKitError("forbidden", "This setup does not match this workspace’s buyer.", 403);
  if (observed.value.status !== "APPROVED") throw new WorldKitError("invalid_request", "Finish saving your wallet in PayPal, then return here to confirm it.", 409);
  wallet = await applySetup(wallet, observed);
  const taken = await claim(wallet, "exchange", { setupId: wallet.setupId });
  if (!taken.won) {
    if (taken.operation.state === "succeeded" && taken.operation.result) return activate(wallet, unseal<VaultObservation<TokenIdentity>>(session.id, taken.operation.result).value, adapter);
    if (wallet.customerId && taken.operation.state === "pending_reconciliation") { const found = await adapter.findExactCustomerToken(wallet.customerId, wallet.description); if (found) return activate(wallet, found, adapter); }
    return wallet;
  }
  try { const result = await adapter.exchange(wallet.setupId!, taken.operation.request_id); await finish(taken.operation, result); return await activate(wallet, result.value, adapter); }
  catch (error) { return fail(wallet, taken.operation, error); }
}
export async function adoptCheckoutWallet(session: Session, order: CommerceOrder, adapter = vaultProvider()) {
  if (!order.walletConsentId || !order.providerOrderId || !order.captureId || !order.capturedMinor) return;
  let wallet = await loadWallet(session.id, order.walletConsentId); if (wallet.method !== "during_purchase" || wallet.revokedAt || wallet.state === "active") return;
  current(wallet);
  const read = await adapter.readOrderWallet({ id: order.providerOrderId, customId: order.id, totalMinor: order.quote.total.minor, currency: "USD" });
  if (!read.value) { await saveWallet(database(), { ...wallet, state: "pending_reconciliation", error: "The payment is complete. PayPal has not yet confirmed a saved wallet; automatic changes remain off." }); return; }
  wallet = { ...wallet, customerId: read.value.customerId, payerId: read.value.payerId };
  await saveWallet(database(), wallet);
  await activate(wallet, { ...read.value, description: null }, adapter);
}
export async function revokeWallet(session: Session, id: string, adapter = vaultProvider()) {
  const wallet = await commerceTransaction(async db => {
    await db.query("SELECT id FROM wk_wallet_consents WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [id, session.id]);
    const latest = await loadWallet(session.id, id, db);
    const revoked = { ...latest, revokedAt: latest.revokedAt ?? new Date().toISOString(), state: "revoked" as const, approvalUrl: null };
    await saveWallet(db, revoked); return revoked;
  });
  if (!wallet.tokenId) return wallet;
  const taken = await claim(wallet, "delete", { tokenId: wallet.tokenId });
  if (!taken.won) {
    if (taken.operation.state === "pending_reconciliation") {
      try { await adapter.readToken(wallet.tokenId); } catch (error) { if (error instanceof VaultFault && error.status === 404) await database().query("UPDATE wk_vault_operations SET state='succeeded',error=NULL,updated_at=now() WHERE id=$1", [taken.operation.id]); }
    }
    return loadWallet(session.id, id);
  }
  try { const result = await adapter.deleteToken(wallet.tokenId); await finish(taken.operation, result); await saveWallet(database(), { ...wallet, error: null }); }
  catch (error) { await fail(wallet, taken.operation, error); }
  return loadWallet(session.id, id);
}
