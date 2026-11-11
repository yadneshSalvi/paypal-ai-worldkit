import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PayPalWebhookVerifier, canonicalJson, type PaymentOperation, type WebhookVerifier } from "@fracture/paypal-core";
import { WorldKitError } from "../../packages/contracts";
import { sha256 } from "../../packages/spec-evidence/sources";
import { Channel3EventSchema, PayPalEventSchema, ProviderIdSchema, commercialSignal, paymentSignal, type CommercialSignal, type PaymentSignal, type WebhookProvider, type WebhookSource, type WebhookState, type WebhookSummary } from "../../packages/webhooks/contracts";
import { channel3Headers, paypalHeaders, verifyChannel3, webhookBodyLimit } from "../../packages/webhooks/signatures";
import { signalMatchesScope, type SubscriptionScope } from "../../packages/living-kit/subscriptions";
import { database, transaction } from "./db";
import { initializeLiving } from "./living-db";
import { sandboxConfig } from "./payment-provider";
import { seal, unseal } from "./secrets";
import type { FinancialAuthority } from "../../packages/commerce/contracts";

export type EventRow = { id: string; provider: WebhookProvider; namespace: string; source_mode: WebhookSource; event_id: string; event_type: string; committed_at: Date | null; body_hash: string; signal: CommercialSignal | PaymentSignal | null; state: WebhookState; owner_key: string | null; tenant_ids: string[]; attempts: number; failures: number; deliveries: number; conflicts: number; error: string | null; received_at: Date; lease_token: string | null; lease_expires_at: Date | null };
export type WebhookClaim = EventRow & { lease_token: string };
export type EventOwners = { ownerKey: string | null; tenantIds: string[]; watchIds: string[]; orderId: string | null; ambiguous: boolean };
const emptyOwners = (): EventOwners => ({ ownerKey: null, tenantIds: [], watchIds: [], orderId: null, ambiguous: false });
const globalVerifier = globalThis as unknown as { worldkitWebhookVerifier?: { id: string; verifier: PayPalWebhookVerifier } };
function configuredPayPalVerifier() {
  const id = process.env.PAYPAL_WEBHOOK_ID;
  if (!id || id === "WEBHOOK_ID") throw new WorldKitError("provider_unavailable", "The PayPal webhook endpoint has not been registered.", 503);
  if (globalVerifier.worldkitWebhookVerifier?.id !== id) globalVerifier.worldkitWebhookVerifier = { id, verifier: new PayPalWebhookVerifier(sandboxConfig(), id) };
  return globalVerifier.worldkitWebhookVerifier.verifier;
}
export function webhookReadiness() { return { channel3: Boolean(process.env.CHANNEL3_WEBHOOK_SECRET?.startsWith("whsec_")), paypal: Boolean(process.env.PAYPAL_WEBHOOK_ID && process.env.PAYPAL_WEBHOOK_ID !== "WEBHOOK_ID") }; }

export async function routeEventOwners(provider: WebhookProvider, signal: CommercialSignal | PaymentSignal, source: WebhookSource, db: Pick<PoolClient, "query"> = database()): Promise<EventOwners> {
  if (provider === "channel3") {
    const commercial = signal as CommercialSignal;
    const rows = await db.query("SELECT s.scope,s.provider_id,w.id AS watch_id,w.tenant_id FROM wk_offer_subscriptions s JOIN wk_offer_watch_resources r ON r.subscription_id=s.id JOIN wk_offer_watches w ON w.id=r.watch_id JOIN wk_sessions t ON t.id=w.tenant_id JOIN wk_inventory_items i ON i.id=w.item_id WHERE s.provider_id=$1 AND s.source_mode=$2 AND w.stopped_at IS NULL AND t.expires_at>now() AND i.payload->>'status'='active' AND (i.payload->>'version')::int=w.item_version", [commercial.subscriptionId, source]);
    const matching = rows.rows.filter(row => signalMatchesScope(commercial, row.provider_id, row.scope as SubscriptionScope));
    return { ownerKey: matching.length ? `catalog:${commercial.subscriptionId}` : null, tenantIds: [...new Set(matching.map(row => row.tenant_id as string))], watchIds: [...new Set(matching.map(row => row.watch_id as string))], orderId: null, ambiguous: false };
  }
  const payment = signal as PaymentSignal;
  if (payment.identityConflict) return { ...emptyOwners(), ambiguous: true };
  const ids = [payment.resourceId, payment.relatedOrderId, payment.relatedCaptureId, payment.relatedRefundId].filter((id): id is string => Boolean(id));
  const rows = await db.query("SELECT DISTINCT r.tenant_id,r.order_id FROM wk_payment_resources r WHERE r.provider_id=ANY($1::text[]) AND r.payload->>'source'=$2", [ids, source === "live" ? "live_sandbox" : source]);
  const owners = new Map(rows.rows.map(row => [row.order_id, { tenantId: row.tenant_id as string, orderId: row.order_id as string }]));
  // The shared core indexes a capture/refund before the domain projection commits.
  const coreExists = (await db.query("SELECT to_regclass('paycore_operations') AS present")).rows[0]?.present;
  if (coreExists) {
    const accepted = await db.query("SELECT a.tenant_id,a.order_id,a.operation_id,a.payload AS authority,p.document FROM wk_financial_authorities a JOIN paycore_operations p ON p.id=a.operation_id AND p.tenant_id=a.tenant_id AND p.project_id='worldkit' WHERE p.provider_effect_id=ANY($1::text[]) OR a.order_id=$2 OR a.operation_id=$2 LIMIT 50", [ids, payment.customId]);
    for (const row of accepted.rows) {
      try {
        const authority = unseal<FinancialAuthority>(row.tenant_id, row.authority);
        const encoded = JSON.parse(row.document); if (!encoded.worldkitOperation || encoded.tenantId !== row.tenant_id) continue;
        const operation = unseal<PaymentOperation>(row.tenant_id, encoded);
        const expectedSource = source === "live" ? "live_sandbox" : source;
        if (authority.tenantId !== row.tenant_id || authority.orderId !== row.order_id || authority.command.operationId !== row.operation_id || operation.command.scope.tenantId !== row.tenant_id || operation.command.scope.projectId !== "worldkit" || canonicalJson(operation.command) !== canonicalJson(authority.command) || operation.receipt?.source !== expectedSource) continue;
        if (!operation.receipt.resources.some(resource => resource.source === expectedSource && ids.includes(resource.id))) continue;
        owners.set(row.order_id, { tenantId: row.tenant_id, orderId: row.order_id });
      } catch { /* A malformed or foreign encrypted operation cannot establish ownership. */ }
    }
  }
  if (owners.size > 1) return { ...emptyOwners(), ambiguous: true };
  const owner = [...owners.values()][0];
  return owner ? { ownerKey: `payment:${owner.orderId}`, tenantIds: [owner.tenantId], watchIds: [], orderId: owner.orderId, ambiguous: false } : emptyOwners();
}

type IntakeOptions = { paypalVerifier?: WebhookVerifier; channel3Secrets?: string[]; sourceMode?: WebhookSource; namespace?: string };
export async function acceptWebhook(provider: WebhookProvider, rawBody: string, headers: Headers, options: IntakeOptions = {}): Promise<{ accepted: true; duplicate: boolean; conflict: boolean; state: WebhookState }> {
  if (Buffer.byteLength(rawBody) > webhookBodyLimit) throw new WorldKitError("invalid_request", "The webhook exceeds its intake limit.", 413);
  const source = options.sourceMode ?? "live"; const namespace = options.namespace ?? "live";
  if ((source === "live") !== (namespace === "live")) throw new WorldKitError("invalid_request", "Live and scenario event namespaces must remain separate.");
  let transmissionId: string; let signedHeaders: Record<string, string>;
  if (provider === "channel3") {
    const secrets = options.channel3Secrets ?? [process.env.CHANNEL3_WEBHOOK_SECRET, process.env.CHANNEL3_WEBHOOK_SECRET_PREVIOUS].filter((secret): secret is string => Boolean(secret));
    transmissionId = verifyChannel3(rawBody, headers, secrets).transmissionId; signedHeaders = channel3Headers(headers);
  } else {
    signedHeaders = paypalHeaders(headers);
    let verified;
    try { verified = await (options.paypalVerifier ?? configuredPayPalVerifier()).verify(rawBody, headers); }
    catch (error) { if (error instanceof WorldKitError) throw error; throw new WorldKitError("provider_unavailable", "PayPal verification is unavailable. This delivery has not been accepted.", 503); }
    if (!verified.verified) throw new WorldKitError("forbidden", "The webhook signature could not be verified.", 400);
    transmissionId = verified.transmissionId;
  }
  let parsed: unknown; try { parsed = JSON.parse(rawBody); } catch { parsed = null; }
  const bodyHash = sha256(rawBody); const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const rawId = ProviderIdSchema.safeParse(envelope.id); const eventId = rawId.success ? rawId.data : `unidentified-${bodyHash.slice(0, 24)}`;
  const result = provider === "channel3" ? Channel3EventSchema.safeParse(parsed) : PayPalEventSchema.safeParse(parsed);
  const signal = result.success ? provider === "channel3" ? commercialSignal(Channel3EventSchema.parse(result.data)) : paymentSignal(PayPalEventSchema.parse(result.data)) : null;
  const eventType = signal?.type ?? "unsupported";
  await initializeLiving();
  return transaction(async db => {
    const owners = signal ? await routeEventOwners(provider, signal, source, db) : emptyOwners();
    const initial: WebhookState = signal && !owners.ambiguous ? "queued" : "dead_letter";
    const error = !signal ? "The authenticated event is unsupported or does not match its documented schema." : owners.ambiguous ? "The event names resources belonging to different owned orders; it was not applied." : null;
    const id = randomUUID(); const receipt = seal(`webhook:${provider}:${namespace}:${eventId}`, { rawBody, headers: signedHeaders, verification: provider === "channel3" ? "standard_webhooks" : "paypal_postback", verifiedAt: new Date().toISOString(), sourceMode: source });
    const inserted = await db.query("INSERT INTO wk_webhook_events(id,provider,namespace,source_mode,event_id,event_type,committed_at,body_hash,raw_receipt,signal,state,owner_key,tenant_ids,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(provider,namespace,event_id) DO NOTHING RETURNING id", [id, provider, namespace, source, eventId, eventType, signal?.committedAt ?? null, bodyHash, receipt, signal, initial, owners.ownerKey, JSON.stringify(owners.tenantIds), error]);
    const existing = (await db.query("SELECT * FROM wk_webhook_events WHERE provider=$1 AND namespace=$2 AND event_id=$3 FOR UPDATE", [provider, namespace, eventId])).rows[0] as EventRow;
    const duplicate = !inserted.rowCount; const conflict = existing.body_hash !== bodyHash;
    if (duplicate) await db.query("UPDATE wk_webhook_events SET deliveries=deliveries+1,conflicts=conflicts+$2,updated_at=now() WHERE id=$1", [existing.id, conflict ? 1 : 0]);
    if (duplicate && !conflict && existing.state === "ignored" && existing.error === "unowned" && owners.ownerKey) {
      await db.query("UPDATE wk_webhook_events SET state='queued',owner_key=$2,tenant_ids=$3,error=NULL,next_attempt_at=now() WHERE id=$1", [existing.id, owners.ownerKey, JSON.stringify(owners.tenantIds)]); existing.state = "queued";
    }
    await db.query("INSERT INTO wk_webhook_deliveries(id,event_id,transmission_id,body_hash,disposition,conflict_receipt) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), existing.id, transmissionId, bodyHash, conflict ? "payload_conflict" : duplicate ? "duplicate" : "accepted", conflict ? receipt : null]);
    return { accepted: true, duplicate, conflict, state: existing.state };
  });
}

export async function claimWebhook(tenantId?: string, namespace = "live"): Promise<WebhookClaim | null> {
  await initializeLiving();
  return transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('worldkit:webhook-claim:v1'))");
    const row = (await db.query(`SELECT e.* FROM wk_webhook_events e WHERE (e.state IN ('queued','retry_wait') OR e.state='processing' AND e.lease_expires_at<now()) AND e.next_attempt_at<=now()
      AND ($1::text IS NULL OR e.tenant_ids ? $1) AND e.namespace=$2 AND (e.lease_expires_at IS NULL OR e.lease_expires_at<now())
      AND (SELECT count(*) FROM wk_webhook_events busy WHERE busy.state='processing' AND busy.lease_expires_at>now())<4
      AND NOT EXISTS(SELECT 1 FROM wk_webhook_events busy WHERE busy.id<>e.id AND busy.owner_key=e.owner_key AND busy.state='processing' AND busy.lease_expires_at>now())
      ORDER BY (e.owner_key IS NOT NULL) DESC,e.next_attempt_at,e.received_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [tenantId ?? null, namespace])).rows[0];
    if (!row) return null;
    const token = randomUUID();
    return (await db.query("UPDATE wk_webhook_events SET state='processing',lease_token=$2,lease_expires_at=now()+interval '150 seconds',attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *", [row.id, token])).rows[0] as WebhookClaim;
  });
}
export async function assertWebhookLease(db: PoolClient, job: WebhookClaim) {
  const row = (await db.query("SELECT id FROM wk_webhook_events WHERE id=$1 AND state='processing' AND lease_token=$2 AND lease_expires_at>now() FOR UPDATE", [job.id, job.lease_token])).rows[0];
  if (!row) throw new WorldKitError("stale_revision", "The event worker lease ended. Its result cannot change saved state.", 409);
}
export async function finishWebhook(job: WebhookClaim, state: WebhookState, result: unknown, error: string | null = null, delaySeconds = 0, persist?: (db: PoolClient) => Promise<void>): Promise<boolean> {
  return transaction(async db => {
    const active = (await db.query("SELECT id FROM wk_webhook_events WHERE id=$1 AND state='processing' AND lease_token=$2 AND lease_expires_at>now() FOR UPDATE", [job.id, job.lease_token])).rowCount;
    if (!active) return false;
    if (persist) await persist(db);
    await db.query("UPDATE wk_webhook_events SET state=$3,result=$4,error=$5,next_attempt_at=now()+($6::int*interval '1 second'),lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2", [job.id, job.lease_token, state, result, error, delaySeconds]);
    return true;
  });
}
export async function failWebhook(job: WebhookClaim): Promise<void> {
  const failed = job.failures + 1;
  await finishWebhook(job, failed >= 6 ? "dead_letter" : "retry_wait", null, failed >= 6 ? "Provider state could not be confirmed after repeated reads. Review the retained event and retry when the provider is available." : "The provider read did not finish. No financial action or kit change was dispatched.", Math.min(600, 5 * 2 ** failed), async db => { await db.query("UPDATE wk_webhook_events SET failures=failures+1 WHERE id=$1", [job.id]); });
}
export async function webhookSummaries(tenantId: string): Promise<WebhookSummary[]> {
  await initializeLiving(); const rows = await database().query("SELECT * FROM wk_webhook_events WHERE tenant_ids ? $1 ORDER BY received_at DESC LIMIT 100", [tenantId]);
  return rows.rows.map(row => ({ id: row.id, provider: row.provider, eventId: row.event_id, eventType: row.event_type, sourceMode: row.source_mode, state: row.state, receivedAt: new Date(row.received_at).toISOString(), committedAt: row.committed_at ? new Date(row.committed_at).toISOString() : null, bodyHash: row.body_hash, attempts: row.attempts, deliveries: row.deliveries, conflicts: row.conflicts, error: row.error }));
}
export async function retryWebhook(tenantId: string, id: string) {
  await initializeLiving();
  const updated = await database().query("UPDATE wk_webhook_events SET state='queued',failures=0,error=NULL,next_attempt_at=now(),updated_at=now() WHERE id=$1 AND tenant_ids ? $2 AND state='dead_letter' AND signal IS NOT NULL RETURNING id", [id, tenantId]);
  if (!updated.rowCount) throw new WorldKitError("not_found", "No retryable event belongs to this workspace.", 404);
}
