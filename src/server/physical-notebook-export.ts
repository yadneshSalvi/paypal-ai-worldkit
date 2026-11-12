import { hash } from "../../packages/compatibility";
import { BENCH_POLICY, type BenchAccess, type BenchAsset, type BenchDetail } from "../../packages/physical-notebook/contracts";
import { benchFail } from "./physical-notebook-authority";
import { physicalNotebookHome } from "./physical-notebook";
import { benchError, benchHeaders } from "./physical-notebook-http";

function redactedAsset(asset: BenchAsset) {
  return { id: asset.id, sha256: asset.sha256, bytes: asset.bytes, mediaType: asset.mediaType, kind: asset.kind, provenance: asset.provenance, detectedModelExport: asset.detectedModelExport, availability: asset.availability, originalBytesRetained: asset.originalBytesRetained, audio: asset.audio ? { format: asset.audio.format, channels: asset.audio.channels, sampleRate: asset.audio.sampleRate, durationSeconds: asset.audio.durationSeconds, scope: asset.audio.scope } : null, declaredPublicSharingAllowed: asset.rights.publicSharingAllowed, rightsExpiry: asset.rights.expiresAt, rightsHash: hash(asset.rights) };
}
export function benchExport(detail: BenchDetail, redacted: boolean) {
  const e = detail.edition, b = e.binding;
  const body = redacted ? {
    schema: "worldkit.physical-proof-redacted.1", policy: BENCH_POLICY, runId: detail.runId, editionId: e.id, editionHash: e.hash, number: e.number, sourceMode: e.sourceMode, phase: e.phase,
    binding: { kind: b.kind, subjectId: b.subjectId, revisionId: b.revisionId, graphHash: b.graphHash, bindingHash: b.hash, certificateHash: b.certificateHash, ruleVersion: b.ruleVersion, graphSource: b.graphSource, components: b.components.map(component => ({ id: component.id, profileId: component.profileId, profileHash: component.profileHash })), sourceFingerprints: b.sources.map(source => ({ id: source.id, hash: source.hash })), protocolHash: hash(b.steps), configurationHash: hash(b.configuration), connectionHash: hash(b.connections) },
    conditionsHash: hash(e.conditions), declaredSeconds: e.conditions.declaredSeconds,
    hardware: e.conditions.hardware.map(item => ({ componentId: item.componentId, modelHash: hash(item.model), revisionHash: hash(item.revision), firmwareHash: hash(item.firmware), matchesBoundModel: item.matchesBoundModel, privateSerialHash: detail.serials.find(serial => serial.id === item.serialRecordId)?.hash ?? null })),
    observations: e.observations.map(observation => ({ id: observation.id, stepId: observation.stepId, outcome: observation.outcome, observedAt: observation.observedAt, recordedAt: observation.recordedAt, detailHash: hash(observation.detail) })),
    attachments: e.attachments.map(link => ({ assetId: link.assetId, assetHash: link.assetHash, stepId: link.stepId })), originals: detail.assets.filter(asset => e.attachments.some(link => link.assetId === asset.id)).map(redactedAsset),
    declaredAt: e.declaredAt, startedAt: e.startedAt, finishedAt: e.finishedAt, sealedAt: e.sealedAt,
    assessment: { ...detail.assessment, missing: detail.assessment.missing.map((_, index) => `Unresolved evidence item ${index + 1}; detail retained in the private manifest.`), missingHash: hash(detail.assessment.missing) },
    reviews: detail.decisions.map(decision => ({ id: decision.id, editionHash: decision.editionHash, provenance: decision.provenance, outcome: decision.outcome, currentAuthority: decision.currentAuthority, currentlyQualified: decision.currentlyQualified, findingHash: hash(decision.finding), limitationsHash: hash(decision.limitations), createdAt: decision.createdAt })),
    redactions: ["Names, location, private serial values, free-form source/condition/observation text, original filenames, private rights records and private URLs are omitted.", "No original-file URL is made public. Sharing permission is a declaration, not independent legal verification."], existingCertificateChanged: false,
  } : { schema: "worldkit.physical-proof-private.1", policy: BENCH_POLICY, edition: e, serialFingerprints: detail.serials, originals: detail.assets.filter(asset => e.attachments.some(link => link.assetId === asset.id)), decisions: detail.decisions, assessment: detail.assessment, subjectCurrent: detail.subjectCurrent, subjectIssues: detail.subjectIssues, privateSerialValuesIncluded: false, existingCertificateChanged: false };
  return { ...body, exportHash: hash(body) };
}
export async function physicalExportResponse(request: Request, access: BenchAccess) {
  try {
    const url = new URL(request.url), redacted = url.searchParams.get("view") !== "private";
    if (request.method !== "GET") benchFail("Exports are read with GET.", "invalid_request", 405);
    if (!redacted && access.kind !== "owner") benchFail("Private owner exports are outside this reviewer invitation.");
    const home = await physicalNotebookHome(access, url.searchParams.get("runId") ?? undefined, url.searchParams.get("editionId") ?? undefined);
    if (!home.selected) benchFail("Select a report to export.", "not_found");
    return Response.json(benchExport(home.selected, redacted), { headers: { ...benchHeaders, "Content-Disposition": `attachment; filename="worldkit-physical-${home.selected.edition.number}-${redacted ? "redacted" : "private"}.json"` } });
  } catch (error) { return benchError(error); }
}
