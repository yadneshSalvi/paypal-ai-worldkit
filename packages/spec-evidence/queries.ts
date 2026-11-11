import type { ExtractionQuery } from "./contracts";
import type { CorpusDevice, SourceDocument } from "./sources";

type Question = [property: string, valueType: ExtractionQuery["valueType"], unit: string | null, question: string, critical?: boolean];
const common: Question[] = [
  ["weightGrams", "number", "g", "What is the stated device mass for this exact variant, with the source's battery/cable exclusions retained?", false],
  ["widthMm", "number", "mm", "What is the stated device width, keeping any specified stand/accessory conditions?", false],
  ["heightMm", "number", "mm", "What is the stated device height, keeping any specified stand/accessory conditions?", false],
  ["depthMm", "number", "mm", "What is the stated device depth, keeping any specified stand/accessory conditions?", false],
];
const audio: Question[] = [
  ["microphoneInputs", "number", "count", "How many external microphone inputs does the exact device have? Do not count built-in capsules, USB returns or stereo mixes."],
  ["independentChannels", "number", "count", "How many external microphone input channels can be recorded as separately inspectable tracks? Keep the exact recorder/interface/host mode."],
  ["onboardIsolated", "boolean", null, "Does the source explicitly establish recording at least two external microphone inputs to separate tracks on the device's own removable storage?"],
  ["simultaneousUsbRecording", "boolean", null, "Does the source explicitly permit onboard recording and USB audio interface transmission at the same time? Keep exact mode and firmware limits."],
  ["maxSimultaneousSampleRate", "number", "Hz", "What is the highest explicitly supported sample rate while onboard recording and USB audio transmission run simultaneously?"],
  ["usbStereoMix", "boolean", null, "Does a stated selectable USB mode send a stereo mix to the host? Distinguish it from a multichannel interface mode."],
  ["usbCaptureChannels", "number", "count", "What is the stated number of channels sent from the device to a computer in its multichannel USB interface mode? Preserve OS/mode exceptions."],
  ["usbPlaybackChannels", "number", "count", "What is the stated number of USB playback/return channels from a computer in the multichannel interface mode?"],
  ["phantomVoltage", "number", "V", "What maximum nominal phantom voltage can the microphone inputs supply? Preserve channel-sharing and power-source conditions."],
  ["batteryPower", "boolean", null, "Does the source explicitly describe operating this device from batteries? Do not infer false from missing information."],
  ["inputConnector", "string", null, "What exact external microphone-input connector is stated, including combination-jack support if present?"],
  ["headphoneConnector", "string", null, "What exact headphone-output connector is stated?"],
  ["usbConnector", "string", null, "What exact USB host-connection connector is stated? Connector shape does not establish protocol."],
  ["powerWatts", "number", "W", "What maximum electrical consumption is explicitly stated for this device, with operating conditions?"],
];
const byKind: Record<string, Question[]> = {
  recorder: audio, interface: audio, mixer: audio,
  microphone: [
    ["transducerType", "string", null, "What microphone transducer type is explicitly stated?"],
    ["polarPattern", "string", null, "What polar pickup pattern is stated for this exact microphone?"],
    ["outputConnector", "string", null, "What exact audio output connector is stated? Distinguish XLR and USB variants."],
    ["phantomRequired", "boolean", null, "Does this exact microphone explicitly require external phantom power? A false answer needs an explicit passive/no-power statement."],
    ["phantomVoltage", "number", "V", "What nominal phantom voltage is specified? If a voltage range is given, preserve the range as a condition and report the highest supported nominal value."],
    ["frequencyMinHz", "number", "Hz", "What is the explicitly stated lower frequency-response bound?"],
    ["frequencyMaxHz", "number", "Hz", "What is the explicitly stated upper frequency-response bound?"],
    ["impedanceOhms", "number", "ohm", "What is the microphone's nominal output impedance? Distinguish recommended load impedance."],
    ["maximumSplDb", "number", "dB SPL", "What maximum sound-pressure level is explicitly stated, retaining the distortion or pad condition?"],
  ],
  host: [
    ["usbCapacityMbps", "number", "Mb/s", "What maximum nominal USB data transfer rate is explicitly stated for this exact host variant? This is not available shared-bus throughput."],
    ["usbCPorts", "number", "count", "How many USB-C-shaped external ports are stated for this exact variant?"],
    ["thunderboltGeneration", "number", "generation", "Which Thunderbolt generation is explicitly supported by this exact variant?"],
    ["externalDisplayCount", "number", "count", "How many external displays are explicitly supported at the same time? Preserve exact resolution, refresh-rate and chip conditions."],
    ["headphoneConnector", "string", null, "What headphone connector is explicitly stated?"],
    ["hostIsolatedWhileStreaming", "boolean", null, "Does this document explicitly establish isolated recording of two USB microphone channels while Camo Studio on iPad streams an external camera at the same time? Hardware capability alone is insufficient."],
    ["exactAppHardwareSupport", "boolean", null, "Does this document explicitly establish Camo Studio on iPad support for this exact host, software version, hub and capture-device combination?"],
  ],
  camera: [
    ["hdmiConnector", "string", null, "What exact HDMI output connector is stated?"],
    ["hdmi1080p60", "boolean", null, "Does the document explicitly support 1920 by 1080 HDMI output at 59.94 or 60 progressive frames per second? Keep regional and mode conditions."],
    ["cleanHdmi", "boolean", null, "Can camera information overlays explicitly be removed from the HDMI output? Preserve setting and simultaneous-recording limits."],
    ["usbConnector", "string", null, "What physical USB connector is specified?"],
    ["uvcVideo", "boolean", null, "Is USB Video Class (UVC) streaming explicitly supported by this exact camera, with firmware and OS conditions?"],
    ["microphoneConnector", "string", null, "What external microphone-input connector and signal level are explicitly stated?"],
    ["headphoneConnector", "string", null, "What headphone-output connector is explicitly stated?"],
    ["batteryPower", "boolean", null, "Is operation from a removable or built-in battery explicitly described?"],
  ],
  capture: [
    ["hdmiInputs", "number", "count", "How many HDMI inputs belong to this exact model? Ignore adjacent models on a combined product page."],
    ["hdmi1080p60", "boolean", null, "Does this device explicitly capture an HDMI 1920 by 1080 signal at 59.94 or 60 progressive frames per second? Distinguish capture from passthrough."],
    ["uvcVideo", "boolean", null, "Does this exact device explicitly expose USB Video Class (UVC) output?"],
    ["usbConnector", "string", null, "What physical USB connector connects this device to its host?"],
    ["usbCapacityMbps", "number", "Mb/s", "What nominal USB interface data rate is explicitly stated? Do not calculate needed video bandwidth from it."],
    ["hdmiAudioChannels", "number", "count", "How many HDMI audio channels can be captured?"],
    ["exactAppHardwareSupport", "boolean", null, "Does the source explicitly establish compatibility with the exact iPad Air 5, iPadOS 26, Camo Studio and selected hub combination?"],
    ["powerWatts", "number", "W", "What maximum electrical consumption is explicitly specified?"],
  ],
  hub: [
    ["usbCapacityMbps", "number", "Mb/s", "What maximum nominal USB data rate is stated for the upstream host connection? Distinguish downstream ports and actual shared throughput."],
    ["hostPowerMaxWatts", "number", "W", "What maximum USB Power Delivery wattage is delivered to the host after the hub's own reservation? Do not substitute adapter input wattage."],
    ["inputPowerMaxWatts", "number", "W", "What maximum PD or adapter input power can the hub accept?"],
    ["peripheralPowerWatts", "number", "W", "What total electrical power budget is explicitly available to connected USB peripherals, with simultaneous-load conditions?"],
    ["usbAPorts", "number", "count", "How many downstream USB-A ports are specified?"],
    ["usbCDataPorts", "number", "count", "How many downstream USB-C data ports are specified, excluding upstream and charging-only ports?"],
    ["hdmiDisplayCount", "number", "count", "How many simultaneous HDMI displays are explicitly supported? Preserve exact host OS and mirror/extend limits."],
    ["exactAppHardwareSupport", "boolean", null, "Does this source explicitly establish the iPad Air 5 plus simultaneous USB audio and UVC capture combination used in the creator rig?"],
  ],
  headphones: [
    ["headphoneConnector", "string", null, "What physical plug connects these headphones, including supplied removable adapter if stated?"],
    ["impedanceOhms", "number", "ohm", "What nominal impedance is specified for this exact variant?"],
    ["frequencyMinHz", "number", "Hz", "What is the lower frequency-response bound? Preserve any measurement tolerance."],
    ["frequencyMaxHz", "number", "Hz", "What is the upper frequency-response bound? Preserve any measurement tolerance."],
    ["stereoMonitoring", "boolean", null, "Does the source explicitly identify stereo listening, stereo plugs or two separately driven left/right channels?"],
    ["cableLengthMm", "number", "mm", "What cable length is explicitly stated? For a coiled cable preserve whether it is stretched or relaxed."],
    ["closedBack", "boolean", null, "Is the headphone enclosure explicitly described as closed-back? A false answer requires an explicit open-back statement."],
  ],
  cable: [
    ["connectorA", "string", null, "What is the exact connector at the first end, including gender and pin configuration?"],
    ["connectorB", "string", null, "What is the exact connector at the other end, including gender and pin configuration?"],
    ["lengthMm", "number", "mm", "What is the length of this exact cable variant?"],
    ["usbCapacityMbps", "number", "Mb/s", "What maximum nominal USB data transfer rate is explicitly stated for this exact cable?"],
    ["powerWatts", "number", "W", "What maximum supported electrical power is stated for this cable? Preserve voltage/current/PD conditions."],
    ["activeConversion", "boolean", null, "Does this cable explicitly contain an active signal/protocol converter? A false answer requires an explicit passive or direct wiring statement."],
  ],
  power: [
    ["powerWatts", "number", "W", "What maximum total electrical output is stated for this exact supply? Distinguish AC input consumption."],
    ["singlePortPowerWatts", "number", "W", "What maximum power is available from one USB-C port? Keep power-sharing conditions."],
    ["usbCPorts", "number", "count", "How many USB-C power output ports are stated?"],
    ["outputConnector", "string", null, "What connector supplies power to the device?"],
    ["usbPdSupported", "boolean", null, "Is USB Power Delivery explicitly supported?"],
    ["sharedPortAllocation", "string", null, "What exact output allocation is stated when multiple ports are used? If not specified, abstain."],
  ],
  storage: [
    ["capacityGb", "number", "GB", "What capacity is specified for this exact storage variant?"],
    ["storageFormFactor", "string", null, "What physical storage format is explicitly stated?"],
    ["speedClass", "string", null, "What minimum sustained recording speed class is explicitly certified? Do not substitute peak read speed."],
    ["writeSpeedMbps", "number", "Mb/s", "What maximum write transfer rate is explicitly stated? Keep the manufacturer's distinction between Mb/s and MB/s."],
  ],
  stand: [
    ["mountThread", "string", null, "What mount thread size is specified, including included adapters?"],
    ["maximumHeightMm", "number", "mm", "What maximum operating height is stated?"],
    ["minimumHeightMm", "number", "mm", "What minimum operating height is stated?"],
    ["maximumLoadGrams", "number", "g", "What maximum supported load is explicitly stated? Preserve arm-extension and balance conditions."],
    ["boomLengthMm", "number", "mm", "What maximum boom-arm reach is stated?"],
  ],
};

/** General product questions. No reference answers or held-out anchors are imported here. */
export function sourceQueries(device: CorpusDevice): ExtractionQuery[] {
  const scope = `${device.manufacturer} ${device.model}; ${device.variant}`.slice(0, 250);
  return [...(byKind[device.kind] ?? []), ...common].map(([property, valueType, unit, question, critical]) => ({ id: `${device.id}:${property.toLowerCase()}`, property, valueType, unit, question, scope, critical: critical ?? true }));
}

/** A transparent reading suggestion; users can choose other pages before dispatch. */
export function suggestedPages(document: SourceDocument): number[] {
  if (document.pages.reduce((n, page) => n + page.text.length, 0) <= 140000) return document.pages.map(page => page.number);
  const score = (text: string) => (text.match(/specifications|technical data|usb audio|audio interface|power supply|simultaneous|recording tracks|connections/gi) ?? []).length;
  const ranked = [...document.pages].sort((a, b) => score(b.text) - score(a.text) || a.number - b.number);
  const selected: number[] = []; let characters = 0;
  for (const page of ranked) {
    if (selected.length >= 40 || characters + page.text.length > 125000) continue;
    if (score(page.text) === 0 && selected.length >= 8) continue;
    selected.push(page.number); characters += page.text.length;
  }
  return selected.sort((a, b) => a - b);
}
