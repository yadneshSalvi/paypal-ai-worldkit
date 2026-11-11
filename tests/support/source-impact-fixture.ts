import { architectures, profiles, sources, seedKit } from "../../packages/device-library";
import { verifyKit } from "../../packages/compatibility";
import type { ImpactBundle, ImpactSource } from "../../packages/spec-evidence/impact";

export function impactFixture() {
  const kit = seedKit(), scopedProfiles = structuredClone(profiles), scopedSources = structuredClone(sources);
  const profile = scopedProfiles.find(value => value.id === "zoom-h4essential")!;
  profile.sourceVersion = "a".repeat(64);
  const sourceRecord = scopedSources.find(value => value.id === profile.facts.onboardIsolated!.sourceIds[0])!;
  sourceRecord.contentHash = profile.sourceVersion;
  const source: ImpactSource = { profileId: profile.id, model: profile.model, variant: "Synthetic impact qualification", documentId: null,
    contentHash: "b".repeat(64), textHash: null, url: sourceRecord.url, status: "available", current: true, headVersion: 2 };
  const bundle: ImpactBundle = { kit, profiles: scopedProfiles, sources: scopedSources, certificate: verifyKit(kit, scopedProfiles, scopedSources, architectures), current: true };
  return { bundle, source, profile, sourceRecord };
}
