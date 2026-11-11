import { hash, verifyKit } from "../compatibility";
import type { DeviceProfile, Fact, Port, Source } from "../contracts";
import { architectures, defaultGoal, seedKit } from "../device-library";
import { SYNTHESIS_VERSION, type OfferObservation, type SynthesisInput } from "./contracts";
import { evaluateCatalog } from "./solver";

/** Deliberately fictional normalized equipment. These records are never
 * manufacturer evidence, people, purchases or physical observations. */
export function sampleSynthesisInput(at = "2026-11-12T00:00:00.000Z", kitId = "sample-synthesis-kit", revisionId = "sample-synthesis-origin"): SynthesisInput {
  const source: Source = { id: "sample:synthesis-premises-v1", publisher: "WorldKit Sample fixture", title: "Fictional system-synthesis premises, edition 1", kind: "sample", url: "https://example.com/worldkit-sample-systems", retrievedAt: at,
    contentHash: hash({ fixture: "worldkit-system-futures", version: 1 }), location: "Synthetic test specification", summary: "Fictional devices, declared resource limits and prices for deterministic software checks. No real manufacturer, review or physical test is represented.", rights: "link_and_facts_only" };
  const port = (id: string, connector: string, direction: Port["direction"], signal: Port["signal"], protocols: string[], channels = 1): Port => ({ id, label: `${id.replaceAll("-", " ")} · ${connector}`, connector, direction, signal, protocols, channels, facts: [source.id] });
  const make = (id: string, model: string, kind: DeviceProfile["kind"], ports: Port[], values: Record<string, Fact["value"]>, accent: string): DeviceProfile => {
    const profileId = `sample:${id}`;
    return { id: profileId, manufacturer: "WorldKit Sample Studio", model: `Sample ${model}`, shortName: model, variant: "Fictional exact variant · fixture v1", kind, version: 1, description: "A clearly labelled synthetic device used to demonstrate full-system planning.", ports,
      facts: Object.fromEntries(Object.entries(values).map(([property, value]) => [property, { id: `${profileId}:${property}:v1`, property, value, unit: property.endsWith("Watts") ? "W" : property.endsWith("Mbps") ? "Mb/s" : null,
        sourceIds: [source.id], scope: `${model} · synthetic fixture v1`, conditions: [], state: value === null ? "unknown" : "supported", critical: true,
        review: { status: "reviewed", reviewer: "Automated Sample fixture — not a human reviewer", date: at } }])),
      catalogId: null, selectedOptions: [], reviewState: "verified_scope", portMapStatus: "reviewed", art: "original_line_art", accent };
  };
  const inputs = (count: number) => Array.from({ length: count }, (_, index) => port(`input${index + 1}`, "XLR", "in", "audio", ["analog_balanced"]));
  const audioPorts = (count: number, storage: boolean) => [...inputs(count), port("usb", "USB-C", "out", "data", ["usb_audio", "usb_data"], count), port("phones", "3.5mm TRS", "out", "audio", ["analog_stereo"], 2), port("line", "3.5mm TRS", "out", "audio", ["analog_stereo"], 2), ...(storage ? [port("sd", "microSD", "out", "data", ["file_storage"], count)] : [])];
  const audioFacts = (count: number, onboard: boolean) => ({ independentChannels: count, onboardIsolated: onboard, simultaneousUsbRecording: onboard, usbStereoMix: true, phantomVoltage: 48, batteryPower: onboard, batteryIncluded: onboard,
    usbBandwidthMbps: 12, powerWatts: 3, firmwareVersion: "fixture-1.0", sampleRate: 48000, recordingMode: onboard ? "Sample SD + USB" : "Sample host multitrack", usbMode: "Sample stereo mix", recordingMediaSupported: onboard, independentLineOutput: true });
  const profiles = [
    make("dynamic-mic", "Voice dynamic", "microphone", [port("out", "XLR", "out", "audio", ["analog_balanced"])], { phantomRequired: false, independentChannels: 1 }, "#cbd6de"),
    make("cheap-condenser", "Low-price incompatible microphone", "microphone", [port("out", "XLR", "out", "audio", ["analog_balanced"])], { phantomRequired: true, phantomVoltage: 96, independentChannels: 1 }, "#e9d4cb"),
    make("interface", "Pocket interface", "interface", audioPorts(2, false), audioFacts(2, false), "#e1b7a2"),
    make("recorder", "Field recorder", "recorder", audioPorts(2, true), audioFacts(2, true), "#c7d9ce"),
    make("mixer", "Six-input desk", "mixer", audioPorts(6, true), audioFacts(6, true), "#c7cbe1"),
    make("camera", "Camera", "camera", [port("hdmi", "Micro HDMI", "out", "video", ["hdmi_1080p60"]), port("mic", "3.5mm TRS", "in", "audio", ["analog_mic_stereo"], 2)], { hdmi1080p60: true, cleanHdmi: true, lineToMicLevel: true, embedsExternalAudio: true, batteryPower: true, batteryIncluded: true }, "#e0ddd3"),
    make("capture", "Capture bridge", "capture", [port("hdmi", "HDMI", "in", "video", ["hdmi_1080p60"]), port("usb", "USB-A", "out", "data", ["uvc", "usb_data"])], { hdmi1080p60: true, uvcVideo: true, uvcAudio: true, exactHardwareRevision: true, usbBandwidthMbps: 320, powerWatts: 3 }, "#d4d0e3"),
    make("host", "Tablet host", "host", [port("usb", "USB-C", "in", "data", ["usb_data", "usb_audio", "uvc"], 8)], { usbCapacityMbps: 5000, externalVideoAudio: true, hostIsolatedWhileStreaming: true, exactAppHardwareSupport: true, simultaneousUsbAudioSources: 1, powerWatts: 15, availableStorageGB: 64, osVersion: "Sample OS 1", appVersion: "Sample Studio 1" }, "#d4dce8"),
    make("hub", "Powered hub", "hub", [port("audio", "USB-C", "in", "data", ["usb_audio", "usb_data"], 8), port("video", "USB-A", "in", "data", ["uvc", "usb_data"]), port("host", "USB-C", "out", "data", ["usb_data", "usb_audio", "uvc"], 8), port("pd", "USB-C", "in", "power", ["usb_pd"])], { usbCapacityMbps: 5000, hostPowerMaxWatts: 60, peripheralPowerWatts: 12, selfPowerWatts: 4 }, "#dbdedb"),
    make("headphones", "Monitor headphones", "headphones", [port("in", "3.5mm TRS", "in", "audio", ["analog_stereo"], 2)], { stereoMonitoring: true }, "#eadcc5"),
    make("power", "65 W supply", "power", [port("out", "USB-C", "out", "power", ["usb_pd"])], { powerWatts: 65 }, "#eadfca"),
    make("storage", "Recording card", "storage", [port("in", "microSD", "in", "data", ["file_storage"], 8)], { recordingMediaSupported: true }, "#d2decf"),
    make("attenuator", "Level converter", "cable", [port("in", "3.5mm TRS", "in", "audio", ["analog_stereo"], 2), port("out", "3.5mm TRS", "out", "audio", ["analog_mic_stereo"], 2)], { lineToMicConversion: true }, "#e7d5c8"),
    ...["analog_balanced", "usb_audio", "hdmi_1080p60", "uvc", "usb_data", "analog_stereo", "usb_pd", "file_storage", "analog_mic_stereo"].map(protocol => {
      const connectorA = protocol === "analog_balanced" ? "XLR" : protocol === "hdmi_1080p60" ? "Micro HDMI" : protocol === "uvc" ? "USB-A" : protocol === "file_storage" ? "microSD" : protocol.startsWith("usb_") ? "USB-C" : "3.5mm TRS";
      return make(`cable-${protocol}`, `${protocol.replaceAll("_", " ")} accessory`, "cable", [], { [`carries:${protocol}`]: true, connectorA, connectorB: protocol === "hdmi_1080p60" ? "HDMI" : connectorA, dataRateMbps: 5000, powerMaxWatts: 100 }, "#e4e5e1");
    }),
  ];
  const price: Record<string, number> = { "dynamic-mic": 2500, "cheap-condenser": 1000, interface: 8000, recorder: 12500, mixer: 24000, camera: 20000, capture: 4500, host: 30000, hub: 4500, headphones: 5000, power: 2500, storage: 1000, attenuator: 1500 };
  const offers: OfferObservation[] = profiles.map(profile => ({ id: `sample-observation:${profile.id}:v1`, profileId: profile.id, profileHash: hash(profile), productId: null, selectedOptions: [], snapshotId: `sample-snapshot:${profile.id}:v1`, snapshotHash: hash({ sample: profile.id, price: price[profile.id.slice(7)] ?? 100 }), offerId: `sample-offer:${profile.id}`, retailer: "Fictional Sample store", condition: "Sample new condition", currency: "USD", unitMinor: price[profile.id.slice(7)] ?? 100,
    shippingMinor: 0, taxMinor: 0, availability: "available", observedAt: at, expiresAt: new Date(Date.parse(at) + 7 * 86400000).toISOString(), mode: "sample", note: "Fictional fixture prices with explicit zero shipping/tax. Seven-day fixture validity; no catalog call, reservation, payment or fulfillment." }));
  const goal = structuredClone(defaultGoal); goal.title = "Sample studio for two"; goal.brief = "A fictional Sample desk: two isolated microphone tracks and a camera stream. Keep the Sample camera, tablet and headphones. New gear budget: $600.";
  goal.requiredOwnedProfileIds = ["sample:camera", "sample:host", "sample:headphones"];
  const kit = seedKit("T2", revisionId, goal); kit.kitId = kitId; kit.createdAt = at;
  const mapping: Record<string, string> = { "mic-1": "dynamic-mic", "mic-2": "dynamic-mic", audio: "recorder", camera: "camera", capture: "capture", hub: "hub", host: "host", headphones: "headphones", power: "power" };
  for (const component of kit.components) {
    component.profileId = `sample:${mapping[component.id]}`;
    if (component.owned) component.ownershipSource = "sample";
    if (component.id === "camera") Object.assign(component.settings, { cleanHdmiConfirmed: true, powerSource: "Batteries" });
    if (component.id === "host") Object.assign(component.settings, { osVersion: "Sample OS 1", appVersion: "Sample Studio 1" });
  }
  const basis = { revisionId: kit.id, graphHash: "", goalHash: hash(goal), goalVersion: goal.version, profilesHash: hash(profiles), sourcesHash: hash([source]), sourceHeadsHash: hash([]), engineeringHash: hash([]), inventoryHash: hash([]), offersHash: hash(offers), commitmentsHash: hash([]), ruleVersion: SYNTHESIS_VERSION };
  const input: SynthesisInput = { base: { kit, profiles, sources: [source], certificate: verifyKit(kit, profiles, [source], architectures, [], at) }, profiles, sources: [source], snapshots: [], inventory: [], offers, basis, purchased: [], invalidProfileIds: [], sourceProblems: [], fixture: true, now: at };
  const complete = evaluateCatalog(input).candidates.find(candidate => candidate.architecture === "T2" && candidate.feasible);
  if (!complete) throw new Error("The fictional complete Sample baseline did not satisfy its own declared premises.");
  input.base = structuredClone(complete.bundle); input.base.kit.id = revisionId; input.base.kit.parentRevisionId = null; input.base.kit.revision = 1; input.base.certificate.revisionId = revisionId;
  input.basis.graphHash = input.base.certificate.graphHash;
  return input;
}
