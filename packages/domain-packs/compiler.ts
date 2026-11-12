import { CertificateSchema, WorldKitError, type Certificate, type Connection, type Fact, type Source, type Truth, type Witness } from "../contracts";
import { combine, connectionIssues, hash } from "../compatibility";
import { manifestFor, packHash, packProfiles, sourcesFor } from "./catalog";
import { PackEditionSchema, PackStateSchema, type PackChange, type PackEdition, type PackGraph, type PackGuide, type PackProfile, type PackRequirement, type PackState } from "./contracts";

const unique = <T,>(values: T[]) => [...new Set(values)];
export function packRequirements(state: PackState): PackRequirement[] {
  const config = state.config;
  const specific = config.packId === "desk-displays" ? [
    { id: "D1", label: `${config.displays} independent display${config.displays === 1 ? "" : "s"}`, detail: "Each external screen has its own native display engine, at the documented 4K 60 Hz mode.", target: config.displays },
    { id: "D2", label: "A supported working mode", detail: "Closed-lid, OS, external input and power conditions must agree with the chosen laptop.", target: null },
    { id: "D3", label: "A separate path to every screen", detail: "Each screen uses a distinct native video output and its video-capable upstream USB-C input.", target: config.displays },
  ] : [
    { id: "P1", label: `${config.participants} microphone inputs`, detail: "Every local voice reaches a separate physical microphone input.", target: config.participants },
    { id: "P2", label: `${config.participants} separate recordings`, detail: "Record isolated microphone files to the selected destination, preserving the track-file setting.", target: config.participants },
    { id: "P3", label: "A listening place for everyone", detail: "A distinct headphone output is available to every participant.", target: config.participants },
    { id: "P4", label: "Power and storage accounted for", detail: "The plan names the recorder’s supported power option and compatible formatted SD media.", target: null },
  ];
  return [...specific, { id: "C1", label: "Every cable agrees", detail: "Both endpoints, signal direction and protocol must match.", target: null },
    { id: "C2", label: "The complete budget", detail: "Exact current equipment, cables, accessories, shipping and tax fit the saved budget.", target: state.budgetMinor },
    { id: "C3", label: "Evidence independently reviewed", detail: "Manufacturer documents, exact identities and critical facts require genuine human review.", target: null }].map(r => ({ ...r, hard: true }));
}

export function buildPackGraph(stateInput: PackState, identity: { id: string; projectId: string; edition: number; parentEditionId: string | null; title: string; at: string }): { graph: PackGraph; profiles: PackProfile[]; sources: Source[] } {
  const state = PackStateSchema.parse(stateInput); const config = state.config;
  if (unique(state.disabledConnections).length !== state.disabledConnections.length || unique(state.ownership.map(o => o.componentId)).length !== state.ownership.length) throw new WorldKitError("invalid_request", "A connection or equipment position was repeated.");
  state.disabledConnections.sort(); state.ownership.sort((a, b) => a.componentId.localeCompare(b.componentId));
  const components: PackGraph["components"] = []; const connections: Connection[] = [];
  const add = (id: string, profileId: string, role: string, x: number, y: number, settings: PackGraph["components"][number]["settings"] = {}) => {
    const owned = state.ownership.find(item => item.componentId === id);
    components.push({ id, profileId, role, quantity: 1, position: { x, y }, settings, owned: !!owned, ...(owned ? { inventoryItemId: owned.inventoryItemId, ownershipSource: "user_confirmed" as const } : {}) });
  };
  const edge = (id: string, from: string, fromPort: string, to: string, toPort: string, signal: Connection["signal"], protocol: string, cable: string, sourceIds: string[]) => connections.push({ id, from: { componentId: from, portId: fromPort }, to: { componentId: to, portId: toPort }, signal, protocol, cable, sourceIds, enabled: !state.disabledConnections.includes(id) });
  if (config.packId === "desk-displays") {
    const hostSource = config.host === "air-m2" ? "apple-air-m2" : "apple-air-m3";
    add("host", config.host === "air-m2" ? "pack-air-m2-2022" : "pack-air-m3-2024", "host", 380, 355, { lid: config.lid, macos: config.macos, externalInputs: config.externalInputs });
    for (let i = 1; i <= config.displays; i++) {
      add(`display-${i}`, "pack-dell-u2723qe", "display", config.displays === 1 ? 380 : i === 1 ? 190 : 570, 110, { resolution: "3840 × 2160", refreshHz: 60 });
      edge(`display-path-${i}`, "host", `usb${config.directPorts ? i : 1}`, `display-${i}`, "usbc-video", "video", "displayport_4k60", "Supplied Dell USB-C → USB-C video cable", [hostSource, "dell-u2723qe"]);
    }
    add("power", "pack-air-magsafe-set", "power", 115, 355);
    edge("power-path", "power", "magsafe", "host", "magsafe", "power", "magsafe_3", "Included adapter + USB-C to MagSafe 3 cable", [hostSource]);
    if (!config.powerConnected) connections.find(e => e.id === "power-path")!.enabled = false;
  } else {
    const source = config.recorder === "podtrak-p4" ? "zoom-p4-manual" : "zoom-p8-manual";
    add("recorder", config.recorder === "podtrak-p4" ? "pack-podtrak-p4" : "pack-podtrak-p8", "recorder", 380, 250, { destination: config.destination, keepTrackFiles: config.keepTrackFiles, inputs: "All local microphone mode", phantomEnabled: false, sampleRate: 44100 });
    for (let i = 1; i <= config.participants; i++) {
      add(`voice-${i}`, "shure-sm58-lc", `voice-${i}`, 90, 45 + i * 70);
      add(`listener-${i}`, "sony-mdr7506", `listener-${i}`, 670, 45 + i * 70);
      edge(`voice-path-${i}`, `voice-${i}`, "out", "recorder", `input${i}`, "audio", "analog_balanced", "Balanced XLR female → male cable", ["shure-sm58", source]);
      edge(`listen-path-${i}`, "recorder", `phones${i}`, `listener-${i}`, "in", "audio", "analog_stereo", "Headphone’s attached 3.5 mm stereo plug", [source, "sony-mdr7506-pack"]);
    }
  }
  if (state.disabledConnections.some(id => !connections.some(edge => edge.id === id))) throw new WorldKitError("invalid_request", "A disconnected cable does not belong to this configuration. Restore it before changing the number of positions.");
  if (state.ownership.some(binding => !components.some(component => component.id === binding.componentId))) throw new WorldKitError("invalid_identity", "An owned equipment position does not belong to this configuration.");
  const profiles = structuredClone(packProfiles.filter(p => components.some(c => c.profileId === p.id)));
  const allSources = sourcesFor(config.packId); const usedSources = new Set([...profiles.flatMap(p => Object.values(p.facts).flatMap(f => f.sourceIds)), ...connections.flatMap(e => e.sourceIds)]);
  return { graph: { id: identity.id, projectId: identity.projectId, edition: identity.edition, parentEditionId: identity.parentEditionId, packId: config.packId, packVersion: manifestFor(config.packId).version, templateId: config.packId, title: identity.title, state, components, connections, createdAt: identity.at, sourceMode: "modelled" }, profiles, sources: allSources.filter(s => usedSources.has(s.id)) };
}
export function packGraphHash(graph: PackGraph, profiles: PackProfile[]): string {
  return hash({ packId: graph.packId, packVersion: graph.packVersion, templateId: graph.templateId, state: graph.state, requirements: packRequirements(graph.state),
    components: [...graph.components].sort((a, b) => a.id.localeCompare(b.id)).map(({ position: _position, ...c }) => ({ ...c, profileHash: hash(profiles.find(p => p.id === c.profileId) ?? null) })), connections: [...graph.connections].sort((a, b) => a.id.localeCompare(b.id)) });
}
function usable(fact: Fact | undefined, sources: Source[]): fact is Fact {
  return !!fact && fact.value !== null && fact.state === "supported" && fact.review.status !== "rejected" && !!fact.sourceIds.length && fact.sourceIds.every(id => sources.some(source => source.id === id && source.kind === "manufacturer" && /^[a-f0-9]{64}$/.test(source.contentHash)));
}
export function packConnectionIssues(graph: PackGraph, profiles: PackProfile[]) {
  const issues = connectionIssues(graph, profiles); const consumed = new Set<string>();
  for (const edge of graph.connections.filter(edge => edge.enabled)) {
    const from = profiles.find(p => p.id === graph.components.find(c => c.id === edge.from.componentId)?.profileId)?.ports.find(p => p.id === edge.from.portId);
    const to = profiles.find(p => p.id === graph.components.find(c => c.id === edge.to.componentId)?.profileId)?.ports.find(p => p.id === edge.to.portId);
    const key = `${edge.from.componentId}:${edge.from.portId}`;
    if (consumed.has(key)) issues.push({ id: edge.id, status: "violated" as const, reason: "Two cables consume the same single output port. This pack does not assume a splitter." });
    consumed.add(key);
    if (from && to && (from.signal !== edge.signal || to.signal !== edge.signal)) issues.push({ id: edge.id, status: "violated" as const, reason: "The modeled signal does not match both physical endpoint types." });
  }
  return issues;
}
export function verifyPack(graph: PackGraph, profiles: PackProfile[], sources: Source[], at = new Date().toISOString()): Certificate {
  const results: Witness[] = []; const config = graph.state.config; const manifest = manifestFor(graph.packId); const issues = packConnectionIssues(graph, profiles);
  const profile = (componentId: string) => profiles.find(p => p.id === graph.components.find(c => c.id === componentId)?.profileId);
  const claim = (componentId: string, property: string) => profile(componentId)?.facts[property];
  const badPath = (id: string) => !graph.connections.some(e => e.id === id && e.enabled) || issues.some(issue => issue.id === id);
  const result = (requirementId: string, status: Truth, title: string, explanation: string, componentIds: string[] = [], connectionIds: string[] = [], facts: (Fact | undefined)[] = [], nextAction: string | null = null) => {
    const supported = facts.filter((f): f is Fact => !!f);
    results.push({ id: `${graph.id}:${requirementId}`, requirementId, ruleId: `${manifest.ruleVersion}:${requirementId}`, status, title, explanation, componentIds, connectionIds, factIds: supported.map(f => f.id), sourceIds: unique(supported.flatMap(f => f.sourceIds)), nextAction });
  };
  if (config.packId === "desk-displays") {
    const capacity = claim("host", "externalDisplays"); const mode = claim("host", "display4k60"); const panel = claim("display-1", "display4k60"); const paths = graph.connections.filter(e => e.signal === "video");
    const supported = usable(capacity, sources) && usable(mode, sources) && usable(panel, sources);
    const countWorks = supported && Number(capacity.value) >= config.displays && mode.value === true && panel.value === true;
    result("D1", !supported ? "unknown" : countWorks ? "satisfied" : "violated", !supported ? "The display limit needs its source" : countWorks ? "The display count fits the documented engine" : Number(capacity.value) < config.displays ? "The native display engine cannot meet this goal" : "The chosen 4K 60 Hz mode is unsupported", !supported ? "A critical display claim is unavailable or rejected." : `The saved goal asks for ${config.displays} independent 4K 60 Hz display${config.displays === 1 ? "" : "s"}. ${profile("host")?.model} documents ${capacity.value} native external display${capacity.value === 1 ? "" : "s"}${config.host === "air-m3" ? " under its closed-lid conditions" : ""}.${mode.value !== true || panel.value !== true ? " One of the exact endpoint facts does not support the requested 4K 60 Hz mode." : ""}`, ["host", ...paths.map(e => e.to.componentId)], paths.map(e => e.id), [capacity, mode, panel], countWorks ? null : "Review another host or explicitly change the display goal");
    const needsClosed = config.host === "air-m3" && config.displays > 1;
    const conditions = [needsClosed && config.lid !== "closed" ? "close the lid" : null, needsClosed && Number(config.macos) < 14.3 ? "use macOS 14.3 or later" : null, needsClosed && !config.externalInputs ? "plan an external keyboard and mouse or trackpad" : null, needsClosed && (!config.powerConnected || badPath("power-path")) ? "connect external power" : null].filter(Boolean);
    result("D2", !usable(capacity, sources) ? "unknown" : conditions.length ? "violated" : "satisfied", conditions.length ? "The second display needs these conditions" : "The planned working mode fits", conditions.length ? `For this M3 Air setup: ${conditions.join("; ")}. Opening the lid turns off the second external display.` : needsClosed ? "Lid closed, supported macOS, external inputs and the planned MagSafe power path are present. These are planned settings; the hardware has not been tested." : "This setup does not rely on the M3 closed-lid dual-display mode. Display-engine capacity is checked separately.", ["host", "power"], ["power-path"], [capacity], conditions.length ? "Update the operating conditions and preview the change" : null);
    const reused = new Set(paths.map(e => `${e.from.componentId}:${e.from.portId}`)).size !== paths.length;
    const requiredPaths = Array.from({ length: config.displays }, (_, i) => `display-path-${i + 1}`);
    const broken = requiredPaths.filter((id, i) => badPath(id) || !graph.connections.some(e => e.id === id && e.from.componentId === "host" && e.to.componentId === `display-${i + 1}` && e.to.portId === "usbc-video"));
    const videoClaims = Array.from({ length: config.displays }, (_, i) => claim(`display-${i + 1}`, "videoUsbC")); const videoKnown = videoClaims.every(f => usable(f, sources));
    result("D3", reused || broken.length ? "violated" : !videoKnown ? "unknown" : videoClaims.some(f => f!.value !== true) ? "violated" : "satisfied", reused ? "The same physical output is used twice" : broken.length ? "A display cable is disconnected or missing" : !videoKnown ? "The display input needs its source" : "Each screen has its own native video path", reused ? "Both screens claim the same single USB-C socket. This pack supports two direct laptop connections; no undocumented splitter or dock is assumed." : broken.length ? `${broken.length} required display path${broken.length === 1 ? " is" : "s are"} unavailable.` : !videoKnown ? "The exact Dell video-input claim is unavailable or rejected." : "Distinct host ports feed the Dell video-capable upstream inputs using the supplied C–C cables. The data-only USB-C input is excluded.", ["host", ...paths.map(e => e.to.componentId)], requiredPaths, videoClaims, reused || broken.length ? "Use one direct cable for each display" : null);
  } else {
    const inputs = claim("recorder", "independentChannels"); const headphones = claim("recorder", "headphoneOutputs"); const isolated = claim("recorder", "onboardIsolated"); const stereo = claim("recorder", "usbStereoMix");
    const voiceIds = Array.from({ length: config.participants }, (_, i) => `voice-path-${i + 1}`); const listenIds = Array.from({ length: config.participants }, (_, i) => `listen-path-${i + 1}`);
    const voiceBroken = voiceIds.filter((id, i) => badPath(id) || !graph.connections.some(e => e.id === id && e.from.componentId === `voice-${i + 1}` && e.to.componentId === "recorder" && e.to.portId === `input${i + 1}`));
    const listenBroken = listenIds.filter((id, i) => badPath(id) || !graph.connections.some(e => e.id === id && e.from.componentId === "recorder" && e.from.portId === `phones${i + 1}` && e.to.componentId === `listener-${i + 1}`));
    const enough = usable(inputs, sources) && Number(inputs.value) >= config.participants;
    result("P1", !usable(inputs, sources) ? "unknown" : !enough || voiceBroken.length ? "violated" : "satisfied", !enough ? "There are fewer inputs than people" : voiceBroken.length ? "A voice has lost its input" : "Every voice reaches a distinct microphone input", usable(inputs, sources) ? `${config.participants} voices need independent local inputs. ${profile("recorder")?.model} provides ${inputs.value}; ${config.participants - voiceBroken.length} modeled paths currently connect. All input selectors are planned in microphone mode.` : "The exact recorder’s independent-input claim needs its manufacturer source.", ["recorder", ...voiceIds.map((_, i) => `voice-${i + 1}`)], voiceIds, [inputs], !enough ? "Choose the P8 for six voices or explicitly reduce the participant goal" : voiceBroken.length ? "Reconnect the missing microphone path" : null);
    const saveTracks = config.recorder === "podtrak-p4" || config.keepTrackFiles;
    const recording = config.destination === "usb_host" ? usable(stereo, sources) && stereo.value === true ? "violated" : "unknown" : !usable(isolated, sources) ? "unknown" : isolated.value !== true || !enough || voiceBroken.length || !saveTracks ? "violated" : config.storageConfirmed ? "satisfied" : "unknown";
    result("P2", recording, config.destination === "usb_host" ? "The USB mix cannot preserve each microphone" : !saveTracks ? "Keep Track Files is off" : recording === "satisfied" ? "The planned SD route preserves each voice" : "Finish the isolated-recording path", config.destination === "usb_host" ? "Both original PodTrak models send a stereo USB mix. Two USB channels do not provide a separate file for each local microphone." : !saveTracks ? "On the P8, set Keep Track Files to Original Data or With Tone & Comp to retain the individual microphone files." : recording === "satisfied" ? `${config.participants} separate microphone paths reach the SD recording route. Compatible formatted media is a declared plan condition, not a tested card or recording.` : !config.storageConfirmed ? "Plan compatible, formatted SD media before relying on the local track files. The exact card is still to be selected." : "Each requested track needs a working input before it can be recorded separately.", ["recorder"], voiceIds, [isolated, ...(config.destination === "usb_host" ? [stereo] : [])], recording === "satisfied" ? null : "Use SD recording, retain track files and connect every voice");
    const monitorClaims = listenIds.map((_, i) => claim(`listener-${i + 1}`, "stereoMonitoring")); const monitoringKnown = monitorClaims.every(f => usable(f, sources));
    result("P3", !usable(headphones, sources) || !monitoringKnown ? "unknown" : Number(headphones.value) < config.participants || listenBroken.length || monitorClaims.some(f => f!.value !== true) ? "violated" : "satisfied", listenBroken.length ? "Someone has no listening output" : !monitoringKnown ? "The exact headphone connection needs evidence" : "Every participant has a headphone path", usable(headphones, sources) ? `${profile("recorder")?.model} has ${headphones.value} headphone outputs. ${config.participants - listenBroken.length} of ${config.participants} planned listening paths connect. Volume and loudness have not been measured.` : "The exact output count needs its manufacturer source.", ["recorder", ...listenIds.map((_, i) => `listener-${i + 1}`)], listenIds, [headphones, ...monitorClaims], listenBroken.length ? "Provide a separate available output for each listener" : null);
    const battery = claim("recorder", "batteryPower"); const powerSupported = usable(battery, sources) && battery.value === true;
    result("P4", config.powerConfirmed && usable(battery, sources) && battery.value !== true ? "violated" : config.powerConfirmed && config.storageConfirmed && powerSupported ? "satisfied" : "unknown", !powerSupported ? "The selected power option needs supporting evidence" : config.powerConfirmed && config.storageConfirmed ? "Power and media are planned" : "Complete the power and media plan", config.powerConfirmed && config.storageConfirmed && powerSupported ? `${config.recorder === "podtrak-p4" ? "Two AA batteries" : "Four AA batteries or the specified AD-14 supply"} and compatible formatted SD media are declared. Exact accessories, card compatibility and runtime still need physical confirmation.` : "Confirm a supported power arrangement and compatible formatted SD media in the plan. A declaration cannot override a false or unavailable manufacturer capability.", ["recorder"], [], [battery], config.powerConfirmed && config.storageConfirmed && powerSupported ? null : "Review the power capability and add the media conditions");
  }
  result("C1", issues.length ? combine(issues.map(i => i.status)) : "satisfied", issues.length ? `${issues.length} cable path${issues.length === 1 ? " needs" : "s need"} attention` : "The modeled cable endpoints agree", issues.length ? issues.map(i => `${i.id}: ${i.reason}`).join(" ") : "Every modeled cable has compatible endpoints and a supported protocol. Connector agreement does not certify physical operation.", unique(graph.connections.flatMap(e => [e.from.componentId, e.to.componentId])), issues.map(i => i.id), [], issues.length ? "Inspect the highlighted connection" : null);
  result("C2", "unknown", "Complete equipment cost is still unknown", `The saved ceiling is $${(graph.state.budgetMinor / 100).toFixed(2)}. No fresh, exact catalog offers, cable and accessory totals, tax or shipping are attached to this pack. Owned items only count when bound to a current equipment-passport entry.`, graph.components.filter(c => !c.owned).map(c => c.id), [], [], "Discover exact products and complete the cost evidence");
  const facts = profiles.flatMap(p => Object.values(p.facts).filter(f => f.critical)); const missing = facts.filter(f => !usable(f, sources));
  result("C3", "unknown", missing.length ? "Critical source evidence is missing" : "Manufacturer evidence awaits independent review", missing.length ? `${missing.length} critical claim${missing.length === 1 ? " has" : "s have"} missing, rejected or conflicting evidence. No claim may be promoted from a model’s confidence.` : `${facts.length} critical claims are linked to manufacturer documents. This pack has zero genuine human reviews and zero physical tests; modeled checks cannot remove that boundary.`, graph.components.map(c => c.id), [], facts, "Review the exact source claims and perform the physical setup test");
  const counts = { satisfied: results.filter(r => r.status === "satisfied").length, violated: results.filter(r => r.status === "violated").length, unknown: results.filter(r => r.status === "unknown").length };
  const graphHash = packGraphHash(graph, profiles); const sourceHash = hash([...sources].sort((a, b) => a.id.localeCompare(b.id)));
  return CertificateSchema.parse({ id: `packcert_${hash({ graphHash, sourceHash, ruleVersion: manifest.ruleVersion, results }).slice(0, 32)}`, revisionId: graph.id, graphHash, ruleVersion: manifest.ruleVersion, sourceHash, status: combine(results.map(r => r.status)), issuedAt: at, sourceMode: "modelled", results, counts, review: { required: facts.length, reviewed: 0, pending: facts.length }, scope: "Computational routing and source-backed constraints; physical performance not tested.", physicalTest: "not_performed" });
}
export function makePackEdition(state: PackState, identity: Parameters<typeof buildPackGraph>[1], reason: string): PackEdition {
  const { graph, profiles, sources } = buildPackGraph(state, identity); const certificate = verifyPack(graph, profiles, sources, identity.at);
  const content = { schema: "worldkit.domain-edition.1" as const, id: identity.id, projectId: identity.projectId, number: identity.edition, packHash: packHash(state.config.packId), graph, certificate, profiles, sources, reason, createdAt: identity.at };
  return PackEditionSchema.parse({ ...content, hash: hash(content) });
}
export function assertPackEdition(edition: PackEdition) {
  const { hash: expected, ...content } = edition;
  if (hash(content) !== expected || packGraphHash(edition.graph, edition.profiles) !== edition.certificate.graphHash || edition.graph.id !== edition.id || edition.certificate.revisionId !== edition.id) throw new WorldKitError("stale_revision", "This saved edition does not match its immutable evidence.", 409);
}
export function packChanges(before: PackState, after: PackState): PackChange[] {
  const names: Record<string, string> = { host: "Laptop", displays: "Display goal", lid: "Lid", macos: "macOS", externalInputs: "External keyboard and pointer", powerConnected: "MagSafe power", directPorts: "Separate native outputs", recorder: "Recorder", participants: "Participant goal", destination: "Recording destination", storageConfirmed: "Compatible SD media planned", powerConfirmed: "Recorder power planned", keepTrackFiles: "Keep individual track files" };
  const display = (v: unknown) => typeof v === "boolean" ? v ? "Yes" : "No" : v === undefined ? "—" : String(v).replaceAll("_", " ");
  const changes = Object.entries(after.config).filter(([key, value]) => key !== "packId" && value !== (before.config as Record<string, unknown>)[key]).map(([key, value]) => ({ field: names[key] ?? key, before: display((before.config as Record<string, unknown>)[key]), after: display(value) }));
  if (before.budgetMinor !== after.budgetMinor) changes.push({ field: "Budget ceiling", before: `$${(before.budgetMinor / 100).toFixed(2)}`, after: `$${(after.budgetMinor / 100).toFixed(2)}` });
  if (hash(before.disabledConnections) !== hash(after.disabledConnections)) changes.push({ field: "Disconnected cables", before: before.disabledConnections.join(", ") || "None", after: after.disabledConnections.join(", ") || "None" });
  if (hash(before.ownership) !== hash(after.ownership)) changes.push({ field: "Equipment passport bindings", before: `${before.ownership.length} positions`, after: `${after.ownership.length} positions` });
  return changes;
}
export function packGuide(edition: PackEdition): PackGuide[] {
  const graph = edition.graph; const config = graph.state.config;
  const model = (id: string) => edition.profiles.find(p => p.id === graph.components.find(c => c.id === id)?.profileId)?.model ?? id;
  const rows: Omit<PackGuide, "index">[] = graph.connections.map(e => ({ id: `guide-${e.id}`, connectionId: e.id, title: `${model(e.from.componentId)} → ${model(e.to.componentId)}`, instruction: `${e.cable}. Use ${e.from.portId} → ${e.to.portId}.${!e.enabled ? " This connection is disabled in the saved plan." : ""}`, sourceIds: e.sourceIds, enabled: e.enabled }));
  if (config.packId === "desk-displays") rows.push({ id: "guide-display-mode", connectionId: null, title: "Set the documented display mode", instruction: `Set each Dell to its video-capable USB-C input and 3840 × 2160 at 60 Hz. ${config.host === "air-m3" && config.displays > 1 ? "Use macOS 14.3 or later, connect an external keyboard and pointer, connect power, then close the laptop lid. Opening the lid disables the second external display." : "Confirm the laptop’s native external-display limit before attaching a second screen."}`, sourceIds: [config.host === "air-m2" ? "apple-air-m2" : "apple-dual-m3", "dell-u2723qe"], enabled: true });
  else rows.unshift({ id: "guide-recorder-mode", connectionId: null, title: "Prepare local microphone recording", instruction: `Lower output levels first. Set all used input selectors to microphone mode; these dynamic microphones do not require phantom power. ${config.recorder === "podtrak-p8" ? "Set Keep Track Files to Original Data or With Tone & Comp. " : ""}Use compatible formatted SD media for isolated recordings. The USB output is a stereo mix.`, sourceIds: [config.recorder === "podtrak-p4" ? "zoom-p4-manual" : "zoom-p8-manual", "shure-sm58"], enabled: true });
  rows.push({ id: "guide-physical-check", connectionId: null, title: "Run the real setup test", instruction: config.packId === "desk-displays" ? "On the actual devices, move a different window to each screen and verify both refresh modes. No physical test has been performed or recorded by this pack." : "On the actual recorder, speak into each microphone in turn, listen at each output, then inspect each saved track file independently. The browser audition is synthesized and is not this hardware test.", sourceIds: [], enabled: true });
  return rows.map((row, index) => ({ ...row, index: index + 1 }));
}
