import { processSubscriptions } from "./subscriptions";
import { processWebhookQueue } from "./webhook-runner";

export async function runLivingMaintenance(tenantId?: string): Promise<{ subscriptionChecks: number; eventChecks: number; maintenanceErrors: number }> {
  const [subscriptions, events] = await Promise.allSettled([processSubscriptions(undefined, tenantId), processWebhookQueue(tenantId)]);
  return { subscriptionChecks: subscriptions.status === "fulfilled" ? subscriptions.value : 0, eventChecks: events.status === "fulfilled" ? events.value : 0, maintenanceErrors: Number(subscriptions.status === "rejected") + Number(events.status === "rejected") };
}
