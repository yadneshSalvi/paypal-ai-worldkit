import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const definitions = [
  { id: "zoom-h4-manual", title: "H4essential operation manual", publisher: "Zoom", url: "https://zoomcorp.com/manuals/h4essential-en/", kind: "manufacturer", location: "Recording; Using as an audio interface; Specifications", summary: "Separate selected tracks; Stereo Mix USB mode with Audio I/F + REC at 44.1 or 48 kHz. Exact settings remain part of the check." },
  { id: "camo-ipad-audio", title: "Camo Studio for iPad: audio and connections", publisher: "Reincubate", url: "https://camo.com/support/camo-ipad/troubleshooting-camo-ipad", kind: "software_publisher", location: "Working with audio; Connecting devices to your iPad", summary: "iPadOS 26 accepts one external audio source. A multi-input interface combines microphones; a powered hub connects video and audio peripherals." },
  { id: "camo-ipad-guide", title: "Camo Studio for iPad user guide", publisher: "Reincubate", url: "https://camo.com/support/camo-ipad/how-to-use-camo-ipad", kind: "software_publisher", location: "Video and audio sources; recording", summary: "External capture and audio sources are selected independently. This guide does not establish simultaneous isolated multitrack recording inside Camo." },
  { id: "shure-sm58", title: "SM58 user guide", publisher: "Shure", url: "https://www.shure.com/en-US/docs/guide/SM58", kind: "manufacturer", location: "Specifications", summary: "Dynamic moving-coil microphone with a male three-pin XLR output. The exact LC variant includes no cable." },
  { id: "at2020", title: "AT2020 specification sheet", publisher: "Audio-Technica", url: "https://docs.audio-technica.com/eu/at2020_english.pdf", kind: "manufacturer", location: "Specifications and phantom power", summary: "The XLR condenser model requires 48 V DC phantom power. USB versions are separate device identities." },
  { id: "sony-zve10-hdmi", title: "ZV-E10 HDMI output settings", publisher: "Sony", url: "https://helpguide.sony.net/ilc/2070/v1/en/contents/TP0001140489.html", kind: "manufacturer", location: "HDMI Settings: 24p/60p Output", summary: "The NTSC ZV-E10 supports 1080p HDMI output at the documented 24p or 60p settings." },
  { id: "sony-zve10-spec", title: "ZV-E10 technical specifications", publisher: "Sony", url: "https://www.sony.com/electronics/support/e-mount-body/zv-e10/specifications", kind: "manufacturer", location: "Interface; video output", summary: "Camera identity and interfaces. Clean output settings must be confirmed in the corresponding guide." },
  { id: "elgato-camlink", title: "Cam Link 4K technical specifications", publisher: "Elgato", url: "https://help.elgato.com/hc/en-us/articles/360027963272-Cam-Link-4K-Technical-Specifications", kind: "manufacturer", location: "Input; supported resolutions", summary: "Unencrypted HDMI input and USB 3.0 capture, including 1080p60. Current and older hardware revisions have different 4K limits." },
  { id: "anker-555", title: "Anker 555 USB-C Hub A8383", publisher: "Anker", url: "https://www.anker.com/uk/products/a8383", kind: "manufacturer", location: "Data ports; power delivery", summary: "10 Gb/s data ports and up to 85 W host charging with a suitable 100 W supply. Per-port peripheral power still needs exact evidence." },
  { id: "ipad-air-5", title: "iPad Air (5th generation) specifications", publisher: "Apple", url: "https://support.apple.com/en-us/111887", kind: "manufacturer", location: "Chip; charging and expansion", summary: "The M1 iPad Air has a USB-C connector supporting USB 3.1 Gen 2, up to 10 Gb/s. Shape alone does not establish software behavior." },
  { id: "scarlett-2i2", title: "Scarlett 2i2 4th Gen specifications", publisher: "Focusrite", url: "https://userguides.focusrite.com/hc/en-gb/articles/19640392541202-Scarlett-2i2-4th-Gen-Specifications", kind: "manufacturer", location: "Input channels; phantom power; connectivity", summary: "Two microphone inputs and switchable 48 V phantom power. Independent host recording needs separate OS and application evidence." },
  { id: "zoom-l8", title: "LiveTrak L-8 product specification", publisher: "Zoom", url: "https://zoomcorp.com/en/jp/digital-mixer-multi-track-recorders/digital-mixer-recorders/LIVETRAK-L-8/", kind: "manufacturer", location: "Audio interface and multitrack recording", summary: "The L-8 can record to computer and SD card simultaneously and can stream while recording. Exact iOS channel mode remains a review task." },
] as const;
await mkdir(".artifacts/manufacturer-sources", { recursive: true });
const outcomes = await Promise.all(definitions.map(async definition => {
  try {
    const response = await fetch(definition.url, { signal: AbortSignal.timeout(25000), headers: { "User-Agent": "WorldKit-source-review/0.1" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 8_000_000) throw new Error("Source exceeds review size limit");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(`.artifacts/manufacturer-sources/${definition.id}.source`, bytes);
    return { ...definition, retrievedAt: new Date().toISOString(), contentHash: hash, rights: "link_and_facts_only" as const };
  } catch (error) {
    console.error(JSON.stringify({ source: definition.id, error: error instanceof Error ? error.message : "unavailable" }));
    return { ...definition, retrievedAt: "", contentHash: "unretrieved", rights: "link_and_facts_only" as const };
  }
}));
await writeFile("packages/device-library/source-manifest.json", JSON.stringify(outcomes, null, 2) + "\n");
console.log(JSON.stringify({ retrieved: outcomes.filter(x => x.contentHash !== "unretrieved").length, total: outcomes.length, humanReview: "pending" }));
