import type { CatalogSnapshot } from "../contracts";
import type { CommercialSignal, WebhookSource, WebhookSummary } from "../webhooks/contracts";
import type { OfferWatch } from "./subscriptions";
import type { OfferImpact } from "./impact";

export type LivingIncident = { id: string; webhookId: string; watchId: string; itemId: string; model: string; sourceMode: WebhookSource; catalogSource: "live" | "sample"; signal: CommercialSignal; impact: OfferImpact; refreshed: CatalogSnapshot; snapshotHash: string; observedAt: string; revisionId: string | null; createdAt: string; dismissedAt: string | null };
export type InAppNotification = { id: string; kind: string; title: string; detail: string; sourceMode: "live" | "sample" | "replay" | "modelled"; createdAt: string; readAt: string | null; incidentId: string | null; orderId: string | null; delivery: "available_in_workbench" };
export type LivingView = { watches: OfferWatch[]; incidents: LivingIncident[]; notifications: InAppNotification[]; events: WebhookSummary[]; readiness: { channel3: boolean; paypal: boolean }; cadence: "priority_daily_refresh" };
