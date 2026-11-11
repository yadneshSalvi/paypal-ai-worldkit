import { randomUUID } from "node:crypto";
import { normalizeProduct } from "../../packages/channel3/client";
import { profiles } from "../../packages/device-library/index";
import type { CatalogReceipt, CatalogSnapshot, DeviceProfile } from "../../packages/contracts/index";
import type { Identity, InventoryConfirmation } from "../../packages/inventory/contracts";
import type { RevisionBundle } from "../../src/server/repository";
export const testProfile = profiles.find(profile => profile.id === "shure-sm58-lc")!;
export function identity(profile: DeviceProfile = testProfile): Identity { return { libraryProfileId: profile.id, manufacturer: profile.manufacturer, model: profile.model, variant: profile.variant, deviceKind: profile.kind, ownership: "planned", quantity: 1, condition: "new", accessories: [], notes: "Synthetic test entry, no equipment purchased or physically inspected.", confirmedExactIdentity: true, confirmedOwnership: false }; }
export function catalog(profile = testProfile): CatalogSnapshot {
  const result = normalizeProduct({ id: `synthetic-product-${randomUUID()}`, title: `${profile.manufacturer} ${profile.model}`, offers: [{ url: "https://merchant.example/fixture?ephemeral=not-retained", domain: "merchant.example", availability: "InStock", condition: "new", price: { price: 99, currency: "USD" } }], variants: { selected: [{ name: "Color", label: "Black" }], options: [{ name: "Color", values: [{ label: "Black", exists: true, available: "InStock" }, { label: "White", exists: true, available: "InStock" }] }] } });
  result.snapshot.detailChecked = true; return result.snapshot;
}
export function receipt(snapshot: CatalogSnapshot): CatalogReceipt { return { id: randomUUID(), operation: "details", query: "Synthetic fixture, never a provider call", resultIds: [snapshot.productId], estimatedCredits: 0, status: "succeeded", error: null, requestedAt: snapshot.observedAt, mode: "live", completedAt: snapshot.observedAt, durationMs: 0, providerRequestId: null }; }
export function confirmation(bundle: RevisionBundle, profile = testProfile, snapshot: CatalogSnapshot | null = null): InventoryConfirmation { return { requestId: randomUUID(), identity: identity(profile), snapshotId: snapshot?.id ?? null, selectedOptions: snapshot?.selectedOptions ?? [], photoId: null, regionId: null, targetComponentId: null, expectedRevisionId: bundle.kit.id, expectedGraphHash: bundle.certificate.graphHash, correctItemId: null, expectedItemVersion: null, confirmOwnedReplacement: false }; }
