import { hash } from "../compatibility";
import type { WalletConsent } from "../commerce/contracts";
import type { AmendmentProposal, KitCommitment, KitRepairClaim, KitRepairPolicy } from "./contracts";
import { preservedIntent } from "./impact";

export function grossAllowance(claims: KitRepairClaim[], policyId: string) {
  const active = claims.filter(claim => claim.policyId === policyId && claim.state !== "refused");
  const consumedMinor = active.filter(claim => ["paid", "refunded"].includes(claim.state)).reduce((sum, claim) => sum + claim.additionalMinor, 0);
  const pendingMinor = active.filter(claim => ["reserved", "payment_pending"].includes(claim.state)).reduce((sum, claim) => sum + claim.additionalMinor, 0);
  return { consumedMinor, pendingMinor, claimedMinor: consumedMinor + pendingMinor };
}
export function evaluateKitPolicy(input: { policy: KitRepairPolicy; commitment: KitCommitment; proposal: AmendmentProposal; claims: KitRepairClaim[]; wallet: WalletConsent | null; claimId?: string; at?: number }): { allowed: boolean; next: "authorized" | "awaiting_consent" | "requires_payment_approval"; reason: string } {
  const { policy, commitment, proposal, wallet } = input; const at = input.at ?? Date.now();
  const refuse = (reason: string, next: "awaiting_consent" | "requires_payment_approval" = "awaiting_consent") => ({ allowed: false, next, reason });
  if (policy.scope !== "controlled_kit_amendments" || policy.commitmentId !== commitment.id || policy.tenantId !== commitment.tenantId || proposal.commitmentId !== commitment.id) return refuse("This authority belongs to a different controlled merchant commitment.");
  if (policy.revokedAt || Date.parse(policy.expiresAt) <= at || !Number.isFinite(Date.parse(policy.expiresAt))) return refuse("The kit-change allowance has ended. Review fresh authority.");
  if (commitment.lines.some(line => line.fulfillment !== "unfulfilled")) return refuse("This controlled kit has entered fulfillment. Automatic changes have ended.");
  if (proposal.commitmentVersion !== commitment.version || proposal.before.certificate.graphHash !== commitment.current.certificate.graphHash) return refuse("The commitment changed after this proposal. A fresh proposal is required.");
  if (proposal.technicalState !== "satisfied" || !preservedIntent(proposal.before, proposal.after).preserved) return refuse("The change must preserve the original brief and owned equipment and pass every critical technical check.");
  if (!policy.merchantIds.includes(proposal.quote.merchantId) || proposal.quote.currency !== policy.currency) return refuse("The merchant or currency is outside this allowance.");
  const changed = proposal.quote.afterLines.filter(line => proposal.impact.changedComponentIds.includes(line.componentId));
  if (changed.some(line => !policy.categories.includes(line.category) || !policy.vendorDomains.includes(line.domain))) return refuse("The replacement category or sourcing retailer is outside this allowance.");
  if (changed.some(line => !line.condition || !policy.conditions?.includes(line.condition))) return refuse("The replacement condition is outside the explicitly reviewed allowance. Review fresh scope before changing new, used or refurbished equipment.");
  const claimed = grossAllowance(input.claims.filter(claim => claim.id !== input.claimId), policy.id).claimedMinor;
  if (claimed + Math.max(0, proposal.quote.deltaMinor) > policy.capMinor) return refuse("Pending and completed changes would exceed this allowance. Refunds do not restore it.");
  if (policy.paymentMode === "sample") {
    if (!policy.sampleInstrumentConsent || policy.sampleInstrumentConsent !== hash({ id: policy.id, scope: policy.scope, commitmentId: policy.commitmentId, paymentMode: "sample" })) return refuse("A fresh Sample payment-instrument consent is required.", "requires_payment_approval");
  } else if (!wallet || !wallet.tokenId || !wallet.verifiedAt || wallet.state !== "active" || wallet.revokedAt || Date.parse(wallet.expiresAt) <= at || wallet.id !== policy.walletConsentId || wallet.version !== policy.walletConsentVersion || wallet.digest !== policy.walletConsentDigest) return refuse("The saved PayPal wallet has no current usable consent. Approve this exact change in PayPal instead.", "requires_payment_approval");
  return { allowed: true, next: "authorized", reason: "Fresh kit-change authority, original intent, current wallet and gross remaining allowance match." };
}
