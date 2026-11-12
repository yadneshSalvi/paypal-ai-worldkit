import type { BenchAsset, BenchAssessment, BenchBinding, BenchConditions, BenchDecision, BenchEdition, BenchStep } from "./contracts";

export function benchProtocol(kind: "desk" | "audio", inputs: { id: string; label: string }[] = [], options: { displays?: number; cameraRequired?: boolean } = {}): BenchStep[] {
  const common: BenchStep[] = [
    { id: "power", title: "Power and connections", instruction: "Record the exact power supply, hubs, adapters and connected ports. Include an original connection photo; retain any mismatch or dropout.", required: true, evidenceKinds: ["connection_photo"] },
    { id: "interval", title: "Declared interval", instruction: "Observe the entire interval declared before Start. Record interruptions and early termination. A timer alone is not evidence of hardware operation.", required: true, evidenceKinds: ["camera_recording", "screen_recording", "isolated_track", "stream_mix"] },
  ];
  if (kind === "desk") return [
    { id: "display_one", title: "First independent display", instruction: "Show independent content on the first display and the exact connection path.", required: true, evidenceKinds: ["screen_recording", "connection_photo", "camera_recording"] },
    { id: "display_two", title: "Second independent display", instruction: "Show whether the second display extends or mirrors the first. Record the observed resolution and refresh mode.", required: (options.displays ?? 2) > 1, evidenceKinds: ["screen_recording", "camera_recording"] },
    { id: "lid_mode", title: "Host and lid condition", instruction: "Record the operating system, power and lid condition while both displays are active.", required: true, evidenceKinds: ["connection_photo", "camera_recording"] },
    { id: "external_inputs", title: "Keyboard and pointing device", instruction: "Use the recorded external keyboard and pointing device while the host is in the tested lid mode.", required: true, evidenceKinds: ["camera_recording", "screen_recording"] },
    ...common,
  ];
  return [
    ...inputs.map(input => ({ id: `source:${input.id}`, title: `${input.label} alone`, instruction: "Exercise this source on its own while the other sources remain silent. Retain the original recording and record which original track contains it.", required: true, evidenceKinds: ["isolated_track"] as BenchStep["evidenceKinds"] })),
    { id: "simultaneous", title: "All sources together", instruction: "Run all sources together with the intended recording and stream paths active. Document each independent original track; meter activity is insufficient.", required: true, evidenceKinds: ["isolated_track", "stream_mix"] },
    { id: "camera", title: "Camera while recording", instruction: "If the bound goal includes a camera/stream path, keep it active at the same time as isolated recording. Retain the original camera or screen recording, including interruptions.", required: options.cameraRequired ?? true, evidenceKinds: ["camera_recording", "screen_recording"] },
    { id: "monitoring", title: "Monitoring and dropouts", instruction: "Record what was heard through the selected monitor path, any latency observation and every dropout; do not infer this from file channel count.", required: true, evidenceKinds: ["stream_mix", "camera_recording", "isolated_track"] },
    ...common,
  ];
}

export function initialBenchConditions(binding: BenchBinding): BenchConditions {
  return {
    hardware: binding.components.map(component => ({ componentId: component.id, model: component.model, revision: "Not recorded", firmware: "Not recorded", matchesBoundModel: false, serialRecordId: null })),
    hostOs: "Not recorded", appAndVersion: "Not recorded", recordingSettings: "Not recorded", streamSettings: "Not recorded",
    storage: "Not recorded", power: "Not recorded", hubsAndCables: "Not recorded", monitoring: "Not recorded", declaredSeconds: 60,
    operator: "Workspace operator", locationLabel: "", notes: "",
  };
}

/** Classification of reported evidence, never a replacement compatibility certificate. */
export function assessBench(edition: BenchEdition, assets: BenchAsset[], decisions: BenchDecision[]): BenchAssessment {
  const scoped = decisions.filter(decision => decision.editionId === edition.id && decision.editionHash === edition.hash);
  const genuine = scoped.filter(decision => decision.provenance === "human" && decision.currentlyQualified && decision.currentAuthority && decision.principalHash && decision.qualificationId);
  const principals = new Set(genuine.map(decision => decision.principalHash));
  const reportedFailures = edition.observations.filter(observation => observation.outcome === "observed_failure").length;
  const elapsedSeconds = edition.startedAt && edition.finishedAt ? Math.max(0, (Date.parse(edition.finishedAt) - Date.parse(edition.startedAt)) / 1000) : null;
  const missing: string[] = [];
  const original = assets.filter(asset => asset.availability === "available" && asset.originalBytesRetained && asset.provenance === "operator_original" && !asset.detectedModelExport && (!asset.rights.expiresAt || Date.parse(asset.rights.expiresAt) > Date.now()));
  for (const step of edition.binding.steps.filter(step => step.required)) {
    const observations = edition.observations.filter(observation => observation.stepId === step.id);
    if (!observations.length) missing.push(`${step.title}: no observation recorded.`);
    else if (!observations.some(observation => observation.outcome === "observed_pass" || observation.outcome === "observed_failure")) missing.push(`${step.title}: execution remains uncertain or unperformed.`);
    const attached = edition.attachments.filter(link => link.stepId === step.id).map(link => original.find(asset => asset.id === link.assetId && asset.sha256 === link.assetHash)).filter((asset): asset is BenchAsset => !!asset);
    if (step.evidenceKinds.length && !attached.some(asset => step.evidenceKinds.includes(asset.kind))) missing.push(`${step.title}: original supporting file is missing.`);
  }
  const linked = (stepId: string) => edition.attachments.filter(link => link.stepId === stepId).flatMap(link => original.filter(asset => asset.id === link.assetId && asset.sha256 === link.assetHash));
  const sourceCount = edition.binding.steps.filter(step => step.required && step.id.startsWith("source:")).length;
  if (sourceCount) {
    const tracks = [...new Map(edition.attachments.flatMap(link => original.filter(asset => asset.id === link.assetId && asset.kind === "isolated_track")).map(asset => [asset.sha256, asset])).values()];
    const inspectableTracks = tracks.reduce((total, asset) => total + (asset.audio?.channels ?? (asset.mediaType === "audio/mpeg" ? 1 : 0)), 0);
    if (inspectableTracks < sourceCount) missing.push(`${sourceCount} source positions need independently inspectable track material; the retained originals expose only ${inspectableTracks} known track positions. Channel count alone still does not prove microphone independence.`);
    if (edition.binding.steps.some(step => step.id === "simultaneous" && step.required) && !linked("simultaneous").some(asset => asset.kind === "isolated_track")) missing.push("All sources together: original isolated-track material for the simultaneous run is missing.");
  }
  if (edition.binding.steps.some(step => step.id === "camera" && step.required) && !linked("simultaneous").some(asset => asset.kind === "stream_mix")) missing.push("The camera/stream goal needs an original stream mix from the simultaneous recording run.");
  const intervalFiles = linked("interval");
  if (intervalFiles.length && intervalFiles.every(asset => asset.audio && asset.audio.durationSeconds < edition.conditions.declaredSeconds)) missing.push("The original audio attached to the declared interval is shorter than that interval; a server timer cannot replace missing recording evidence.");
  if (edition.conditions.hardware.some(hardware => !hardware.matchesBoundModel)) missing.push("Exact hardware correspondence is not confirmed.");
  const unknown = (value: string) => /^(not recorded|unknown|unspecified)$/i.test(value.trim());
  if (unknown(edition.conditions.hostOs) || unknown(edition.conditions.appAndVersion)) missing.push("Exact host/software conditions are not recorded.");
  if (edition.conditions.hardware.some(hardware => unknown(hardware.revision) || unknown(hardware.firmware))) missing.push("Hardware revision or firmware remains unrecorded. Explicitly record not applicable when a device has none.");
  if ([edition.conditions.recordingSettings, edition.conditions.streamSettings, edition.conditions.storage, edition.conditions.power, edition.conditions.hubsAndCables, edition.conditions.monitoring].some(unknown)) missing.push("Recording, stream, storage, power, cable or monitoring conditions remain unrecorded. Record exact values or an explicit scope-specific not-applicable reason.");
  if (!edition.startedAt || !edition.finishedAt) missing.push("The recorded test interval is incomplete.");
  if (elapsedSeconds !== null && elapsedSeconds < edition.conditions.declaredSeconds) missing.push(`Recorded interval is ${Math.floor(elapsedSeconds)} s; the declared ${edition.conditions.declaredSeconds} s was not completed.`);
  const base: BenchAssessment = {
    status: "reported_unreviewed", label: "Operator report · awaiting review", detail: "These are recorded operator observations. Independent review has not established the physical report's exact scope.",
    physicalExecution: edition.startedAt ? "operator_reported" : "not_performed", actualQualifiedReviews: edition.sourceMode === "sample" ? 0 : principals.size,
    sampleReviews: scoped.filter(decision => decision.provenance === "sample").length, reportedFailures, missing,
    elapsedSeconds, declaredSeconds: edition.conditions.declaredSeconds, existingCertificateChanged: false,
  };
  if (edition.sourceMode === "sample") return { ...base, status: "sample_only", label: "Sample rehearsal", detail: "Generated files, Sample people and rehearsed steps exercise this notebook. No equipment test or actual human review is claimed.", physicalExecution: "not_performed", actualQualifiedReviews: 0 };
  if (edition.phase === "planning") return { ...base, status: "planning", label: "Plan · no test recorded", detail: "Declare the exact conditions and interval before starting. Nothing has been recorded as physical execution." };
  if (edition.phase === "running") return { ...base, status: "recording", label: "Operator recording in progress", detail: "The server clock records elapsed time. The operator must retain original observations and files; elapsed time is not physical proof." };
  // Revoking access cannot erase a previously qualified contradiction.
  if (scoped.some(decision => decision.provenance === "human" && decision.qualificationId && decision.outcome === "contradiction")) return { ...base, status: "review_contradicted", label: "Independent contradiction retained", detail: "A qualified reviewer recorded a contradiction against this exact manifest. Preserve it and prepare a new test or graph revision." };
  const supported = genuine.some(decision => decision.outcome === "supports_reported_scope" && edition.binding.steps.filter(step => step.required).every(step => linked(step.id).some(asset => step.evidenceKinds.includes(asset.kind) && decision.inspectedAssetIds.includes(asset.id))));
  if (reportedFailures) return { ...base, status: "reported_failure", label: supported ? "Reviewed report · failure retained" : "Operator reported a failure", detail: "A reported failure remains visible in every later edition. A review of this report does not turn the system into a passing configuration.", physicalExecution: supported && edition.phase === "sealed" && !missing.length ? "independently_reviewed_report" : "operator_reported" };
  if (genuine.some(decision => decision.outcome === "needs_evidence")) return { ...base, status: "review_needs_evidence", label: "Review needs more evidence", detail: "The current qualified review requests more evidence for the named conditions." };
  if (missing.length) return { ...base, status: "evidence_incomplete", label: "Physical report incomplete", detail: "Missing originals, unperformed steps or an incomplete interval remain visible. A reviewer cannot fill those gaps with a badge." };
  if (supported && edition.phase === "sealed") return { ...base, status: "reviewed_exact_conditions", label: "Independently reviewed report", detail: "A currently authorized, separately qualified reviewer supports this immutable report under its exact recorded conditions. Other hardware, software, durations and electrical safety are outside this claim.", physicalExecution: "independently_reviewed_report" };
  return base;
}
