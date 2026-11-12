import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { CompleteCheckoutResponse, PayPalCart } from "@paypal/agentic-commerce-spec";
import { z } from "zod";
import { CartInputSchema, CartProblem, type CartInput, type CartRevision, type CartScope } from "../../packages/cart-interop/contracts";
import { cartHash, evaluateCart } from "../../packages/cart-interop/evaluate";
import { initializeCartInterop } from "./cart-interop-db";
import { cartActorId, cartAuthority, cartCatalogue, cartReadProjection, cartRevision, currentCartEvaluation, ownedCart, priorCartCommand, recordCartCommand, recordCartEvent, saveCartRevision, type CartActor, type CartRow, type MerchantRow } from "./cart-interop-store";
import { transaction } from "./db";
import { seal } from "./secrets";

export const CartRequestId = z.string().min(8).max(120).regex(/^[A-Za-z0-9:_-]+$/);
const cartIdSchema = z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/);
type Failure = { status: number; code: string; message: string; issue?: CartProblem["issue"] };
type Outcome<T> = { value: T } | { problem: Failure };
const business = (code: string, message: string, field = "cart") => new CartProblem(422, code, message, { code: "BUSINESS_RULE_ERROR", type: "BUSINESS_RULE", message, user_message: message, field });
const stripPayment = (body: CartInput): CartInput => { const { payment_method: _payment, ...input } = body; return input; };

/** Receipts and refusals survive retries, but never bypass current authority. */
export async function runCartOperation<T>(actor: CartActor, operation: string, input: unknown, requestId: string | undefined, scope: CartScope,
  work: (db: PoolClient, merchant: MerchantRow) => Promise<T>, cartId?: string, receiptValue: (value: T) => T = value => value): Promise<T> {
  const identity = CartRequestId.parse(requestId ?? randomUUID()); const inputHash = cartHash(input);
  await initializeCartInterop();
  const outcome = await transaction(async db => {
    const merchant = await cartAuthority(db, actor, scope, true); const actorId = cartActorId(actor);
    const previous = await priorCartCommand<Outcome<T>>(db, merchant, actorId, identity, operation, inputHash);
    if (previous) { await cartAuthority(db, actor, scope); return previous; }
    await db.query("SAVEPOINT cart_operation"); let result: Outcome<T>;
    try { result = { value: await work(db, merchant) }; }
    catch (error) {
      if (!(error instanceof CartProblem) || error.status < 400 || error.status >= 500) throw error;
      await db.query("ROLLBACK TO SAVEPOINT cart_operation");
      const ownedId = cartId && (await db.query("SELECT id FROM wk_cart_carts WHERE id=$1 AND merchant_id=$2 AND tenant_id=$3", [cartId, merchant.id, merchant.tenant_id])).rowCount ? cartId : null;
      await recordCartEvent(db, merchant, "cart.operation_refused", error.message, ownedId, null, { operation, code: error.code });
      result = { problem: { status: error.status, code: error.code, message: error.message, ...(error.issue ? { issue: error.issue } : {}) } };
    }
    await cartAuthority(db, actor, scope);
    await recordCartCommand(db, merchant, actorId, identity, operation, inputHash, "value" in result ? { value: receiptValue(result.value) } : result);
    return result;
  });
  if ("problem" in outcome) throw new CartProblem(outcome.problem.status, outcome.problem.code, outcome.problem.message, outcome.problem.issue);
  return outcome.value;
}
function requireOpen(row: CartRow) {
  if (row.state !== "open") throw business("CART_COMPLETED", "This cart is complete. Its retained receipt cannot be replaced; create a new cart.");
  if (row.expires_at.getTime() <= Date.now()) throw business("CART_EXPIRED", "This cart expired. Create a new cart before approving another Sample checkout.");
}
function requireVersion(row: CartRow, expected?: number) {
  if (expected !== undefined && row.version !== expected) throw new CartProblem(409, "CART_VERSION_CHANGED", "The saved cart changed. Refresh its exact version before continuing.");
}
function requireOwnPayment(body: CartInput, current?: PayPalCart) {
  const payment = body.payment_method;
  if (payment?.approval_url || payment?.payer_id || payment?.token && payment.token !== current?.payment_method?.token)
    throw business("PAYMENT_IDENTITY_MISMATCH", "Payment identity belongs to one saved cart. Replace cart details first, then approve that exact Sample cart separately.", "payment_method");
}
async function createRevision(db: PoolClient, merchant: MerchantRow, row: CartRow, input: CartInput, created = false) {
  const evaluation = evaluateCart(input, await cartCatalogue(db, merchant), merchant.id, row.id);
  const revisionId = row.current_revision_id;
  const token = evaluation.issues.length ? null : `WK-SAMPLE-TOKEN-${randomUUID()}`;
  const response: PayPalCart = { ...evaluation.cart, ...(created && !evaluation.issues.length ? { status: "CREATED" as const } : {}),
    payment_method: { type: "paypal", ...(token ? { token } : {}) } };
  const revision = await saveCartRevision(db, row, input, response, evaluation.digest, evaluation.totalMinor, revisionId);
  if (token && evaluation.totalMinor !== null) await db.query("INSERT INTO wk_cart_payment_tokens(id,cart_id,merchant_id,tenant_id,revision_id,quote_hash,total_minor,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [token, row.id, merchant.id, merchant.tenant_id, revision.id, evaluation.digest, evaluation.totalMinor, row.expires_at]);
  return revision;
}

export async function createMerchantCart(actor: CartActor, value: unknown, requestId?: string): Promise<PayPalCart> {
  const body = CartInputSchema.parse(value);
  return runCartOperation(actor, "cart.create", body, requestId, "cart", async (db, merchant) => {
    requireOwnPayment(body);
    const id = `wkcart_${randomUUID()}`; const revisionId = `wkcartrev_${randomUUID()}`;
    const expiresAt = new Date(Math.min(Date.now() + 30 * 60_000, merchant.session_expires_at.getTime()));
    const row = (await db.query<CartRow>("INSERT INTO wk_cart_carts(id,merchant_id,tenant_id,version,state,current_revision_id,expires_at) VALUES($1,$2,$3,1,'open',$4,$5) RETURNING *", [id, merchant.id, merchant.tenant_id, revisionId, expiresAt])).rows[0]!;
    const revision = await createRevision(db, merchant, row, stripPayment(body), true);
    await recordCartEvent(db, merchant, "cart.created", "A new Sample cart was saved. Nothing is reserved or ordered.", id, 1, { evaluationHash: revision.evaluationHash, totalMinor: revision.totalMinor });
    return revision.response;
  });
}
export async function getMerchantCart(actor: CartActor, id: string): Promise<PayPalCart> {
  cartIdSchema.parse(id); await initializeCartInterop();
  return transaction(async db => {
    const merchant = await cartAuthority(db, actor, "cart"); const row = await ownedCart(db, merchant, id);
    const projection = await cartReadProjection(db, merchant, row, await cartRevision(db, row));
    await cartAuthority(db, actor, "cart"); return projection.response;
  });
}
export async function replaceMerchantCart(actor: CartActor, id: string, value: unknown, requestId?: string, expectedVersion?: number): Promise<PayPalCart> {
  cartIdSchema.parse(id); const body = CartInputSchema.parse(value);
  return runCartOperation(actor, "cart.replace", { id, body, expectedVersion }, requestId, "cart", async (db, merchant) => {
    const row = await ownedCart(db, merchant, id, true); requireOpen(row); requireVersion(row, expectedVersion);
    const current = await cartRevision(db, row); requireOwnPayment(body, current.response);
    const input = stripPayment(body); const evaluation = evaluateCart(input, await cartCatalogue(db, merchant), merchant.id, id);
    const expiredApproval = current.response.payment_method?.token && (await db.query("SELECT id FROM wk_cart_approvals WHERE token_id=$1 AND cart_id=$2 AND merchant_id=$3 AND tenant_id=$4 AND expires_at<=clock_timestamp()", [current.response.payment_method.token, id, merchant.id, merchant.tenant_id])).rowCount;
    // The evaluated quote omits caller-supplied labels and equivalent selections.
    // PUT still replaces the entire writable document, so quote equality alone
    // cannot retain fields the client explicitly omitted from its replacement.
    if (evaluation.digest === current.evaluationHash && cartHash(input) === cartHash(current.input) && !expiredApproval) return current.response;
    const next = { ...row, version: row.version + 1, current_revision_id: `wkcartrev_${randomUUID()}` };
    const revision = await createRevision(db, merchant, next, input);
    await db.query("UPDATE wk_cart_carts SET version=$2,current_revision_id=$3 WHERE id=$1", [id, next.version, next.current_revision_id]);
    await recordCartEvent(db, merchant, "cart.replaced", "The complete cart document was replaced. Earlier approval does not authorize this version.", id, next.version, { evaluationHash: revision.evaluationHash, previousRevisionId: current.id, totalMinor: revision.totalMinor });
    return revision.response;
  }, id);
}

const ApprovalSchema = z.object({ cartId: cartIdSchema, expectedVersion: z.number().int().positive(), evaluationHash: z.string().length(64), token: z.string().min(8).max(120), acknowledgedSample: z.literal(true) }).strict();
export type SampleApproval = { id: string; token: string; payerId: string; expiresAt: string; cartId: string; version: number; totalMinor: number; sourceMode: "sample" };
export async function approveSampleCart(actor: CartActor, value: unknown, requestId?: string): Promise<SampleApproval> {
  if (actor.kind !== "workspace") throw new CartProblem(403, "BUYER_APPROVAL_REQUIRED", "Only the private workspace's explicit Sample buyer action can approve this cart.");
  const input = ApprovalSchema.parse(value);
  return runCartOperation(actor, "cart.approve_sample", input, requestId, "cart", async (db, merchant) => {
    const row = await ownedCart(db, merchant, input.cartId, true); requireOpen(row); requireVersion(row, input.expectedVersion);
    const revision = await cartRevision(db, row); const evaluation = await currentCartEvaluation(db, merchant, row, revision);
    if (evaluation.issues.length || evaluation.digest !== revision.evaluationHash || input.evaluationHash !== revision.evaluationHash || evaluation.totalMinor === null)
      throw business("CART_REVIEW_REQUIRED", "This cart's stock, price or system proof changed. Replace it with reviewed current details before approving it.");
    const token = (await db.query("SELECT * FROM wk_cart_payment_tokens WHERE id=$1 AND cart_id=$2 AND merchant_id=$3 AND tenant_id=$4 AND revision_id=$5 AND expires_at>clock_timestamp()", [input.token, row.id, merchant.id, merchant.tenant_id, revision.id])).rows[0];
    if (!token || token.quote_hash !== evaluation.digest || token.total_minor !== evaluation.totalMinor) throw business("PAYMENT_IDENTITY_MISMATCH", "This payment identity is unavailable for the exact saved cart version.", "payment_method.token");
    const existing = (await db.query("SELECT * FROM wk_cart_approvals WHERE token_id=$1 AND cart_id=$2 AND merchant_id=$3 AND tenant_id=$4", [input.token, row.id, merchant.id, merchant.tenant_id])).rows[0];
    if (existing) {
      if (existing.expires_at.getTime() <= Date.now()) throw business("APPROVAL_EXPIRED", "The Sample approval expired. Replace the cart to obtain a new payment identity.", "payment_method");
      return { id: existing.id, token: input.token, payerId: existing.payer_id, expiresAt: existing.expires_at.toISOString(), cartId: row.id, version: row.version, totalMinor: existing.total_minor, sourceMode: "sample" };
    }
    const approval: SampleApproval = { id: `wkappr_${randomUUID()}`, token: input.token, payerId: `WK-SAMPLE-PAYER-${randomUUID()}`, expiresAt: new Date(Math.min(Date.now() + 10 * 60_000, token.expires_at.getTime(), merchant.session_expires_at.getTime())).toISOString(), cartId: row.id, version: row.version, totalMinor: evaluation.totalMinor, sourceMode: "sample" };
    await db.query("INSERT INTO wk_cart_approvals(id,cart_id,merchant_id,tenant_id,token_id,quote_hash,total_minor,payer_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [approval.id, row.id, merchant.id, merchant.tenant_id, input.token, evaluation.digest, evaluation.totalMinor, approval.payerId, approval.expiresAt]);
    await recordCartEvent(db, merchant, "cart.sample_approved", "The Sample buyer explicitly approved this exact cart, amount and system proof. No real payment was authorized.", row.id, row.version, { approvalId: approval.id, evaluationHash: evaluation.digest, totalMinor: evaluation.totalMinor });
    return approval;
  }, input.cartId);
}

function requireMatchingCheckoutFields(body: CartInput, revision: CartRevision) {
  for (const [key, value] of Object.entries(stripPayment(body))) if (revision.input[key as keyof CartInput] === undefined || cartHash(value) !== cartHash(revision.input[key as keyof CartInput]))
    throw business("CHECKOUT_DETAILS_CHANGED", "Checkout cannot silently replace the saved cart. Send the complete replacement first and approve its new version.", key);
}
export async function completeMerchantCheckout(actor: CartActor, id: string, value: unknown, requestId?: string): Promise<CompleteCheckoutResponse> {
  cartIdSchema.parse(id); const body = CartInputSchema.parse(value);
  return runCartOperation(actor, "cart.complete", { id, body }, requestId, "checkout", async (db, merchant) => {
    const row = await ownedCart(db, merchant, id, true); const revision = await cartRevision(db, row); const payment = body.payment_method;
    if (!payment?.token || !payment.payer_id || payment.approval_url) throw business("BUYER_APPROVAL_REQUIRED", "An exact owned payment identity and explicit Sample buyer approval are required.", "payment_method");
    requireMatchingCheckoutFields(body, revision);
    if (row.state === "completed") {
      if (revision.response.payment_method?.token !== payment.token || revision.response.payment_method?.payer_id !== payment.payer_id)
        throw business("PAYMENT_IDENTITY_MISMATCH", "This completed receipt belongs to a different payment or buyer identity.", "payment_method");
      return revision.response;
    }
    requireOpen(row);
    const token = (await db.query("SELECT * FROM wk_cart_payment_tokens WHERE id=$1 AND cart_id=$2 AND merchant_id=$3 AND tenant_id=$4 AND revision_id=$5 AND expires_at>clock_timestamp()", [payment.token, id, merchant.id, merchant.tenant_id, revision.id])).rows[0];
    const approval = (await db.query("SELECT * FROM wk_cart_approvals WHERE token_id=$1 AND cart_id=$2 AND merchant_id=$3 AND tenant_id=$4 AND payer_id=$5 AND expires_at>clock_timestamp()", [payment.token, id, merchant.id, merchant.tenant_id, payment.payer_id])).rows[0];
    if (!token || !approval) throw business("BUYER_APPROVAL_REQUIRED", "The exact cart payment identity has no current Sample buyer approval. Review and approve this version first.", "payment_method");
    const requireCurrentApproval = () => {
      requireOpen(row);
      if (approval.expires_at.getTime() <= Date.now() || token.expires_at.getTime() <= Date.now())
        throw business("APPROVAL_EXPIRED", "The Sample buyer approval expired while this checkout was being checked. Review and approve a new cart version before continuing.", "payment_method");
    };
    const evaluation = await currentCartEvaluation(db, merchant, row, revision);
    requireCurrentApproval();
    if (evaluation.issues.length || evaluation.digest !== revision.evaluationHash || token.quote_hash !== evaluation.digest || approval.quote_hash !== evaluation.digest
      || evaluation.totalMinor === null || token.total_minor !== evaluation.totalMinor || approval.total_minor !== evaluation.totalMinor)
      throw business("CART_REVIEW_REQUIRED", "The price, stock or system proof changed after approval. Replace the cart and approve its exact new version before completing it.");
    for (const item of evaluation.cart.items ?? []) {
      const updated = await db.query("UPDATE wk_cart_catalogue SET stock=stock-$4,stock_version=stock_version+1 WHERE id=$1 AND merchant_id=$2 AND tenant_id=$3 AND stock>=$4 RETURNING id", [item.variant_id, merchant.id, merchant.tenant_id, item.quantity]);
      if (updated.rowCount !== 1) throw business("STOCK_UNAVAILABLE", "The current Sample stock is insufficient. Review the cart before continuing.", "items");
    }
    const settlementId = `WK-SAMPLE-SETTLEMENT-${randomUUID()}`;
    const response: CompleteCheckoutResponse = { ...revision.response, status: "COMPLETED", payment_method: { type: "paypal", token: payment.token, payer_id: payment.payer_id }, payment_confirmation: { merchant_order_number: settlementId } };
    const next = { ...row, version: row.version + 1, current_revision_id: `wkcartrev_${randomUUID()}` };
    await saveCartRevision(db, next, revision.input, response, revision.evaluationHash, revision.totalMinor, next.current_revision_id);
    await db.query("INSERT INTO wk_cart_settlements(id,cart_id,merchant_id,tenant_id,token_id,payload) VALUES($1,$2,$3,$4,$5,$6)", [settlementId, id, merchant.id, merchant.tenant_id, payment.token,
      seal(`cart-settlement:${merchant.tenant_id}:${id}`, { id: settlementId, cartId: id, approvedRevisionId: revision.id, evaluationHash: evaluation.digest, graphHashes: evaluation.graphHashes, totalMinor: evaluation.totalMinor, currency: "USD", sourceMode: "sample", providerCalls: 0, financialCalls: 0, fulfillment: "not_performed" })]);
    await db.query("UPDATE wk_cart_carts SET version=$2,current_revision_id=$3,state='completed',completed_at=clock_timestamp() WHERE id=$1", [id, next.version, next.current_revision_id]);
    await recordCartEvent(db, merchant, "cart.sample_completed", "One Sample settlement was recorded and Sample stock adjusted. No funds moved and no equipment was ordered or shipped.", id, next.version, { settlementId, approvedRevisionId: revision.id, evaluationHash: evaluation.digest, totalMinor: evaluation.totalMinor });
    requireCurrentApproval();
    return response;
  }, id);
}
