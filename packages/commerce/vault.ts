import { PaypalError, type PaypalClient, type SetupTokenRequest, type SetupTokenResponse, type PaymentTokenResponse } from "paypal";
import { canonicalJson, fromProviderMoney, sha256 } from "@fracture/paypal-core";
import { safeApprovalUrl } from "./policy";

export class VaultFault extends Error {
  constructor(message: string, readonly outcome: "refused" | "unknown" | "not_sent", readonly status: number, readonly debugId: string | null = null) { super(message); this.name = "VaultFault"; }
}
type Result<T> = { ok: true; value: T; status: number; headers: Headers } | { ok: false; status: number; headers: Headers; payload: unknown };
export type VaultObservation<T> = { value: T; status: number; debugId: string | null; bodyHash: string; observedAt: string };
export type SetupIdentity = { id: string; status: string; customerId: string; merchantCustomerId: string | null; payerId: string | null; approvalUrl: string | null };
export type TokenIdentity = { id: string; customerId: string; merchantCustomerId: string | null; payerId: string | null; description: string | null };
const failure = (status: number, debugId: string | null) => new VaultFault(status === 401 || status === 403 ? "PayPal cannot use saved-wallet features for this application right now." : status === 429 ? "PayPal needs a moment before refreshing this wallet." : status === 404 ? "This PayPal wallet resource was not found." : status >= 400 && status < 500 ? "PayPal refused this wallet request. Your kit and earlier payments are unchanged." : "We are confirming the wallet operation with PayPal before any further write.", status >= 400 && status < 500 ? "refused" : "unknown", status === 401 || status === 403 ? 502 : status === 429 ? 503 : status, debugId);
function setupIdentity(value: SetupTokenResponse): SetupIdentity {
  if (!value.id || !value.customer?.id || !value.status) throw new VaultFault("PayPal returned an incomplete setup identity. We must reconcile it.", "unknown", 502);
  const approvalUrl = safeApprovalUrl(value.links?.find(l => ["approve", "payer-action"].includes(l.rel) && l.method === "GET")?.href);
  if (value.status === "PAYER_ACTION_REQUIRED" && !approvalUrl) throw new VaultFault("The wallet approval link was missing or could not be trusted.", "unknown", 502);
  return { id: value.id, status: value.status, customerId: value.customer.id, merchantCustomerId: value.customer.merchantCustomerId ?? null, payerId: value.paymentSource?.paypal?.payerId ?? value.paymentSource?.paypal?.accountId ?? null, approvalUrl };
}
function tokenIdentity(value: PaymentTokenResponse): TokenIdentity {
  if (!value.id || !value.customer?.id || !value.paymentSource?.paypal) throw new VaultFault("PayPal returned an incomplete saved-wallet identity. No charge permission was enabled.", "unknown", 502);
  return { id: value.id, customerId: value.customer.id, merchantCustomerId: value.customer.merchantCustomerId ?? null, payerId: value.paymentSource.paypal.payerId ?? value.paymentSource.paypal.accountId ?? null, description: value.paymentSource.paypal.description ?? null };
}
export function assertOwnedToken(token: TokenIdentity, expected: { id: string; customerId: string; merchantCustomerId: string; payerId: string | null }) {
  if (token.id !== expected.id || token.customerId !== expected.customerId || (token.merchantCustomerId && token.merchantCustomerId !== expected.merchantCustomerId) || (expected.payerId && token.payerId !== expected.payerId)) throw new VaultFault("The saved wallet did not match this buyer’s recorded consent.", "refused", 403);
}
export class VaultAdapter {
  constructor(readonly client: PaypalClient) {}
  private async call<T>(work: (signal: AbortSignal) => Promise<Result<T>>): Promise<VaultObservation<T>> {
    try {
      const result = await work(AbortSignal.timeout(25000));
      if (!result.ok) throw failure(result.status, result.headers.get("paypal-debug-id"));
      return { value: result.value, status: result.status, debugId: result.headers.get("paypal-debug-id"), bodyHash: sha256(canonicalJson(result.value ?? null)), observedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof VaultFault) throw error;
      if (error instanceof PaypalError) {
        switch (error.kind) {
          case "auth": throw new VaultFault("PayPal authentication failed before the wallet request was sent.", "not_sent", 502);
          case "encode": throw new VaultFault("The wallet request was rejected before it was sent.", "not_sent", 400);
          case "api": throw failure(error.status, error.headers.get("paypal-debug-id"));
          case "decode": if (error.status >= 400) throw failure(error.status, error.headers.get("paypal-debug-id")); throw new VaultFault("The wallet response could not be read completely. We are checking its state.", "unknown", 502);
          case "connection": case "timeout": throw new VaultFault("The wallet response was lost. We will check the original operation before another write.", error.uri.endsWith("/v1/oauth2/token") ? "not_sent" : "unknown", 502);
        }
      }
      if (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)) throw new VaultFault("The wallet request was interrupted and its outcome is being checked.", "unknown", 502);
      throw error;
    }
  }
  setupBody(input: { merchantCustomerId: string; description: string; returnUrl: string; cancelUrl: string }): SetupTokenRequest {
    return { customer: { merchantCustomerId: input.merchantCustomerId }, paymentSource: { paypal: { description: input.description, usagePattern: "IMMEDIATE", usageType: "MERCHANT", customerType: "CONSUMER", permitMultiplePaymentTokens: false, experienceContext: { brandName: "WorldKit Studio", locale: "en-US", returnUrl: input.returnUrl, cancelUrl: input.cancelUrl, shippingPreference: "NO_SHIPPING", userAction: "CONTINUE" } } } };
  }
  async createSetup(body: SetupTokenRequest, requestId: string) { const observed = await this.call(signal => this.client.vault.createSetupToken({ payPalRequestId: requestId, body }, { signal, retry: { maxRetries: 0 } }).asApiResult()); return { ...observed, value: setupIdentity(observed.value) }; }
  async readSetup(id: string) { const observed = await this.call(signal => this.client.vault.getSetupToken({ id }, { signal }).asApiResult()); const value = setupIdentity(observed.value); if (value.id !== id) throw new VaultFault("PayPal returned a different setup identity.", "unknown", 502); return { ...observed, value }; }
  async exchange(setupId: string, requestId: string) { const observed = await this.call(signal => this.client.vault.createPaymentToken({ payPalRequestId: requestId, body: { paymentSource: { token: { id: setupId, type: "SETUP_TOKEN" } } } }, { signal, retry: { maxRetries: 0 } }).asApiResult()); return { ...observed, value: tokenIdentity(observed.value) }; }
  async readToken(id: string) { const observed = await this.call(signal => this.client.vault.getPaymentToken({ id }, { signal }).asApiResult()); const value = tokenIdentity(observed.value); if (value.id !== id) throw new VaultFault("PayPal returned a different saved-wallet identity.", "unknown", 502); return { ...observed, value }; }
  async deleteToken(id: string) { const observed = await this.call(signal => this.client.vault.deletePaymentToken({ id }, { signal, retry: { maxRetries: 0 } }).asApiResult()); if (observed.status !== 204) throw new VaultFault("PayPal did not confirm wallet deletion yet.", "unknown", 502); return { ...observed, value: { deleted: true } }; }
  async findExactCustomerToken(customerId: string, description: string) {
    const candidates: TokenIdentity[] = []; let complete = false;
    for (let page = 1; page <= 5; page++) {
      const result = await this.call(signal => this.client.vault.listCustomerPaymentTokens({ customerId, pageSize: 20, page, totalRequired: true }, { signal }).asApiResult());
      if (result.value.customer?.id && result.value.customer.id !== customerId) throw new VaultFault("PayPal returned another customer’s wallet list.", "refused", 403);
      for (const token of result.value.paymentTokens ?? []) { const t = tokenIdentity(token); if (t.customerId === customerId && t.description === description) candidates.push(t); }
      if (typeof result.value.totalPages === "number" && result.value.totalPages <= page) { complete = true; break; }
      if ((result.value.paymentTokens?.length ?? 0) < 20 && !result.value.links?.some(l => l.rel === "next")) { complete = true; break; }
    }
    return complete && candidates.length === 1 ? candidates[0]! : null;
  }
  async readOrderWallet(input: { id: string; customId: string; totalMinor: number; currency: string }) {
    const observed = await this.call(signal => this.client.orders.getOrder({ id: input.id }, { signal }).asApiResult());
    const order = observed.value; const unit = order.purchaseUnits?.[0]; const amount = unit?.amount && fromProviderMoney(unit.amount);
    if (order.id !== input.id || order.status !== "COMPLETED" || order.purchaseUnits?.length !== 1 || unit?.customId !== input.customId || !amount || amount.minor !== input.totalMinor || amount.currency !== input.currency) throw new VaultFault("The completed order does not match this saved-wallet consent.", "refused", 403);
    const vault = order.paymentSource?.paypal?.attributes?.vault;
    if (!vault?.id || !vault.customer?.id || vault.status !== "VAULTED") return { ...observed, value: null };
    return { ...observed, value: { id: vault.id, customerId: vault.customer.id, merchantCustomerId: vault.customer.merchantCustomerId ?? null, payerId: order.paymentSource?.paypal?.accountId ?? order.payer?.payerId ?? null } };
  }
}
