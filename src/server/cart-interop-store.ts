import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { completeCheckoutSchema2, type PayPalCart } from "@paypal/agentic-commerce-spec";
import { cartCredentialLocator, verifyCartCredential } from "../../packages/cart-interop/auth";
import { CartProblem, type CartCatalogueLine, type CartCredential, type CartPrincipal, type CartRevision, type CartScope } from "../../packages/cart-interop/contracts";
import { cartHash, evaluateCart } from "../../packages/cart-interop/evaluate";
import { assertPackEdition } from "../../packages/domain-packs/compiler";
import { PackEditionSchema } from "../../packages/domain-packs/contracts";
import { InventoryItemSchema } from "../../packages/inventory/contracts";
import { initializeCartInterop } from "./cart-interop-db";
import { database } from "./db";
import { domainEditionFreshness } from "./domain-packs";
import type { Session } from "./repository";
import { seal, unseal } from "./secrets";

export type CartActor = { kind: "workspace"; session: Session } | { kind: "integration"; principal: CartPrincipal; token: string };
export type MerchantRow = { id: string; tenant_id: string; account_id: string; audience: string; source_mode: "sample"; disabled_at: Date | null; created_at: Date; session_expires_at: Date };
export type CartRow = { id: string; tenant_id: string; merchant_id: string; current_revision_id: string; version: number; state: "open" | "completed"; expires_at: Date; created_at: Date; completed_at: Date | null };
type CredentialRow = { id: string; merchant_id: string; tenant_id: string; payload: CartCredential; expires_at: Date; revoked_at: Date | null; session_expires_at: Date };
const authenticationFailed = () => new CartProblem(401, "AUTHENTICATION_FAILED", "The merchant integration credential is unavailable, expired or invalid.");
const credentialValue = (row: CredentialRow): CartCredential => ({ ...row.payload, id: row.id, merchantId: row.merchant_id, tenantId: row.tenant_id, expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null, sessionExpiresAt: row.session_expires_at.toISOString() });

export async function authenticateCartRequest(request: Request, required: CartScope): Promise<CartActor> {
  const { id, token } = cartCredentialLocator(request.headers.get("authorization"));
  await initializeCartInterop();
  const row = (await database().query<CredentialRow>(`SELECT c.*,s.expires_at AS session_expires_at FROM wk_cart_credentials c
    JOIN wk_cart_merchants m ON m.id=c.merchant_id AND m.tenant_id=c.tenant_id
    JOIN wk_sessions s ON s.id=c.tenant_id WHERE c.id=$1 AND m.disabled_at IS NULL AND m.source_mode='sample'`, [id])).rows[0];
  if (!row) throw authenticationFailed();
  return { kind: "integration", token, principal: verifyCartCredential(token, credentialValue(row), required) };
}

export async function activeCartSession(db: PoolClient, tenantId: string, write = false): Promise<Date> {
  const row = (await db.query("SELECT expires_at FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR " + (write ? "UPDATE" : "SHARE"), [tenantId])).rows[0];
  if (!row) throw new CartProblem(401, "WORKSPACE_EXPIRED", "This private workspace has expired.");
  return row.expires_at;
}
export const cartActorId = (actor: CartActor) => actor.kind === "workspace" ? `workspace:${actor.session.id}` : `integration:${actor.principal.credentialId}`;

/** Current authority is checked inside the transaction, before even an idempotent replay. */
export async function cartAuthority(db: PoolClient, actor: CartActor, required: CartScope, write = false): Promise<MerchantRow> {
  const tenantId = actor.kind === "workspace" ? actor.session.id : actor.principal.tenantId;
  let expiry = await activeCartSession(db, tenantId);
  const merchant = (await db.query<MerchantRow>("SELECT *, $2::timestamptz AS session_expires_at FROM wk_cart_merchants WHERE tenant_id=$1 AND disabled_at IS NULL AND source_mode='sample' FOR SHARE", [tenantId, expiry])).rows[0];
  if (!merchant) throw new CartProblem(409, "MERCHANT_UNAVAILABLE", "Start the separate Sample merchant before using its cart.");
  // All cart readers and writers take this lock before resource-row locks. That also
  // prevents a concurrent revocation from deadlocking behind a queued checkout.
  await db.query(`SELECT ${write ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended($1,0))`, [`worldkit:cart:${merchant.id}`]);
  expiry = await activeCartSession(db, tenantId); merchant.session_expires_at = expiry;
  if (actor.kind === "integration") {
    if (actor.principal.merchantId !== merchant.id) throw authenticationFailed();
    const row = (await db.query<CredentialRow>("SELECT *, $4::timestamptz AS session_expires_at FROM wk_cart_credentials WHERE id=$1 AND merchant_id=$2 AND tenant_id=$3 FOR SHARE", [actor.principal.credentialId, merchant.id, tenantId, expiry])).rows[0];
    if (!row) throw authenticationFailed();
    const credential = credentialValue(row);
    if (credential.audience !== merchant.audience || credential.accountId !== merchant.account_id) throw authenticationFailed();
    verifyCartCredential(actor.token, credential, required);
  }
  return merchant;
}

export async function cartCatalogue(db: PoolClient, merchant: MerchantRow): Promise<CartCatalogueLine[]> {
  const rows = (await db.query(`SELECT c.*,p.current_edition_id,p.archived_at,e.payload AS edition,ce.graph_hash AS current_graph_hash
    FROM wk_cart_catalogue c JOIN wk_domain_projects p ON p.id=c.project_id AND p.tenant_id=c.tenant_id
    JOIN wk_domain_editions e ON e.id=c.edition_id AND e.project_id=p.id AND e.tenant_id=c.tenant_id
    JOIN wk_domain_editions ce ON ce.id=p.current_edition_id AND ce.project_id=p.id AND ce.tenant_id=c.tenant_id
    WHERE c.merchant_id=$1 AND c.tenant_id=$2 ORDER BY c.created_at DESC,c.id FOR SHARE OF c,p`, [merchant.id, merchant.tenant_id])).rows;
  const inventory = (await db.query("SELECT payload FROM wk_inventory_items WHERE tenant_id=$1 ORDER BY id FOR SHARE", [merchant.tenant_id])).rows.map(row => InventoryItemSchema.parse(row.payload));
  return rows.map(row => {
    const edition = PackEditionSchema.parse(row.edition); assertPackEdition(edition);
    return { id: row.id, parentId: row.payload.parentId, merchantId: merchant.id, title: row.payload.title, description: row.payload.description,
      productKind: row.payload.productKind, sourceMode: row.payload.sourceMode, priceMinor: row.price_minor, stock: row.stock, stockVersion: row.stock_version,
      projectId: row.project_id, editionId: row.edition_id, graphHash: edition.certificate.graphHash, currentEditionId: row.current_edition_id,
      packId: edition.graph.packId, editionNumber: edition.number, componentCount: edition.graph.components.reduce((total, component) => total + component.quantity, 0),
      currentGraphHash: row.current_graph_hash, modelConflicts: edition.certificate.counts.violated, actualHumanReviews: 0, physicalTests: 0,
      active: !row.archived_at, evidenceCurrent: domainEditionFreshness(edition, inventory).current };
  });
}

export async function ownedCart(db: PoolClient, merchant: MerchantRow, id: string, write = false): Promise<CartRow> {
  const row = (await db.query<CartRow>(`SELECT * FROM wk_cart_carts WHERE id=$1 AND merchant_id=$2 AND tenant_id=$3 FOR ${write ? "UPDATE" : "SHARE"}`, [id, merchant.id, merchant.tenant_id])).rows[0];
  if (!row) throw new CartProblem(404, "RESOURCE_NOT_FOUND", "This cart is not available to this merchant.");
  return row;
}
export async function cartRevision(db: PoolClient, row: CartRow, revisionId = row.current_revision_id): Promise<CartRevision> {
  const saved = (await db.query("SELECT * FROM wk_cart_revisions WHERE id=$1 AND cart_id=$2 AND merchant_id=$3 AND tenant_id=$4", [revisionId, row.id, row.merchant_id, row.tenant_id])).rows[0];
  if (!saved) throw new CartProblem(409, "REVISION_UNAVAILABLE", "The saved cart version could not be read.");
  const revision = unseal<CartRevision>(`cart-revision:${row.tenant_id}:${row.id}:${revisionId}`, saved.payload);
  const { hash, ...data } = revision;
  if (hash !== saved.content_hash || hash !== cartHash(data) || revision.id !== revisionId || revision.number !== saved.number
    || revision.evaluationHash !== saved.evaluation_hash || revision.totalMinor !== saved.total_minor || revision.response.id !== row.id)
    throw new CartProblem(409, "REVISION_INTEGRITY", "This cart version did not match its saved proof.");
  if (!completeCheckoutSchema2.safeParse(revision.response).success) throw new CartProblem(409, "REVISION_INTEGRITY", "This saved cart response does not match its protocol contract.");
  return revision;
}
export async function saveCartRevision(db: PoolClient, row: CartRow, input: CartRevision["input"], response: PayPalCart, evaluationHash: string, totalMinor: number | null, id: string): Promise<CartRevision> {
  if (!completeCheckoutSchema2.safeParse(response).success) throw new CartProblem(500, "INVALID_MERCHANT_RESPONSE", "The merchant could not construct a valid cart response.");
  const data = { id, number: row.version, input, response, evaluationHash, totalMinor, createdAt: new Date().toISOString() };
  const revision: CartRevision = { ...data, hash: cartHash(data) };
  await db.query("INSERT INTO wk_cart_revisions(id,cart_id,merchant_id,tenant_id,number,content_hash,evaluation_hash,payload,total_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [id, row.id, row.merchant_id, row.tenant_id, row.version, revision.hash, evaluationHash, seal(`cart-revision:${row.tenant_id}:${row.id}:${id}`, revision), totalMinor]);
  return revision;
}
export async function recordCartEvent(db: PoolClient, merchant: MerchantRow, kind: string, detail: string, cartId: string | null = null, version: number | null = null, extra: Record<string, unknown> = {}) {
  await db.query("INSERT INTO wk_cart_events(id,merchant_id,tenant_id,cart_id,kind,payload) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), merchant.id, merchant.tenant_id, cartId, kind,
    { ...extra, version, detail, sourceMode: "sample", providerCalls: 0, financialCalls: 0, fulfillment: "not_performed" }]);
}
export async function priorCartCommand<T>(db: PoolClient, merchant: MerchantRow, actorId: string, requestId: string, operation: string, inputHash: string): Promise<T | null> {
  const row = (await db.query("SELECT operation,input_hash,response FROM wk_cart_commands WHERE merchant_id=$1 AND tenant_id=$2 AND actor_id=$3 AND request_id=$4", [merchant.id, merchant.tenant_id, actorId, requestId])).rows[0];
  if (!row) return null;
  if (row.operation !== operation || row.input_hash !== inputHash) throw new CartProblem(409, "IDEMPOTENCY_CONFLICT", "This request identity was already used for different cart details. Use a new request identity.");
  return unseal<T>(`cart-command:${merchant.tenant_id}:${merchant.id}:${actorId}:${requestId}`, row.response);
}
export async function recordCartCommand<T>(db: PoolClient, merchant: MerchantRow, actorId: string, requestId: string, operation: string, inputHash: string, response: T) {
  await db.query("INSERT INTO wk_cart_commands(merchant_id,tenant_id,actor_id,request_id,operation,input_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [merchant.id, merchant.tenant_id, actorId, requestId, operation, inputHash, seal(`cart-command:${merchant.tenant_id}:${merchant.id}:${actorId}:${requestId}`, response)]);
}
export async function currentCartEvaluation(db: PoolClient, merchant: MerchantRow, row: CartRow, revision: CartRevision) {
  return evaluateCart(revision.input, await cartCatalogue(db, merchant), merchant.id, row.id);
}
export async function cartReadProjection(db: PoolClient, merchant: MerchantRow, row: CartRow, revision: CartRevision): Promise<{ response: PayPalCart; reviewRequired: boolean }> {
  if (row.state === "completed") return { response: revision.response, reviewRequired: false };
  const evaluation = await currentCartEvaluation(db, merchant, row, revision);
  const expired = row.expires_at.getTime() <= Date.now();
  const token = revision.response.payment_method?.token;
  const approval = token && (await db.query("SELECT payer_id,expires_at,quote_hash,total_minor FROM wk_cart_approvals WHERE token_id=$1 AND cart_id=$2 AND merchant_id=$3 AND tenant_id=$4", [token, row.id, merchant.id, merchant.tenant_id])).rows[0];
  const approvalExpired = !!approval && approval.expires_at.getTime() <= Date.now();
  if (!expired && !approvalExpired && evaluation.digest === revision.evaluationHash) {
    const currentApproval = approval && approval.quote_hash === evaluation.digest && approval.total_minor === evaluation.totalMinor;
    return { response: currentApproval ? { ...revision.response, payment_method: { type: "paypal", token, payer_id: approval.payer_id } } : revision.response, reviewRequired: false };
  }
  const message = expired ? "This cart expired. Create a new cart before approving another Sample checkout." : approvalExpired ? "The Sample buyer approval expired. Replace the cart to review its current details and obtain a new payment identity." : "The merchant or system proof changed. Replace the cart with reviewed current details before approving checkout.";
  return { reviewRequired: true, response: { ...evaluation.cart, status: "INCOMPLETE", validation_status: "INVALID", payment_method: { type: "paypal" }, validation_issues: [
    ...(evaluation.cart.validation_issues ?? []), { code: "BUSINESS_RULE_ERROR", type: "BUSINESS_RULE", message, user_message: message, field: "cart" },
  ] } };
}
