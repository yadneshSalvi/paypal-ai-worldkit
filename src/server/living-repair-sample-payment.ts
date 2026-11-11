import { randomUUID } from "node:crypto";
import { ProviderError, canonicalJson, payloadHash, type PaymentCommand, type PaymentOperation, type ProviderAdapter, type ProviderReceipt, type ProviderResource } from "@fracture/paypal-core";
import { hash } from "../../packages/compatibility";
import { WorldKitError } from "../../packages/contracts";
import { loadOrder } from "./commerce";
import { database } from "./db";
import { repairTransaction } from "./living-repair-db";
import { loadAmendment, loadRepair } from "./living-repair-store";

/** Explicit persistent Sample simulator. It has no network client, credentials or
 * fabricated provider signature. Its receipts always say local_fixture/sample. */
export class LivingRepairSampleProvider implements ProviderAdapter {
  readonly source = "sample" as const;
  constructor(private readonly tenantId: string) {}
  async execute(command: PaymentCommand): Promise<ProviderReceipt> {
    if (command.scope.tenantId !== this.tenantId || command.scope.projectId !== "worldkit") throw new WorldKitError("forbidden", "Sample payment scope mismatch.", 403);
    const authority = (await database().query("SELECT order_id FROM wk_financial_authorities WHERE operation_id=$1 AND tenant_id=$2", [command.operationId, this.tenantId])).rows[0];
    if (!authority) throw new WorldKitError("forbidden", "A durable, exact Sample financial authority is required.", 403);
    const order = await loadOrder(this.tenantId, authority.order_id);
    if (order.livingRepair?.paymentMode !== "sample") throw new WorldKitError("forbidden", "A Sample provider cannot execute a PayPal order.", 403);
    const amendment = await loadAmendment(this.tenantId, order.livingRepair.amendmentId); const run = await loadRepair(this.tenantId, amendment.proposal.runId);
    if (run.sourceMode !== "sample") throw new WorldKitError("forbidden", "A real market repair cannot be passed off as a Sample payment.", 403);
    const action = command.action; const at = new Date().toISOString();
    const resource = (kind: ProviderResource["kind"], id: string, status: string, parentId: string | null = null): ProviderResource => ({ kind, id, status, parentId, money: kind === "order" ? null : action.money, customId: kind === "order" ? order.id : kind === "refund" ? command.operationId : null, observedAt: at, source: "sample", links: [] });
    const key = hash({ tenant: this.tenantId, operation: command.operationId }).slice(0, 28);
    let resources: ProviderResource[];
    if (action.kind === "create_order") resources = [resource("order", `sample-order-${key}`, "CREATED")];
    else if (action.kind === "capture_order") resources = [resource("order", action.orderId, "COMPLETED"), resource("capture", `sample-capture-${key}`, "COMPLETED", action.orderId)];
    else if (action.kind === "refund_capture") resources = [resource("refund", `sample-refund-${key}`, "COMPLETED", action.captureId)];
    else throw new ProviderError("encode", "This Sample simulator supports only its declared amendment and compensation operations.", "not_sent", 400);
    const receipt: ProviderReceipt = { id: randomUUID(), operationId: command.operationId, providerRequestId: command.providerRequestId, transport: "local_fixture", source: "sample", status: 201, observedAt: at, resources, debugId: null, bodyHash: payloadHash(action), reconciled: false };
    const lost = run.scenario === "lost-payment-response" && action.kind === "capture_order";
    const stored = await repairTransaction(async db => {
      const row = (await db.query("INSERT INTO wk_kit_sample_payments(operation_id,tenant_id,order_id,command_digest,receipt,response_lost) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(operation_id) DO NOTHING RETURNING receipt", [command.operationId, this.tenantId, order.id, hash(command), receipt, lost])).rows[0];
      if (row) return { receipt: row.receipt as ProviderReceipt, fresh: true };
      const prior = (await db.query("SELECT command_digest,receipt FROM wk_kit_sample_payments WHERE operation_id=$1 AND tenant_id=$2", [command.operationId, this.tenantId])).rows[0];
      if (!prior || prior.command_digest !== hash(command)) throw new WorldKitError("forbidden", "A Sample operation was reused with different authority.", 403);
      return { receipt: prior.receipt as ProviderReceipt, fresh: false };
    });
    if (lost && stored.fresh) throw new ProviderError("timeout", "Sample capture completed; its first response was deliberately lost. Reconcile the retained operation.", "unknown", 502);
    return stored.receipt;
  }
  async read(kind: ProviderResource["kind"], id: string): Promise<ProviderResource[]> {
    const records = (await database().query("SELECT receipt FROM wk_kit_sample_payments WHERE tenant_id=$1 ORDER BY created_at", [this.tenantId])).rows.map(row => row.receipt as ProviderReceipt);
    const resources = new Map<string, ProviderResource>(); for (const receipt of records) for (const resource of receipt.resources) resources.set(resource.id, resource);
    const item = resources.get(id); if (!item || item.kind !== kind) return [];
    if (kind === "order") {
      const captures = [...resources.values()].filter(resource => resource.kind === "capture" && resource.parentId === id);
      const refunds = [...resources.values()].filter(resource => resource.kind === "refund" && captures.some(capture => capture.id === resource.parentId));
      return [item, ...captures, ...refunds].map(resource => ({ ...resource, observedAt: new Date().toISOString() }));
    }
    if (kind === "capture") {
      const total = [...resources.values()].filter(resource => resource.kind === "refund" && resource.parentId === id && resource.status === "COMPLETED").reduce((sum, resource) => sum + (resource.money?.minor ?? 0), 0);
      return [{ ...item, status: total ? total >= (item.money?.minor ?? 0) ? "REFUNDED" : "PARTIALLY_REFUNDED" : item.status, observedAt: new Date().toISOString() }];
    }
    return [{ ...item, observedAt: new Date().toISOString() }];
  }
  async reconcile(operation: PaymentOperation): Promise<ProviderReceipt | null> {
    if (operation.command.scope.tenantId !== this.tenantId) return null;
    const row = (await database().query("SELECT * FROM wk_kit_sample_payments WHERE tenant_id=$1 AND operation_id=$2", [this.tenantId, operation.command.operationId])).rows[0];
    if (!row || row.command_digest !== hash(operation.command)) return null;
    if (row.response_lost) { await database().query("UPDATE wk_kit_sample_payments SET response_lost=false WHERE operation_id=$1 AND tenant_id=$2", [operation.command.operationId, this.tenantId]); return null; }
    const receipt = row.receipt as ProviderReceipt;
    if (receipt.providerRequestId !== operation.command.providerRequestId || receipt.bodyHash !== payloadHash(operation.command.action) || !canonicalJson(receipt.resources)) return null;
    return { ...receipt, reconciled: true, observedAt: new Date().toISOString() };
  }
}
