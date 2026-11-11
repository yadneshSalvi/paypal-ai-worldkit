import { processSubscriptions } from "./subscriptions";
import { processWebhookQueue } from "./webhook-runner";
import { processRepairMaintenance } from "./living-repair-view";

export async function runLivingMaintenance(tenantId?: string): Promise<{ subscriptionChecks: number; eventChecks: number; repairChecks: number; maintenanceErrors: number }> {
  const [subscriptions, events] = await Promise.allSettled([processSubscriptions(undefined, tenantId), processWebhookQueue(tenantId)]);
  let repairs = { repairChecks: 0, repairErrors: 0 }; try { repairs = await processRepairMaintenance(tenantId); } catch { repairs.repairErrors++; }
  return { subscriptionChecks: subscriptions.status === "fulfilled" ? subscriptions.value : 0, eventChecks: events.status === "fulfilled" ? events.value : 0, repairChecks: repairs.repairChecks, maintenanceErrors: Number(subscriptions.status === "rejected") + Number(events.status === "rejected") + repairs.repairErrors };
}
