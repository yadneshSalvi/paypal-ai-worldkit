import corpus from "./corpus.json";
import manifest from "./corpus-source-manifest.json";
import proposals from "./corpus-proposals.json";
import { candidateProfile, immutableSource } from "../spec-evidence/profile";
import type { ExtractionDraft } from "../spec-evidence/contracts";

const proposalRecords = proposals as { profileId: string; draft: ExtractionDraft }[];
export const candidateSources = corpus.flatMap(device => {
  const document = manifest.find(row => row.profileId === device.id && row.status === "retrieved");
  return document ? [immutableSource(device, document)] : [];
});
export const candidateProfiles = corpus.flatMap(device => {
  const document = manifest.find(row => row.profileId === device.id && row.status === "retrieved");
  const proposal = proposalRecords.find(row => row.profileId === device.id && row.draft.sourceHash === document?.contentHash);
  return document ? [candidateProfile(device, document, proposal?.draft)] : [];
});
