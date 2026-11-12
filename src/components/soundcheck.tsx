"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, AudioLines, Pause, Play, Volume2, X } from "lucide-react";
import type { KitRevision } from "../../packages/contracts/index";
import { encodeWav, MODEL_SAMPLE_RATE, renderSoundcheck, rms, routingState, testSignal, type ListeningBus } from "../../packages/soundcheck/index";
import { ModalFrame } from "./modal";

class AudioSession {
  context: AudioContext; inputs: AudioBufferSourceNode[] = []; buses: GainNode[] = []; analysers: AnalyserNode[] = []; master: GainNode;
  closing: Promise<void> | null = null;
  constructor(kit: KitRevision) {
    this.context = new AudioContext();
    try {
      this.master = this.context.createGain(); this.master.gain.value = 0.7; this.master.connect(this.context.destination);
      const rendered = renderSoundcheck(kit);
      for (const bus of [rendered.track1, rendered.track2, rendered.mix]) {
        const buffer = this.context.createBuffer(1, bus.length, MODEL_SAMPLE_RATE); buffer.copyToChannel(new Float32Array(bus), 0);
        const input = this.context.createBufferSource(); this.inputs.push(input); input.buffer = buffer; input.loop = true;
        const analyser = this.context.createAnalyser(); analyser.fftSize = 1024; const output = this.context.createGain(); output.gain.value = 0;
        input.connect(analyser); analyser.connect(output); output.connect(this.master); input.start();
        this.buses.push(output); this.analysers.push(analyser);
      }
      this.listen("mix");
    } catch (error) {
      void this.close().catch(() => {});
      throw error;
    }
  }
  listen(bus: ListeningBus) { this.buses.forEach((gain, index) => gain.gain.setTargetAtTime(index === ["track1", "track2", "mix"].indexOf(bus) ? 1 : 0, this.context.currentTime, .02)); }
  levels() { return this.analysers.map(analyser => { const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data); return rms(data); }); }
  close() { return this.closing ??= (async () => { this.inputs.forEach(source => { try { source.stop(); } catch { /* A stopped node is already inert. */ } }); if (this.context.state !== "closed") await this.context.close(); })(); }
}
export function Soundcheck({ kit, onClose, contextLabel, onPlaybackStarted }: { kit: KitRevision; onClose: () => void; contextLabel?: string; onPlaybackStarted?: (value: { revisionId: string; bus: ListeningBus }) => void }) {
  const session = useRef<AudioSession | null>(null); const [playing, setPlaying] = useState(false); const [starting, setStarting] = useState(false); const [bus, setBus] = useState<ListeningBus>("mix"); const [levels, setLevels] = useState([0, 0, 0]); const [error, setError] = useState("");
  const active = useRef(false), epoch = useRef(0), changing = useRef(false), selectedBus = useRef(bus), currentKit = useRef(kit.id), started = useRef(onPlaybackStarted); currentKit.current = kit.id; started.current = onPlaybackStarted;
  const route = routingState(kit);
  useEffect(() => { active.current = true; epoch.current++; changing.current = false; setStarting(false); setPlaying(false); setLevels([0, 0, 0]); return () => { active.current = false; epoch.current++; void session.current?.close(); session.current = null; }; }, [kit.id]);
  useEffect(() => { if (!playing) return; const timer = setInterval(() => setLevels(session.current?.levels() ?? [0, 0, 0]), 60); return () => clearInterval(timer); }, [playing]);
  async function toggle() {
    if (changing.current) return; changing.current = true; setStarting(true); const revisionId = kit.id, generation = epoch.current;
    if (playing) { try { await session.current?.close(); if (epoch.current === generation) { session.current = null; if (active.current) { setPlaying(false); setLevels([0, 0, 0]); } } } finally { if (epoch.current === generation) { changing.current = false; if (active.current) setStarting(false); } } return; }
    let audio: AudioSession | null = null;
    try { audio = new AudioSession(kit); session.current = audio; await audio.context.resume(); if (!active.current || currentKit.current !== revisionId || session.current !== audio) { await audio.close(); return; } if (audio.context.state !== "running") throw new Error("Playback did not enter the running state."); audio.listen(selectedBus.current); setPlaying(true); setError(""); started.current?.({ revisionId, bus: selectedBus.current }); }
    catch { await audio?.close().catch(() => {}); if (session.current === audio) session.current = null; if (active.current && currentKit.current === revisionId) setError("Audio could not start. Try this browser’s audio permission, then press Play again."); }
    finally { if (epoch.current === generation) { changing.current = false; if (active.current && currentKit.current === revisionId) setStarting(false); } }
  }
  function choose(value: ListeningBus) { selectedBus.current = value; setBus(value); session.current?.listen(value); }
  function download(value: ListeningBus) {
    const rendered = renderSoundcheck(kit); const url = URL.createObjectURL(new Blob([encodeWav(rendered[value])], { type: "audio/wav" }));
    const a = document.createElement("a"); a.href = url; a.download = `worldkit-modelled-r${kit.revision}-${value}.wav`; a.click(); URL.revokeObjectURL(url);
  }
  return <ModalFrame onClose={onClose} labelledBy="stage-title" className="stage" backdropClassName="stage-backdrop">
    <header><span className="eyebrow"><AudioLines size={15}/> YOUR SIGNAL, IN MOTION</span><button className="icon-button dark" onClick={onClose} aria-label="Close soundcheck"><X size={20}/></button></header>
      <div className="stage-title"><div><h2 id="stage-title">Before the first take.</h2><p>{contextLabel ?? "Hear what your saved connections do."}</p></div><span className="stage-mode">Modelled audio · revision {kit.revision}</span></div>
      <div className="stage-flow"><div className="signal-origin"><span className="signal-disc a">A</span><strong>Original test signal A</strong><small>220 Hz pattern · input 1</small></div><div className="stage-wire"><span/><span/></div><div className="stage-recorder"><AudioLines size={37}/><strong>{kit.templateId === "T1" ? "Host recording" : "Onboard recorder"}</strong><span>{route.isolated ? "Separate recording buses" : "Isolated mode not established"}</span></div><div className="stage-wire"><span/><span/></div><div className="signal-origin"><span className="signal-disc b">B</span><strong>Original test signal B</strong><small>440 Hz pattern · input 2</small></div></div>
      <div className="bus-grid">{(["track1", "track2", "mix"] as const).map((value, index) => <article className={`bus-card ${bus === value ? "selected" : ""}`} key={value}><header><span>{index < 2 ? `ISOLATED TRACK ${index + 1}` : "STREAM MIX"}</span><span className="mono">{levels[index]! > 0 ? `${(20 * Math.log10(levels[index]!)).toFixed(1)} dBFS` : "−∞ dBFS"}</span></header><div className="level-meter" aria-label={`${value} level`}><i style={{ width: `${Math.min(100, levels[index]! * 600)}%` }}/>{Array.from({length:18}, (_,i)=><b key={i}/>)}</div><div className="waveform" aria-hidden="true">{Array.from({length:45},(_,i)=><span key={i} style={{height:`${Math.abs(testSignal(index === 1 ? 2 : 1, .02, 2400)[i] ?? 0) * 190 + 4}px`,opacity: index === 0 ? route.input1 ? 1 : .15 : index === 1 ? route.input2 ? 1 : .15 : route.stream ? 1 : .15}}/>)}</div><p>{index === 0 ? route.input1 ? "Only signal A reaches this recording." : "Input 1 is disconnected or unpowered." : index === 1 ? route.input2 ? "Only signal B reaches this recording." : "Input 2 is disconnected or unpowered." : route.stream ? "Both available inputs join at the stream." : "The downstream stream path is broken."}</p><footer><button onClick={() => choose(value)} className={bus === value ? "listen active" : "listen"}><Volume2 size={15}/>{bus === value ? "Listening" : "Listen"}</button><button className="icon-button dark" onClick={() => download(value)} aria-label={`Download modeled ${value} WAV`}><ArrowDownToLine size={16}/></button></footer></article>)}</div>
      <footer className="stage-controls"><button className="button light" disabled={starting} onClick={() => void toggle()}>{playing ? <Pause size={18}/> : <Play size={18}/>} {starting ? "Preparing audio…" : playing ? "Pause soundcheck" : "Play soundcheck"}</button><p>Generated original test signals, rendered from this graph.<br/>This demonstrates routing. It does not measure real equipment.</p></footer>{error && <p role="alert" className="stage-error">{error}</p>}
  </ModalFrame>;
}
