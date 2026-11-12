import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { CART_SPEC, CartCommandSchema, CartProblem, type CartCommand, type CartCommandResult, type CartGrantView, type CartHome, type CartSystemChoice } from "../../packages/cart-interop/contracts";
import { issueCartCredential } from "../../packages/cart-interop/auth";
import { cartHash } from "../../packages/cart-interop/evaluate";
import { assertPackEdition } from "../../packages/domain-packs/compiler";
import { PackEditionSchema } from "../../packages/domain-packs/contracts";
import { InventoryItemSchema } from "../../packages/inventory/contracts";
import { initializeCartInterop } from "./cart-interop-db";
import { activeCartSession, cartActorId, cartAuthority, cartCatalogue, cartReadProjection, cartRevision, ownedCart, priorCartCommand, recordCartCommand, recordCartEvent, type CartActor, type MerchantRow } from "./cart-interop-store";
import { approveSampleCart, completeMerchantCheckout, createMerchantCart, replaceMerchantCart, runCartOperation } from "./cart-interop";
import { transaction } from "./db";
import { domainEditionFreshness } from "./domain-packs";
import type { Session } from "./repository";

async function systems(db: PoolClient, tenantId: string): Promise<CartSystemChoice[]> {
  const rows = (await db.query(`SELECT p.id,p.title,p.pack_id,e.payload FROM wk_domain_projects p
    JOIN wk_domain_editions e ON e.id=p.current_edition_id AND e.tenant_id=p.tenant_id AND e.project_id=p.id
    WHERE p.tenant_id=$1 AND p.archived_at IS NULL ORDER BY p.created_at DESC,p.id LIMIT 40 FOR SHARE OF p`, [tenantId])).rows;
  const items = (await db.query("SELECT payload FROM wk_inventory_items WHERE tenant_id=$1 ORDER BY id FOR SHARE", [tenantId])).rows.map(row => InventoryItemSchema.parse(row.payload));
  return rows.map(row => {
    const edition = PackEditionSchema.parse(row.payload); assertPackEdition(edition);
    return { id: row.id, title: row.title, packId: row.pack_id, editionId: edition.id, editionNumber: edition.number,
      graphHash: edition.certificate.graphHash, modelConflicts: edition.certificate.counts.violated, modelQuestions: edition.certificate.counts.unknown,
      componentCount: edition.graph.components.reduce((total, component) => total + component.quantity, 0), evidenceCurrent: domainEditionFreshness(edition, items).current };
  });
}
export async function cartHome(session: Session, cartId?: string, revisionId?: string): Promise<CartHome> {
  await initializeCartInterop();
  return transaction(async db => {
    await activeCartSession(db, session.id);
    const exists = (await db.query("SELECT id FROM wk_cart_merchants WHERE tenant_id=$1", [session.id])).rows[0];
    const workspaceKey = cartHash({ purpose: "worldkit.cart.recovery.1", sessionId: session.id });
    const empty: CartHome = { sourceMode: "sample", spec: CART_SPEC, workspaceKey, merchant: null, systems: [], catalogue: [], credentials: [], carts: [], selected: null, events: [] };
    if (!exists) {
      if (cartId || revisionId) throw new CartProblem(404, "RESOURCE_NOT_FOUND", "This cart is not available in the private workspace.");
      empty.systems = await systems(db, session.id); await activeCartSession(db, session.id); return empty;
    }
    const actor: CartActor = { kind: "workspace", session }; const merchant = await cartAuthority(db, actor, "cart");
    const choices = await systems(db, session.id); const catalogue = await cartCatalogue(db, merchant);
    const grants = (await db.query("SELECT id,payload->'scopes' AS scopes,expires_at,revoked_at,created_at FROM wk_cart_credentials WHERE tenant_id=$1 AND merchant_id=$2 ORDER BY created_at DESC LIMIT 50", [session.id, merchant.id])).rows;
    const credentials: CartGrantView[] = grants.map(row => ({ id: row.id, scopes: row.scopes, expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null, createdAt: row.created_at.toISOString() }));
    const cartRows = (await db.query(`SELECT c.id,c.version,c.state,c.created_at,c.expires_at,r.total_minor FROM wk_cart_carts c
      JOIN wk_cart_revisions r ON r.id=c.current_revision_id AND r.cart_id=c.id AND r.merchant_id=c.merchant_id AND r.tenant_id=c.tenant_id
      WHERE c.tenant_id=$1 AND c.merchant_id=$2 ORDER BY c.created_at DESC,c.id LIMIT 40`, [session.id, merchant.id])).rows;
    const carts: CartHome["carts"] = cartRows.map(row => ({ id: row.id, version: row.version, state: row.state, totalMinor: row.total_minor, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() }));
    const selectedId = cartId ?? carts[0]?.id; let selected: CartHome["selected"] = null;
    if (selectedId) {
      const row = await ownedCart(db, merchant, selectedId); const current = await cartRevision(db, row);
      const displayedRevision = revisionId ? await cartRevision(db, row, revisionId) : current;
      const historical = displayedRevision.id !== current.id;
      const projection = await cartReadProjection(db, merchant, row, current);
      const reviewRequired = projection.reviewRequired;
      const history = (await db.query("SELECT id,number,content_hash,evaluation_hash,total_minor,created_at FROM wk_cart_revisions WHERE cart_id=$1 AND tenant_id=$2 AND merchant_id=$3 ORDER BY number DESC LIMIT 100", [row.id, session.id, merchant.id])).rows.map(value => ({ id: value.id, number: value.number, hash: value.content_hash, evaluationHash: value.evaluation_hash, totalMinor: value.total_minor, createdAt: value.created_at.toISOString() }));
      const token = displayedRevision.response.payment_method?.token;
      const approvalRow = token && (await db.query("SELECT * FROM wk_cart_approvals WHERE token_id=$1 AND cart_id=$2 AND tenant_id=$3 AND merchant_id=$4", [token, row.id, session.id, merchant.id])).rows[0];
      selected = { record: { id: row.id, merchantId: row.merchant_id, tenantId: row.tenant_id, sourceMode: "sample", version: row.version, state: row.state,
        current, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null },
        displayedRevision, historical, response: historical ? displayedRevision.response : projection.response, reviewRequired,
        history, approval: approvalRow ? { id: approvalRow.id, token: approvalRow.token_id, payerId: approvalRow.payer_id, expiresAt: approvalRow.expires_at.toISOString(),
          current: !historical && !reviewRequired && row.state === "open" && row.expires_at.getTime() > Date.now() && approvalRow.expires_at.getTime() > Date.now() && approvalRow.quote_hash === current.evaluationHash } : null };
    }
    const events = (await db.query("SELECT id,kind,cart_id,payload,created_at FROM wk_cart_events WHERE merchant_id=$1 AND tenant_id=$2 AND ($3::text IS NULL OR cart_id=$3 OR cart_id IS NULL) ORDER BY created_at DESC,id DESC LIMIT 60", [merchant.id, session.id, selectedId ?? null])).rows.map(row => ({ id: row.id, kind: row.kind, cartId: row.cart_id, version: row.payload.version, detail: row.payload.detail, at: row.created_at.toISOString(), sourceMode: "sample" as const }));
    await cartAuthority(db, actor, "cart");
    return { sourceMode: "sample", spec: CART_SPEC, workspaceKey, merchant: { id: merchant.id, audience: merchant.audience, createdAt: merchant.created_at.toISOString() }, systems: choices, catalogue, credentials, carts, selected, events };
  });
}

async function startMerchant(session: Session, command: Extract<CartCommand, { kind: "start_sample" }>): Promise<CartCommandResult> {
  await initializeCartInterop();
  return transaction(async db => {
    const expiry = await activeCartSession(db, session.id, true); const audience = new URL(process.env.WORLDKIT_PUBLIC_URL ?? "").host;
    const existing = (await db.query<MerchantRow>("SELECT *, $2::timestamptz AS session_expires_at FROM wk_cart_merchants WHERE tenant_id=$1", [session.id, expiry])).rows[0];
    if (existing?.disabled_at) throw new CartProblem(403, "MERCHANT_DISABLED", "This Sample merchant has been disabled. Its history remains retained.");
    const merchant = existing ?? (await db.query<MerchantRow>("INSERT INTO wk_cart_merchants(id,tenant_id,account_id,audience,source_mode) VALUES($1,$2,$3,$4,'sample') RETURNING *, $5::timestamptz AS session_expires_at", [`wkmerchant_${randomUUID()}`, session.id, `WK-SAMPLE-ACCOUNT-${randomUUID()}`, audience, expiry])).rows[0]!;
    const actor = { kind: "workspace" as const, session }; const inputHash = cartHash(command);
    const previous = await priorCartCommand<CartCommandResult>(db, merchant, cartActorId(actor), command.requestId, "merchant.start", inputHash);
    if (previous) return previous;
    if (!existing) await recordCartEvent(db, merchant, "merchant.sample_started", "A separate Sample physical merchant was opened. Program enrollment and real merchant fulfillment remain unestablished.");
    const result = { message: existing ? "Your separate Sample merchant is already open." : "Your Sample merchant is ready. Add an exact saved system to its controlled catalogue." };
    await activeCartSession(db, session.id);
    await recordCartCommand(db, merchant, cartActorId(actor), command.requestId, "merchant.start", inputHash, result); return result;
  });
}
async function addCatalogue(actor: CartActor, command: Extract<CartCommand, { kind: "catalogue_add" }>): Promise<CartCommandResult> {
  return runCartOperation(actor, "catalogue.add", command, command.requestId, "cart", async (db, merchant) => {
    const choice = (await systems(db, merchant.tenant_id)).find(value => value.id === command.projectId);
    if (!choice) throw new CartProblem(404, "SYSTEM_NOT_FOUND", "This saved system is not available in the private workspace.");
    if (choice.editionId !== command.expectedEditionId || choice.graphHash !== command.expectedGraphHash) throw new CartProblem(409, "SYSTEM_CHANGED", "This system changed. Refresh its current edition before adding it to the Sample catalogue.");
    const existing = (await db.query("SELECT id FROM wk_cart_catalogue WHERE merchant_id=$1 AND tenant_id=$2 AND edition_id=$3", [merchant.id, merchant.tenant_id, choice.editionId])).rows[0];
    if (existing) return { message: "This exact system edition is already in the Sample catalogue. Change its stock or price from that entry." };
    const count = (await db.query("SELECT count(*)::integer AS total FROM wk_cart_catalogue WHERE merchant_id=$1 AND tenant_id=$2", [merchant.id, merchant.tenant_id])).rows[0]!.total;
    if (count >= 80) throw new CartProblem(422, "CATALOGUE_LIMIT", "This bounded Sample merchant already has 80 exact catalogue editions.");
    const id = `wksku_${randomUUID()}`;
    const payload = { parentId: `wksystem_${choice.id}`, title: `Sample · ${choice.title}`, description: `Controlled physical-system bundle, edition ${choice.editionNumber}. Example price and stock; no equipment is ordered or shipped.`, productKind: "physical", sourceMode: "sample" };
    await db.query("INSERT INTO wk_cart_catalogue(id,merchant_id,tenant_id,project_id,edition_id,payload,price_minor,stock) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, merchant.id, merchant.tenant_id, choice.id, choice.editionId, payload, command.priceMinor, command.stock]);
    await recordCartEvent(db, merchant, "catalogue.system_added", "An exact saved system edition was added to the Sample physical catalogue.", null, null, { catalogueId: id, projectId: choice.id, editionId: choice.editionId, graphHash: choice.graphHash, priceMinor: command.priceMinor, stock: command.stock });
    return { message: "The exact system edition is in the Sample catalogue. Its model conflicts and current proof will be checked at checkout." };
  });
}
async function changeCatalogue(actor: CartActor, command: Extract<CartCommand, { kind: "catalogue_change" }>): Promise<CartCommandResult> {
  return runCartOperation(actor, "catalogue.change", command, command.requestId, "cart", async (db, merchant) => {
    const row = (await db.query("SELECT * FROM wk_cart_catalogue WHERE id=$1 AND merchant_id=$2 AND tenant_id=$3 FOR UPDATE", [command.catalogueId, merchant.id, merchant.tenant_id])).rows[0];
    if (!row) throw new CartProblem(404, "CATALOGUE_NOT_FOUND", "That catalogue entry is not available to this merchant.");
    if (row.stock_version !== command.expectedStockVersion) throw new CartProblem(409, "CATALOGUE_CHANGED", "The Sample stock or price changed. Refresh before editing it again.");
    if (row.price_minor === command.priceMinor && row.stock === command.stock) return { message: "The Sample stock and price are unchanged." };
    await db.query("UPDATE wk_cart_catalogue SET price_minor=$2,stock=$3,stock_version=stock_version+1 WHERE id=$1", [row.id, command.priceMinor, command.stock]);
    await recordCartEvent(db, merchant, "catalogue.changed", "Sample stock or price changed. Existing carts retain their earlier quotes and require review before completion.", null, null, { catalogueId: row.id, stockVersion: row.stock_version + 1, priceMinor: command.priceMinor, stock: command.stock });
    return { message: "Sample stock and price updated. Earlier cart approval now requires a fresh review." };
  });
}
async function issueCredential(actor: CartActor, command: Extract<CartCommand, { kind: "credential_issue" }>): Promise<CartCommandResult> {
  return runCartOperation<CartCommandResult>(actor, "credential.issue", command, command.requestId, "cart", async (db, merchant) => {
    const count = (await db.query("SELECT count(*)::integer AS total FROM wk_cart_credentials WHERE merchant_id=$1 AND tenant_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()", [merchant.id, merchant.tenant_id])).rows[0]!.total;
    if (count >= 10) throw new CartProblem(422, "CREDENTIAL_LIMIT", "Revoke an existing integration credential before issuing another.");
    const issued = issueCartCredential({ merchantId: merchant.id, tenantId: merchant.tenant_id, audience: merchant.audience, accountId: merchant.account_id, scopes: command.scopes, sessionExpiresAt: merchant.session_expires_at.toISOString() });
    const row = (await db.query("INSERT INTO wk_cart_credentials(id,merchant_id,tenant_id,payload,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING created_at", [issued.credential.id, merchant.id, merchant.tenant_id, issued.credential, issued.credential.expiresAt])).rows[0]!;
    await recordCartEvent(db, merchant, "credential.issued", "A one-hour-or-shorter Sample integration credential was issued. It cannot approve a buyer or authorize real funds.", null, null, { credentialId: issued.credential.id, scopes: command.scopes, expiresAt: issued.credential.expiresAt });
    return { message: "Copy the Sample credential now. It is shown once and its private signing key is not retained.", token: issued.token,
      credential: { id: issued.credential.id, scopes: command.scopes, expiresAt: issued.credential.expiresAt, revokedAt: null, createdAt: row.created_at.toISOString() } };
  }, undefined, value => ({ ...value, token: undefined, secretUnavailable: true, message: "This credential was already issued. Its one-time token cannot be recovered; revoke it before issuing a replacement." }));
}
async function revokeCredential(actor: CartActor, command: Extract<CartCommand, { kind: "credential_revoke" }>): Promise<CartCommandResult> {
  return runCartOperation(actor, "credential.revoke", command, command.requestId, "cart", async (db, merchant) => {
    const row = (await db.query("SELECT id,revoked_at FROM wk_cart_credentials WHERE id=$1 AND merchant_id=$2 AND tenant_id=$3 FOR UPDATE", [command.credentialId, merchant.id, merchant.tenant_id])).rows[0];
    if (!row) throw new CartProblem(404, "CREDENTIAL_NOT_FOUND", "This integration credential is not available in the workspace.");
    if (!row.revoked_at) {
      await db.query("UPDATE wk_cart_credentials SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL", [row.id]);
      await recordCartEvent(db, merchant, "credential.revoked", "The Sample integration credential was revoked. Future requests must pass current authority again.", null, null, { credentialId: row.id });
    }
    return { message: "The Sample integration credential is revoked." };
  });
}
export async function cartWorkbenchCommand(session: Session, value: unknown): Promise<CartCommandResult> {
  const command = CartCommandSchema.parse(value); const actor: CartActor = { kind: "workspace", session };
  switch (command.kind) {
    case "start_sample": return startMerchant(session, command);
    case "catalogue_add": return addCatalogue(actor, command);
    case "catalogue_change": return changeCatalogue(actor, command);
    case "credential_issue": return issueCredential(actor, command);
    case "credential_revoke": return revokeCredential(actor, command);
    case "cart_create": { const cart = await createMerchantCart(actor, command.body, command.requestId); return { cartId: cart.id, message: "Sample cart saved. Review its exact items, amount and system proof before approving." }; }
    case "cart_replace": { const cart = await replaceMerchantCart(actor, command.cartId, command.body, command.requestId, command.expectedVersion); return { cartId: cart.id, message: "The complete Sample cart is saved. Its current approval status is shown below." }; }
    case "cart_approve": { const { kind: _kind, requestId, ...input } = command; const approval = await approveSampleCart(actor, input, requestId); return { cartId: approval.cartId, message: "This exact Sample cart is approved. No real funds were authorized." }; }
    case "cart_complete": { const cart = await completeMerchantCheckout(actor, command.cartId, command.body, command.requestId); return { cartId: cart.id, message: "One Sample settlement is retained. No funds moved and no equipment was ordered or shipped." }; }
  }
}
