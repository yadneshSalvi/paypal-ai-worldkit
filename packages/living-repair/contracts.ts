import type { CatalogReceipt, CatalogSnapshot, Certificate, DeviceProfile, KitRevision, Source, Truth } from "../contracts";
import type { CommerceOrder, WalletView } from "../commerce/contracts";

export type RepairSource = "live" | "sample" | "replay";
export type RepairBundle = { kit: KitRevision; certificate: Certificate; profiles: DeviceProfile[]; sources: Source[] };
export type RepairPhase = "queued" | "refreshing" | "discovering" | "verifying" | "ready" | "needs_evidence" | "no_alternative" | "not_in_kit" | "protected" | "resolved" | "stale" | "cancelled" | "failed";
export type RepairStep = { id: string; title: string; detail: string; at: string; state: "complete" | "open" | "blocked" };
export type RepairImpact = {
  changedComponentIds: string[]; componentIds: string[]; connectionIds: string[]; requirementIds: string[];
  factIds: string[]; sourceIds: string[]; protectedComponentIds: string[]; explanation: string;
};
export type RepairOffer = {
  productId: string; selectedOptions: { name: string; value: string }[]; offerId: string; domain: string;
  retailer: string; unitMinor: number; currency: "USD"; availability: string; checkedAt: string;
  snapshotId: string; snapshotHash: string; shipping: "unknown"; condition: string;
};
export type RepairEvidence = {
  mode: "live" | "sample"; snapshots: CatalogSnapshot[]; receipts: CatalogReceipt[];
  checkedAt: string; expiresAt: string; query: string; method: "same_variant" | "similar_and_constraints" | "sample_fixture";
};
export type CriticalCheck = { factId: string; profileId: string; property: string; state: Truth; reason: string; sourceIds: string[] };
export type RepairCandidate = {
  id: string; runId: string; kind: "merchant_change" | "variant_change"; title: string; explanation: string;
  offer: RepairOffer; componentId: string; beforeProfileId: string; afterProfileId: string;
  bundle: RepairBundle; impact: RepairImpact; criticalChecks: CriticalCheck[]; technicalState: Truth;
  identityState: "exact_profile_match" | "needs_confirmation"; evidence: RepairEvidence;
  rank: number; createdAt: string; blockers: string[]; digest: string;
};
export type SampleScenario = "available-alternative" | "followup-change" | "unknown-evidence" | "above-cap" | "original-unavailable" | "shipment" | "lost-payment-response" | "commit-failure";
export type RepairRun = {
  id: string; tenantId: string; kitId: string; sourceMode: RepairSource; catalogMode: "live" | "sample";
  incidentIds: string[]; causeKey: string; commitmentId: string | null; scenario: SampleScenario | null;
  phase: RepairPhase; title: string; reason: string; createdAt: string; updatedAt: string;
  base: RepairBundle; itemId: string | null; productId: string; selectedOptions: { name: string; value: string }[];
  affectedDomain: string; impact: RepairImpact; steps: RepairStep[]; candidateIds: string[];
  selectedCandidateId: string | null; amendmentId: string | null; original: RepairEvidence | null;
  discovery: { productId: string; selectedOptions: { name: string; value: string }[] }[];
  discoveryCursor: number; attempts: number; nextAttemptAt: string; error: string | null;
  automaticEvaluation?: { policyId: string; proposalId: string; claimHash: string; state: string; at: string };
  sampleBaseUnitMinor?: number;
};

export type CommitmentLine = {
  componentId: string; profileId: string; model: string; quantity: number; unitMinor: number;
  productId: string | null; selectedOptions: { name: string; value: string }[]; domain: string;
  offerId?: string | null; condition?: string;
  category: DeviceProfile["kind"]; fulfillment: "unfulfilled" | "shipped" | "delivered";
};
export type KitCommitment = {
  id: string; tenantId: string; kitId: string; version: number; branch: "sample_demonstration" | "workspace";
  current: RepairBundle; original: RepairBundle; workspaceRevisionId: string; lines: CommitmentLine[];
  merchantId: "worldkit-studio"; createdAt: string; updatedAt: string; acceptedTermsAt: string;
  baseline: "sample_commitment_no_payment"; baselineTotalMinor: number; currentTotalMinor: number;
  shippingMinor: 0; taxMinor: 0; currency: "USD"; latestAmendmentId: string | null;
  returnPolicy: "unfulfilled_24h_conditional";
};
export type MerchantQuote = {
  id: string; commitmentId: string; commitmentVersion: number; merchantId: "worldkit-studio";
  beforeTotalMinor: number; afterTotalMinor: number; deltaMinor: number; currency: "USD";
  beforeLines: CommitmentLine[]; afterLines: CommitmentLine[]; shippingMinor: 0; taxMinor: 0;
  createdAt: string; expiresAt: string; policyVersion: "controlled-kit-sandbox.v1"; digest: string;
  boundary: "Controlled demonstration only. No retailer reservation, order, shipment or refund is made.";
};
export type AmendmentProposal = {
  id: string; runId: string; candidateId: string; commitmentId: string; commitmentVersion: number;
  before: RepairBundle; after: RepairBundle; impact: RepairImpact; criticalChecks: CriticalCheck[];
  evidence: RepairEvidence; quote: MerchantQuote; kind: RepairCandidate["kind"];
  sourceMode: RepairSource; createdAt: string; expiresAt: string; digest: string;
  preserveOwned: true; preserveHardRequirements: true; technicalState: Truth;
};
export type AmendmentStatus = "proposed" | "awaiting_consent" | "requires_payment_approval" | "payment_pending" | "ready_to_commit" | "committed" | "stale" | "cancelled" | "refused" | "compensation_required" | "compensating" | "compensated" | "undo_pending" | "undone" | "partial_support_needed";
export type KitAmendment = {
  proposal: AmendmentProposal;
  status: AmendmentStatus; reason: string; orderId: string | null; policyId: string | null; claimId: string | null;
  paymentMode: "sample" | "live_sandbox" | null; acceptedAt: string | null; committedAt: string | null;
  committedVersion: number | null; updatedAt: string; undoUntil: string | null;
  dispatchCheck?: { proposalDigest: string; checkedAt: string; expiresAt: string; sourceHash: string; technicalHash: string };
};
export type KitRepairPolicy = {
  id: string; tenantId: string; commitmentId: string; scope: "controlled_kit_amendments";
  version: number; digest: string; capMinor: number; currency: "USD"; merchantIds: ["worldkit-studio"];
  vendorDomains: string[]; categories: DeviceProfile["kind"][]; conditions: string[]; preserveOwned: true; preserveHardRequirements: true;
  stopAfterFulfillment: true; createdAt: string; expiresAt: string; revokedAt: string | null;
  paymentMode: "sample" | "live_sandbox"; walletConsentId: string | null; walletConsentVersion: number | null;
  walletConsentDigest: string | null; sampleInstrumentConsent: string | null;
  origin: string; automatic: true; acceptedProposalDigest: string;
};
export type KitRepairClaim = {
  id: string; tenantId: string; amendmentId: string; commitmentId: string; policyId: string | null; orderId: string | null;
  additionalMinor: number; paymentMode: "sample" | "live_sandbox"; acceptedDigest: string; createdAt: string;
  state: "reserved" | "payment_pending" | "paid" | "refunded" | "refused";
};
export type CompensationRequest = {
  id: string; tenantId: string; amendmentId: string; commitmentId: string; expectedVersion: number;
  kind: "undo" | "failed_commit" | "price_credit"; state: "review" | "requires_payment_approval" | "payment_pending" | "refund_pending" | "restoring" | "completed" | "refused" | "partial_support_needed";
  createdAt: string; expiresAt: string; consentedAt: string | null; digest: string; reason: string;
  originalCheck: RepairEvidence | null; restore: RepairBundle | null; restoreLines: CommitmentLine[] | null;
  restorationTotalMinor: number | null; supplementalMinor: number; refundMinor: number;
  creditShortfallMinor: number;
  orderId: string | null; supplementalOrderId: string | null; refundOperationId: string | null; refundedMinor: number;
  paymentMode: "sample" | "live_sandbox"; sourceMode: RepairSource;
  balanceProof?: { captureId: string; capturedMinor: number; remainingMinor: number; observedAt: string; refundIds: string[]; digest: string };
};
export type RepairAuthorityContext = {
  amendmentId: string; commitmentId: string; proposalDigest: string; claimId: string | null;
  policyId: string | null; compensationId: string | null; paymentMode: "sample" | "live_sandbox";
};
export type RepairNotice = { id: string; kind: string; title: string; detail: string; sourceMode: RepairSource; createdAt: string; deliveredAt: string | null; attempts: number; runId: string | null; amendmentId: string | null };
export type RepairRunSummary = Pick<RepairRun, "id" | "sourceMode" | "phase" | "title" | "createdAt" | "amendmentId"> & { amendmentStatus: AmendmentStatus | null };
export type RepairView = {
  run: RepairRun | null; runs: RepairRunSummary[]; candidates: RepairCandidate[]; commitments: KitCommitment[]; amendments: KitAmendment[];
  policies: (KitRepairPolicy & { consumedMinor: number; pendingMinor: number; remainingMinor: number })[];
  claims: KitRepairClaim[]; compensations: CompensationRequest[]; orders: CommerceOrder[];
  wallets: WalletView[]; notices: RepairNotice[];
  readiness: { catalog: boolean; paypal: boolean; boundary: string };
};
export const SAMPLE_SCENARIOS: { id: SampleScenario; title: string; detail: string; deltaMinor: number }[] = [
  { id: "available-alternative", title: "Keep the recording going", detail: "The recorder’s sample retailer sells out. An exact alternative is available for $8 more.", deltaMinor: 800 },
  { id: "followup-change", title: "A second change, the same allowance", detail: "A later exact replacement costs $20 more. Pending and completed changes must still fit the original gross limit.", deltaMinor: 2000 },
  { id: "unknown-evidence", title: "Let uncertainty stop the change", detail: "A replacement lacks a reviewed simultaneous-recording fact. The proposal must wait.", deltaMinor: 800 },
  { id: "above-cap", title: "Stop at your spending limit", detail: "A $28 change exceeds a fresh $25 allowance and asks for a new decision.", deltaMinor: 2800 },
  { id: "original-unavailable", title: "An undo that needs care", detail: "The new recorder is available, but the original remains out of stock when undo is requested.", deltaMinor: 800 },
  { id: "shipment", title: "Protect a shipped kit", detail: "A simulated shipment ends automatic changes and conditional undo.", deltaMinor: 800 },
  { id: "lost-payment-response", title: "Recover an uncertain payment", detail: "A Sample capture succeeds but its first response is lost. Reconcile the same operation.", deltaMinor: 800 },
  { id: "commit-failure", title: "A paid change cannot be applied", detail: "A sample stock change arrives after payment. Request compensation with separate consent.", deltaMinor: 800 },
];
