import { z } from "zod";
import { hash } from "../compatibility";
import { WorldKitError, type CatalogSnapshot } from "../contracts";
import { DomainSchema, LocaleSchema, OfferEventTypeSchema, ProviderIdSchema, SelectionSchema, offerEventTypes, type CommercialSignal, type Selection } from "../webhooks/contracts";

export const SubscriptionScopeSchema = z.object({ productId: ProviderIdSchema, selection: SelectionSchema, domains: z.array(DomainSchema).min(1).max(25), events: z.array(OfferEventTypeSchema).min(1).max(4), locale: LocaleSchema }).strict();
export type SubscriptionScope = z.infer<typeof SubscriptionScopeSchema>;
export const ProviderSubscriptionSchema = z.object({ id: ProviderIdSchema, scope: SubscriptionScopeSchema.extend({ domains: z.array(DomainSchema).max(25).nullable() }), state: z.enum(["active", "cancelled"]), createdAt: z.iso.datetime({ offset: true }) });
export type ProviderSubscription = z.infer<typeof ProviderSubscriptionSchema>;
export type SubscriptionPhase = "queued" | "inspecting" | "ready_to_create" | "creating" | "pending_canonicalization" | "create_unknown" | "active" | "cancel_pending" | "cancelling" | "cancel_unknown" | "cancelled" | "review_needed";
export type SubscriptionOwnership = "unconfirmed" | "adopted_read_only" | "operator_confirmed";
export type OfferWatch = { id: string; sourceMode: "live" | "sample" | "replay"; itemId: string; itemVersion: number; productId: string; model: string; selection: Selection; domains: string[]; state: "starting" | "active" | "needs_attention" | "stopped"; createdAt: string; stoppedAt: string | null; resources: { id: string; phase: SubscriptionPhase; ownership: SubscriptionOwnership; providerId: string | null; nextAttemptAt: string; error: string | null }[] };

export function canonicalSelection(selection: Selection): Selection { return [...selection].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map(value => ({ name: value.name.toLowerCase(), label: value.label })); }
export function sameSelection(a: Selection, b: Selection): boolean { return hash(canonicalSelection(a)) === hash(canonicalSelection(b)); }
export function scopeHash(scope: SubscriptionScope): string { return hash({ ...scope, selection: canonicalSelection(scope.selection), domains: [...new Set(scope.domains)].sort(), events: [...new Set(scope.events)].sort() }); }
export function matchesScope(provider: ProviderSubscription, expected: SubscriptionScope): boolean {
  return provider.scope.productId === expected.productId && provider.scope.domains !== null && scopeHash({ ...provider.scope, domains: provider.scope.domains }) === scopeHash(expected);
}
export function signalMatchesScope(signal: CommercialSignal, providerId: string, scope: SubscriptionScope): boolean {
  return signal.subscriptionId === providerId && signal.productId === scope.productId && scope.domains.includes(signal.domain) && scope.events.includes(signal.type) && sameSelection(signal.selection, scope.selection) && hash(signal.locale) === hash(scope.locale);
}
export function watchScopes(snapshot: CatalogSnapshot, domains: string[]): SubscriptionScope[] {
  if (!snapshot.detailChecked || !snapshot.variantExact || !Number.isFinite(Date.parse(snapshot.observedAt)) || Date.now() - Date.parse(snapshot.observedAt) > 120_000 || Date.parse(snapshot.observedAt) > Date.now() + 5_000) throw new WorldKitError("stale_revision", "Refresh this exact catalog variant before starting alerts.", 409);
  const selection = SelectionSchema.parse(snapshot.selectedOptions.map(option => ({ name: option.name, label: option.value })));
  if ((snapshot.variantOptions?.length ?? 0) !== selection.length || snapshot.variantOptions?.some(option => !selection.some(value => value.name === option.name))) throw new WorldKitError("needs_evidence", "Confirm one exact value for every variant option before starting alerts.", 422);
  const selected = [...new Set(domains.map(domain => DomainSchema.parse(domain)))].sort();
  if (!selected.length || selected.some(domain => !snapshot.offers.some(offer => offer.domain.toLowerCase() === domain))) throw new WorldKitError("invalid_request", "Choose merchant domains from the current exact-product offers.");
  const scopes: SubscriptionScope[] = [];
  for (let offset = 0; offset < selected.length; offset += 25) scopes.push(SubscriptionScopeSchema.parse({ productId: snapshot.productId, selection, domains: selected.slice(offset, offset + 25), events: [...offerEventTypes], locale: { language: "en", country: "US", currency: "USD" } }));
  return scopes;
}
export function canonicalizationDelay(attempt: number, elapsedMs: number): { seconds: number; background: boolean } {
  if (elapsedMs >= 600_000) return { seconds: 300, background: true };
  return { seconds: [2, 4, 8, 16, 30][Math.max(0, Math.min(4, attempt - 1))]!, background: false };
}
