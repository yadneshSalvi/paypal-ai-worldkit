import type { PoolClient } from "pg";
import type { ProviderResource } from "@fracture/paypal-core";
import { WorldKitError, type Principal } from "../../packages/contracts";
import { hash } from "../../packages/compatibility";
import { ToolkitReadInput, type ToolkitDesk, type ToolkitOwnedOrder, type ToolkitReadRecord } from "../../packages/commerce/toolkit-contracts";
import type { CommerceOrder } from "../../packages/commerce/contracts";
import type { AmendmentProposal, CompensationRequest, KitAmendment, KitCommitment, KitRepairClaim } from "../../packages/living-repair/contracts";
import { database, transaction } from "./db";
import { initializeCommerce } from "./commerce-db";
import { currentAccess, getRevision, type Session } from "./repository";
import { ScopedPayPalToolkit, type ToolkitReader } from "./paypal-toolkit";
import { initializeLivingRepair } from "./living-repair-db";
import { compensationDigest } from "./living-repair-compensation";

export type PaymentEvidenceActor = { session: Session } | { principal: Principal };
const globalSchema = globalThis as unknown as { worldkitPaymentEvidenceSchema1?: Promise<void> };
export function initializePaymentEvidence() {
  return globalSchema.worldkitPaymentEvidenceSchema1 ??= initializeCommerce().then(async () => {
    await database().query(`CREATE TABLE IF NOT EXISTS wk_payment_evidence_reads (
      id text NOT NULL,tenant_id text NOT NULL REFERENCES wk_sessions(id),order_id text NOT NULL REFERENCES wk_commerce_orders(id),
      actor_id text NOT NULL,input_hash text NOT NULL,binding_hash text NOT NULL,payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id));
      CREATE INDEX IF NOT EXISTS wk_payment_evidence_reads_recent ON wk_payment_evidence_reads(tenant_id,created_at DESC);`);
  }).catch(error => { globalSchema.worldkitPaymentEvidenceSchema1 = undefined; throw error; });
}
const denied = () => new WorldKitError("forbidden", "This payment evidence is outside your current workspace or agent grant.", 403);
const tenant = (actor: PaymentEvidenceActor) => "session" in actor ? actor.session.id : actor.principal.tenantId;
const actorId = (actor: PaymentEvidenceActor) => "session" in actor ? `session:${actor.session.id}` : `grant:${actor.principal.id}`;
async function authorize(actor: PaymentEvidenceActor) {
  if ("principal" in actor) {
    if (!actor.principal.scopes.includes("payment:read") || Date.parse(actor.principal.expiresAt) <= Date.now()) throw denied();
    return currentAccess(actor.principal, "payment:read");
  }
  if (Date.parse(actor.session.expiresAt) <= Date.now()) throw denied();
  const row = await database().query("SELECT id FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp()", [actor.session.id]);
  if (!row.rowCount) throw denied(); return null;
}
async function historicalGraph(order: CommerceOrder, db: Pick<PoolClient, "query">) {
  if (!order.livingRepair) return { bundle: await getRevision(order.tenantId, order.revisionId), manifest: null };
  await initializeLivingRepair();
  const context = order.livingRepair;
  const row = (await db.query("SELECT id,commitment_id,proposal,proposal_digest,payload FROM wk_kit_amendments WHERE id=$1 AND tenant_id=$2", [context.amendmentId, order.tenantId])).rows[0];
  const commitment = (await db.query("SELECT payload FROM wk_kit_commitments WHERE id=$1 AND tenant_id=$2", [context.commitmentId, order.tenantId])).rows[0]?.payload as KitCommitment | undefined;
  if (!row || !commitment) throw denied();
  const proposal = row.proposal as AmendmentProposal, amendment = row.payload as Omit<KitAmendment, "proposal">;
  const { digest, ...body } = proposal, { digest: quoteDigest, ...quote } = proposal.quote;
  if (row.id !== proposal.id || row.commitment_id !== context.commitmentId || proposal.commitmentId !== context.commitmentId || commitment.id !== context.commitmentId || commitment.tenantId !== order.tenantId || commitment.kitId !== order.kitId || row.proposal_digest !== digest || context.proposalDigest !== digest || hash(body) !== digest || hash(quote) !== quoteDigest || !amendment.acceptedAt || context.paymentMode !== "live_sandbox") throw denied();
  if (context.compensationId) {
    const request = (await db.query("SELECT payload FROM wk_kit_compensations WHERE id=$1 AND tenant_id=$2", [context.compensationId, order.tenantId])).rows[0]?.payload as CompensationRequest | undefined;
    if (!request || request.id !== context.compensationId || request.tenantId !== order.tenantId || request.amendmentId !== proposal.id || request.commitmentId !== commitment.id || request.supplementalOrderId !== order.id || !request.consentedAt || request.paymentMode !== "live_sandbox" || !request.restore || request.digest !== compensationDigest(request) || request.digest !== order.quote.quoteHash || request.supplementalMinor !== order.quote.total.minor) throw denied();
    return { bundle: request.restore, manifest: { row, commitment, request } };
  }
  const claim = (await db.query("SELECT payload FROM wk_kit_repair_claims WHERE id=$1 AND tenant_id=$2", [context.claimId, order.tenantId])).rows[0]?.payload as KitRepairClaim | undefined;
  if (!claim || claim.id !== context.claimId || claim.tenantId !== order.tenantId || claim.amendmentId !== proposal.id || claim.commitmentId !== commitment.id || claim.orderId !== order.id || claim.acceptedDigest !== digest || claim.paymentMode !== "live_sandbox" || claim.additionalMinor !== order.quote.total.minor || amendment.claimId !== claim.id || amendment.orderId !== order.id || amendment.paymentMode !== "live_sandbox" || order.quote.quoteHash !== digest || proposal.quote.deltaMinor !== order.quote.total.minor) throw denied();
  return { bundle: proposal.after, manifest: { row, commitment, claim } };
}
async function owned(actor: PaymentEvidenceActor, input: ToolkitReadInput, db: Pick<PoolClient, "query"> = database()) {
  const grant = await authorize(actor);
  const row = (await db.query("SELECT quote_id,payload FROM wk_commerce_orders WHERE id=$1 AND tenant_id=$2", [input.orderId, tenant(actor)])).rows[0];
  if (!row) throw denied(); const order = row.payload as CommerceOrder;
  if (order.id !== input.orderId || order.tenantId !== tenant(actor) || grant && (!grant.allowedKitIds.includes(order.kitId) || !("principal" in actor) || !actor.principal.allowedKitIds.includes(order.kitId))) throw denied();
  if (order.graphHash !== input.expectedGraphHash || order.quote.graphHash !== order.graphHash || order.quote.revisionId !== order.revisionId || order.quote.tenantId !== tenant(actor) || order.quote.id !== row.quote_id || order.quote.merchantId !== "worldkit-studio") throw new WorldKitError("stale_revision", "Use the exact saved graph and accepted Studio quote bound to this order.", 409);
  const { bundle, manifest } = await historicalGraph(order, db);
  if (bundle.kit.id !== order.revisionId || bundle.kit.kitId !== order.kitId || bundle.certificate.graphHash !== order.graphHash || bundle.certificate.id !== order.quote.verificationId) throw denied();
  if (order.sourceMode !== "live_sandbox" || !order.providerOrderId || !order.captureId || !Number.isSafeInteger(order.capturedMinor) || order.capturedMinor <= 0 || order.capturedMinor !== order.quote.total.minor || order.quote.total.currency !== "USD") throw new WorldKitError("needs_evidence", "This read needs an owned sandbox order with an already recorded capture. Sample and uncaptured orders cannot enter PayPal.", 409);
  const resources = (await db.query("SELECT provider_id,kind,payload FROM wk_payment_resources WHERE tenant_id=$1 AND order_id=$2 AND provider_id=ANY($3::text[]) ORDER BY provider_id", [tenant(actor), order.id, [order.providerOrderId, order.captureId]])).rows;
  const payment = resources.find(r => r.provider_id === order.providerOrderId && r.kind === "order")?.payload as ProviderResource | undefined;
  const capture = resources.find(r => r.provider_id === order.captureId && r.kind === "capture")?.payload as ProviderResource | undefined;
  if (resources.length !== 2 || !payment || !capture || payment.id !== order.providerOrderId || payment.kind !== "order" || payment.customId !== order.id || payment.source !== "live_sandbox" || capture.id !== order.captureId || capture.kind !== "capture" || capture.parentId !== payment.id || capture.source !== "live_sandbox" || capture.money?.minor !== order.capturedMinor || capture.money.currency !== "USD") throw denied();
  const binding: ToolkitOwnedOrder = { orderId: order.id, kitId: order.kitId, revisionId: order.revisionId, graphHash: order.graphHash, providerOrderId: order.providerOrderId, captureId: order.captureId, customId: order.id, amountMinor: order.capturedMinor };
  return { binding, fingerprint: hash({ order, resources, manifest }) };
}
export function toolkitAvailability(): Pick<ToolkitDesk, "available" | "mode" | "message"> {
  const available = process.env.WORLDKIT_TOOLKIT_READS_ENABLED === "1" && process.env.WORLDKIT_DISABLE_PROVIDERS !== "true" && !process.env.WORLDKIT_QA_MODE && process.env.PAYPAL_ENVIRONMENT === "sandbox" && !!process.env.PAYPAL_PROJECT_ISOLATED && !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET && (!process.env.DEBUG || !/agent-toolkit|\*/.test(process.env.DEBUG));
  return { available, mode: "sandbox", message: available ? "Read this order directly from PayPal’s sandbox. Each observation is saved separately from the original receipt." : "Live PayPal reads are unavailable here. Previously saved observations remain available." };
}
function productionReader(): ToolkitReader {
  if (!toolkitAvailability().available) throw new WorldKitError("provider_unavailable", "Live PayPal evidence reads are unavailable. Saved observations remain available.", 503);
  return new ScopedPayPalToolkit(process.env.PAYPAL_CLIENT_ID!, process.env.PAYPAL_CLIENT_SECRET!);
}
function displayRecord(value: ToolkitReadRecord): ToolkitReadRecord {
  if (value.state === "running" && Date.now() - Date.parse(value.createdAt) > 120000) return { ...value, message: "This read was interrupted before its result was saved. It will not be dispatched again. Start a separate read to obtain a fresh observation." };
  return value;
}
export async function readPaymentEvidence(actor: PaymentEvidenceActor, raw: ToolkitReadInput, injected?: ToolkitReader): Promise<ToolkitReadRecord> {
  const input = ToolkitReadInput.parse(raw); await initializePaymentEvidence();
  const original = await owned(actor, input), inputHash = hash(input), id = actorId(actor), tenantId = tenant(actor);
  const revalidate = async () => { if ((await owned(actor, input)).fingerprint !== original.fingerprint) throw new WorldKitError("stale_revision", "This order or its resource binding changed during the read. The observation was withheld.", 409); };
  const claimed = await transaction(async db => {
    await db.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [tenantId]); await authorize(actor);
    const existing = (await db.query("SELECT input_hash,actor_id,payload FROM wk_payment_evidence_reads WHERE tenant_id=$1 AND id=$2", [tenantId, input.requestId])).rows[0];
    if (existing) {
      if (existing.input_hash !== inputHash || existing.actor_id !== id) throw new WorldKitError("invalid_request", "This read identity already belongs to a different request or caller. Start a new read.", 409);
      return { dispatch: false, record: existing.payload as ToolkitReadRecord };
    }
    const recent = (await db.query("SELECT count(*)::int AS n FROM wk_payment_evidence_reads WHERE tenant_id=$1 AND created_at>now()-interval '1 minute'", [tenantId])).rows[0];
    if (recent.n >= 6) throw new WorldKitError("rate_limited", "Six evidence reads per minute are available in this workspace. Saved observations remain available.", 429);
    if (!injected) productionReader();
    const record: ToolkitReadRecord = { id: input.requestId, orderId: input.orderId, graphHash: input.expectedGraphHash, operation: input.operation, state: "running", createdAt: new Date().toISOString(), finishedAt: null, observation: null, message: "Reading the exact owned resource. Your original payment state is unchanged." };
    await db.query("INSERT INTO wk_payment_evidence_reads(id,tenant_id,order_id,actor_id,input_hash,binding_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7)", [input.requestId, tenantId, input.orderId, id, inputHash, original.fingerprint, record]);
    return { dispatch: true, record };
  });
  if (!claimed.dispatch) { await revalidate(); return displayRecord(claimed.record); }
  let record: ToolkitReadRecord;
  try {
    const observation = await (injected ?? productionReader()).read(input.operation, original.binding, revalidate);
    await revalidate();
    if (hash(observation.binding) !== hash(original.binding) || observation.operation !== input.operation) throw denied();
    record = { ...claimed.record, state: "succeeded", finishedAt: new Date().toISOString(), observation, message: "Saved a separate PayPal observation. The original receipt and payment state are unchanged." };
  } catch (error) {
    record = { ...claimed.record, state: "failed", finishedAt: new Date().toISOString(), message: error instanceof WorldKitError ? error.message : "The PayPal read did not complete. No successful or missing payment was inferred." };
  }
  await database().query("UPDATE wk_payment_evidence_reads SET payload=$3 WHERE tenant_id=$1 AND id=$2 AND payload->>'state'='running'", [tenantId, input.requestId, record]);
  await revalidate(); return record;
}
export async function paymentEvidenceDesk(session: Session): Promise<ToolkitDesk> {
  await initializePaymentEvidence(); await authorize({ session });
  const [reads, orders] = await Promise.all([
    database().query("SELECT payload FROM wk_payment_evidence_reads WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20", [session.id]),
    database().query("SELECT payload FROM wk_commerce_orders WHERE tenant_id=$1 AND payload->>'sourceMode'='live_sandbox' AND payload->>'captureId' IS NOT NULL AND payload->>'providerOrderId' IS NOT NULL AND (payload->>'capturedMinor')::bigint>0 ORDER BY created_at DESC,id DESC LIMIT 100", [session.id]),
  ]);
  await authorize({ session });
  return { ...toolkitAvailability(), orders: orders.rows.map(row => { const order = row.payload as CommerceOrder; return { id: order.id, graphHash: order.graphHash, createdAt: order.createdAt, capturedMinor: order.capturedMinor, purpose: order.livingRepair ? "Controlled kit amendment" as const : order.kind === "amendment" ? "Studio amendment" as const : "Studio service" as const }; }), records: reads.rows.map(row => displayRecord(row.payload)) };
}
