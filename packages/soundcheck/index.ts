import type { KitRevision } from "../contracts/index";

export const MODEL_SAMPLE_RATE = 24000;
export type ListeningBus = "track1" | "track2" | "mix";
export type RoutingState = { input1: boolean; input2: boolean; isolated: boolean; stream: boolean; monitor: boolean };
function reaches(kit: KitRevision, start: string, end: string) {
  const seen = new Set<string>(); const queue = [start];
  while (queue.length) { const current = queue.shift()!; if (current === end) return true; if (seen.has(current)) continue; seen.add(current); for (const edge of kit.connections) if (edge.enabled && edge.from.componentId === current && edge.signal !== "power") queue.push(edge.to.componentId); }
  return false;
}
export function routingState(kit: KitRevision): RoutingState {
  const audio = kit.components.find(c => c.role === "audio");
  const micActive = (id: string, input: string) => {
    const mic = kit.components.find(c => c.id === id); if (!mic || !audio) return false;
    const powered = mic.profileId !== "at2020-xlr" || audio.settings.phantomEnabled === true;
    return powered && kit.connections.some(e => e.enabled && e.from.componentId === id && e.from.portId === "out" && e.to.componentId === audio.id && e.to.portId === input && e.protocol === "analog_balanced");
  };
  const documentedMode = audio?.profileId !== "zoom-h4essential" || ([44100, 48000].includes(Number(audio.settings.sampleRate)) && audio.settings.recordingMode === "Audio I/F + REC");
  return { input1: micActive("mic-1", "input1"), input2: micActive("mic-2", "input2"), isolated: kit.templateId !== "T1" && Boolean(documentedMode), stream: Boolean(audio && reaches(kit, audio.id, "host")), monitor: Boolean(audio && reaches(kit, audio.id, "headphones")) };
}
/** Original synthetic test signals, not musicians or recorded hardware. */
export function testSignal(index: 1 | 2, duration = 6, sampleRate = MODEL_SAMPLE_RATE): Float32Array {
  const result = new Float32Array(Math.floor(duration * sampleRate));
  const frequencies = index === 1 ? [220, 277.18, 329.63, 277.18] : [440, 523.25, 659.25, 523.25];
  for (let i = 0; i < result.length; i++) {
    const t = i / sampleRate; const phase = (t * (index === 1 ? 2 : 3)) % 1; const note = frequencies[Math.floor(t * 2) % frequencies.length]!;
    const envelope = Math.min(1, phase * 35) * Math.exp(-phase * 3.3) * Math.min(1, t * 40, (duration - t) * 40);
    result[i] = 0.22 * envelope * (Math.sin(2 * Math.PI * note * t) + 0.14 * Math.sin(2 * Math.PI * note * 2 * t));
  }
  return result;
}
export function renderSoundcheck(kit: KitRevision, duration = 6, sampleRate = MODEL_SAMPLE_RATE) {
  const routes = routingState(kit); const a = testSignal(1, duration, sampleRate); const b = testSignal(2, duration, sampleRate);
  const track1 = new Float32Array(a.length); const track2 = new Float32Array(a.length); const mix = new Float32Array(a.length); const monitor = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const input1 = routes.input1 ? a[i]! : 0; const input2 = routes.input2 ? b[i]! : 0;
    track1[i] = routes.isolated ? input1 : 0; track2[i] = routes.isolated ? input2 : 0;
    const combined = (input1 + input2) / 2; mix[i] = routes.stream ? combined : 0; monitor[i] = routes.monitor ? combined : 0;
  }
  return { track1, track2, mix, monitor, routes, sampleRate, duration };
}
export function rms(samples: ArrayLike<number>): number { let sum = 0; for (let i = 0; i < samples.length; i++) sum += samples[i]! ** 2; return Math.sqrt(sum / Math.max(samples.length, 1)); }
export function encodeWav(samples: Float32Array, sampleRate = MODEL_SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
  const text = (offset: number, word: string) => [...word].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const value = Math.max(-1, Math.min(1, samples[i]!)); view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }
  return buffer;
}
