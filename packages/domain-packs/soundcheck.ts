import { WorldKitError } from "../contracts";
import { encodeWav } from "../soundcheck";
import type { PackEdition } from "./contracts";
import { assertPackEdition, packConnectionIssues } from "./compiler";

export function renderPackAudition(edition: PackEdition, channel: "mix" | number) {
  assertPackEdition(edition); const config = edition.graph.state.config;
  if (config.packId !== "podcast-classroom") throw new WorldKitError("invalid_request", "The routing audition belongs to the podcast pack.");
  if (channel !== "mix" && (!Number.isInteger(channel) || channel < 1 || channel > config.participants)) throw new WorldKitError("invalid_request", "Choose a voice in this saved system.");
  const issues = packConnectionIssues(edition.graph, edition.profiles);
  const paths = Array.from({ length: config.participants }, (_, i) => {
    const id = `voice-path-${i + 1}`; const connected = edition.graph.connections.some(e => e.id === id && e.enabled) && !issues.some(issue => issue.id === id);
    return { voice: i + 1, connected, isolated: connected && config.destination === "sd_card" && (config.recorder === "podtrak-p4" || config.keepTrackFiles), frequencyHz: 220 * 2 ** (i / 7) };
  });
  const sampleRate = 24000; const seconds = config.participants; const samples = new Float32Array(sampleRate * seconds);
  for (const path of paths) {
    // One labeled time slot per participant makes missing inputs audible without
    // pretending these generated signals are recordings of people or hardware.
    const audible = channel === "mix" ? path.connected : channel === path.voice && path.isolated;
    if (!audible) continue;
    for (let n = 0; n < sampleRate; n++) {
      const t = n / sampleRate; const gate = Math.min(1, t / .035, (1 - t) / .08);
      const pulse = (.72 + .28 * Math.sin(2 * Math.PI * 4 * t)) * Math.max(0, gate);
      samples[(path.voice - 1) * sampleRate + n] = .16 * pulse * (Math.sin(2 * Math.PI * path.frequencyHz * t) + .22 * Math.sin(4 * Math.PI * path.frequencyHz * t));
    }
  }
  const peak = samples.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0);
  return { wav: encodeWav(samples, sampleRate), samples, paths, seconds, sampleRate, peak, sourceMode: "modelled" as const, physicalTest: "not_performed" as const, graphHash: edition.certificate.graphHash, notice: "Synthesized routing audition. It models available input paths and track routing only; power, actual SD media, noise, gain and physical sound quality are not tested." };
}
