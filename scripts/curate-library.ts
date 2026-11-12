/** Curation record for the real-device library.
 *
 * Each claim names a device, a property, a value, the cited manufacturer (or software publisher) document and a
 * locator pattern. The script copies the verbatim passage from the privately cached source text into
 * `packages/device-library/curated/library.json`. Nothing here is a human review: these are first-pass claims
 * that only count after `scripts/source-check.ts` locates each quote and an independent model confirms it.
 *
 *   npx tsx scripts/curate-library.ts
 */
import { writeFile } from "node:fs/promises";
import { readCachedSource, type CachedSource } from "./source-cache";

type Value = string | number | boolean;
type Claim = { property: string; value: Value; unit?: string; source: string; find: string; conditions?: string[]; note?: string; critical?: boolean };
type PortClaim = { id: string; label: string; connector: string; direction: "in" | "out" | "bidirectional"; signal: "audio" | "video" | "data" | "power"; protocols: string[]; channels?: number; integral?: boolean; source: string; find: string };
type ModeClaim = { id: string; label: string; settings: Record<string, Value | Value[]>; enables: string[]; source: string; find: string };
type Entry = {
  id: string; manufacturer: string; model: string; variant: string; kind: string; shortName: string; description: string; accent: string;
  sources: { id: string; title: string; publisher: string; kind: "manufacturer" | "software_publisher"; location: string }[];
  ports: PortClaim[]; facts: Claim[]; unknowns?: { property: string; reason: string }[]; modes?: ModeClaim[];
};
const EXTRACTOR = "Anthropic Claude Fable 5.2 (curation pass over cached manufacturer text)";
const xlrIn = (index: number, source: string, find: string): PortClaim => ({ id: `input${index}`, label: `Input ${index} · XLR`, connector: "XLR", direction: "in", signal: "audio", protocols: ["analog_balanced"], source, find });
const micOut = (source: string, find: string): PortClaim => ({ id: "out", label: "Balanced XLR out", connector: "XLR", direction: "out", signal: "audio", protocols: ["analog_balanced"], source, find });
const zoomEssential = (id: string, model: string, inputs: number, source: string, description: string, extra: Partial<Entry>): Entry => ({
  id, manufacturer: "Zoom", model, variant: `Original ${model} · firmware as documented in the operation manual`, kind: "recorder", shortName: model, description, accent: "#d7dfeb",
  sources: [{ id: source, title: `Zoom ${model} Operation Manual`, publisher: "Zoom", kind: "manufacturer", location: "Online operation manual" }],
  ports: [], facts: [], ...extra,
});

const entries: Entry[] = [
  { id: "shure-sm58-lc", manufacturer: "Shure", model: "SM58", variant: "SM58-LC · wired XLR · no cable", kind: "microphone", shortName: "SM58", description: "A familiar dynamic microphone for a voice.", accent: "#dbe4ed",
    sources: [{ id: "corpus-shure-sm58-lc", title: "Shure SM58 User Guide", publisher: "Shure", kind: "manufacturer", location: "User guide PDF, specifications" }],
    ports: [micOut("corpus-shure-sm58-lc", "Three-pin professional audio \\(XLR\\), male")],
    facts: [{ property: "transducerType", value: "dynamic", source: "corpus-shure-sm58-lc", find: "unidirectional \\(cardioid\\) dynamic vocal microphone", note: "A moving-coil dynamic microphone is passive; the rule engine derives that it needs no phantom power." }] },
  { id: "rode-podmic", manufacturer: "RØDE", model: "PodMic", variant: "XLR dynamic · black", kind: "microphone", shortName: "PodMic", description: "A broadcast-style dynamic microphone built for speech.", accent: "#e2e0dc",
    sources: [{ id: "corpus-rode-podmic", title: "RØDE PodMic Datasheet", publisher: "RØDE", kind: "manufacturer", location: "Datasheet PDF" }],
    ports: [micOut("corpus-rode-podmic", "Output Connection: XLR")],
    facts: [
      { property: "transducerType", value: "dynamic", source: "corpus-rode-podmic", find: "Acoustic Principle: Dynamic" },
      { property: "phantomRequired", value: false, source: "corpus-rode-podmic", find: "Phantom Power: Not required" },
    ] },
  { id: "at2020-xlr", manufacturer: "Audio-Technica", model: "AT2020", variant: "Black · XLR condenser (not USB)", kind: "microphone", shortName: "AT2020", description: "A condenser microphone that needs 48 V phantom power.", accent: "#e0e2e6",
    sources: [{ id: "corpus-at2020-xlr", title: "Audio-Technica AT2020 specification sheet", publisher: "Audio-Technica", kind: "manufacturer", location: "Specification sheet PDF" }],
    ports: [micOut("corpus-at2020-xlr", "XLRM-type connector is low")],
    facts: [
      { property: "transducerType", value: "condenser", source: "corpus-at2020-xlr", find: "permanently polarized condenser" },
      { property: "phantomRequired", value: true, source: "corpus-at2020-xlr", find: "It requires 48V DC phantom power" },
      { property: "phantomVoltage", value: 48, unit: "V", source: "corpus-at2020-xlr", find: "It requires 48V DC phantom power" },
    ] },
  zoomEssential("zoom-h4essential", "H4essential", 2, "corpus-zoom-h4essential", "Keeps each microphone on its own track on the card and sends the mix to your stream.", {
    ports: [
      xlrIn(1, "corpus-zoom-h4essential", "Connect dynamic and condenser mics with XLR plugs to inputs 1 and 2"), xlrIn(2, "corpus-zoom-h4essential", "Connect dynamic and condenser mics with XLR plugs to inputs 1 and 2"),
      { id: "usb", label: "USB-C · audio interface", connector: "USB-C", direction: "out", signal: "data", protocols: ["usb_audio", "usb_data"], channels: 2, source: "corpus-zoom-h4essential", find: "USB \\| Connectors \\| USB Type-C" },
      { id: "phones", label: "Phone / line out", connector: "3.5mm TRS", direction: "out", signal: "audio", protocols: ["analog_stereo"], channels: 2, source: "corpus-zoom-h4essential", find: "Use this stereo mini jack to output sound to headphones or a connected device" },
    ],
    facts: [
      { property: "independentChannels", value: 2, unit: "count", source: "corpus-zoom-h4essential", find: "MIC/LINE \\(mono\\) \\| Connectors \\| 2 XLR/TRS combo jacks", conditions: ["Counts the two mono XLR/TRS combo inputs (INPUT 1 and INPUT 2)."] },
      { property: "onboardIsolated", value: true, source: "corpus-zoom-h4essential", find: "every selected track is recorded separately", conditions: ["Tracks for INPUT 1 and INPUT 2 enabled; stereo link off."] },
      { property: "simultaneousUsbRecording", value: true, source: "corpus-zoom-h4essential", find: "Audio I/F \\+ REC \\| The H4essential can record and play back even when it is being used as an audio interface", conditions: ["USB audio interface mode set to Audio I/F + REC", "Sample rate 44.1 kHz or 48 kHz"] },
      { property: "usbStereoMix", value: true, source: "corpus-zoom-h4essential", find: "Stereo mix \\| This will make a stereo mix of all inputs", conditions: ["USB audio interface channel set to Stereo mix"] },
      { property: "usbDriverless", value: true, source: "corpus-zoom-h4essential", find: "No driver is necessary for use with smartphones, tablets or Mac computers" },
      { property: "phantomVoltage", value: 48, unit: "V", source: "corpus-zoom-h4essential", find: "inputs 1 and 2 support phantom power and can provide \\+48 V" },
      { property: "batteryPower", value: true, source: "corpus-zoom-h4essential", find: "can operate using batteries or a power supply connected to the USB port", conditions: ["Two AA batteries; not stated as included."] },
      { property: "usbBusPower", value: true, source: "corpus-zoom-h4essential", find: "USB \\| Connectors \\| USB Type-C" },
      { property: "powerWatts", value: 3, unit: "W", source: "corpus-zoom-h4essential", find: "Power consumption \\| 3 W maximum" },
      { property: "recordingMedia", value: "microSDHC 4-32 GB or microSDXC 64 GB-1 TB", source: "corpus-zoom-h4essential", find: "microSDXC: 64 GB", critical: false },
      { property: "sharedPhoneLineOutput", value: true, source: "corpus-zoom-h4essential", find: "Outputs \\| PHONE/LINE OUT \\| Connector \\| 1 stereo mini jack", note: "One jack serves headphones or a line feed, not both." },
    ],
    modes: [{ id: "aif-rec", label: "Audio I/F + REC at 44.1 or 48 kHz", settings: { recordingMode: "Audio I/F + REC", sampleRate: [44100, 48000] }, enables: ["simultaneousUsbRecording"], source: "corpus-zoom-h4essential", find: "can be selected only when the sample rate is set to 44.1 kHz or 48 kHz" }],
  }),
  zoomEssential("zoom-h6essential", "H6essential", 4, "corpus-zoom-h6essential", "Four microphone inputs on separate tracks, with room for two more voices.", {
    accent: "#d3dde6",
    ports: [
      ...[1, 2, 3, 4].map(index => xlrIn(index, "corpus-zoom-h6essential", "MIC/LINE \\(mono\\) \\| 4 \\|")),
      { id: "usb", label: "USB-C · audio interface", connector: "USB-C", direction: "out", signal: "data", protocols: ["usb_audio", "usb_data"], channels: 2, source: "corpus-zoom-h6essential", find: "USB port \\(Type-C\\)" },
      { id: "phones", label: "Headphone out", connector: "3.5mm TRS", direction: "out", signal: "audio", protocols: ["analog_stereo"], channels: 2, source: "corpus-zoom-h6essential", find: "Headphone \\| Connector \\| 1 stereo mini jack" },
      { id: "line", label: "Line out", connector: "3.5mm TRS", direction: "out", signal: "audio", protocols: ["analog_stereo"], channels: 2, source: "corpus-zoom-h6essential", find: "Use a stereo mini jack cable to connect the input jack of the camera to the H6essential LINE OUT jack" },
    ],
    facts: [
      { property: "independentChannels", value: 4, unit: "count", source: "corpus-zoom-h6essential", find: "MIC/LINE \\(mono\\) \\| 4 \\|", conditions: ["Counts the four mono XLR/TRS combo inputs."] },
      { property: "onboardIsolated", value: true, source: "corpus-zoom-h6essential", find: "every selected track is recorded separately" },
      { property: "simultaneousUsbRecording", value: true, source: "corpus-zoom-h6essential", find: "the H6essential can record even when it is being used as an audio interface", conditions: ["USB audio interface mode set to Audio I/F + REC", "Sample rate 44.1 kHz or 48 kHz"] },
      { property: "usbDriverless", value: true, source: "corpus-zoom-h6essential", find: "No driver is necessary for use with smartphones, tablets or Mac computers" },
      { property: "phantomVoltage", value: 48, unit: "V", source: "corpus-zoom-h6essential", find: "support phantom power and can provide \\+48 V" },
      { property: "batteryPower", value: true, source: "corpus-zoom-h6essential", find: "can operate using batteries or a" },
      { property: "usbBusPower", value: true, source: "corpus-zoom-h6essential", find: "This supports operation on USB bus power" },
      { property: "recordingMedia", value: "microSDHC 4-32 GB or microSDXC 64 GB-1 TB", source: "corpus-zoom-h6essential", find: "microSDXC: 64 GB", critical: false },
      { property: "independentLineOutput", value: true, source: "corpus-zoom-h6essential", find: "LINE OUT jack\\nThis outputs sound to a connected device" },
    ],
    unknowns: [{ property: "usbStereoMix", reason: "The cached manual passage for the stereo-mix USB channel setting was not located for this model." }],
    modes: [{ id: "aif-rec", label: "Audio I/F + REC at 44.1 or 48 kHz", settings: { recordingMode: "Audio I/F + REC", sampleRate: [44100, 48000] }, enables: ["simultaneousUsbRecording"], source: "corpus-zoom-h6essential", find: "can be selected only when the sample rate is set to 44.1 kHz or 48 kHz" }],
  }),
  { id: "zoom-podtrak-p4", manufacturer: "Zoom", model: "PodTrak P4", variant: "Original P4 · firmware 2 manual", kind: "mixer", shortName: "PodTrak P4", description: "A four-voice podcast recorder with a headphone output for everyone.", accent: "#e6ddcf",
    sources: [{ id: "corpus-zoom-podtrak-p4", title: "Zoom PodTrak P4 Operation Manual", publisher: "Zoom", kind: "manufacturer", location: "Operation manual PDF" }],
    ports: [
      ...[1, 2, 3, 4].map(index => xlrIn(index, "corpus-zoom-podtrak-p4", "The levels of the 4 mic inputs can be adjusted")),
      { id: "usb", label: "USB-C · audio interface", connector: "USB-C", direction: "out", signal: "data", protocols: ["usb_audio", "usb_data"], channels: 2, source: "corpus-zoom-podtrak-p4", find: "2-in/2-out USB audio interface functions" },
      { id: "phones", label: "Headphone out 1", connector: "3.5mm TRS", direction: "out", signal: "audio", protocols: ["analog_stereo"], channels: 2, source: "corpus-zoom-podtrak-p4", find: "The 4 headphone outputs allow" },
    ],
    facts: [
      { property: "independentChannels", value: 4, unit: "count", source: "corpus-zoom-podtrak-p4", find: "Multitrack recorder supports recording up to four channels at the same time" },
      { property: "onboardIsolated", value: true, source: "corpus-zoom-podtrak-p4", find: "separate files for the audio of each channel" },
      { property: "usbStereoMix", value: true, source: "corpus-zoom-podtrak-p4", find: "2-in/2-out USB audio interface functions", conditions: ["USB carries a two-channel mix."] },
      { property: "phantomVoltage", value: 48, unit: "V", source: "corpus-zoom-podtrak-p4", find: "phantom power \\(\\+48 V\\)" },
      { property: "batteryPower", value: true, source: "corpus-zoom-podtrak-p4", find: "can be powered by 2 AA batteries or a USB mobile battery" },
      { property: "directHostConnectionAdvised", value: true, source: "corpus-zoom-podtrak-p4", find: "Do not connect it through a USB", note: "Zoom's troubleshooting guidance: connect directly to the host, not through a hub." },
    ],
    unknowns: [{ property: "simultaneousUsbRecording", reason: "The cited manual passages do not state that the P4 records its card files while streaming over USB through a hub; WorldKit will not guess." }] },
  { id: "zoom-livetrak-l8", manufacturer: "Zoom", model: "LiveTrak L-8", variant: "L-8 · not L-6 or L-12", kind: "mixer", shortName: "LiveTrak L-8", description: "A hands-on mixer that records every voice to its own track.", accent: "#d8dee7",
    sources: [{ id: "corpus-zoom-livetrak-l8", title: "Zoom LiveTrak L-8 product page", publisher: "Zoom", kind: "manufacturer", location: "Product page" }],
    ports: [
      ...[1, 2].map(index => xlrIn(index, "corpus-zoom-livetrak-l8", "six high performance preamps each with phantom power")),
      { id: "usb", label: "USB · audio interface", connector: "USB-C", direction: "out", signal: "data", protocols: ["usb_audio", "usb_data"], channels: 2, source: "corpus-zoom-livetrak-l8", find: "12-in/4-out audio interface" },
      { id: "phones", label: "Headphone out", connector: "3.5mm TRS", direction: "out", signal: "audio", protocols: ["analog_stereo"], channels: 2, source: "corpus-zoom-livetrak-l8", find: "four headphone outputs" },
    ],
    facts: [
      { property: "independentChannels", value: 6, unit: "count", source: "corpus-zoom-livetrak-l8", find: "six independent Zoom preamps" },
      { property: "onboardIsolated", value: true, source: "corpus-zoom-livetrak-l8", find: "records separate tracks directly to your SD card" },
      { property: "simultaneousUsbRecording", value: true, source: "corpus-zoom-livetrak-l8", find: "record full episodes directly to your computer and an SD card simultaneously", conditions: ["Not at 96 kHz."] },
      { property: "usbDriverless", value: true, source: "corpus-zoom-livetrak-l8", find: "L-8 is class compliant, enabling connection with iOS devices" },
      { property: "batteryPower", value: true, source: "corpus-zoom-livetrak-l8", find: "four AA batteries, or on a USB battery" },
    ],
    unknowns: [
      { property: "usbStereoMix", reason: "Zoom's product page does not say that the L-8 sends a stereo mix to a tablet over USB while it records; WorldKit will not guess." },
      { property: "phantomVoltage", reason: "The product page says each preamp has phantom power but does not state the voltage." },
    ] },
  { id: "focusrite-2i2-4", manufacturer: "Focusrite", model: "Scarlett 2i2", variant: "4th generation · two microphone inputs", kind: "interface", shortName: "Scarlett 2i2", description: "A compact interface; recording depends on the host application.", accent: "#f3d4d3",
    sources: [{ id: "corpus-focusrite-2i2-4", title: "Focusrite Scarlett 2i2 4th Gen User Guide", publisher: "Focusrite", kind: "manufacturer", location: "User guide PDF" }],
    ports: [
      xlrIn(1, "corpus-focusrite-2i2-4", "48V phantom power at the XLR mic input"), xlrIn(2, "corpus-focusrite-2i2-4", "48V phantom power at the XLR mic input"),
      { id: "usb", label: "USB-C", connector: "USB-C", direction: "out", signal: "data", protocols: ["usb_audio", "usb_data"], channels: 2, source: "corpus-focusrite-2i2-4", find: "USB-C to A cable" },
      { id: "phones", label: "Headphone out", connector: "6.35mm TRS", direction: "out", signal: "audio", protocols: ["analog_stereo"], channels: 2, source: "corpus-focusrite-2i2-4", find: "48V phantom power at the XLR mic input" },
    ],
    facts: [
      { property: "independentChannels", value: 2, unit: "count", source: "corpus-focusrite-2i2-4", find: "applies 48V phantom power to both inputs", conditions: ["Two XLR microphone inputs."] },
      { property: "phantomVoltage", value: 48, unit: "V", source: "corpus-focusrite-2i2-4", find: "Press to turn on 48V phantom power at the XLR mic input" },
    ],
    unknowns: [
      { property: "onboardIsolated", reason: "The interface has no recorder of its own; separate files depend on the host application." },
      { property: "hostIsolatedWhileStreaming", reason: "No Focusrite or tablet-app source states that a tablet records both inputs as separate files while it streams the live camera." },
    ] },
  { id: "sony-zve10", manufacturer: "Sony", model: "ZV-E10", variant: "Original generation · 1080 60p compatible model", kind: "camera", shortName: "ZV-E10", description: "Your camera supplies the picture over HDMI.", accent: "#dfe3e7",
    sources: [
      { id: "corpus-sony-zve10", title: "Sony ZV-E10 Help Guide: Specifications", publisher: "Sony", kind: "manufacturer", location: "Help Guide, Specifications" },
      { id: "sony-zve10-hdmi-resolution", title: "Sony ZV-E10 Help Guide: 24p/60p Output", publisher: "Sony", kind: "manufacturer", location: "Help Guide, HDMI Settings" },
    ],
    ports: [
      { id: "hdmi", label: "Micro HDMI out", connector: "Micro HDMI", direction: "out", signal: "video", protocols: ["hdmi_1080p60"], source: "corpus-sony-zve10", find: "HDMI type D micro jack" },
      { id: "mic", label: "Microphone input", connector: "3.5mm TRS", direction: "in", signal: "audio", protocols: ["analog_mic_stereo"], channels: 2, source: "corpus-sony-zve10", find: "\\(Microphone\\) terminal" },
    ],
    facts: [{ property: "hdmi1080p60", value: true, source: "sony-zve10-hdmi-resolution", find: "You can set 1080/24p or 1080/60p as the HDMI output format", conditions: ["HDMI Resolution set to 1080p", "1080 60p compatible model"] }],
    unknowns: [{ property: "lineToMicLevel", reason: "Sony's cited pages do not state a safe line-level input for the microphone jack; WorldKit will not guess." }] },
  { id: "elgato-camlink-4k", manufacturer: "Elgato", model: "Cam Link 4K", variant: "USB 3.0 capture stick", kind: "capture", shortName: "Cam Link 4K", description: "Turns your camera's HDMI output into a webcam source.", accent: "#e3e5ec",
    sources: [{ id: "corpus-elgato-camlink-4k", title: "Elgato Cam Link 4K Technical Specifications", publisher: "Elgato", kind: "manufacturer", location: "Help center article" }],
    ports: [
      { id: "hdmi", label: "HDMI in", connector: "HDMI", direction: "in", signal: "video", protocols: ["hdmi_1080p60"], source: "corpus-elgato-camlink-4k", find: "female HDMI port on one end" },
      { id: "usb", label: "USB 3.0 plug", connector: "USB-A", direction: "out", signal: "data", protocols: ["uvc", "usb_data"], integral: true, source: "corpus-elgato-camlink-4k", find: "male USB 3.0 port on the other end" },
    ],
    facts: [
      { property: "hdmi1080p60", value: true, source: "corpus-elgato-camlink-4k", find: "1080p \\(1920 by 1080 resolution, up to 60 fps\\)", conditions: ["Unencrypted HDMI input."] },
      { property: "webcamSource", value: true, source: "corpus-elgato-camlink-4k", find: "will appear as a webcam in various applications" },
      { property: "usbInterfaceMbps", value: 5000, unit: "Mb/s", source: "corpus-elgato-camlink-4k", find: "male USB 3.0 port on the other end", note: "USB 3.0 SuperSpeed is a 5 Gb/s link; used as an upper bound on what this device can ask of the bus." },
      { property: "directPlug", value: true, source: "corpus-elgato-camlink-4k", find: "It is a USB stick" },
    ],
    unknowns: [{ property: "powerWatts", reason: "Elgato publishes no power draw for the Cam Link 4K; WorldKit will not guess a wattage." }] },
  { id: "apple-ipad-air5", manufacturer: "Apple", model: "iPad Air", variant: "5th generation · M1 · Camo Studio for iPad", kind: "host", shortName: "iPad Air", description: "Your tablet runs the stream. Isolated recording happens elsewhere.", accent: "#dddcef",
    sources: [
      { id: "corpus-apple-ipad-air5", title: "iPad Air (5th generation) Technical Specifications", publisher: "Apple", kind: "manufacturer", location: "Apple Support technical specifications" },
      { id: "camo-ipad-guide", title: "How to use Camo Studio for iPad", publisher: "Reincubate", kind: "software_publisher", location: "Camo support article" },
      { id: "camo-ipad-troubleshooting", title: "Tips & Troubleshooting Camo Studio for iPad", publisher: "Reincubate", kind: "software_publisher", location: "Camo support article" },
    ],
    ports: [{ id: "usb", label: "USB-C data + power", connector: "USB-C", direction: "in", signal: "data", protocols: ["usb_data", "usb_audio", "uvc"], channels: 2, source: "corpus-apple-ipad-air5", find: "USB 3 \\(up to 10Gb/s\\)" }],
    facts: [
      { property: "usbCapacityMbps", value: 10000, unit: "Mb/s", source: "corpus-apple-ipad-air5", find: "USB 3 \\(up to 10Gb/s\\)" },
      { property: "externalVideo", value: true, source: "camo-ipad-guide", find: "select external video source as your Type, and then select your capture card as your Device", conditions: ["Camo Studio for iPad", "Capture card connected over USB"] },
      { property: "externalVideoViaHub", value: true, source: "camo-ipad-guide", find: "plug them first into a hub, which then connects to the iPad" },
      { property: "externalUsbAudio", value: true, source: "camo-ipad-troubleshooting", find: "This can be the iPad.s own microphone or one connected via a USB cable or USB hub", conditions: ["One audio source at a time."] },
      { property: "simultaneousUsbAudioSources", value: 1, unit: "count", source: "camo-ipad-troubleshooting", find: "only permits audio through a single source" },
    ],
    unknowns: [{ property: "hostIsolatedWhileStreaming", reason: "No Apple or Camo source states that the tablet records each microphone as its own file while it streams the live camera; WorldKit will not guess." }] },
  { id: "anker-555-a8383", manufacturer: "Anker", model: "555 USB-C Hub", variant: "A8383 · 8-in-1 · 10 Gb/s", kind: "hub", shortName: "555 USB-C Hub", description: "One connection to your tablet for the camera, audio and charging.", accent: "#dedfe6",
    sources: [{ id: "corpus-anker-555-a8383", title: "Anker 555 USB-C Hub (8-in-1) product page", publisher: "Anker", kind: "manufacturer", location: "Product page, model A8383" }],
    ports: [
      { id: "audio", label: "USB-C data", connector: "USB-C", direction: "in", signal: "data", protocols: ["usb_audio", "usb_data"], channels: 2, source: "corpus-anker-555-a8383", find: "a USB-C data port, 2 USB-A data ports" },
      { id: "video", label: "USB-A data", connector: "USB-A", direction: "in", signal: "data", protocols: ["uvc", "usb_data"], source: "corpus-anker-555-a8383", find: "a USB-C data port, 2 USB-A data ports" },
      { id: "host", label: "USB-C to host", connector: "USB-C", direction: "out", signal: "data", protocols: ["usb_data", "usb_audio", "uvc"], channels: 2, source: "corpus-anker-555-a8383", find: "Turn your device.s USB-C port into 8 ports" },
      { id: "pd", label: "USB-C PD in", connector: "USB-C", direction: "in", signal: "power", protocols: ["usb_pd"], source: "corpus-anker-555-a8383", find: "Equipped with a USB-C Power Delivery input port" },
    ],
    facts: [
      { property: "usbCapacityMbps", value: 10000, unit: "Mb/s", source: "corpus-anker-555-a8383", find: "USB-C and USB-A data ports provide file transfer at speeds up to 10 Gbps" },
      { property: "pdInputMaxWatts", value: 100, unit: "W", source: "corpus-anker-555-a8383", find: "supports pass-through charging up to 100W \\(minus 15W for operation\\)" },
      { property: "pdReserveWatts", value: 15, unit: "W", source: "corpus-anker-555-a8383", find: "supports pass-through charging up to 100W \\(minus 15W for operation\\)" },
      { property: "hostPowerMaxWatts", value: 85, unit: "W", source: "corpus-anker-555-a8383", find: "high-speed pass-through charging up to 85W" },
      { property: "tabletMinAdapterWatts", value: 45, unit: "W", source: "corpus-anker-555-a8383", find: "use an adapter that supports at least 15V \\(45W\\)", conditions: ["Anker's note for tablets."] },
    ],
    unknowns: [{ property: "peripheralPowerWatts", reason: "Anker publishes no per-port wattage for bus-powered accessories; WorldKit will not guess a headroom figure." }] },
  { id: "anker-735-a2668", manufacturer: "Anker", model: "735 Charger", variant: "A2668 · GaNPrime 65W", kind: "power", shortName: "735 Charger 65W", description: "A 65 W USB-C charger for the hub's pass-through power.", accent: "#eae0ce",
    sources: [{ id: "corpus-anker-735-a2668", title: "Anker 735 Charger (GaNPrime 65W) product description", publisher: "Anker", kind: "manufacturer", location: "Anker service product description, A2668" }],
    ports: [{ id: "out", label: "USB-C PD out", connector: "USB-C", direction: "out", signal: "power", protocols: ["usb_pd"], source: "corpus-anker-735-a2668", find: "USB-C1\\(Top Port\\)/USB-C2\\(Middle Port\\)" }],
    facts: [{ property: "powerWatts", value: 65, unit: "W", source: "corpus-anker-735-a2668", find: "20V==3.25A \\(65W Max\\)", conditions: ["Single USB-C port in use."] }] },
  { id: "sony-mdr7506", manufacturer: "Sony", model: "MDR-7506", variant: "Stereo Unimatch plug · 3.5 mm with 6.3 mm adaptor", kind: "headphones", shortName: "MDR-7506", description: "Your headphones follow the recorder's mix.", accent: "#e4e3dc",
    sources: [{ id: "corpus-sony-mdr7506", title: "Sony MDR-7506 product sheet", publisher: "Sony", kind: "manufacturer", location: "Sony Professional product PDF" }],
    ports: [{ id: "in", label: "Headphone plug", connector: "3.5mm TRS", direction: "in", signal: "audio", protocols: ["analog_stereo"], channels: 2, integral: true, source: "corpus-sony-mdr7506", find: "Plug Type Gold, Stereo Unimatch plug[^\\n]*\\nCord Length 9.8 ft" }],
    facts: [
      { property: "stereoMonitoring", value: true, source: "corpus-sony-mdr7506", find: "Stereo professional headphones" },
      { property: "adapterIncluded", value: true, source: "corpus-sony-mdr7506", find: "3.5mm/6.3mm adaptor", critical: false },
    ] },
  { id: "hosa-hmic010", manufacturer: "Hosa", model: "HMIC-010", variant: "Pro Microphone Cable · XLR3F to XLR3M · 10 ft", kind: "cable", shortName: "XLR mic cable", description: "A balanced microphone cable, one per voice.", accent: "#e4e5e1",
    sources: [{ id: "corpus-hosa-hmic010", title: "Hosa Pro Microphone Cable HMIC-000 series", publisher: "Hosa", kind: "manufacturer", location: "Product page, HMIC-000 series" }],
    ports: [],
    facts: [
      { property: "connectorA", value: "XLR", source: "corpus-hosa-hmic010", find: "REAN XLR3F to XLR3M" },
      { property: "connectorB", value: "XLR", source: "corpus-hosa-hmic010", find: "REAN XLR3F to XLR3M" },
    ] },
  { id: "startech-hdmiadmm3", manufacturer: "StarTech.com", model: "HDMIADMM3", variant: "3 ft Micro HDMI to HDMI · High Speed with Ethernet", kind: "cable", shortName: "Micro HDMI cable", description: "Carries the camera's picture to the capture stick.", accent: "#e4e5e1",
    sources: [{ id: "corpus-startech-hdmiadmm3", title: "StarTech.com HDMIADMM3 datasheet", publisher: "StarTech.com", kind: "manufacturer", location: "Datasheet PDF" }],
    ports: [],
    facts: [
      { property: "connectorA", value: "Micro HDMI", source: "corpus-startech-hdmiadmm3", find: "Connector 2 Micro HDMI" },
      { property: "connectorB", value: "HDMI", source: "corpus-startech-hdmiadmm3", find: "Connector 1 HDMI" },
      { property: "carries:hdmi_1080p60", value: true, source: "corpus-startech-hdmiadmm3", find: "Full HD \\(1920x1080p, 120Hz\\)" },
    ] },
  { id: "startech-usb315cc1m", manufacturer: "StarTech.com", model: "USB315CC1M", variant: "1 m USB-C to USB-C · 5 Gb/s · 60 W", kind: "cable", shortName: "USB-C cable", description: "A data-capable USB-C cable that also carries charging power.", accent: "#e4e5e1",
    sources: [{ id: "corpus-startech-usb315cc1m", title: "StarTech.com USB315CC1M datasheet", publisher: "StarTech.com", kind: "manufacturer", location: "Datasheet PDF" }],
    ports: [],
    facts: [
      { property: "connectorA", value: "USB-C", source: "corpus-startech-usb315cc1m", find: "Connector 1 USB-C" },
      { property: "connectorB", value: "USB-C", source: "corpus-startech-usb315cc1m", find: "Connector 2 USB-C" },
      { property: "carries:usb_data", value: true, source: "corpus-startech-usb315cc1m", find: "Supports data transfer rates up to 5Gbps" },
      { property: "carries:usb_audio", value: true, source: "corpus-startech-usb315cc1m", find: "Supports data transfer rates up to 5Gbps", note: "USB audio is ordinary USB data; the cable is documented as a data cable." },
      { property: "carries:usb_pd", value: true, source: "corpus-startech-usb315cc1m", find: "Power Delivery 60W" },
      { property: "dataRateMbps", value: 5000, unit: "Mb/s", source: "corpus-startech-usb315cc1m", find: "Supports data transfer rates up to 5Gbps" },
      { property: "powerMaxWatts", value: 60, unit: "W", source: "corpus-startech-usb315cc1m", find: "Power Delivery 60W" },
    ] },
];

const cache = new Map<string, CachedSource>();
async function source(id: string) { if (!cache.has(id)) cache.set(id, await readCachedSource(id)); return cache.get(id)!; }
/** The verbatim passage around the first match: its whole line, or the surrounding sentences when the line is long. */
async function quote(sourceId: string, pattern: string, owner: string): Promise<{ quote: string; locator: string }> {
  const document = await source(sourceId); const expression = new RegExp(pattern, "i");
  for (const page of document.pages) {
    const match = expression.exec(page.text); if (!match) continue;
    let start = page.text.lastIndexOf("\n", match.index) + 1, end = page.text.indexOf("\n", match.index + match[0].length); if (end < 0) end = page.text.length;
    
    if (end - start > 380) {
      const before = page.text.slice(start, match.index), after = page.text.slice(match.index + match[0].length, end);
      const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf(": ")); const stop = after.search(/[.!?](\s|$)/);
      start = cut >= 0 ? start + cut + 2 : Math.max(start, match.index - 120); end = stop >= 0 ? match.index + match[0].length + stop + 1 : Math.min(end, match.index + match[0].length + 160);
    }
    const text = page.text.slice(start, end).trim(); if (text.length < 12) throw new Error(`${owner}: located passage is too short to stand as evidence (${JSON.stringify(text)}).`);
    return { quote: text.slice(0, 400), locator: `page ${page.number}` };
  }
  throw new Error(`${owner}: no passage matches /${pattern}/ in ${sourceId}.`);
}
const devices = [];
for (const entry of entries) {
  const sources = await Promise.all(entry.sources.map(async item => ({ ...item, url: (await source(item.id)).url })));
  devices.push({
    id: entry.id, manufacturer: entry.manufacturer, model: entry.model, variant: entry.variant, kind: entry.kind, shortName: entry.shortName, description: entry.description, accent: entry.accent, sources,
    ports: await Promise.all(entry.ports.map(async port => ({ id: port.id, label: port.label, connector: port.connector, direction: port.direction, signal: port.signal, protocols: port.protocols, channels: port.channels ?? 1, integral: port.integral ?? false, sourceId: port.source, ...(await quote(port.source, port.find, `${entry.id} port ${port.id}`)) }))),
    facts: await Promise.all(entry.facts.map(async fact => ({ property: fact.property, value: fact.value, unit: fact.unit ?? null, conditions: fact.conditions ?? [], critical: fact.critical ?? true, sourceId: fact.source, ...(await quote(fact.source, fact.find, `${entry.id} ${fact.property}`)), note: fact.note ?? null }))),
    unknowns: entry.unknowns ?? [],
    operatingModes: await Promise.all((entry.modes ?? []).map(async mode => ({ id: mode.id, label: mode.label, settings: mode.settings, enables: mode.enables, sourceId: mode.source, ...(await quote(mode.source, mode.find, `${entry.id} mode ${mode.id}`)) }))),
  });
}
await writeFile("packages/device-library/curated/library.json", JSON.stringify({ schema: "worldkit.dossier.1", extractor: EXTRACTOR, devices }, null, 1) + "\n");
console.log(JSON.stringify({ devices: devices.length, facts: devices.reduce((sum, device) => sum + device.facts.length, 0), ports: devices.reduce((sum, device) => sum + device.ports.length, 0), modes: devices.reduce((sum, device) => sum + device.operatingModes.length, 0) }));
