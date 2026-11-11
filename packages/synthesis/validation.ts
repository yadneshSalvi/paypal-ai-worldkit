import { combine, graphHash, hash, verifyKit } from "../compatibility";
import type { Certificate, Component, DeviceProfile, Fact, KitRevision, Source, Truth, Witness } from "../contracts";
import { architectures } from "../device-library";
import { estimateCost } from "./cost";
import { SYNTHESIS_VERSION, type Candidate, type CostEstimate, type SynthesisInput } from "./contracts";

const unique = <T,>(values: T[]) => [...new Set(values)];
export function supported(fact: Fact | undefined, sources: Source[], sample: boolean): boolean {
  return Boolean(fact && fact.state === "supported" && fact.value !== null && fact.review.status === "reviewed" && fact.review.reviewer && fact.review.date
    && fact.sourceIds.length && fact.sourceIds.every(id => sources.some(source => source.id === id && /^[a-f0-9]{64}$/.test(source.contentHash) && ["manufacturer", "software_publisher", ...(sample ? ["sample"] : [])].includes(source.kind))));
}
function witness(id: string, status: Truth, title: string, explanation: string, components: string[] = [], connections: string[] = [], facts: Fact[] = []): Witness {
  return { id: `synthesis:${id}`, requirementId: `system:${id}`, ruleId: `${SYNTHESIS_VERSION}:${id}`, status, title, explanation,
    componentIds: components, connectionIds: connections, factIds: unique(facts.map(fact => fact.id)), sourceIds: unique(facts.flatMap(fact => fact.sourceIds)), nextAction: status === "satisfied" ? null : status === "violated" ? "Review another complete system" : "Review the exact source premise" };
}
export function sourcePremises(kit: KitRevision, input: SynthesisInput): Candidate["openPremises"] {
  return unique(kit.components.map(component => component.profileId)).flatMap(id => {
    const profile = input.profiles.find(value => value.id === id);
    if (!profile || !Object.values(profile.facts).some(fact => fact.critical)) return [{ id: `${id}:coverage`, profileId: id, property: "critical source coverage", reason: "The exact profile needs its own source-backed engineering premises.", sourceIds: [] }];
    const result = Object.values(profile.facts).filter(fact => fact.critical && !supported(fact, input.sources, input.fixture)).map(fact => ({ id: fact.id, profileId: id, property: fact.property,
      reason: fact.state === "conflicted" ? "The exact source claims conflict." : fact.state === "unknown" || fact.value === null ? "The critical value is unknown." : fact.review.status !== "reviewed" || !fact.review.reviewer ? "Independent source review is still open." : "A current primary source and review are missing.", sourceIds: fact.sourceIds }));
    if (profile.ports.length && profile.portMapStatus !== "reviewed") result.push({ id: `${id}:port-map`, profileId: id, property: "exact port map", reason: "The declared connectors and port resources still need their exact source-bound review. Matching shapes alone cannot verify this map.", sourceIds: unique(profile.ports.flatMap(port => port.facts)) });
    if (input.invalidProfileIds.includes(id)) result.push({ id: `${id}:edition`, profileId: id, property: "engineering edition", reason: "This engineering edition is no longer eligible for a new graph.", sourceIds: [] });
    result.push(...input.sourceProblems.filter(problem => problem.profileId === id).map(problem => ({ id: `${id}:current-source`, profileId: id, property: "current source version", reason: problem.reason, sourceIds: [] })));
    return result;
  });
}

export function systemConstraints(kit: KitRevision, input: SynthesisInput): Witness[] {
  const results: Witness[] = [];
  const invalidTargets = kit.goal.requirements.filter(requirement => requirement.confirmed && (
    ["isolated_tracks", "monitoring"].includes(requirement.kind) && requirement.target !== null && (!Number.isSafeInteger(requirement.target) || requirement.target < 1)
    || requirement.kind === "budget" && requirement.target !== null && requirement.target !== kit.goal.budgetMinor
  ));
  const missingTargets = kit.goal.requirements.filter(requirement => requirement.confirmed && ["isolated_tracks", "monitoring", "budget"].includes(requirement.kind) && requirement.target === null);
  results.push(witness("typed-goal", invalidTargets.length ? "violated" : missingTargets.length ? "unknown" : "satisfied", "The hard brief has consistent quantities", invalidTargets.length ? "Tracks and listeners need positive integer counts, and the budget requirement must match the exact USD minor-unit budget. Review the conflicting goal before choosing a system." : missingTargets.length ? "Confirm the missing track, listener or budget target; a default cannot silently satisfy an unspecified hard outcome." : "Track and listener counts are positive integers; the typed budget and requirement agree. No hard outcome was silently changed."));
  const component = (role: string) => kit.components.find(value => value.role === role);
  const profile = (value: Component | undefined) => input.profiles.find(p => p.id === value?.profileId);
  const fact = (value: Component | undefined, key: string) => profile(value)?.facts[key];
  const number = (value: Component | undefined, key: string): number | null => { const premise = fact(value, key); return supported(premise, input.sources, input.fixture) && typeof premise!.value === "number" && Number.isFinite(premise!.value) && premise!.value >= 0 ? premise!.value : null; };
  const bool = (value: Component | undefined, key: string): boolean | null => { const premise = fact(value, key); return supported(premise, input.sources, input.fixture) && typeof premise!.value === "boolean" ? premise!.value : null; };
  const facts = (...values: (Fact | undefined)[]) => values.filter(Boolean) as Fact[];
  const audio = component("audio"), host = component("host"), hub = component("hub"), capture = component("capture"), power = component("power"), camera = component("camera");
  const usedOutputs = new Map<string, string[]>();
  for (const edge of kit.connections.filter(edge => edge.enabled)) {
    const key = JSON.stringify([edge.from.componentId, edge.from.portId]);
    usedOutputs.set(key, [...usedOutputs.get(key) ?? [], edge.id]);
    const from = kit.components.find(value => value.id === edge.from.componentId), to = kit.components.find(value => value.id === edge.to.componentId);
    const fromPort = profile(from)?.ports.find(port => port.id === edge.from.portId), toPort = profile(to)?.ports.find(port => port.id === edge.to.portId);
    if (fromPort && toPort && (fromPort.signal !== edge.signal || toPort.signal !== edge.signal)) results.push(witness(`signal:${edge.id}`, "violated", "This signal needs an explicit converter", "A cable cannot change its declared signal type between endpoints.", [edge.from.componentId, edge.to.componentId], [edge.id]));
    const cable = kit.components.find(value => value.role === `cable:${edge.id}` && value.settings.connectionId === edge.id);
    if (!cable) results.push(witness(`cable:${edge.id}`, "unknown", "Name the exact cable or included accessory", `${edge.cable} still needs an exact procurement identity or sourced inclusion record.`, [edge.from.componentId, edge.to.componentId], [edge.id]));
    else {
      const carries = fact(cable, `carries:${edge.protocol}`);
      const endA = fact(cable, "connectorA"), endB = fact(cable, "connectorB");
      const endsKnown = fromPort && toPort && supported(endA, input.sources, input.fixture) && supported(endB, input.sources, input.fixture);
      const endsFit = endsKnown && ((endA!.value === fromPort.connector && endB!.value === toPort.connector) || (endB!.value === fromPort.connector && endA!.value === toPort.connector));
      results.push(witness(`cable:${edge.id}`, !supported(carries, input.sources, input.fixture) || !endsKnown ? "unknown" : carries!.value === true && endsFit && cable.quantity === 1 ? "satisfied" : "violated", "The complete connection includes its exact cable", "Both sourced connector ends, protocol, one physical accessory and cost must match this path. A shared protocol does not establish a compatible cable.", [cable.id], [edge.id], facts(carries, endA, endB)));
      if (["usb_audio", "uvc", "usb_data"].includes(edge.protocol)) {
        const upstream = [kit.templateId === "T4" ? 0 : number(audio, "usbBandwidthMbps"), number(capture, "usbBandwidthMbps")];
        const demand = edge.from.componentId === hub?.id ? upstream.some(value => value === null) ? null : upstream.reduce<number>((sum, value) => sum + value!, 0) : number(from, "usbBandwidthMbps");
        const limit = number(cable, "dataRateMbps");
        results.push(witness(`cable-bandwidth:${edge.id}`, demand === null || limit === null ? "unknown" : demand <= limit ? "satisfied" : "violated", "The cable carries the declared data load", "The cable has its own sourced data-rate limit; a USB-C connector alone does not establish bandwidth.", [cable.id], [edge.id], facts(fact(cable, "dataRateMbps"))));
      }
      if (edge.protocol === "usb_pd") {
        const limit = number(cable, "powerMaxWatts"), supply = number(power, "powerWatts");
        results.push(witness(`cable-power:${edge.id}`, limit === null || supply === null ? "unknown" : limit >= supply ? "satisfied" : "violated", "The power cable supports the declared supply", "The exact power cable must carry the selected supply rating; its connector shape is insufficient.", [cable.id], [edge.id], facts(fact(cable, "powerMaxWatts"))));
      }
    }
  }
  for (const [key, edges] of usedOutputs) if (edges.length > 1) {
    const [componentId, portId] = JSON.parse(key) as [string, string];
    const source = kit.components.find(value => value.id === componentId);
    const capacity = number(source, `fanout:${portId}`) ?? 1;
    results.push(witness(`output:${key}`, edges.length > capacity ? "violated" : "satisfied", "One physical jack cannot be spent twice", `${edges.length} cables use this output; its documented simultaneous connection capacity is ${capacity}. Channel count does not grant extra physical sockets.`, [componentId!], edges, facts(fact(source, `fanout:${portId}`))));
  }
  const activeAudioUsb = kit.connections.some(edge => edge.enabled && edge.from.componentId === audio?.id && edge.to.componentId === hub?.id && edge.protocol === "usb_audio");
  const audioBandwidth = activeAudioUsb ? number(audio, "usbBandwidthMbps") : 0;
  const videoBandwidth = number(capture, "usbBandwidthMbps"), hubBandwidth = number(hub, "usbCapacityMbps"), hostBandwidth = number(host, "usbCapacityMbps");
  const knownBandwidth = [audioBandwidth, videoBandwidth, hubBandwidth, hostBandwidth].every(value => value !== null);
  const requestedBandwidth = (audioBandwidth ?? 0) + (videoBandwidth ?? 0);
  results.push(witness("bandwidth", knownBandwidth ? requestedBandwidth <= Math.min(hubBandwidth!, hostBandwidth!) ? "satisfied" : "violated" : "unknown", knownBandwidth ? "The shared USB resource is accounted for" : "The shared USB allowance needs evidence",
    knownBandwidth ? `${requestedBandwidth} Mb/s of declared simultaneous demand shares a ${Math.min(hubBandwidth!, hostBandwidth!)} Mb/s sourced route. This models declared capacity; real throughput is untested.` : "Source the exact capture, audio, hub and host mode bandwidth; connector shape cannot fill this gap.", [audio?.id, capture?.id, hub?.id, host?.id].filter(Boolean) as string[], kit.connections.filter(edge => ["uvc", "usb_audio", "usb_data"].includes(edge.protocol)).map(edge => edge.id), facts(fact(audio, "usbBandwidthMbps"), fact(capture, "usbBandwidthMbps"), fact(hub, "usbCapacityMbps"), fact(host, "usbCapacityMbps"))));
  const videoAudio = kit.templateId === "T4";
  const usbSources = activeAudioUsb ? 1 : 0;
  const sourceLimit = number(host, "simultaneousUsbAudioSources");
  results.push(witness("software-resources", sourceLimit === null ? "unknown" : usbSources + Number(videoAudio) <= sourceLimit ? "satisfied" : "violated", "The app has a source for each job", "The exact application must admit the selected simultaneous audio sources. Recording inputs and app source slots are separate resources.", [host?.id ?? "host"], [], facts(fact(host, "simultaneousUsbAudioSources"))));

  const peripheralAllowance = number(hub, "peripheralPowerWatts"), captureDemand = number(capture, "powerWatts"), supply = number(power, "powerWatts"), hostDemand = number(host, "powerWatts"), hubDemand = number(hub, "selfPowerWatts"), hostAllowance = number(hub, "hostPowerMaxWatts");
  const audioBattery = audio?.settings.powerSource === "Batteries" && bool(audio, "batteryPower") === true;
  const audioDemand = audioBattery ? 0 : number(audio, "powerWatts");
  const values = [peripheralAllowance, captureDemand, supply, hostDemand, hubDemand, hostAllowance, audioDemand];
  const powerConnected = kit.connections.some(edge => edge.enabled && edge.from.componentId === power?.id && edge.to.componentId === hub?.id && edge.signal === "power");
  const powerState = !powerConnected ? "violated" : values.some(value => value === null) ? "unknown" : captureDemand! + (activeAudioUsb ? audioDemand! : 0) > peripheralAllowance! || hostDemand! > hostAllowance! || captureDemand! + audioDemand! + hostDemand! + hubDemand! > supply! ? "violated" : "satisfied";
  results.push(witness("whole-power", powerState, powerState === "satisfied" ? "Every declared load fits the source" : "Account for the entire power route", powerConnected ? "Capture, recorder/interface, host and hub demand must fit both the peripheral allowance and the upstream supply. Battery operation needs its own source." : "The hub has no enabled path from its declared power source.", [audio?.id, hub?.id, power?.id, host?.id, capture?.id].filter(Boolean) as string[], ["power-hub"], facts(fact(hub, "peripheralPowerWatts"), fact(power, "powerWatts"), fact(host, "powerWatts"), fact(hub, "selfPowerWatts"), fact(audio, audioBattery ? "batteryPower" : "powerWatts"))));
  if (audioBattery) results.push(witness("recorder-batteries", bool(audio, "batteryIncluded") === true ? "satisfied" : "unknown", "The recorder battery is included in the exact plan", "Battery operation requires sourced inclusion in this exact equipment identity. Otherwise the battery needs its own cost and identity before the system can pass.", [audio!.id], [], facts(fact(audio, "batteryIncluded"))));
  results.push(witness("camera-power", camera?.settings.powerSource === "Batteries" && bool(camera, "batteryPower") === true && bool(camera, "batteryIncluded") === true ? "satisfied" : "unknown", "The camera has a separate power premise", "Confirm the exact camera power mode and included battery. A video cable does not imply power delivery or an included battery.", camera ? [camera.id] : [], [], facts(fact(camera, "batteryPower"), fact(camera, "batteryIncluded"))));

  const media = component("storage");
  const storageNeeded = kit.templateId !== "T1";
  const storagePath = media && audio && kit.connections.some(edge => edge.enabled && edge.from.componentId === audio.id && edge.to.componentId === media.id && edge.protocol === "file_storage");
  results.push(witness("recording-media", storageNeeded ? !storagePath ? "unknown" : bool(media, "recordingMediaSupported") === false || bool(audio, "recordingMediaSupported") === false ? "violated" : bool(media, "recordingMediaSupported") === true && bool(audio, "recordingMediaSupported") === true ? "satisfied" : "unknown" : number(host, "availableStorageGB") !== null && number(host, "availableStorageGB")! > 0 ? "satisfied" : "unknown", "There is a destination for the files", storageNeeded ? "Onboard recording requires exact supported storage in the graph and cost estimate." : "Host recording needs sourced available storage for this plan; retained files and duration need a separate operational check.", [audio?.id, media?.id, ...(storageNeeded ? [] : [host?.id])].filter(Boolean) as string[], storagePath ? ["audio-storage"] : [], facts(fact(media, "recordingMediaSupported"), fact(audio, "recordingMediaSupported"), fact(host, "availableStorageGB"))));

  for (const [device, keys] of [[audio, ["firmwareVersion"]], [host, ["osVersion", "appVersion"]]] as [Component | undefined, string[]][]) for (const key of keys) {
    const expected = fact(device, key);
    const state = !supported(expected, input.sources, input.fixture) || device?.settings[key] === undefined ? "unknown" : expected!.value === device!.settings[key] ? "satisfied" : "violated";
    results.push(witness(`mode:${device?.id ?? "missing"}:${key}`, state, "The exact operating version travels with the plan", `${profile(device)?.model ?? "This role"}: ${key.replace(/([A-Z])/g, " $1").toLowerCase()} must match its sourced premise.`, device ? [device.id] : [], [], facts(expected)));
  }
  if (videoAudio) {
    const converter = component("attenuator");
    const conversion = bool(converter, "lineToMicConversion"), lineOutput = bool(audio, "independentLineOutput"), embedded = bool(camera, "embedsExternalAudio"), captured = bool(capture, "uvcAudio");
    results.push(witness("camera-audio", [conversion, lineOutput, embedded, captured].some(value => value === null) ? "unknown" : [conversion, lineOutput, embedded, captured].every(Boolean) ? "satisfied" : "violated", "The camera route needs a real level conversion", "A separate line output, sourced attenuator, camera embedding and capture audio mode must all agree. Headphone monitoring retains its own jack.", [audio?.id, converter?.id, camera?.id, capture?.id].filter(Boolean) as string[], kit.connections.filter(edge => ["audio-attenuator", "attenuator-camera", "camera-capture"].includes(edge.id)).map(edge => edge.id), facts(fact(converter, "lineToMicConversion"), fact(audio, "independentLineOutput"), fact(camera, "embedsExternalAudio"), fact(capture, "uvcAudio"))));
  }
  for (const key of ["hdmi1080p60", "cleanHdmi"]) if (bool(camera, key) === false) results.push(witness(`video:${key}`, "violated", "The camera source rules this mode out", "A sourced false capability cannot satisfy a video route just because its connectors match.", camera ? [camera.id] : [], [], facts(fact(camera, key))));
  for (const key of ["externalVideoAudio", "exactAppHardwareSupport"]) if (bool(host, key) === false) results.push(witness(`host:${key}`, "violated", "The host source rules this mode out", "The exact operating-system and application premises must support the chosen path.", host ? [host.id] : [], [], facts(fact(host, key))));
  for (const key of ["hdmi1080p60", "uvcVideo", "exactHardwareRevision"]) if (bool(capture, key) === false) results.push(witness(`capture:${key}`, "violated", "The capture source rules this mode out", "A known unsupported capture mode remains a hard conflict.", capture ? [capture.id] : [], [], facts(fact(capture, key))));
  const monitoring = kit.goal.requirements.find(requirement => requirement.kind === "monitoring" && requirement.confirmed);
  if (monitoring) {
    const monitors = kit.components.filter(value => profile(value)?.kind === "headphones" && kit.connections.some(edge => edge.enabled && edge.from.componentId === audio?.id && edge.to.componentId === value.id && edge.signal === "audio"));
    const state = monitors.some(value => bool(value, "stereoMonitoring") === false) || monitors.length < (monitoring.target ?? 1) ? "violated" : monitors.some(value => bool(value, "stereoMonitoring") === null) ? "unknown" : "satisfied";
    results.push(witness("monitor-count", state, "Each listener has a real monitoring path", "Count distinct connected headphones, not a device quantity or channel label. Additional listeners need their own sourced output or distribution path.", monitors.map(value => value.id), [], monitors.flatMap(value => facts(fact(value, "stereoMonitoring")))));
  }
  const ambiguousUnits = kit.components.filter(value => value.quantity !== 1 && kit.connections.some(edge => edge.enabled && [edge.from.componentId, edge.to.componentId].includes(value.id)));
  if (ambiguousUnits.length) results.push(witness("physical-instances", "violated", "Connected units need separate identities", "One connected component denotes one physical instance. Give each additional device its own ports and graph position.", ambiguousUnits.map(value => value.id)));

  const ownedBefore = input.base.kit.components.filter(value => value.owned);
  const changedOwned = ownedBefore.filter(before => !kit.components.some(after => after.id === before.id && after.profileId === before.profileId && after.owned && after.quantity >= before.quantity && after.inventoryItemId === before.inventoryItemId));
  results.push(witness("owned-preservation", changedOwned.length ? "violated" : "satisfied", "Equipment you own stays yours", changedOwned.length ? "This alternative changes an exact owned position without an explicit owned-equipment decision." : "Every original owned position, exact profile, quantity and equipment-passport reference is retained.", changedOwned.map(value => value.id)));
  for (const itemId of unique(kit.components.flatMap(value => value.inventoryItemId ? [value.inventoryItemId] : []))) {
    const used = kit.components.filter(value => value.inventoryItemId === itemId), item = input.inventory.find(value => value.id === itemId);
    const requested = used.reduce((sum, value) => sum + value.quantity, 0);
    const valid = item && item.status === "active" && item.ownership === "owned" && used.every(value => value.profileId === item.profile.id && value.owned) && requested <= item.quantity;
    results.push(witness(`inventory:${itemId}`, valid ? "satisfied" : "violated", "A possession cannot fill more positions than you own", valid ? `${requested} of ${item.quantity} confirmed units are used.` : "The confirmed profile, active status or available quantity no longer covers these positions.", used.map(value => value.id)));
  }
  for (const commitment of input.purchased) {
    const changed = commitment.components.filter(before => !kit.components.some(after => after.id === before.id && after.profileId === before.profileId && after.quantity >= before.quantity));
    results.push(witness(`purchased:${commitment.id}`, changed.length ? "violated" : "satisfied", "Purchased equipment has its own change process", changed.length ? "This route would replace equipment in a saved merchant commitment. Use the separate repair/return process first; a comparison cannot authorize it." : "The equipment positions in the saved merchant commitment are preserved. Its original graph and payment records remain immutable.", changed.map(value => value.id)));
  }
  const open = sourcePremises(kit, input);
  results.push(witness("current-evidence", open.length ? "unknown" : "satisfied", input.fixture ? "Synthetic premises are explicitly scoped" : "Every critical premise needs current support", open.length ? `${open.length} exact fact, source or engineering-edition questions remain.` : input.fixture ? "These are fictional Sample sources and machine fixtures. No manufacturer claim, human review or physical observation is asserted." : "The selected exact profiles and critical facts retain their current primary sources and recorded reviews.", unique(kit.components.map(value => value.id))));
  return results;
}

export function verifySystem(kit: KitRevision, input: SynthesisInput): { certificate: Certificate; constraints: Witness[]; cost: CostEstimate; openPremises: Candidate["openPremises"] } {
  const certificate = verifyKit(kit, input.profiles, input.sources, architectures, input.snapshots, input.now);
  const cost = estimateCost(kit, input.profiles, input.offers, input.now), constraints = systemConstraints(kit, input);
  const results = certificate.results.map(result => {
    const requirement = kit.goal.requirements.find(value => value.id === result.requirementId);
    if (requirement?.kind !== "budget" || !requirement.confirmed) return result;
    const over = (cost.landedMinor ?? cost.knownSubtotalMinor) > kit.goal.budgetMinor;
    return { ...result, ruleId: `${SYNTHESIS_VERSION}:complete-cost`, status: over ? "violated" as const : cost.complete ? "satisfied" as const : "unknown" as const,
      title: over ? "This whole system exceeds the budget" : cost.complete ? "Every item fits the stated budget" : "The complete landed cost is still open",
      explanation: cost.complete ? `${cost.mode === "sample" ? "Sample fixture" : "Observed"} landed estimate: ${cost.landedMinor} USD cents, including every listed component, cable, shipping and tax. No purchase or reservation is created.` : `Known item subtotal: ${cost.knownSubtotalMinor} USD cents. ${cost.missingComponents.length} component costs still need an exact current offer, shipping or tax; the subtotal is not the complete price.`,
      componentIds: cost.lines.filter(line => line.kind === "new").map(line => line.componentId), nextAction: over ? "Review an explicit budget relaxation" : cost.complete ? null : "Refresh exact offers and resolve shipping and tax" };
  });
  const allResults = [...results, ...constraints];
  const status = combine([...results.filter(result => kit.goal.requirements.find(requirement => requirement.id === result.requirementId)?.hard).map(result => result.status), ...constraints.map(result => result.status)]);
  const ruleVersion = `${certificate.ruleVersion}+${SYNTHESIS_VERSION}`, sourceHash = hash({ sources: certificate.sourceHash, observations: cost.lines.map(line => line.observation), currentSources: input.basis.sourceHeadsHash, engineering: input.basis.engineeringHash });
  return { certificate: { ...certificate, id: `cert_${hash({ graph: graphHash(kit, input.profiles), sourceHash, ruleVersion, results: allResults }).slice(0, 32)}`, sourceHash, ruleVersion,
    status, sourceMode: input.fixture ? "sample" : "modelled", results: allResults,
    counts: { satisfied: allResults.filter(value => value.status === "satisfied").length, violated: allResults.filter(value => value.status === "violated").length, unknown: allResults.filter(value => value.status === "unknown").length } },
    constraints, cost, openPremises: sourcePremises(kit, input) };
}
