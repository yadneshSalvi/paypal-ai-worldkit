import type { PaymentCommand, PaymentOperation, ProviderReceipt } from "@fracture/paypal-core";
import type { Quote } from "../contracts/index";

export const MERCHANT_ID = "worldkit-studio";
export const PROJECT_ID = "worldkit";
export const REPAIR_CAP_MINOR = 2500;
export type WalletState = "awaiting_approval" | "active" | "pending_reconciliation" | "refused" | "revoked";
export interface WalletConsent {
  id: string; tenantId: string; version: number; digest: string; createdAt: string; expiresAt: string;
  revokedAt: string | null; state: WalletState; method: "separate_setup" | "during_purchase";
  setupId: string | null; tokenId: string | null; customerId: string | null; payerId: string | null;
  merchantCustomerId: string; approvalUrl: string | null; verifiedAt: string | null; error: string | null;
  description: string; origin: string;
}
export interface WalletView {
  id: string; version: number; digest: string; state: WalletState; method: WalletConsent["method"];
  createdAt: string; expiresAt: string; revokedAt: string | null; verifiedAt: string | null;
  approvalUrl: string | null; error: string | null;
}
export interface RepairPolicy {
  id: string; tenantId: string; kitId: string; baseOrderId: string; baseRevisionId: string;
  walletConsentId: string; walletConsentDigest: string; walletConsentVersion: number;
  version: number; digest: string; createdAt: string; expiresAt: string; revokedAt: string | null;
  capMinor: number; currency: "USD"; merchants: string[]; categories: string[];
  scope: "digital_setup_amendments"; preserveOwned: true; preserveGoal: true; stopAfterFulfillment: true;
}
export type RepairClaimState = "reserved" | "payment_pending" | "paid" | "refunded" | "refused" | "escalated";
export interface RepairClaim {
  id: string; tenantId: string; policyId: string; orderId: string | null; revisionId: string;
  scenarioId: string; additionalMinor: number; state: RepairClaimState; createdAt: string;
  explanation: string; sourceMode: "sample"; reversedAt: string | null;
}
export const repairScenarios = [
  { id: "connection-revision", title: "Update the connection dossier", detail: "Sample merchant event: a cable option changed. Prepare a revised digital routing dossier.", minor: 800 },
  { id: "architecture-revision", title: "Rework the recording architecture", detail: "Sample merchant event: the preferred recorder is unavailable. Prepare a complete alternate digital setup dossier.", minor: 2000 },
  { id: "expanded-revision", title: "Expand the setup dossier", detail: "Sample merchant event: a substantial setup revision exceeds automatic authority. Requires new explicit approval.", minor: 6000 },
] as const;
export type CommerceState = "creating" | "awaiting_approval" | "payment_pending" | "paid" | "partially_refunded" | "refunded" | "refused" | "cancelled";
export interface CommerceOrder {
  id: string; tenantId: string; kitId: string; revisionId: string; graphHash: string; quote: Quote;
  createdAt: string; updatedAt: string; origin: string; state: CommerceState;
  kind: "initial" | "amendment"; parentOrderId: string | null; repairClaimId: string | null;
  approval: PaymentCommand["approval"]; walletConsentId: string | null;
  providerOrderId: string | null; captureId: string | null; approvalUrl: string | null;
  capturedMinor: number; refundedMinor: number; fulfilledAt: string | null;
  operationIds: string[]; error: string | null; sourceMode: "live_sandbox";
}
export interface FinancialAuthority {
  id: string; tenantId: string; orderId: string; kind: "purchase" | "capture" | "refund";
  command: PaymentCommand; createdAt: string; revokedAt: string | null;
  repairPolicyId: string | null; repairClaimId: string | null;
}
export interface CommerceView {
  orders: CommerceOrder[]; wallets: WalletView[]; policies: (RepairPolicy & { consumedMinor: number; pendingMinor: number })[];
  repairs: RepairClaim[]; receipts: ProviderReceipt[];
  operations: { id: string; kind: string; status: PaymentOperation["status"]; observedAt: string; message: string | null }[];
  merchant: { name: string; offer: string; environment: "sandbox"; currency: "USD"; automaticRepairCapMinor: number; scope: string };
  scenarios: typeof repairScenarios;
}
export function walletView(wallet: WalletConsent): WalletView {
  const { id, version, digest, state, method, createdAt, expiresAt, revokedAt, verifiedAt, approvalUrl, error } = wallet;
  return { id, version, digest, state, method, createdAt, expiresAt, revokedAt, verifiedAt, approvalUrl, error };
}
