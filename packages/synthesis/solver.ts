import { graphHash, hash } from "../compatibility";
import type { Component, DeviceProfile, Goal, KitRevision, Signal } from "../contracts";
import { architectures } from "../device-library";
import { routingState } from "../soundcheck";
import { estimateCost } from "./cost";
import { SYNTHESIS_VERSION, type Candidate, type ComparisonEdition, type GoalChange, type GraphDiff, type ObjectiveVector, type Relaxation, type SynthesisInput, type UpgradeJourney, type UpgradeStage } from "./contracts";
import { supported, verifySystem } from "./validation";

const sortId = <T extends { id: string }>(values: T[]) => [...values].sort((a, b) => a.id.localeCompare(b.id));
const unique = <T,>(values: T[]) => [...new Set(values)];
const MAX_MODELED_INPUTS = 32;
const names: Record<KitRevision["templateId"], [string, string]> = {
  T1: ["One host. Two jobs.", "An interface feeds separate tracks to the recording and streaming host."],
  T2: ["Keep the takes. Share the mix.", "A recorder keeps the isolated files while the host runs the stream."],
  T3: ["Make room for the next voice.", "A mixer records the session with spare input capacity for later."],
  T4: ["Let the camera carry it.", "An isolated recorder feeds a converted mix into the camera path."],
};
const policy = {
  dominance: "Among complete feasible systems, A dominates B only when A is no worse on landed cost, new units, connections, host-recording dependencies, retained units and spare independent inputs, and strictly better on at least one. Unknown objectives never dominate known ones.",
  budget: "Lowest complete landed estimate among the feasible non-dominated full configurations evaluated for the current role choices. This is not an exhaustive market minimum.",
  balanced: "Minimize host-recording dependencies first, then connections, then landed cost. Choose a different architecture from the budget choice when one exists.",
  upgrade: "Most sourced spare independent inputs, then fewer host-recording dependencies, then cost. Choose a remaining distinct architecture when one exists.",
  ties: "Ties use the stable design key in ascending lexical order. Labels never manufacture an extra architecture.",
};

function unresolved(id: string, kind: DeviceProfile["kind"], model: string, property: string): DeviceProfile {
  return { id, manufacturer: "Unspecified role", model, shortName: model, variant: "Exact identity still required", kind, version: 1, description: "An unresolved role, not a product recommendation.",
    ports: [], facts: { [property]: { id: `${id}:${property}`, property, value: null, unit: null, sourceIds: [], scope: "Unspecified exact identity", conditions: [], state: "unknown", critical: true, review: { status: "pending", reviewer: null, date: null } } },
    catalogId: null, selectedOptions: [], reviewState: "candidate", portMapStatus: "pending", art: "original_line_art", accent: "#eee4d6" };
}
function exactPort(profile: DeviceProfile | undefined, preferred: string, direction: "in" | "out", protocol: string) {
  const fits = profile?.ports.filter(port => port.direction !== (direction === "in" ? "out" : "in") && port.protocols.includes(protocol)) ?? [];
  return fits.find(port => port.id === preferred)?.id ?? (fits.length === 1 ? fits[0]!.id : `unmapped-${preferred}`);
}
function profileChoices(input: SynthesisInput, kind: DeviceProfile["kind"], currentId?: string): DeviceProfile[] {
  const values = input.profiles.filter(profile => profile.kind === kind && !profile.id.startsWith("unresolved:"));
  return values.sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId)
    || Object.values(b.facts).filter(fact => supported(fact, input.sources, input.fixture)).length - Object.values(a.facts).filter(fact => supported(fact, input.sources, input.fixture)).length
    || a.id.localeCompare(b.id)).slice(0, 6);
}
function ensureProfile(input: SynthesisInput, value: DeviceProfile) { if (!input.profiles.some(profile => profile.id === value.id)) input.profiles.push(value); return value; }

function configuration(input: SynthesisInput, goal: Goal, template: KitRevision["templateId"], audioProfile: DeviceProfile, microphone: DeviceProfile): KitRevision {
  const base = input.base.kit;
  const keepRoles = ["camera", "capture", "hub", "host", "monitor", "power"];
  const components = structuredClone(base.components.filter(component => keepRoles.includes(component.role)));
  const originalAudio = base.components.find(component => component.role === "audio");
  const exactAudio = originalAudio?.owned ? input.profiles.find(profile => profile.id === originalAudio.profileId) ?? audioProfile : audioProfile;
  const settings = originalAudio?.profileId === exactAudio.id ? structuredClone(originalAudio.settings) : { sampleRate: 48000, phantomEnabled: false, powerSource: exactAudio.facts.batteryPower?.value === true ? "Batteries" : "USB", recordingMode: "Unconfirmed", usbMode: "Unconfirmed" };
  for (const key of ["firmwareVersion", "sampleRate", "recordingMode", "usbMode"]) {
    const fact = exactAudio.facts[key];
    if (supported(fact, input.sources, input.fixture) && ["string", "number", "boolean"].includes(typeof fact!.value)) settings[key] = fact!.value as string | number | boolean;
  }
  if ((exactAudio.baseProfileId ?? exactAudio.id) === "zoom-h4essential") Object.assign(settings, { sampleRate: 48000, recordingMode: "Audio I/F + REC", usbMode: "Stereo Mix" });
  components.push({ id: "audio", profileId: exactAudio.id, role: "audio", owned: originalAudio?.owned ?? false, quantity: 1, position: originalAudio?.position ?? { x: 300, y: 165 }, settings,
    ...(originalAudio?.owned ? { inventoryItemId: originalAudio.inventoryItemId, ownershipSource: originalAudio.ownershipSource } : {}) });
  // Keep the original hard target intact. A larger brief fails its full check;
  // this bound limits graph generation, never silently reduces the goal.
  const tracks = Math.min(MAX_MODELED_INPUTS, Math.max(1, Math.ceil(goal.requirements.find(requirement => requirement.kind === "isolated_tracks")?.target ?? 2)));
  for (let index = 1; index <= tracks; index++) {
    const previous = base.components.find(component => component.id === `mic-${index}`);
    components.push(previous?.owned ? structuredClone(previous) : { id: `mic-${index}`, profileId: microphone.id, role: `voice-${index}`, owned: false, quantity: 1, position: { x: 40, y: 60 + (index - 1) * 210 }, settings: {} });
  }
  // Extra owned possessions cannot disappear just because the new brief has
  // fewer source roles. Their identity remains in the graph and diff.
  for (const previous of base.components.filter(component => component.owned)) if (!components.some(component => component.id === previous.id)) components.push(structuredClone(previous));
  const get = (role: string) => components.find(component => component.role === role);
  const profile = (role: string) => input.profiles.find(profile => profile.id === get(role)?.profileId);
  const connections: KitRevision["connections"] = [];
  const edge = (id: string, from: string, fromPort: string, to: string, toPort: string, signal: Signal, protocol: string, cable: string) => {
    const a = get(from), b = get(to), ap = profile(from), bp = profile(to);
    connections.push({ id, from: { componentId: a?.id ?? from, portId: exactPort(ap, fromPort, "out", protocol) }, to: { componentId: b?.id ?? to, portId: exactPort(bp, toPort, "in", protocol) }, signal, protocol, cable, enabled: true, sourceIds: unique([...Object.values(ap?.facts ?? {}), ...Object.values(bp?.facts ?? {})].flatMap(fact => fact.sourceIds)) });
  };
  for (const voice of components.filter(component => /^voice-\d+$/.test(component.role))) edge(`mic${voice.role.slice(6)}-audio`, voice.role, "out", "audio", `input${voice.role.slice(6)}`, "audio", "analog_balanced", "Balanced XLR cable");
  if (template !== "T4") edge("audio-hub", "audio", "usb", "hub", "audio", "data", "usb_audio", "Exact USB audio data cable");
  edge("camera-capture", "camera", "hdmi", "capture", "hdmi", "video", "hdmi_1080p60", "Micro HDMI → HDMI");
  edge("capture-hub", "capture", "usb", "hub", "video", "data", "uvc", "USB-A video connection");
  edge("hub-host", "hub", "host", "host", "usb", "data", "usb_data", "USB-C host data cable");
  edge("audio-monitor", "audio", "phones", "monitor", "in", "audio", "analog_stereo", exactAudio.ports.find(port => port.id === "phones")?.connector === "6.35mm TRS" ? "6.35 mm headphone adapter" : "Stereo headphone cable");
  edge("power-hub", "power", "out", "hub", "pd", "power", "usb_pd", "Exact USB-C power-delivery cable");
  if (template !== "T1") {
    const previous = base.components.find(component => component.role === "storage" && component.owned);
    const storage = previous ? input.profiles.find(profile => profile.id === previous.profileId)! : profileChoices(input, "storage")[0] ?? ensureProfile(input, unresolved("unresolved:storage", "storage", "Supported recording media to confirm", "recordingMediaSupported"));
    if (!components.some(component => component.id === "storage")) components.push(previous ?? { id: "storage", profileId: storage.id, role: "storage", owned: false, quantity: 1, position: { x: 310, y: 390 }, settings: {} });
    edge("audio-storage", "audio", "sd", "storage", "in", "data", "file_storage", "Exact supported recording card");
  }
  if (template === "T4") {
    const converter = input.profiles.find(profile => profile.kind === "cable" && profile.facts.lineToMicConversion?.value === true) ?? ensureProfile(input, unresolved("unresolved:attenuator", "cable", "Line-to-mic converter to confirm", "lineToMicConversion"));
    components.push({ id: "attenuator", profileId: converter.id, role: "attenuator", owned: false, quantity: 1, position: { x: 300, y: 385 }, settings: {} });
    edge("audio-attenuator", "audio", "line", "attenuator", "in", "audio", "analog_stereo", "Stereo line cable");
    edge("attenuator-camera", "attenuator", "out", "camera", "mic", "audio", "analog_mic_stereo", "Camera microphone cable");
  }
  for (const connection of connections) {
    const previous = base.components.find(component => component.owned && component.role === `cable:${connection.id}`);
    if (previous) { if (!components.some(component => component.id === previous.id)) components.push(structuredClone(previous)); continue; }
    const cable = sortId(input.profiles.filter(profile => profile.kind === "cable" && profile.facts[`carries:${connection.protocol}`]?.value === true))[0] ?? ensureProfile(input, unresolved(`unresolved:cable:${connection.protocol}`, "cable", `Exact ${connection.protocol.replaceAll("_", " ")} accessory`, `carries:${connection.protocol}`));
    components.push({ id: `cable-${connection.id}`, profileId: cable.id, role: `cable:${connection.id}`, owned: false, quantity: 1, position: { x: 1100, y: components.length * 70 }, settings: { connectionId: connection.id } });
  }
  return { ...base, id: `proposal:${hash({ template, goal, components, connections }).slice(0, 32)}`, goal: structuredClone(goal), templateId: template, components, connections,
    parentRevisionId: base.id, revision: base.revision + 1, createdAt: input.now, sourceMode: input.fixture ? "sample" : "modelled" };
}

export function diffGraphs(before: KitRevision, after: KitRevision, profiles: DeviceProfile[]): GraphDiff {
  const name = (component: Component | undefined) => component ? profiles.find(profile => profile.id === component.profileId)?.model ?? component.profileId : null;
  const content = (value: Component | undefined) => value ? { ...value, position: undefined } : null;
  const components = unique([...before.components, ...after.components].map(value => value.id)).map(id => {
    const a = before.components.find(value => value.id === id), b = after.components.find(value => value.id === id);
    return { id, kind: !a ? "added" as const : !b ? "removed" as const : hash(content(a)) === hash(content(b)) ? "retained" as const : "changed" as const, before: a ?? null, after: b ?? null, beforeName: name(a), afterName: name(b) };
  });
  const connections = unique([...before.connections, ...after.connections].map(value => value.id)).map(id => {
    const a = before.connections.find(value => value.id === id), b = after.connections.find(value => value.id === id);
    return { id, kind: !a ? "added" as const : !b ? "removed" as const : hash(a) === hash(b) ? "retained" as const : "changed" as const, before: a ?? null, after: b ?? null };
  });
  return { components, connections, preservedOwned: components.filter(value => value.before?.owned && value.after?.owned && value.before.profileId === value.after.profileId).map(value => value.id),
    storedForLater: components.filter(value => value.kind === "removed" || value.kind === "changed").filter(value => value.before).map(value => value.id) };
}

function evaluateCandidate(input: SynthesisInput, kit: KitRevision): Candidate {
  const proof = verifySystem(kit, input);
  const audio = kit.components.find(component => component.role === "audio"), profile = input.profiles.find(profile => profile.id === audio?.profileId);
  const channels = profile?.facts.independentChannels;
  const requested = kit.goal.requirements.find(requirement => requirement.kind === "isolated_tracks")?.target ?? 2;
  const objectives: ObjectiveVector = { landedMinor: proof.cost.landedMinor, newItems: kit.components.filter(component => !component.owned).reduce((sum, component) => sum + component.quantity, 0),
    connections: kit.connections.filter(connection => connection.enabled).length, externalRecordingDependencies: kit.templateId === "T1" ? 1 : 0,
    spareInputs: supported(channels, input.sources, input.fixture) && typeof channels!.value === "number" ? Math.max(0, channels!.value - requested) : null,
    reusedItems: kit.components.filter(component => component.owned).reduce((sum, component) => sum + component.quantity, 0) };
  const designKey = hash({ template: kit.templateId, components: sortId(kit.components).map(component => ({ role: component.role, profileId: component.profileId, quantity: component.quantity, settings: component.settings })), connections: sortId(kit.connections) });
  const id = `candidate:${hash({ designKey, graph: proof.certificate.graphHash, sources: proof.certificate.sourceHash }).slice(0, 40)}`;
  const flow = proof.certificate.results.filter(result => kit.goal.requirements.some(requirement => ["isolated_tracks", "simultaneous", "connections", "monitoring", "power"].includes(requirement.kind) && requirement.id === result.requirementId));
  // The existing audio renderer supports two onboard sources. A sourced host
  // architecture is still offered, but it does not receive invented audio output.
  const renderedRoute = routingState(kit);
  const soundcheck = kit.templateId !== "T1" && requested === 2 && Object.values(renderedRoute).every(Boolean) && flow.every(result => result.status === "satisfied") && proof.constraints.every(result => result.status === "satisfied");
  return { id, designKey, architecture: kit.templateId, title: names[kit.templateId][0], subtitle: names[kit.templateId][1],
    bundle: { kit, certificate: proof.certificate, profiles: input.profiles.filter(profile => kit.components.some(component => component.profileId === profile.id)), sources: input.sources.filter(source => kit.components.some(component => Object.values(input.profiles.find(profile => profile.id === component.profileId)?.facts ?? {}).some(fact => fact.sourceIds.includes(source.id)))) },
    cost: proof.cost, objectives, constraints: proof.constraints, feasible: proof.certificate.status === "satisfied", state: proof.certificate.status, nondominated: false, dominatedBy: [], labels: [],
    tradeoffs: [kit.templateId === "T1" ? "The host owns both recording and streaming; the exact application mode is a hard premise." : "Isolated files live on the recorder; the streaming application has one less recording job.",
      objectives.spareInputs === null ? "Spare independent inputs have not been established." : `${objectives.spareInputs} sourced input${objectives.spareInputs === 1 ? "" : "s"} remain beyond this brief. Additional microphones and paths would need a new verification.`,
      `${objectives.connections} modeled connections, ${objectives.newItems} new units including all listed cables and media.`,
      proof.cost.complete ? `${proof.cost.mode === "sample" ? "Fictional Sample" : "Observed"} cost includes the listed shipping and tax. It is an estimate, not an approved quote.` : "The known subtotal leaves shipping, tax or exact items unresolved."],
    diff: diffGraphs(input.base.kit, kit, input.profiles), openPremises: proof.openPremises,
    soundcheck: { supported: soundcheck, reason: soundcheck ? "Two onboard routing paths can use the existing modeled soundcheck; no physical performance is asserted." : "The current soundcheck models two onboard tracks. This route or its source premises are outside that supported preview." },
    retainedEquipment: kit.components.filter(component => component.owned).map(component => component.id), newEquipment: kit.components.filter(component => !component.owned).map(component => component.id) };
}

export function dominates(a: ObjectiveVector, b: ObjectiveVector): boolean {
  if (a.landedMinor === null || b.landedMinor === null || a.spareInputs === null || b.spareInputs === null) return false;
  const left = [a.landedMinor, a.newItems, a.connections, a.externalRecordingDependencies, -a.spareInputs, -a.reusedItems];
  const right = [b.landedMinor, b.newItems, b.connections, b.externalRecordingDependencies, -b.spareInputs, -b.reusedItems];
  return left.every((value, index) => value <= right[index]!) && left.some((value, index) => value < right[index]!);
}
export function rankCandidates(candidates: Candidate[]): Candidate[] {
  for (const candidate of candidates) {
    candidate.labels = [];
    candidate.dominatedBy = candidate.feasible ? candidates.filter(other => other.id !== candidate.id && other.feasible && dominates(other.objectives, candidate.objectives)).map(other => other.id).sort() : [];
    candidate.nondominated = candidate.feasible && !candidate.dominatedBy.length;
  }
  const frontier = candidates.filter(candidate => candidate.nondominated);
  const tie = (a: Candidate, b: Candidate) => a.designKey.localeCompare(b.designKey);
  const budget = [...frontier].sort((a, b) => a.objectives.landedMinor! - b.objectives.landedMinor! || tie(a, b))[0];
  const balancedPool = frontier.filter(candidate => candidate.architecture !== budget?.architecture);
  const balanced = balancedPool.sort((a, b) => a.objectives.externalRecordingDependencies - b.objectives.externalRecordingDependencies || a.objectives.connections - b.objectives.connections || a.objectives.landedMinor! - b.objectives.landedMinor! || tie(a, b))[0];
  const upgradePool = frontier.filter(candidate => candidate.architecture !== budget?.architecture && candidate.architecture !== balanced?.architecture);
  const upgrade = upgradePool.sort((a, b) => b.objectives.spareInputs! - a.objectives.spareInputs! || a.objectives.externalRecordingDependencies - b.objectives.externalRecordingDependencies || a.objectives.landedMinor! - b.objectives.landedMinor! || tie(a, b))[0];
  if (budget) budget.labels.push("budget"); if (balanced) balanced.labels.push("balanced"); if (upgrade) upgrade.labels.push("upgrade");
  return candidates.sort((a, b) => Number(b.feasible) - Number(a.feasible) || Number(b.labels.length > 0) - Number(a.labels.length > 0) || Number(b.nondominated) - Number(a.nondominated) || (a.objectives.landedMinor ?? Number.MAX_SAFE_INTEGER) - (b.objectives.landedMinor ?? Number.MAX_SAFE_INTEGER) || tie(a, b));
}

export function evaluateCatalog(original: SynthesisInput, goal: Goal = original.base.kit.goal): { candidates: Candidate[]; truncated: boolean } {
  const input = { ...original, profiles: [...original.profiles] };
  const currentAudio = original.base.kit.components.find(component => component.role === "audio"), currentMic = original.base.kit.components.find(component => component.role === "voice-1");
  const microphones = profileChoices(input, "microphone", currentMic?.profileId).slice(0, 3);
  if (!microphones.length) microphones.push(ensureProfile(input, unresolved("unresolved:microphone", "microphone", "Microphone identity to confirm", "phantomRequired")));
  const kits: KitRevision[] = []; let truncated = false;
  for (const template of architectures) {
    const choices = profileChoices(input, template.id === "T1" ? "interface" : template.id === "T3" ? "mixer" : "recorder", currentAudio?.profileId);
    if (!choices.length) choices.push(ensureProfile(input, unresolved(`unresolved:audio:${template.id}`, template.id === "T1" ? "interface" : template.id === "T3" ? "mixer" : "recorder", `${template.name}: exact equipment to confirm`, "independentChannels")));
    for (const audio of choices) for (const microphone of microphones) {
      if (kits.length >= 72) { truncated = true; continue; }
      kits.push(configuration(input, goal, template.id, audio, microphone));
    }
  }
  const graphs = new Set<string>();
  const candidates = kits.filter(kit => { const key = graphHash(kit, input.profiles); if (graphs.has(key)) return false; graphs.add(key); return true; }).map(kit => evaluateCandidate(input, kit));
  return { candidates: rankCandidates(candidates), truncated };
}

function changedGoal(goal: Goal, changes: GoalChange[]): Goal {
  const next = structuredClone(goal); next.version = goal.version + 1;
  for (const change of changes) {
    const requirement = next.requirements.find(requirement => requirement.id === change.requirementId)!;
    requirement.target = change.after;
    if (change.kind === "budget") { next.budgetMinor = change.after; requirement.label = `New gear under $${(change.after / 100).toFixed(2)}`; }
    else requirement.label = `${change.after} separate track${change.after === 1 ? "" : "s"}`;
  }
  return next;
}
export function minimalRelaxations(input: SynthesisInput, candidates: Candidate[]): Relaxation[] {
  if (candidates.some(candidate => candidate.feasible)) return [];
  const goal = input.base.kit.goal, budget = goal.requirements.find(requirement => requirement.kind === "budget" && requirement.hard), tracks = goal.requirements.find(requirement => requirement.kind === "isolated_tracks" && requirement.hard);
  const proposals: Relaxation[] = [];
  const assess = (values: Candidate[], changes: GoalChange[]) => {
    const technical = values.filter(candidate => candidate.cost.complete && candidate.bundle.certificate.results.filter(result => result.requirementId !== budget?.id).every(result => result.status === "satisfied"));
    if (!technical.length) return;
    const minimum = Math.min(...technical.map(candidate => candidate.cost.landedMinor!));
    const actual = [...changes];
    if (minimum > goal.budgetMinor) {
      if (!budget) return;
      actual.push({ kind: "budget", requirementId: budget.id, before: goal.budgetMinor, after: minimum, explanation: `Raise the complete equipment budget by ${minimum - goal.budgetMinor} USD cents for the least expensive verified system in this saved catalog.` });
    }
    if (!actual.length) return;
    const proposedGoal = changedGoal(goal, actual), result = evaluateCatalog(input, proposedGoal).candidates.filter(candidate => candidate.feasible);
    if (!result.length) return;
    proposals.push({ id: `relaxation:${hash({ goal: hash(goal), changes: actual }).slice(0, 32)}`, title: actual.map(change => change.kind === "budget" ? `Budget $${(change.after / 100).toFixed(2)}` : `${change.after} isolated track${change.after === 1 ? "" : "s"}`).join(" + "), changes: actual, proposedGoal,
      candidateIds: result.map(candidate => candidate.id), originalBlockers: unique(candidates.flatMap(candidate => candidate.bundle.certificate.results.filter(result => result.status !== "satisfied").map(result => result.requirementId))), verifiedCandidateCount: result.length,
      minimal: true, scope: "Smallest changes within the evaluated architecture catalog; not a global market optimum." });
  };
  assess(candidates, []);
  const largestCapacity = Math.min(MAX_MODELED_INPUTS, Math.max(0, ...input.profiles.flatMap(profile => supported(profile.facts.independentChannels, input.sources, input.fixture) && typeof profile.facts.independentChannels!.value === "number" ? [Math.floor(profile.facts.independentChannels!.value)] : [])));
  if (tracks?.target && Number.isSafeInteger(tracks.target) && tracks.target > 1) for (let count = Math.min(tracks.target - 1, largestCapacity); count >= 1; count--) {
    const change: GoalChange = { kind: "tracks", requirementId: tracks.id, before: tracks.target, after: count, explanation: `Explicitly reduce the required isolated microphone tracks from ${tracks.target} to ${count}.` };
    assess(evaluateCatalog(input, changedGoal(goal, [change])).candidates, [change]);
  }
  if (!proposals.length) return [];
  const fewest = Math.min(...proposals.map(value => value.changes.length));
  return proposals.filter(value => value.changes.length === fewest).filter(value => !proposals.some(other => other !== value && other.changes.length === fewest && other.changes.every(change => {
    const compared = value.changes.find(item => item.kind === change.kind);
    return compared && (change.kind === "budget" ? change.after <= compared.after : change.after >= compared.after);
  }) && other.changes.some(change => { const compared = value.changes.find(item => item.kind === change.kind); return compared && change.after !== compared.after; }))).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 6);
}

export function makeComparison(input: SynthesisInput, options: { id: string; sequence: number; createdBy: string; previous?: ComparisonEdition; preferredCandidateId?: string | null; goal?: Goal; changes?: GoalChange[] }): ComparisonEdition {
  const goal = options.goal ?? input.base.kit.goal, result = evaluateCatalog(input, goal), blockers = new Map<string, ComparisonEdition["unsatisfied"][number]>();
  for (const candidate of result.candidates) for (const witness of candidate.bundle.certificate.results.filter(witness => witness.status !== "satisfied" && (witness.requirementId.startsWith("system:") || goal.requirements.find(requirement => requirement.id === witness.requirementId)?.hard))) {
    const previous = blockers.get(witness.requirementId);
    blockers.set(witness.requirementId, { id: witness.requirementId, title: witness.title, status: witness.status === "violated" || previous?.status === "violated" ? "violated" : "unknown", candidateCount: (previous?.candidateCount ?? 0) + 1 });
  }
  const previousCandidate = options.previous?.candidates.find(candidate => candidate.id === options.preferredCandidateId);
  const matched = previousCandidate ? result.candidates.find(candidate => candidate.designKey === previousCandidate.designKey) ?? result.candidates.find(candidate => candidate.architecture === previousCandidate.architecture && candidate.bundle.kit.components.find(component => component.role === "audio")?.profileId === previousCandidate.bundle.kit.components.find(component => component.role === "audio")?.profileId) : null;
  const value: Omit<ComparisonEdition, "hash"> = { id: options.id, kitId: input.base.kit.kitId, sequence: options.sequence, previousEditionId: options.previous?.id ?? null, createdAt: input.now, createdBy: options.createdBy, basis: input.basis,
    sourceMode: input.fixture ? "sample" : "modelled", originalGoal: input.base.kit.goal, goal, goalChanges: options.changes ?? [], candidates: result.candidates,
    relaxations: options.changes?.length ? [] : minimalRelaxations(input, result.candidates), origin: input.base,
    search: { evaluated: result.candidates.length, uniqueArchitectures: new Set(result.candidates.map(candidate => candidate.architecture)).size, truncated: result.truncated,
      catalogScope: "Four declared creator architectures; up to six exact audio profiles and three microphone choices per architecture. Existing non-audio roles are retained; exact sourced cable and storage identities are selected deterministically. At most 32 voice positions are modeled; larger hard targets remain unsatisfied. Every resulting full graph is checked. This is not an exhaustive market search." },
    policy, outcome: result.candidates.some(candidate => candidate.feasible) ? "feasible" : result.candidates.some(candidate => candidate.state === "unknown") ? "research" : "infeasible", unsatisfied: [...blockers.values()].sort((a, b) => b.candidateCount - a.candidateCount || a.id.localeCompare(b.id)),
    rebasedPreference: previousCandidate ? { previousCandidateId: previousCandidate.id, matchedCandidateId: matched?.id ?? null } : null };
  return { ...value, hash: hash(value) };
}

export function makeJourney(input: SynthesisInput, edition: ComparisonEdition, first: Candidate, later: Candidate, id: string): UpgradeJourney {
  const stages: UpgradeStage[] = [];
  let before = edition.origin.kit;
  for (const [index, candidate] of [first, later].entries()) {
    const reused = new Map<string, number>();
    if (index > 0) for (const component of first.bundle.kit.components.filter(component => !component.owned)) reused.set(component.profileId, (reused.get(component.profileId) ?? 0) + component.quantity);
    const incrementalCost = estimateCost(candidate.bundle.kit, candidate.bundle.profiles, input.offers, input.now, reused);
    const diff = diffGraphs(before, candidate.bundle.kit, [...edition.origin.profiles, ...first.bundle.profiles, ...later.bundle.profiles]);
    const reusedIds = incrementalCost.lines.filter(line => line.kind === "planned_reuse").map(line => line.componentId);
    stages.push({ id: `${id}:stage-${index + 1}`, index: index + 1, title: index === 0 ? "Build your first complete system" : "Grow when the next session needs it", candidateId: candidate.id, bundle: candidate.bundle, diff,
      fullSystemCost: candidate.cost, incrementalCost, reusedFromPreviousStage: reusedIds,
      prerequisites: ["Review the current goal, exact sources, equipment passport and fresh offers before applying this graph.", ...(index > 0 ? ["Confirm that the previous stage’s proposed new equipment was actually acquired and recorded in your passport. Planned reuse is conditional, not ownership."] : []), "Every purchase requires a separate current quote and payer approval. No funds are reserved.", ...(diff.storedForLater.length ? ["Keep any acquired equipment that the new wiring no longer uses. No resale, refund, return or fulfillment is assumed."] : [])],
      evidenceNeeded: unique([...candidate.openPremises.map(premise => premise.reason), ...candidate.bundle.certificate.results.filter(result => result.status !== "satisfied").map(result => result.title)]),
      originalOwned: edition.origin.kit.components.filter(component => component.owned).map(component => component.id), status: "proposed", funding: "not_approved", fulfillment: "not_performed" });
    before = candidate.bundle.kit;
  }
  const value: Omit<UpgradeJourney, "hash"> = { id, editionId: edition.id, kitId: edition.kitId, createdAt: input.now, origin: edition.origin, basis: edition.basis, stages, title: "Start complete. Grow deliberately.", purchasedHistory: input.purchased,
    authority: "Planning only. Each later graph needs a fresh review; purchases and repairs require separate authority." };
  return { ...value, hash: hash(value) };
}
