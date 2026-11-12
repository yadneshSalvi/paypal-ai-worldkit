import type { Fact, Port, Source } from "../contracts";
import { profiles as creatorProfiles, sources as creatorSources } from "../device-library";
import { hash } from "../compatibility";
import { PACK_SCHEMA, PackProfileSchema, type PackId, type PackManifest, type PackProfile } from "./contracts";
import retrievedSources from "./source-manifest.json";

// Public links, factual notes and byte fingerprints only. Original documents stay
// outside the application. No extracted claim is counted as a human review.
export const packSources: Source[] = [...retrievedSources as Source[], ...creatorSources.filter(s => s.id === "shure-sm58")];
const fact = (id: string, property: string, value: Fact["value"], sourceIds: string[], conditions: string[] = [], unit: string | null = null): Fact => ({
  id: `${id}:${property}:1`, property, value, sourceIds, conditions, unit, scope: id,
  state: value === null ? "unknown" : "supported", critical: true, review: { status: "pending", reviewer: null, date: null },
});
const port = (id: string, label: string, connector: string, direction: Port["direction"], signal: Port["signal"], protocol: string, channels = 1): Port => ({ id, label, connector, direction, signal, protocols: [protocol], channels, facts: [] });
function profile(id: string, manufacturer: string, model: string, variant: string, kind: PackProfile["kind"], description: string, ports: Port[], claims: [string, Fact["value"], string[], string[]?][], accent: string): PackProfile {
  const facts = Object.fromEntries(claims.map(([property, value, sourceIds, conditions]) => [property, fact(id, property, value, sourceIds, conditions)]));
  return { id, manufacturer, model, variant, kind, version: 1, shortName: model, description, ports: ports.map(p => ({ ...p, facts: Object.values(facts).map(f => f.id) })), facts,
    catalogId: null, selectedOptions: [], reviewState: "review_pending", portMapStatus: "review_pending", art: "original_line_art", accent };
}
const airPorts = () => [port("usb1", "Thunderbolt / USB 4 · 1", "USB-C", "out", "video", "displayport_4k60"), port("usb2", "Thunderbolt / USB 4 · 2", "USB-C", "out", "video", "displayport_4k60"), port("magsafe", "MagSafe 3 power", "MagSafe 3", "in", "power", "magsafe_3")];
const recorderPorts = (inputs: number) => [
  ...Array.from({ length: inputs }, (_, i) => port(`input${i + 1}`, `INPUT ${i + 1} · XLR`, "XLR", "in", "audio", "analog_balanced")),
  ...Array.from({ length: inputs }, (_, i) => port(`phones${i + 1}`, `PHONES ${i + 1}`, "3.5mm TRS", "out", "audio", "analog_stereo", 2)),
  port("usb", "USB · stereo mix", "USB-C", "out", "data", "usb_audio", 2),
];
const shure = PackProfileSchema.parse(structuredClone(creatorProfiles.find(p => p.id === "shure-sm58-lc")!));
const sony = PackProfileSchema.parse(structuredClone(creatorProfiles.find(p => p.id === "sony-mdr7506")!));
sony.version = 2; sony.description = "A stereo headphone at each listening position. Impedance and physical loudness still need a real setup check.";
sony.facts.stereoMonitoring = fact(sony.id, "stereoMonitoring", true, ["sony-mdr7506-pack"]);

export const packProfiles: PackProfile[] = [
  profile("pack-air-m2-2022", "Apple", "MacBook Air M2", "13-inch · 2022 · native DisplayPort", "host", "Two USB-C sockets, one native external display.", airPorts(), [
    ["externalDisplays", 1, ["apple-air-m2"]], ["display4k60", true, ["apple-air-m2"], ["One external display up to 6K at 60 Hz"]], ["magsafe3", true, ["apple-air-m2"]],
  ], "#b7c4da"),
  profile("pack-air-m3-2024", "Apple", "MacBook Air M3", "13-inch · 2024 · native DisplayPort", "host", "Two external displays require the lid closed and the documented setup conditions.", airPorts(), [
    ["externalDisplays", 2, ["apple-air-m3", "apple-dual-m3"], ["Lid closed", "macOS 14.3 or later", "External keyboard and mouse or trackpad", "External power", "Independent native display paths"]],
    ["display4k60", true, ["apple-air-m3", "apple-dual-m3"], ["Second display up to 5K at 60 Hz with lid closed"]], ["magsafe3", true, ["apple-air-m3"]],
  ], "#b7c4da"),
  profile("pack-dell-u2723qe", "Dell", "UltraSharp U2723QE", "27-inch · 3840 × 2160 · 60 Hz", "display", "Use the video-capable upstream USB-C port, not the separate data-only upstream port.", [port("usbc-video", "USB-C upstream · DP 1.4 video", "USB-C", "in", "video", "displayport_4k60")], [
    ["display4k60", true, ["dell-u2723qe"]], ["videoUsbC", true, ["dell-u2723qe"], ["Video/data upstream port", "Supplied C–C cable"]],
  ], "#d5e7d9"),
  profile("pack-air-magsafe-set", "Apple", "MacBook Air power set", "Supplied adapter + USB-C to MagSafe 3 cable", "power", "The complete included supply and MagSafe cable are modeled as one power path.", [port("magsafe", "MagSafe 3 cable tip", "MagSafe 3", "out", "power", "magsafe_3")], [["magsafe3", true, ["apple-air-m2", "apple-air-m3"], ["Included supply for the exact laptop configuration"]]], "#ede7db"),
  profile("pack-podtrak-p4", "Zoom", "PodTrak P4", "Original P4 · not P4next · local microphone inputs", "recorder", "Four microphone inputs and four headphone sockets. USB carries a stereo mix.", recorderPorts(4), [
    ["independentChannels", 4, ["zoom-p4-spec", "zoom-p4-manual"]], ["headphoneOutputs", 4, ["zoom-p4-spec"]], ["onboardIsolated", true, ["zoom-p4-manual"], ["SD card recording", "Inputs 3 and 4 set to microphone, not phone or USB"]],
    ["usbStereoMix", true, ["zoom-p4-manual", "zoom-p4-spec"]], ["batteryPower", true, ["zoom-p4-spec"], ["Two suitable AA batteries"]],
  ], "#f2c488"),
  profile("pack-podtrak-p8", "Zoom", "PodTrak P8", "Original P8 · six local microphone inputs", "recorder", "Six local microphone paths and six headphone sockets. Keep Track Files preserves isolated recordings.", recorderPorts(6), [
    ["independentChannels", 6, ["zoom-p8-manual"]], ["headphoneOutputs", 6, ["zoom-p8-manual"]], ["onboardIsolated", true, ["zoom-p8-manual", "zoom-p8-guide"], ["SD card recording", "Keep Track Files set to Original Data or With Tone & Comp", "Input 6 set to microphone, not USB"]],
    ["usbStereoMix", true, ["zoom-p8-manual"]], ["batteryPower", true, ["zoom-p8-guide"], ["Four suitable AA batteries or the specified AD-14 supply"]],
  ], "#f2c488"),
  shure, sony,
];

export const packManifests: PackManifest[] = [
  { schema: PACK_SCHEMA, id: "desk-displays", version: "1.0.0", ruleVersion: "desk-displays.1.0.0", name: "A desk for two views", eyebrow: "DESK · DISPLAYS · POWER", description: "Two independent 4K workspaces. One precise answer about your laptop.", promise: "Discover why a second socket is not a second display engine.", accent: "#47674e",
    defaultState: { config: { packId: "desk-displays", host: "air-m2", displays: 2, lid: "open", macos: "14.3", externalInputs: false, powerConnected: true, directPorts: true }, disabledConnections: [], ownership: [], budgetMinor: 250000 },
    sourceIds: ["apple-air-m2", "apple-air-m3", "apple-dual-m3", "dell-u2723qe"],
    coverage: ["Native independent external displays", "Exact M2 and M3 Air display limits", "Lid, OS, input and power conditions", "Direct USB-C DisplayPort cable paths"],
    exclusions: ["DisplayLink, MST, docks and daisy chains are outside this pack", "Prices, tax and shipping need current exact offers", "External inputs are a planned setup condition", "No physical display test or genuine human source review yet"], actualHumanReviews: 0, physicalTests: 0 },
  { schema: PACK_SCHEMA, id: "podcast-classroom", version: "1.0.0", ruleVersion: "podcast-classroom.1.0.0", name: "Every voice, its own track", eyebrow: "SHARED STUDIO · PODCAST · CLASSROOM", description: "A table for two to six people. Separate files. A listening position for everyone.", promise: "Hear exactly which voice is lost when an input is missing.", accent: "#a86332",
    defaultState: { config: { packId: "podcast-classroom", recorder: "podtrak-p4", participants: 6, destination: "sd_card", storageConfirmed: false, powerConfirmed: false, keepTrackFiles: true }, disabledConnections: [], ownership: [], budgetMinor: 150000 },
    sourceIds: ["zoom-p4-spec", "zoom-p4-manual", "zoom-p8-guide", "zoom-p8-manual", "shure-sm58", "sony-mdr7506-pack"],
    coverage: ["Original P4 and P8 exact input counts", "One isolated file per local microphone", "One independent headphone socket per participant", "A modelled signal audition tied to the saved graph"],
    exclusions: ["Remote guests, USB return and phone inputs are outside this local-voice pack", "USB output is a stereo mix, not isolated microphone tracks", "Exact storage media, stands and accessory prices remain to be selected", "No physical audio performance test or genuine human source review yet"], actualHumanReviews: 0, physicalTests: 0 },
];
export function manifestFor(id: PackId): PackManifest { return packManifests.find(pack => pack.id === id)!; }
export function sourcesFor(id: PackId): Source[] { const wanted = new Set(manifestFor(id).sourceIds); return structuredClone(packSources.filter(source => wanted.has(source.id))); }
export function packHash(id: PackId): string {
  const profileIds = id === "desk-displays" ? ["pack-air-m2-2022", "pack-air-m3-2024", "pack-dell-u2723qe", "pack-air-magsafe-set"] : ["pack-podtrak-p4", "pack-podtrak-p8", "shure-sm58-lc", "sony-mdr7506"];
  return hash({ manifest: manifestFor(id), profiles: packProfiles.filter(profile => profileIds.includes(profile.id)), sources: sourcesFor(id) });
}
