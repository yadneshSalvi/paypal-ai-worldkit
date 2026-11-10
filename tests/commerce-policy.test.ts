import assert from "node:assert/strict";
import test from "node:test";
import { seedKit } from "../packages/device-library/index";
import { evaluateRepair, safeApprovalUrl } from "../packages/commerce/policy";
import type { RepairPolicy, WalletConsent } from "../packages/commerce/contracts";
import { seal, unseal } from "../src/server/secrets";
const kit = seedKit(); const date = "2026-11-11T00:00:00Z";
const wallet: WalletConsent = { id: "consent-a", tenantId: "tenant-a", version: 1, digest: "digest-a", createdAt: date, expiresAt: "2030-01-01T00:00:00Z", revokedAt: null, state: "active", method: "during_purchase", setupId: null, tokenId: "fixture-private-token", customerId: "fixture-customer", payerId: "fixture-payer", merchantCustomerId: "tenant-a", approvalUrl: null, verifiedAt: date, error: null, description: "fixture", origin: "http://localhost:4106" };
const policy: RepairPolicy = { id: "policy-a", tenantId: wallet.tenantId, kitId: kit.kitId, baseOrderId: "order-a", baseRevisionId: kit.id, walletConsentId: wallet.id, walletConsentVersion: 1, walletConsentDigest: wallet.digest, version: 1, digest: "policy-digest", createdAt: date, expiresAt: wallet.expiresAt, revokedAt: null, capMinor: 2500, currency: "USD", merchants: ["worldkit-studio"], categories: ["setup-service"], scope: "digital_setup_amendments", preserveOwned: true, preserveGoal: true, stopAfterFulfillment: true };
const input = () => ({ policy: structuredClone(policy), wallet: structuredClone(wallet), original: structuredClone(kit), proposed: structuredClone(kit), merchant: "worldkit-studio", category: "setup-service", additionalMinor: 800, consumedMinor: 0, fulfilled: false, now: Date.parse(date) });
test("a wallet alone never authorizes a changed merchant, category, goal or owned device", () => {
  assert.equal(evaluateRepair(input()).allowed, true);
  for (const mutate of [ (i: ReturnType<typeof input>) => { i.merchant = "another-seller"; }, (i: ReturnType<typeof input>) => { i.category = "physical-goods"; }, (i: ReturnType<typeof input>) => { i.proposed.goal.budgetMinor++; }, (i: ReturnType<typeof input>) => { i.proposed.components.find(c => c.owned)!.profileId = "replacement"; } ]) { const value = input(); mutate(value); assert.equal(evaluateRepair(value).allowed, false); }
});
test("+8 consumes gross authority and a following +20 or +60 needs a new approval", () => {
  const value = input(); value.consumedMinor = 800; value.additionalMinor = 2000; const result = evaluateRepair(value); assert.equal(result.allowed, false); assert.equal(result.remainingMinor, 1700);
  value.additionalMinor = 6000; assert.equal(evaluateRepair(value).allowed, false);
});
test("pending verification, revoked consent, changed digest and fulfillment stop automatic use", () => {
  for (const mutate of [ (i: ReturnType<typeof input>) => { i.wallet.state = "pending_reconciliation"; }, (i: ReturnType<typeof input>) => { i.wallet.revokedAt = date; }, (i: ReturnType<typeof input>) => { i.wallet.digest = "changed"; }, (i: ReturnType<typeof input>) => { i.policy.revokedAt = date; }, (i: ReturnType<typeof input>) => { i.fulfilled = true; } ]) { const value = input(); mutate(value); assert.equal(evaluateRepair(value).allowed, false); }
});
test("only an exact sandbox PayPal approval URL is allowed", () => {
  assert.ok(safeApprovalUrl("https://www.sandbox.paypal.com/checkoutnow?token=FIXTURE"));
  for (const url of ["https://paypal.com/checkout", "https://sandbox.paypal.com.attacker.test/", "javascript:alert(1)", "https://buyer@www.sandbox.paypal.com/", "http://sandbox.paypal.com/"]) assert.equal(safeApprovalUrl(url), null);
});
test("private records use authenticated tenant-bound encryption with fresh nonces", () => {
  const secret = "fixture-only-encryption-key".repeat(3); const one = seal("tenant-a", wallet, secret); const two = seal("tenant-a", wallet, secret);
  assert.notEqual(one.sealed, two.sealed); assert.equal(JSON.stringify(one).includes(wallet.tokenId!), false); assert.deepEqual(unseal("tenant-a", one, secret), wallet);
  assert.throws(() => unseal("tenant-b", one, secret)); assert.throws(() => unseal("tenant-a", one, "different-fixture-key".repeat(3)));
});
