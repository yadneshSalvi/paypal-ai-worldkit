import { hash, verifyKit } from "../compatibility";
import type { CatalogReceipt, CatalogSnapshot, DeviceProfile, Source } from "../contracts";
import { architectures, profiles, seedKit } from "../device-library";
import type { RepairBundle, SampleScenario } from "./contracts";
import { SAMPLE_SCENARIOS } from "./contracts";

const SAMPLE_SOURCE_ID = "sample:living-repair-premises";
/** Deliberately synthetic engineering premises. They never enter the real profile,
 * inventory, source-review or catalog tables, and cannot close a human review gate. */
export function sampleRepairBundle(kitId: string, at: string): RepairBundle {
  const kit = seedKit("T2", `sample:${kitId}:r1`);
  kit.kitId = `sample:${kitId}`; kit.createdAt = at; kit.goal.id = `sample:${kit.goal.id}`;
  kit.goal.title = "The sample session stays on";
  kit.goal.brief = "A synthetic two-voice studio for testing a controlled merchant repair. No physical equipment or manufacturer review is implied.";
  kit.goal.requiredOwnedProfileIds = kit.goal.requiredOwnedProfileIds.map(id => `sample:${id}`);
  const synthetic = profiles.map(profile => {
    const value = structuredClone(profile); value.id = `sample:${profile.id}`; value.manufacturer = "WorldKit Example";
    value.model = profile.kind === "recorder" ? "Field recorder A" : `Sample ${profile.kind}`;
    value.shortName = value.model; value.variant = "Synthetic demonstration identity"; value.reviewState = "verified_scope";
    value.description = "An explicit synthetic fixture. Its facts are not real product specifications.";
    value.catalogId = profile.kind === "recorder" ? "sample-recorder-a" : null;
    const amounts: Record<string, number | string | boolean> = { usbBandwidthMbps: 1000, powerWatts: profile.kind === "power" ? 100 : 4, peripheralPowerWatts: 15, exactHardwareRevision: "sample-revision-1", cleanHdmi: true, lineToMicLevel: true, hostIsolatedWhileStreaming: true, exactAppHardwareSupport: true, stereoMonitoring: true, usbStereoMix: true, simultaneousUsbRecording: true };
    for (const fact of Object.values(value.facts)) {
      fact.id = `sample:${fact.id}`; fact.value ??= amounts[fact.property] ?? true;
      fact.scope = "Synthetic Sample fixture only"; fact.sourceIds = [SAMPLE_SOURCE_ID]; fact.state = "supported"; fact.conditions = [];
      fact.review = { status: "reviewed", reviewer: "Synthetic fixture assertion; no human review", date: at };
    }
    return value;
  });
  for (const component of kit.components) { component.profileId = `sample:${component.profileId}`; component.ownershipSource = "sample"; if (component.role === "camera") component.settings.cleanHdmiConfirmed = true; }
  for (const edge of kit.connections) edge.sourceIds = [SAMPLE_SOURCE_ID];
  const source: Source = { id: SAMPLE_SOURCE_ID, title: "Synthetic Living Repair premises", publisher: "WorldKit sample simulator", url: "https://example.invalid/worldkit/living-repair", kind: "sample", retrievedAt: at, contentHash: hash(synthetic), location: "Local deterministic fixture", summary: "Synthetic fixture assertions for testing the saga. No real manufacturer claims, human reviews or physical test results.", rights: "link_and_facts_only" };
  return { kit, profiles: synthetic, sources: [source], certificate: verifyKit(kit, synthetic, [source], architectures, [], at) };
}
export function sampleAlternativeProfile(base: RepairBundle, unknown: boolean): DeviceProfile {
  const profile = structuredClone(base.profiles.find(profile => profile.id === base.kit.components.find(component => component.role === "audio")!.profileId)!);
  profile.id = "sample:field-recorder-b"; profile.model = "Field recorder B"; profile.shortName = profile.model; profile.catalogId = "sample-recorder-b";
  for (const fact of Object.values(profile.facts)) fact.id = `${profile.id}:${fact.property}`;
  if (unknown) { const fact = profile.facts.simultaneousUsbRecording!; fact.value = null; fact.state = "unknown"; fact.review = { status: "pending", reviewer: null, date: null }; }
  return profile;
}
export function sampleCatalog(productId: string, scenario: SampleScenario, stage: "repair" | "restore" | "commit" = "repair", at = new Date().toISOString()): { value: { snapshot: CatalogSnapshot }; receipt: CatalogReceipt } {
  const delta = SAMPLE_SCENARIOS.find(value => value.id === scenario)?.deltaMinor ?? 800;
  const originalAvailable = stage === "restore" && scenario !== "original-unavailable";
  const alternativeAvailable = !(stage === "commit" && scenario === "commit-failure");
  const value: Omit<CatalogSnapshot, "responseHash"> = {
    id: `sample-snapshot:${hash({ productId, scenario, stage, at }).slice(0, 28)}`, productId,
    title: productId === "sample-recorder-b" ? "WorldKit Example Field recorder B" : "WorldKit Example Field recorder A", brand: "WorldKit Example", description: "Explicit Sample catalog fixture. No Channel3 request was made.",
    selectedOptions: [], variantExact: true, detailChecked: true, variantOptions: [], categoryIds: ["sample-recorders"], observedAt: at, source: "channel3", sourceMode: "live",
    offers: [
      { id: `${productId}:original`, retailer: "Original sample retailer", domain: "original.example.invalid", price: { currency: "USD", minor: 24800 }, availability: originalAvailable ? "InStock" : "OutOfStock", condition: "new", observedAt: at, shipping: "unknown" },
      { id: `${productId}:alternative`, retailer: "Alternate sample retailer", domain: "alternate.example.invalid", price: { currency: "USD", minor: 24800 + delta }, availability: alternativeAvailable ? "InStock" : "OutOfStock", condition: "new", observedAt: at, shipping: "unknown" },
    ],
  };
  const snapshot = { ...value, responseHash: hash(value) };
  // CatalogSnapshot's wire shape is shared; the enclosing RepairEvidence.mode is
  // authoritative. This fixture is never saved through the live catalog repository.
  const receipt: CatalogReceipt = { id: `sample-receipt:${hash(value).slice(0, 28)}`, operation: "Sample exact-product refresh", status: "succeeded", requestedAt: at, completedAt: at, durationMs: 0, resultIds: [productId], query: "Explicit local Sample fixture", mode: "live", estimatedCredits: 0, providerRequestId: null, error: null };
  return { value: { snapshot }, receipt };
}
export const sampleUnitPrice = (kind: DeviceProfile["kind"]) => ({ microphone: 7000, recorder: 24800, capture: 8000, hub: 3500, power: 2000 }[kind as "recorder"] ?? 0);
