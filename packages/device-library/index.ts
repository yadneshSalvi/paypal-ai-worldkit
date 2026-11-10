import type { Architecture, DeviceKind, DeviceProfile, Fact, Goal, KitRevision, Port, Signal, Source } from "../contracts/index";
import sourceManifest from "./source-manifest.json";

export const sources: Source[] = sourceManifest as Source[];
const observed = "2026-11-11";
function fact(profileId: string, property: string, value: Fact["value"], sourceIds: string[], scope: string, unit: string | null = null, conditions: string[] = []): Fact {
  return { id: `${profileId}:${property}:1`, property, value, unit, sourceIds, scope, conditions, state: value === null ? "unknown" : "supported", critical: true, review: { status: "pending", reviewer: null, date: null } };
}
function port(id: string, label: string, connector: string, direction: Port["direction"], signal: Signal, protocols: string[], channels = 1): Port {
  return { id, label, connector, direction, signal, protocols, channels, facts: [] };
}
function profile(id: string, manufacturer: string, model: string, variant: string, kind: DeviceKind, description: string, ports: Port[], values: [string, Fact["value"], string[], string?, string[]?][], accent: string): DeviceProfile {
  return { id, manufacturer, model, variant, kind, version: 1, shortName: model, description, ports,
    facts: Object.fromEntries(values.map(([key, value, sourceIds, unit, conditions]) => [key, fact(id, key, value, sourceIds, `${manufacturer} ${model}; ${variant}`, unit ?? null, conditions ?? [])])),
    catalogId: null, selectedOptions: [], reviewState: "review_pending", art: "original_line_art", accent };
}
const audioInputs = () => [port("input1", "Input 1 · XLR", "XLR", "in", "audio", ["analog_balanced"]), port("input2", "Input 2 · XLR", "XLR", "in", "audio", ["analog_balanced"])];
const usbAudio = () => port("usb", "USB · stereo mix", "USB-C", "out", "data", ["usb_audio", "usb_data"], 2);
const headphonesOut = () => port("phones", "Headphone out", "3.5mm TRS", "out", "audio", ["analog_stereo"], 2);

export const profiles: DeviceProfile[] = [
  profile("shure-sm58-lc", "Shure", "SM58", "SM58-LC · wired XLR · no cable", "microphone", "A familiar dynamic microphone for the first voice.", [port("out", "Balanced XLR out", "XLR", "out", "audio", ["analog_balanced"])], [["phantomRequired", false, ["shure-sm58"]], ["independentChannels", 1, ["shure-sm58"]]], "#dbe4ed"),
  profile("at2020-xlr", "Audio-Technica", "AT2020", "Black · XLR condenser (not USB)", "microphone", "A condenser microphone that needs 48 V phantom power.", [port("out", "Balanced XLR out", "XLR", "out", "audio", ["analog_balanced"])], [["phantomRequired", true, ["at2020"]], ["phantomVoltage", 48, ["at2020"], "V"], ["phantomCurrent", 2, ["at2020"], "mA"]], "#e0e2e6"),
  profile("zoom-h4essential", "Zoom", "H4essential", "48 kHz · Stereo Mix · Audio I/F + REC", "recorder", "Keep isolated tracks on the recorder, send the mix to your stream.", [...audioInputs(), usbAudio(), headphonesOut(), port("sd", "microSD storage", "microSD", "out", "data", ["file_storage"], 4)], [["independentChannels", 2, ["zoom-h4-manual"]], ["onboardIsolated", true, ["zoom-h4-manual"]], ["simultaneousUsbRecording", true, ["zoom-h4-manual"], undefined, ["Audio I/F + REC", "44.1 or 48 kHz"]], ["maxSimultaneousSampleRate", 48000, ["zoom-h4-manual"], "Hz"], ["usbStereoMix", true, ["zoom-h4-manual"]], ["phantomVoltage", 48, ["zoom-h4-manual"], "V"], ["batteryPower", true, ["zoom-h4-manual"]]], "#d7dfeb"),
  profile("focusrite-2i2-4", "Focusrite", "Scarlett 2i2", "4th generation · two microphone inputs", "interface", "A compact interface; recording still depends on the host application.", [...audioInputs(), usbAudio(), { ...headphonesOut(), connector: "6.35mm TRS" }], [["independentChannels", 2, ["scarlett-2i2"]], ["onboardIsolated", false, ["scarlett-2i2"]], ["phantomVoltage", 48, ["scarlett-2i2"], "V"], ["usbStereoMix", null, []], ["simultaneousUsbRecording", null, []]], "#f3d4d3"),
  profile("zoom-livetrak-l8", "Zoom", "LiveTrak L-8", "USB + SD · iOS routing review pending", "mixer", "Hands-on mixing and onboard recording, with more inputs to grow into.", [...audioInputs(), usbAudio(), headphonesOut()], [["independentChannels", 6, ["zoom-l8"]], ["onboardIsolated", true, ["zoom-l8"]], ["simultaneousUsbRecording", true, ["zoom-l8"]], ["usbStereoMix", null, []], ["phantomVoltage", 48, ["zoom-l8"], "V"], ["batteryPower", true, ["zoom-l8"]]], "#d8dee7"),
  profile("sony-zve10", "Sony", "ZV-E10", "Original generation · NTSC · 1080p60", "camera", "Your camera supplies the video, with its HDMI display settings confirmed.", [port("hdmi", "Micro HDMI out", "Micro HDMI", "out", "video", ["hdmi_1080p60"]), port("mic", "Microphone input", "3.5mm TRS", "in", "audio", ["analog_mic_stereo"], 2)], [["hdmi1080p60", true, ["sony-zve10-hdmi"]], ["cleanHdmi", null, ["sony-zve10-spec"]], ["lineToMicLevel", null, []]], "#dfe3e7"),
  profile("elgato-camlink-4k", "Elgato", "Cam Link 4K", "1080p60 · hardware revision to confirm", "capture", "Turns your camera’s HDMI output into a USB video source.", [port("hdmi", "HDMI in", "HDMI", "in", "video", ["hdmi_1080p60"]), port("usb", "USB 3 video out", "USB-A", "out", "data", ["usb_data", "uvc"], 1)], [["hdmi1080p60", true, ["elgato-camlink"]], ["uvcVideo", true, ["elgato-camlink"]], ["usbBandwidthMbps", null, []], ["powerWatts", null, []], ["exactHardwareRevision", null, []]], "#e3e5ec"),
  profile("apple-ipad-air5", "Apple", "iPad Air", "5th generation · M1 · iPadOS 26 · Camo 2.4.1", "host", "Your tablet runs the stream. Isolated recording happens elsewhere.", [port("usb", "USB-C data + power", "USB-C", "in", "data", ["usb_data", "usb_audio", "uvc"], 2)], [["usbCapacityMbps", 10000, ["ipad-air-5"], "Mb/s"], ["externalVideoAudio", true, ["camo-ipad-audio", "camo-ipad-guide"]], ["hostIsolatedWhileStreaming", null, []], ["singleUsbAudioSource", true, ["camo-ipad-audio"]], ["exactAppHardwareSupport", null, []]], "#dddcef"),
  profile("anker-555-a8383", "Anker", "555 USB-C Hub", "A8383 · 8-in-1 · 10 Gb/s", "hub", "One connection to your tablet for the camera, audio and charging.", [port("audio", "USB-C data", "USB-C", "in", "data", ["usb_audio", "usb_data"], 2), port("video", "USB-A data", "USB-A", "in", "data", ["usb_data", "uvc"]), port("host", "USB-C to host", "USB-C", "out", "data", ["usb_data", "usb_audio", "uvc"], 2), port("pd", "USB-C PD in", "USB-C", "in", "power", ["usb_pd"])], [["usbCapacityMbps", 10000, ["anker-555"], "Mb/s"], ["hostPowerMaxWatts", 85, ["anker-555"], "W"], ["peripheralPowerWatts", null, []]], "#dedfe6"),
  profile("sony-mdr7506", "Sony", "MDR-7506", "3.5 mm plug · supplied 6.35 mm adapter", "headphones", "Use your existing headphones to hear the recorder’s mix.", [port("in", "Headphone input", "3.5mm TRS", "in", "audio", ["analog_stereo"], 2)], [["stereoMonitoring", null, []]], "#e4e3dc"),
  profile("power-usb-pd", "Unconfirmed", "USB-C power supply", "Exact 100 W PD supply and cable required", "power", "Choose and review the exact supply before electrical verification.", [port("out", "USB-C PD out", "USB-C", "out", "power", ["usb_pd"])], [["powerWatts", null, []]], "#eae0ce"),
];

export const architectures: Architecture[] = [
  { id: "T1", name: "The compact interface", subtitle: "Record on your tablet", description: "Two microphones feed a Scarlett interface. The tablet would handle isolated recording and the live camera stream together.", tradeoff: "Needs exact application evidence for isolated recording while streaming.", recordingLocation: "Tablet application", requiredFacts: [{ role: "host", property: "hostIsolatedWhileStreaming", expected: true }] },
  { id: "T2", name: "Record here. Stream there.", subtitle: "A recorder shares the work", description: "The H4essential keeps separate tracks on its card and sends a stereo mix through the hub. Your tablet takes care of the camera and stream.", tradeoff: "Simultaneous use requires Audio I/F + REC at 44.1 or 48 kHz.", recordingLocation: "Recorder microSD card", requiredFacts: [{ role: "audio", property: "onboardIsolated", expected: true }, { role: "audio", property: "simultaneousUsbRecording", expected: true }, { role: "audio", property: "usbStereoMix", expected: true }] },
  { id: "T3", name: "Room to grow", subtitle: "Mix first, record more", description: "A LiveTrak mixer gives performers physical controls and extra recording inputs. Its exact tablet USB routing still needs confirmation.", tradeoff: "More room for guests, more desk space, and a mode-specific USB review.", recordingLocation: "Mixer SD card", requiredFacts: [{ role: "audio", property: "onboardIsolated", expected: true }, { role: "audio", property: "simultaneousUsbRecording", expected: true }, { role: "audio", property: "usbStereoMix", expected: true }] },
  { id: "T4", name: "The camera carries the mix", subtitle: "One combined stream input", description: "The recorder keeps isolated tracks and sends its mix into the camera. HDMI carries both onward to the tablet.", tradeoff: "An exact line-to-microphone level conversion must be sourced before use.", recordingLocation: "Recorder microSD card", requiredFacts: [{ role: "audio", property: "onboardIsolated", expected: true }, { role: "camera", property: "lineToMicLevel", expected: true }] },
];

export const defaultGoal: Goal = {
  id: "goal-duo", title: "A studio for two", brief: "Livestream two musicians and record each microphone on its own track. Reuse our camera, iPad and headphones. Keep new equipment under $600.", version: 1, currency: "USD", budgetMinor: 60000, locale: "en-US",
  requiredOwnedProfileIds: ["sony-zve10", "apple-ipad-air5", "sony-mdr7506"],
  requirements: [
    { id: "R1", kind: "isolated_tracks", label: "Two separate tracks", detail: "Each microphone keeps its own independently usable recording.", hard: true, target: 2, confirmed: true },
    { id: "R2", kind: "camera_stream", label: "Camera in the stream", detail: "A documented camera path reaches the streaming application.", hard: true, target: null, confirmed: true },
    { id: "R3", kind: "monitoring", label: "Hear the mix", detail: "The existing headphones connect to an available monitor output.", hard: true, target: 1, confirmed: true },
    { id: "R4", kind: "power", label: "Power, properly accounted for", detail: "Microphone power and the exact hub/peripheral power budget are supported.", hard: true, target: null, confirmed: true },
    { id: "R5", kind: "budget", label: "New gear under $600", detail: "Fresh exact-variant prices, shipping, tax and required accessories fit the budget.", hard: true, target: 60000, confirmed: true },
    { id: "R6", kind: "reuse", label: "Keep what you own", detail: "Retain the exact camera, tablet and headphones in your equipment passport.", hard: true, target: 3, confirmed: true },
    { id: "R7", kind: "simultaneous", label: "Record while you stream", detail: "The selected device modes explicitly support both jobs at the same time.", hard: true, target: null, confirmed: true },
    { id: "R8", kind: "connections", label: "Every path connects", detail: "Direction, connector pairing and protocol agree on each enabled cable.", hard: true, target: null, confirmed: true },
    { id: "R9", kind: "source_review", label: "Evidence independently reviewed", detail: "Critical manufacturer claims require a real reviewer before the kit earns a verified badge.", hard: true, target: null, confirmed: true },
  ],
};

export function seedKit(templateId: Architecture["id"] = "T2", id = "sample-duo-r1", goal: Goal = structuredClone(defaultGoal)): KitRevision {
  const audioProfile = templateId === "T1" ? "focusrite-2i2-4" : templateId === "T3" ? "zoom-livetrak-l8" : "zoom-h4essential";
  const component = (id: string, profileId: string, role: string, owned: boolean, x: number, y: number, settings: Record<string, string | number | boolean> = {}) => ({ id, profileId, role, owned, quantity: 1, position: { x, y }, settings });
  const components = [
    component("mic-1", "shure-sm58-lc", "voice-1", false, 40, 60), component("mic-2", "shure-sm58-lc", "voice-2", false, 40, 270),
    component("audio", audioProfile, "audio", false, 300, 165, { sampleRate: 48000, phantomEnabled: false, usbMode: "Stereo Mix", recordingMode: "Audio I/F + REC", powerSource: "Batteries" }),
    component("camera", "sony-zve10", "camera", true, 40, 500, { resolution: "1080p60", cleanHdmiConfirmed: false }),
    component("capture", "elgato-camlink-4k", "capture", false, 300, 500),
    component("hub", "anker-555-a8383", "hub", false, 565, 330),
    component("host", "apple-ipad-air5", "host", true, 825, 165),
    component("headphones", "sony-mdr7506", "monitor", true, 565, 60),
    component("power", "power-usb-pd", "power", false, 825, 500),
  ];
  const edge = (id: string, from: string, fromPort: string, to: string, toPort: string, signal: Signal, protocol: string, cable: string, sourceIds: string[] = []) => ({ id, from: { componentId: from, portId: fromPort }, to: { componentId: to, portId: toPort }, signal, protocol, cable, enabled: true, sourceIds });
  const connections = [
    edge("mic1-audio", "mic-1", "out", "audio", "input1", "audio", "analog_balanced", "Balanced XLR female → male"),
    edge("mic2-audio", "mic-2", "out", "audio", "input2", "audio", "analog_balanced", "Balanced XLR female → male"),
    edge("audio-hub", "audio", "usb", "hub", "audio", "data", "usb_audio", "USB-C data cable", ["zoom-h4-manual"]),
    edge("camera-capture", "camera", "hdmi", "capture", "hdmi", "video", "hdmi_1080p60", "Micro HDMI → HDMI", ["sony-zve10-hdmi", "elgato-camlink"]),
    edge("capture-hub", "capture", "usb", "hub", "video", "data", "uvc", "USB-A 3.0 connection", ["elgato-camlink"]),
    edge("hub-host", "hub", "host", "host", "usb", "data", "usb_data", "Hub’s attached USB-C data cable", ["anker-555", "ipad-air-5"]),
    edge("audio-monitor", "audio", "phones", "headphones", "in", "audio", "analog_stereo", templateId === "T1" ? "6.35 mm adapter → headphone cable" : "3.5 mm headphone cable"),
    edge("power-hub", "power", "out", "hub", "pd", "power", "usb_pd", "100 W USB-C PD cable (exact identity pending)", ["anker-555"]),
  ];
  if (templateId === "T4") {
    connections.splice(connections.findIndex(x => x.id === "audio-hub"), 1);
    connections.push(edge("audio-camera", "audio", "phones", "camera", "mic", "audio", "analog_mic_stereo", "Line-to-mic attenuator (exact model pending)"));
  }
  return { id, kitId: "duo-studio", revision: 1, parentRevisionId: null, templateId, goal, components, connections, createdAt: `${observed}T00:00:00.000Z`, sourceMode: "sample" };
}

export function getProfile(id: string): DeviceProfile {
  const found = profiles.find(profile => profile.id === id);
  if (!found) throw new Error("Unknown device profile");
  return found;
}
