import { createHash } from "node:crypto";
import type { BenchAudioInspection, BenchFileInput } from "./contracts";

const SAMPLE_MARKER = "WORLDKIT_GENERATED_SAMPLE_V1";
const SCOPE = "Byte-derived waveform and channel statistics; neither physical origin nor microphone independence is inferred." as const;
/** A bounded RIFF reader. It retains only one sample frame and small chunk headers. */
class WaveInspection {
  pending: Buffer = Buffer.alloc(0); remaining = 0; chunk = ""; padding = 0; started = false; invalid = false;
  fmt: { format: "pcm" | "float"; channels: number; sampleRate: number; bitsPerSample: number; block: number } | null = null;
  declaredFrames = 0; frames = 0; peaks: number[] = []; squares: number[] = []; clipped: number[] = []; envelope: number[][] = [];
  sampleCarry = Buffer.alloc(0); foundData = false; sample = false; notes: string[] = [];
  push(input: Buffer) {
    if (this.invalid) return;
    let bytes = this.pending.length ? Buffer.concat([this.pending, input]) : input; this.pending = Buffer.alloc(0);
    if (!this.started) {
      if (bytes.length < 12) { this.pending = bytes; return; }
      if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") { this.invalid = true; return; }
      this.started = true; bytes = bytes.subarray(12);
    }
    while (bytes.length) {
      if (!this.remaining) {
        if (this.padding) { bytes = bytes.subarray(1); this.padding = 0; if (!bytes.length) return; }
        if (bytes.length < 8) { this.pending = Buffer.from(bytes); return; }
        this.chunk = bytes.toString("ascii", 0, 4); this.remaining = bytes.readUInt32LE(4); this.padding = this.remaining % 2; bytes = bytes.subarray(8);
        if (this.chunk === "fmt " && (this.remaining < 16 || this.remaining > 4096)) { this.invalid = true; this.notes.push("The WAV format header is unsupported."); return; }
        if (this.chunk === "data") {
          if (this.foundData || !this.fmt || this.remaining % this.fmt.block) { this.invalid = true; this.notes.push("Multiple, unaligned or pre-format data chunks cannot be inspected by this reader."); return; }
          this.foundData = true; this.declaredFrames = this.remaining / this.fmt.block;
        }
        if (!this.remaining) continue;
      }
      if ((this.chunk === "fmt " || this.chunk === "wknb") && bytes.length < this.remaining && this.remaining <= 4096) { this.pending = Buffer.from(bytes); return; }
      const count = Math.min(bytes.length, this.remaining), part = bytes.subarray(0, count);
      if (this.chunk === "fmt ") {
        let encoding = part.readUInt16LE(0); const channels = part.readUInt16LE(2), sampleRate = part.readUInt32LE(4), block = part.readUInt16LE(12), bitsPerSample = part.readUInt16LE(14);
        if (encoding === 65534 && part.length >= 40) encoding = part.readUInt16LE(24);
        if (!([1, 3].includes(encoding) && channels >= 1 && channels <= 32 && sampleRate >= 8000 && sampleRate <= 384000 && [8, 16, 24, 32].includes(bitsPerSample) && block === channels * bitsPerSample / 8 && (encoding !== 3 || bitsPerSample === 32))) { this.invalid = true; this.notes.push("This WAV encoding is retained unchanged but has no computed waveform."); return; }
        this.fmt = { format: encoding === 1 ? "pcm" : "float", channels, sampleRate, bitsPerSample, block };
        this.peaks = Array(channels).fill(0); this.squares = Array(channels).fill(0); this.clipped = Array(channels).fill(0); this.envelope = Array.from({ length: channels }, () => Array(80).fill(0));
      } else if (this.chunk === "wknb") {
        if (part.includes(Buffer.from(SAMPLE_MARKER))) this.sample = true;
      } else if (this.chunk === "data" && this.fmt) this.samples(part);
      this.remaining -= count; bytes = bytes.subarray(count);
    }
  }
  samples(input: Buffer) {
    const f = this.fmt!; const bytes = this.sampleCarry.length ? Buffer.concat([this.sampleCarry, input]) : input;
    const count = Math.floor(bytes.length / f.block), width = f.bitsPerSample / 8;
    for (let frame = 0; frame < count; frame++) {
      const bin = Math.min(79, Math.floor((this.frames + frame) * 80 / Math.max(1, this.declaredFrames)));
      for (let channel = 0; channel < f.channels; channel++) {
        const offset = frame * f.block + channel * width;
        let value = f.format === "float" ? bytes.readFloatLE(offset) : width === 1 ? (bytes.readUInt8(offset) - 128) / 128 : bytes.readIntLE(offset, width) / 2 ** (f.bitsPerSample - 1);
        if (!Number.isFinite(value)) { this.invalid = true; this.notes.push("Non-finite floating-point samples prevent a meaningful waveform."); return; }
        const magnitude = Math.abs(value); this.peaks[channel] = Math.max(this.peaks[channel]!, magnitude); this.squares[channel]! += value * value;
        if (magnitude >= 0.999) this.clipped[channel]!++;
        this.envelope[channel]![bin] = Math.max(this.envelope[channel]![bin]!, Math.min(1, magnitude));
      }
    }
    this.frames += count; this.sampleCarry = Buffer.from(bytes.subarray(count * f.block));
  }
  result(): BenchAudioInspection | null {
    if (this.invalid || !this.fmt || !this.foundData || this.remaining || this.pending.length || this.sampleCarry.length || this.frames !== this.declaredFrames || !this.frames) return null;
    return { format: this.fmt.format, channels: this.fmt.channels, sampleRate: this.fmt.sampleRate, bitsPerSample: this.fmt.bitsPerSample, frames: this.frames, durationSeconds: this.frames / this.fmt.sampleRate, channelPeaks: this.peaks, channelRms: this.squares.map(square => Math.sqrt(square / this.frames)), envelope: this.envelope, clippingSamples: this.clipped, scope: SCOPE };
  }
}

function sniff(prefix: Buffer): BenchFileInput["mediaType"] | null {
  if (prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  if (prefix.toString("ascii", 0, 3) === "ID3" || prefix[0] === 255 && (prefix[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  if (prefix.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return "image/jpeg";
  if (prefix.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

export class BenchInspectionError extends Error {}
export async function inspectBenchOriginal(stream: ReadableStream<Uint8Array>, expected: Pick<BenchFileInput, "bytes" | "mediaType" | "expectedSha256">, onProgress?: (bytes: number) => Promise<void>) {
  const digest = createHash("sha256"), wave = expected.mediaType === "audio/wav" ? new WaveInspection() : null;
  let size = 0, prefix = Buffer.alloc(0), lastProgress = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      const part = Buffer.from(result.value); size += part.length;
      if (size > expected.bytes) throw new BenchInspectionError("The original exceeds the exact declared byte count.");
      if (prefix.length < 32) prefix = Buffer.concat([prefix, part.subarray(0, 32 - prefix.length)]);
      digest.update(part); wave?.push(part);
      if (onProgress && size - lastProgress >= 8 * 1024 * 1024) { await onProgress(size); lastProgress = size; }
    }
    if (size !== expected.bytes) throw new BenchInspectionError("The original is incomplete or its declared byte count differs.");
    const sha256 = digest.digest("hex"), observedMediaType = sniff(prefix);
    if (observedMediaType !== expected.mediaType) throw new BenchInspectionError("The original file signature does not match the selected media format.");
    if (expected.expectedSha256 && expected.expectedSha256 !== sha256) throw new BenchInspectionError("The original SHA-256 differs from the declared fingerprint; the file was not accepted.");
    const audio = wave?.result() ?? null;
    const inspectionNotes = ["Original bytes were streamed and hashed without transcoding. A file signature and hash do not establish physical origin, safety or participant consent.", ...(wave?.notes ?? [])];
    if (wave && !audio) inspectionNotes.push("This WAV container has no supported complete PCM/float waveform inspection. Inspect the retained original with an appropriate player.");
    if (!wave) inspectionNotes.push("Container signature only; duration, tracks and physical content were not independently decoded.");
    if (wave?.sample) inspectionNotes.push("An embedded WorldKit generated-Sample marker was found. This cannot support physical execution.");
    return { sha256, bytes: size, observedMediaType, audio, detectedModelExport: wave?.sample ?? false, inspectionNotes };
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}

/** Deliberately unmistakable generated material for a Sample rehearsal, never a hardware recording. */
export function sampleBenchWave(channels: number, graphHash: string, mix = false): Buffer {
  channels = Math.max(1, Math.min(8, channels)); const rate = 16000, frames = rate * 2, metadata = Buffer.from(JSON.stringify({ marker: SAMPLE_MARKER, graphHash, physicalTest: "not_performed", note: "Generated routing tones; no microphone or hardware was recorded." }));
  const metaSize = metadata.length + metadata.length % 2, dataSize = frames * channels * 2, bytes = Buffer.alloc(12 + 24 + 8 + metaSize + 8 + dataSize);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8); bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28); bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("wknb", 36); bytes.writeUInt32LE(metadata.length, 40); metadata.copy(bytes, 44); const data = 44 + metaSize; bytes.write("data", data); bytes.writeUInt32LE(dataSize, data + 4);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const fade = Math.min(1, frame / 400, (frames - frame) / 400), active = mix || Math.floor(frame / (frames / channels)) === channel;
    bytes.writeInt16LE(active ? Math.round(Math.sin(2 * Math.PI * (220 + channel * 110) * frame / rate) * 9500 * fade) : 0, data + 8 + (frame * channels + channel) * 2);
  }
  return bytes;
}
