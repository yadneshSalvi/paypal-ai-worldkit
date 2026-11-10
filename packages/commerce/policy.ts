import { canonicalJson } from "@fracture/paypal-core";
import type { KitRevision } from "../contracts/index";
import type { RepairPolicy, WalletConsent } from "./contracts";

export function evaluateRepair(input: {
  policy: RepairPolicy; wallet: WalletConsent; original: KitRevision; proposed: KitRevision;
  merchant: string; category: string; additionalMinor: number; consumedMinor: number;
  fulfilled: boolean; now?: number;
}): { allowed: boolean; reason: string; remainingMinor: number } {
  const { policy: p, wallet: w } = input; const now = input.now ?? Date.now();
  const remainingMinor = Math.max(0, p.capMinor - input.consumedMinor);
  const refuse = (reason: string) => ({ allowed: false, reason, remainingMinor });
  if (p.revokedAt || Date.parse(p.expiresAt) <= now) return refuse("This repair authority has expired or was revoked.");
  if (w.revokedAt || w.state !== "active" || Date.parse(w.expiresAt) <= now || !w.tokenId || !w.verifiedAt) return refuse("A current, verified saved wallet is required.");
  if (p.tenantId !== w.tenantId || p.walletConsentId !== w.id || p.walletConsentVersion !== w.version || p.walletConsentDigest !== w.digest) return refuse("The wallet consent no longer matches this repair authority.");
  if (input.original.kitId !== p.kitId || input.proposed.kitId !== p.kitId) return refuse("This authority belongs to another kit.");
  if (!p.merchants.includes(input.merchant) || !p.categories.includes(input.category)) return refuse("That merchant or category is outside this authority.");
  if (input.fulfilled && p.stopAfterFulfillment) return refuse("The original service has already been fulfilled. Review a new order instead.");
  if (!Number.isSafeInteger(input.additionalMinor) || input.additionalMinor < 1 || !Number.isSafeInteger(input.consumedMinor) || input.consumedMinor < 0) return refuse("The incremental amount is invalid.");
  if (input.additionalMinor > remainingMinor) return refuse(`This change exceeds the remaining cumulative allowance of $${(remainingMinor / 100).toFixed(2)}. A new approval is required.`);
  if (canonicalJson(input.original.goal.requirements) !== canonicalJson(input.proposed.goal.requirements) || input.original.goal.budgetMinor !== input.proposed.goal.budgetMinor) return refuse("A changed hard requirement or budget needs a new approval.");
  const owned = (kit: KitRevision) => kit.components.filter(c => c.owned).map(c => ({ id: c.id, profileId: c.profileId, quantity: c.quantity, role: c.role })).sort((a, b) => a.id.localeCompare(b.id));
  if (canonicalJson(owned(input.original)) !== canonicalJson(owned(input.proposed))) return refuse("An owned component would change. Review that replacement explicitly.");
  return { allowed: true, reason: "The current wallet, unchanged requirements, owned equipment, merchant, category and cumulative cap all permit this digital-service amendment.", remainingMinor };
}

export function safeApprovalUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && ["www.sandbox.paypal.com", "sandbox.paypal.com"].includes(url.hostname) && !url.username && !url.password ? url.toString() : null; }
  catch { return null; }
}
