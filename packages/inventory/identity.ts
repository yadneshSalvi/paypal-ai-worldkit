import { WorldKitError, type CatalogSnapshot, type DeviceProfile } from "../contracts/index";
import type { Identity } from "./contracts";

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
export function engineeringId(profile: DeviceProfile): string { return profile.baseProfileId ?? profile.id; }
export function catalogIdentityMatches(snapshot: CatalogSnapshot, profile: DeviceProfile): boolean {
  const title = normalize(snapshot.title); const identity = normalize(`${snapshot.brand ?? ""} ${snapshot.title}`);
  if (profile.manufacturer === "Unconfirmed" || !identity.includes(normalize(profile.manufacturer)) || !title.includes(normalize(profile.model))) return false;
  const id = engineeringId(profile);
  if (/\bbundle\b|\bkit with\b|\bpack of\b|\b\d+[ -]pack\b/i.test(snapshot.title)) return false;
  if (id === "at2020-xlr" && /at2020usb|at2020\+usb/.test(title)) return false;
  if (id === "focusrite-2i2-4" && !/4th|4thgen|4thgeneration|fourth/.test(title)) return false;
  if (id === "sony-zve10" && /zve10ii|zve10mark2|zve102/.test(title)) return false;
  if (id === "apple-ipad-air5" && !/5th|5thgeneration|air5|m1/.test(title)) return false;
  if (id === "anker-555-a8383" && !/555|a8383/.test(title)) return false;
  return true;
}
export function assertExactSelection(snapshot: CatalogSnapshot, selection: { name: string; value: string }[], now = Date.now()) {
  if (!snapshot.detailChecked) throw new WorldKitError("invalid_identity", "Refresh the product details before confirming an exact model.", 409);
  if (!snapshot.variantExact) throw new WorldKitError("invalid_identity", "The catalog relaxed an option. Refresh and confirm an available exact selection.", 409);
  const observed = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observed) || now - observed > 15 * 60_000 || observed > now + 60_000) throw new WorldKitError("quote_expired", "Refresh these product details before confirming the model.", 409);
  const normalized = (list: typeof selection) => list.map(o => `${o.name.toLowerCase()}=${o.value}`).sort();
  if (new Set(selection.map(o => o.name.toLowerCase())).size !== selection.length || JSON.stringify(normalized(selection)) !== JSON.stringify(normalized(snapshot.selectedOptions))) throw new WorldKitError("invalid_identity", "Confirm the exact options returned by the most recent product refresh.", 409);
  for (const option of snapshot.variantOptions ?? []) {
    const selected = selection.find(s => s.name.toLowerCase() === option.name.toLowerCase());
    if (!selected || !option.values.some(v => v.value === selected.value && v.exists)) throw new WorldKitError("invalid_identity", `Select and refresh the ${option.name} variant first.`, 409);
  }
}
export function confirmedProfile(id: string, identity: Identity, snapshot: CatalogSnapshot | null, library: DeviceProfile[], at: string): DeviceProfile {
  const base = identity.libraryProfileId ? library.find(p => p.id === identity.libraryProfileId) : null;
  if (identity.libraryProfileId && !base) throw new WorldKitError("invalid_identity", "That engineering profile is no longer available. Choose an exact profile or a new candidate.", 409);
  if (base && (base.manufacturer !== identity.manufacturer || base.model !== identity.model || base.variant !== identity.variant || base.kind !== identity.deviceKind)) throw new WorldKitError("invalid_identity", "The confirmed identity does not match the selected engineering profile.", 409);
  if (base && snapshot && !catalogIdentityMatches(snapshot, base)) throw new WorldKitError("invalid_identity", "This catalog listing does not identify the same exact model. Keep it as a new candidate or choose a matching listing.", 409);
  const unknownFact = { id: `${id}:technical-scope:1`, property: "technicalScope", value: null, unit: null, sourceIds: [], scope: `${identity.manufacturer} ${identity.model}; ${identity.variant}`, conditions: [], state: "unknown" as const, critical: true, review: { status: "pending" as const, reviewer: null, date: null } };
  return {
    ...(base ? structuredClone(base) : { manufacturer: identity.manufacturer, model: identity.model, variant: identity.variant, kind: identity.deviceKind, shortName: identity.model, description: "Exact identity confirmed by you. Manufacturer specifications and technical review are still needed.", ports: [], facts: { technicalScope: unknownFact }, reviewState: "candidate" as const, art: "original_line_art" as const, accent: "#dae4e0" }),
    id, version: 1, ...(base ? { baseProfileId: engineeringId(base) } : {}),
    catalogId: snapshot?.productId ?? null, selectedOptions: snapshot?.selectedOptions ?? [],
    ...(snapshot ? { catalogBinding: { snapshotId: snapshot.id, productId: snapshot.productId, selectedOptions: snapshot.selectedOptions, confirmedAt: at, confirmation: "user_confirmed_exact_identity" as const } } : { catalogBinding: undefined }),
  };
}
