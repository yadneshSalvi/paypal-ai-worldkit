"use client";
import { useId, useState } from "react";
import { AudioLines, FileAudio, FileImage, FileText, FileVideo, Fingerprint, FlaskConical, LockKeyhole, ShieldAlert, ShieldCheck } from "lucide-react";
import type { BenchAsset, BenchDetail } from "../../packages/physical-notebook/contracts";
import { benchBytes, benchOriginalUrl, benchShort, benchTime } from "./physical-notebook-client";
import styles from "./physical-notebook.module.css";

export const fileKindLabel = (kind: string) => (({ isolated_track: "Isolated track", stream_mix: "Stream mix", camera_recording: "Camera recording", connection_photo: "Connection photo", screen_recording: "Screen recording", rights_record: "Rights record", supporting_file: "Supporting file" } as Record<string, string>)[kind] ?? kind.replaceAll("_", " "));
export const provenanceLabel = (value: string) => (({ operator_original: "Operator-declared original", third_party: "Third-party original", model_export: "Model export", sample_generated: "Generated Sample" } as Record<string, string>)[value] ?? value);
export function originalAvailable(asset: BenchAsset) {
  return asset.availability === "available" && asset.originalBytesRetained && asset.rights.privateReviewAllowed && (!asset.rights.expiresAt || Date.parse(asset.rights.expiresAt) > Date.now());
}

export function OriginalIcon({ asset }: { asset: BenchAsset }) {
  const Icon = asset.observedMediaType.startsWith("audio/") ? FileAudio : asset.observedMediaType.startsWith("video/") ? FileVideo : asset.observedMediaType.startsWith("image/") ? FileImage : FileText;
  return <Icon size={21} aria-hidden="true"/>;
}

export function BenchWaveform({ asset }: { asset: BenchAsset }) {
  const titleId = useId();
  if (!asset.audio) return null;
  const audio = asset.audio;
  return <figure className={styles.waveform} aria-labelledby={titleId}>
    <figcaption id={titleId}><AudioLines size={14}/><span>Original-byte waveform</span><small>{audio.channels} {audio.channels === 1 ? "channel" : "channels"} · {audio.sampleRate.toLocaleString()} Hz · {audio.durationSeconds.toFixed(2)} s</small></figcaption>
    <div className={styles.waveChannels}>{audio.envelope.map((channel, index) => <div key={index} className={styles.waveChannel}>
      <span>CH {index + 1}</span><svg viewBox="0 0 400 44" preserveAspectRatio="none" role="img" aria-label={`Channel ${index + 1} byte-derived amplitude envelope`}>
        <line x1="0" x2="400" y1="22" y2="22"/>
        {channel.map((peak, bin) => { const height = Math.max(1, Math.min(1, Math.max(0, peak)) * 38); return <rect key={bin} x={bin * 400 / Math.max(channel.length, 1)} y={(44 - height) / 2} width={Math.max(1, 400 / Math.max(channel.length, 1) - 1.5)} height={height} rx=".8"/>; })}
      </svg><small>{audio.clippingSamples[index] ?? 0} clipped samples</small>
    </div>)}</div>
    <p>{audio.scope}</p>
  </figure>;
}

export function OriginalPreview({ asset, runId, reviewer }: { asset: BenchAsset; runId: string; reviewer: boolean }) {
  const [mediaError, setMediaError] = useState(false);
  if (!originalAvailable(asset)) return <div className={styles.emptySmall}><ShieldAlert size={25}/><h3>Original access is unavailable</h3><p>The manifest retains its fingerprint. A withdrawn or unavailable original cannot support a new inspection.</p><code>{asset.sha256}</code></div>;
  const url = benchOriginalUrl(asset.id, runId, reviewer);
  return <div className={styles.originalPreview}>
    <div className={styles.fileHeading}><OriginalIcon asset={asset}/><div><h3>{asset.filename}</h3><p>{fileKindLabel(asset.kind)} · {provenanceLabel(asset.provenance)} · {benchBytes(asset.bytes)}</p></div></div>
    {(asset.detectedModelExport || asset.provenance === "model_export" || asset.provenance === "sample_generated") && <div className={styles.warning} role="note"><FlaskConical size={19}/><p><b>Model or Sample evidence · cannot support physical execution</b><br/>The declared provenance and any detected model/Sample marker remain visible. Byte identity, channel counts and a waveform do not establish an equipment recording.</p></div>}
    {asset.observedMediaType.startsWith("audio/") ? <audio controls preload="none" src={url} onError={() => setMediaError(true)} aria-label={`Play original ${asset.filename}`}/> : asset.observedMediaType.startsWith("video/") ? <video controls preload="none" playsInline src={url} onError={() => setMediaError(true)} aria-label={`Play original ${asset.filename}`}/> : asset.observedMediaType.startsWith("image/") ? <img src={url} onError={() => setMediaError(true)} alt={`Original ${fileKindLabel(asset.kind).toLowerCase()}: ${asset.filename}`}/> : <p>PDF originals are download-only. Open the exact file to inspect it.</p>}
    {mediaError && <p className={styles.inlineError} role="alert">The original could not be loaded for playback or display. Refresh current access, or inspect the exact download. A failed preview is not successful file inspection.</p>}
    <BenchWaveform asset={asset}/>
    <a className={styles.button} href={url} download>Download exact original</a>
    <dl className={styles.facts}><div><dt>Verified bytes</dt><dd>{benchTime(asset.verifiedAt)}</dd></div><div><dt>SHA256</dt><dd><code>{asset.sha256}</code></dd></div><div><dt>Rights holder</dt><dd>{asset.rights.holder}</dd></div><div><dt>Permission</dt><dd>{asset.rights.permissionReference}</dd></div><div><dt>Private review</dt><dd>Permitted · granted {benchTime(asset.rights.grantedAt)}{asset.rights.expiresAt ? ` · expires ${benchTime(asset.rights.expiresAt)}` : " · no recorded expiry"}</dd></div><div><dt>Public sharing rights</dt><dd>{asset.rights.publicSharingAllowed ? "Declared by uploader; this notebook does not publish originals" : "Not granted"}</dd></div></dl>
    {asset.rights.attribution && <p>Attribution: {asset.rights.attribution}</p>}
    {asset.rights.restrictions && <p>Restrictions: {asset.rights.restrictions}</p>}
    {asset.inspectionNotes.length > 0 && <ul className={styles.notes}>{asset.inspectionNotes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
  </div>;
}

export function BoundSystem({ detail }: { detail: BenchDetail }) {
  const b = detail.edition.binding;
  return <section className={styles.binding} aria-label="Exact saved system binding">
    <header><span className={styles.sectionIcon}><Fingerprint size={19}/></span><div><span className={styles.eyebrow}>THE EXACT SAVED SYSTEM</span><h3>{b.title}</h3><p>{b.components.length} components · {b.connections.length} connections · {b.graphSource === "sample" ? "Sample graph" : b.graphSource === "mixed" ? "Mixed model / Sample sources" : "Modelled graph"}</p></div><span className={styles.hash} title={b.graphHash}>{benchShort(b.graphHash)}</span></header>
    <div className={styles.componentStrip}>{b.components.map((c, index) => <div key={c.id}><span>{String(index + 1).padStart(2, "0")}</span><b>{c.model}</b><small>{c.profileId}</small></div>)}</div>
    <details><summary>Inspect the frozen graph, sources and requirements</summary><div className={styles.bindingDetails}>
      <dl className={styles.facts}><div><dt>Graph</dt><dd><code>{b.graphHash}</code></dd></div><div><dt>Binding</dt><dd><code>{b.hash}</code></dd></div><div><dt>Existing certificate</dt><dd><code>{b.certificateHash}</code></dd></div><div><dt>Rule version</dt><dd>{b.ruleVersion}</dd></div></dl>
      <h4>Connections</h4><div className={styles.connectionList}>{b.connections.map(c => <div key={c.id}><code>{c.from}</code><span aria-label="connected to">→</span><code>{c.to}</code><small>{c.signal} · {c.protocol} · {c.cable} · {c.enabled ? "Enabled in saved graph" : "Disabled in saved graph"}</small></div>)}</div>
      <h4>Saved configuration</h4>{b.configuration.length ? b.configuration.map(c => <div key={c.componentId} className={styles.settings}><b>{b.components.find(v => v.id === c.componentId)?.model ?? c.componentId}</b><dl>{Object.entries(c.settings).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></div>) : <p>No additional configuration was recorded in the saved graph.</p>}
      <h4>Model requirements</h4><ul className={styles.notes}>{b.requirements.map(r => <li key={r.id}><b>{r.label}</b><span>{r.modeledStatus} · model scope</span></li>)}</ul>
      <h4>Frozen sources</h4><ul className={styles.sourceList}>{b.sources.map(s => <li key={s.id}><FileText size={14}/><div><b>{s.title}</b><code>{s.hash}</code>{safeSource(s.url) && <a href={s.url!} target="_blank" rel="noreferrer">Open source</a>}</div></li>)}</ul>
    </div></details>
    <footer><LockKeyhole size={13}/>This notebook retains the saved graph. It never rewrites the existing model certificate.</footer>
  </section>;
}

function safeSource(value: string | null) { if (!value) return false; try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }

export function Assessment({ detail }: { detail: BenchDetail }) {
  const a = detail.assessment;
  const caution = a.reportedFailures > 0 || a.status === "review_contradicted";
  const Icon = caution ? ShieldAlert : a.status === "reviewed_exact_conditions" ? ShieldCheck : a.status === "sample_only" ? FlaskConical : FileText;
  return <section className={`${styles.assessment} ${caution ? styles.failure : ""}`} aria-label="Current evidence assessment">
    <div className={styles.assessmentTop}><Icon size={23}/><div><span className={styles.eyebrow}>WHAT THIS EVIDENCE SUPPORTS</span><h3>{a.label}</h3></div><span className={styles.badge}>{detail.edition.sourceMode === "sample" ? "Sample" : "Operator report"}</span></div>
    <p>{a.detail}</p>
    <div className={styles.assessmentCounts}><div><strong>{a.actualQualifiedReviews}</strong><span>actual qualified reviews</span></div><div><strong>{a.sampleReviews}</strong><span>Sample reviews</span></div><div><strong>{a.reportedFailures}</strong><span>reported failures retained</span></div></div>
    {a.missing.length > 0 && <details><summary>{a.missing.length} evidence {a.missing.length === 1 ? "gap" : "gaps"} remains visible</summary><ul>{a.missing.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
    <p className={styles.smallPrint}>Scope: {a.physicalExecution.replaceAll("_", " ")} · existing compatibility certificate unchanged.</p>
  </section>;
}
