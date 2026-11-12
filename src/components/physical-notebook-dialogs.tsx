"use client";
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { ArrowRight, CircleAlert, FileUp, LockKeyhole, ShieldAlert, X } from "lucide-react";
import { BENCH_MAX_BYTES, BenchCommandSchema, type BenchAsset, type BenchCommand, type BenchConditions, type BenchFileInput, type BenchFileKind, type BenchGrant, type BenchHome, type BenchUpload } from "../../packages/physical-notebook/contracts";
import { ModalFrame } from "./modal";
import { benchBytes, benchCurrent, benchOriginalUrl, benchShort, benchTime, fromUtcInput, utcInput, type BenchCommandBody } from "./physical-notebook-client";
import { fileKindLabel, originalAvailable, OriginalPreview } from "./physical-notebook-evidence";
import styles from "./physical-notebook.module.css";

export type NotebookDialog =
  | { kind: "create" }
  | { kind: "plan" }
  | { kind: "serial"; componentId?: string; recovery?: Omit<Extract<BenchCommand, { kind: "private_serial" }>, "serial"> }
  | { kind: "start" | "finish" | "seal" | "sample" | "upload" | "invite" | "review" }
  | { kind: "observe"; stepId: string }
  | { kind: "attach" | "withdraw" | "original"; asset: BenchAsset }
  | { kind: "send"; upload: BenchUpload; file?: File }
  | { kind: "remove_upload"; upload: BenchUpload }
  | { kind: "revoke"; grant: BenchGrant };

const mediaTypes = ["audio/wav", "audio/mpeg", "video/mp4", "video/webm", "image/png", "image/jpeg", "application/pdf"] as const;
const fileKinds: BenchFileKind[] = ["isolated_track", "stream_mix", "camera_recording", "connection_photo", "screen_recording", "rights_record", "supporting_file"];
const titleFor = (kind: NotebookDialog["kind"]) => ({ create: "Open a field notebook", plan: "Declare the exact conditions", serial: "Seal a private equipment serial", start: "Begin the recorded interval", finish: "Finish and retain this interval", seal: "Seal this exact report", sample: "Create clearly generated Sample originals", upload: "Prepare a private original", invite: "Invite a scoped reviewer", review: "Record your exact-scope review", observe: "Append an operator observation", attach: "Link an original to a protocol step", withdraw: "Withdraw access to this original", original: "Inspect the exact original", send: "Send this original file", remove_upload: "Remove this unverified upload", revoke: "Revoke this review invitation" }[kind]);
const conditionFields: { key: Exclude<keyof BenchConditions, "hardware" | "declaredSeconds">; label: string; max: number; wide?: boolean }[] = [
  { key: "operator", label: "Operator name", max: 100 }, { key: "locationLabel", label: "Location label (optional)", max: 160 },
  { key: "hostOs", label: "Host and operating system", max: 160 }, { key: "appAndVersion", label: "Application and exact version", max: 240 },
  { key: "recordingSettings", label: "Recording settings", max: 2000, wide: true }, { key: "streamSettings", label: "Stream settings", max: 1600, wide: true },
  { key: "storage", label: "Storage format and capacity", max: 800 }, { key: "power", label: "Power supplies and mode", max: 1000 },
  { key: "hubsAndCables", label: "Hubs, adapters and cables", max: 2000, wide: true }, { key: "monitoring", label: "Monitoring path", max: 1000, wide: true },
  { key: "notes", label: "Conditions and limitations (optional)", max: 4000, wide: true },
];
function Field({ label, children, hint, wide = false }: { label: string; children: ReactNode; hint?: string; wide?: boolean }) {
  return <label className={`${styles.field} ${wide ? styles.wide : ""}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Acknowledge({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
  return <label className={styles.acknowledge}><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}/><span>{children}</span></label>;
}

export function NotebookActionDialog({ dialog, home, busy, checking = false, blocked = false, pending, error, returnFocusRef, onClose, onCommand, onSend }: {
  dialog: NotebookDialog; home: BenchHome; busy: boolean; checking?: boolean; blocked?: boolean; pending: boolean; error: string;
  returnFocusRef: RefObject<HTMLElement | null>; onClose: () => void;
  onCommand: (command: BenchCommandBody | BenchCommand, file?: File) => void;
  onSend: (upload: BenchUpload, file: File) => void;
}) {
  const d = home.selected;
  const [subjectIndex, setSubjectIndex] = useState(0);
  const [title, setTitle] = useState(home.subjects[0] ? `${home.subjects[0].title} · field notebook`.slice(0, 120) : "");
  const [mode, setMode] = useState<"sample" | "operator_recorded">("sample");
  const [conditions, setConditions] = useState<BenchConditions | null>(d ? structuredClone(d.edition.conditions) : null);
  const [ackA, setAckA] = useState(false); const [ackB, setAckB] = useState(false);
  const [note, setNote] = useState(""); const [limits, setLimits] = useState("");
  const [stepId, setStepId] = useState(dialog.kind === "observe" ? dialog.stepId : d?.edition.binding.steps.find(s => dialog.kind !== "attach" || s.evidenceKinds.includes(dialog.asset.kind))?.id ?? "");
  const [outcome, setOutcome] = useState<"observed_pass" | "observed_failure" | "uncertain" | "not_performed">("uncertain");
  const [observedAt, setObservedAt] = useState(utcInput(d?.edition.finishedAt ?? new Date().toISOString()));
  const [componentId, setComponentId] = useState(dialog.kind === "serial" ? dialog.recovery?.componentId ?? dialog.componentId ?? d?.edition.binding.components[0]?.id ?? "" : "");
  const [serial, setSerial] = useState("");
  const [file, setFile] = useState<File | null>(dialog.kind === "send" ? dialog.file ?? null : null);
  const [kind, setKind] = useState<BenchFileKind>("isolated_track");
  const [mediaType, setMediaType] = useState<BenchFileInput["mediaType"]>("audio/wav");
  const [provenance, setProvenance] = useState<BenchFileInput["provenance"]>(d?.edition.sourceMode === "sample" ? "sample_generated" : "operator_original");
  const [expectedHash, setExpectedHash] = useState("");
  const [rightsBasis, setRightsBasis] = useState<BenchFileInput["rights"]["basis"]>(d?.edition.sourceMode === "sample" ? "sample_generated" : "original_creator");
  const [holder, setHolder] = useState(""); const [permission, setPermission] = useState("");
  const [grantedAt, setGrantedAt] = useState(""); const [expiresAt, setExpiresAt] = useState("");
  const [attribution, setAttribution] = useState(""); const [publicAllowed, setPublicAllowed] = useState(false);
  const [people, setPeople] = useState(false); const [participantConsent, setParticipantConsent] = useState(false);
  const [reviewerId, setReviewerId] = useState(""); const [reviewerName, setReviewerName] = useState("");
  const [reviewerProvenance, setReviewerProvenance] = useState<"human" | "sample">(d?.edition.sourceMode === "sample" ? "sample" : "human");
  const [hours, setHours] = useState(24);
  const [decision, setDecision] = useState<"supports_reported_scope" | "contradiction" | "needs_evidence">("needs_evidence");
  const [inspected, setInspected] = useState<string[]>([]);
  const [validation, setValidation] = useState(""); const [discard, setDiscard] = useState(false);
  const dirty = useRef(false); const keepEditing = useRef<HTMLButtonElement>(null); const form = useRef<HTMLFormElement>(null);
  const wasDiscarding = useRef(false);
  const changed = () => { dirty.current = true; setValidation(""); };
  const acknowledge = (setter: (value: boolean) => void) => (value: boolean) => { changed(); setter(value); };
  const close = () => { if (busy || checking) return; if (dirty.current && dialog.kind !== "original") setDiscard(true); else onClose(); };
  useEffect(() => { if (discard) { wasDiscarding.current = true; keepEditing.current?.focus(); } else if (wasDiscarding.current) { wasDiscarding.current = false; form.current?.querySelector<HTMLElement>("input,select,textarea,button")?.focus(); } }, [discard]);

  function chooseFile(value: File | undefined) {
    changed(); setFile(value ?? null);
    if (value && mediaTypes.includes(value.type as BenchFileInput["mediaType"])) setMediaType(value.type as BenchFileInput["mediaType"]);
    else if (value?.name.toLowerCase().endsWith(".wav")) setMediaType("audio/wav");
  }
  function submit(event: FormEvent) {
    event.preventDefault(); if (busy || checking || blocked || pending) return; setValidation("");
    try {
      if (dialog.kind === "send") { if (!file) throw new Error("Choose the exact original file first."); onSend(dialog.upload, file); return; }
      let body: BenchCommandBody | BenchCommand;
      if (dialog.kind === "create") {
        if (!ackA) throw new Error("Acknowledge what a notebook can and cannot establish.");
        const subject = home.subjects[subjectIndex]; if (!subject) throw new Error("Choose a currently saved system.");
        body = { kind: "create", subject: subject.subject, title, sourceMode: mode, acknowledgedEvidenceScope: true };
      } else {
        if (!d) throw new Error("Reopen the saved notebook before making a change.");
        const current = benchCurrent(d);
        switch (dialog.kind) {
          case "plan": if (!conditions) return; body = { kind: "plan", ...current, conditions, reason: note }; break;
          case "serial": body = dialog.recovery ? { ...dialog.recovery, serial } : { kind: "private_serial", ...current, componentId, serial }; break;
          case "start": if (!ackA || !ackB) throw new Error("Confirm both declarations before starting."); body = { kind: "start", ...current, confirmedExactEquipment: true, acknowledgedOperatorReport: true }; break;
          case "observe": body = { kind: "observe", ...current, observation: { stepId, outcome, detail: note, observedAt: fromUtcInput(observedAt) } }; break;
          case "finish": body = { kind: "finish", ...current, note }; break;
          case "seal": if (!ackA) throw new Error("Confirm that this immutable manifest records reported evidence."); body = { kind: "seal", ...current, acknowledgedManifestIsReportedEvidence: true }; break;
          case "sample": if (!ackA) throw new Error("Acknowledge the generated Sample scope."); body = { kind: "sample_originals", ...current, acknowledgedGeneratedSample: true }; break;
          case "upload": {
            if (!file) throw new Error("Choose the original file explicitly.");
            if (!ackA) throw new Error("Confirm permission for this private review.");
            body = { kind: "upload_intent", ...current, file: { filename: file.name, bytes: file.size, mediaType, kind, provenance, expectedSha256: expectedHash.trim() || null,
              rights: { basis: rightsBasis, holder, permissionReference: permission, grantedAt: fromUtcInput(grantedAt), expiresAt: expiresAt ? fromUtcInput(expiresAt) : null, attribution, privateReviewAllowed: true, publicSharingAllowed: publicAllowed, identifiablePeople: people, participantConsentConfirmed: participantConsent, restrictions: limits } } }; break;
          }
          case "attach": body = { kind: "attach", ...current, assetId: dialog.asset.id, stepId, note }; break;
          case "withdraw": if (!ackA) throw new Error("Acknowledge that the immutable fingerprint remains."); body = { kind: "withdraw_asset", runId: d.runId, assetId: dialog.asset.id, reason: note, acknowledgedRetainedManifestHash: true }; break;
          case "remove_upload": if (!ackA) throw new Error("Acknowledge that the intent and any retained fingerprint stay in history."); body = { kind: "withdraw_upload", runId: d.runId, uploadId: dialog.upload.id, reason: note, acknowledgedRetainedManifestHash: true }; break;
          case "invite": {
            if (!ackA) throw new Error("Confirm that the invitation is for private, exact-scope review.");
            const person = home.reviewers.find(r => r.id === reviewerId);
            body = { kind: "invite_reviewer", ...current, actorId: person?.id ?? null, name: person?.name ?? reviewerName, provenance: person?.provenance ?? reviewerProvenance, hours, acknowledgedPrivateReviewOnly: true }; break;
          }
          case "revoke": body = { kind: "revoke_reviewer", runId: d.runId, grantId: dialog.grant.id }; break;
          case "review": if (!ackA || !ackB) throw new Error("Confirm inspection of the exact originals and conditions."); body = { kind: "review", ...current, decision: { outcome: decision, finding: note, limitations: limits, inspectedAssetIds: inspected, inspectedOriginals: true, reviewedExactConditions: true } }; break;
          default: return;
        }
      }
      const parsed = BenchCommandSchema.parse({ requestId: "00000000-0000-4000-8000-000000000000", ...body });
      if (!("requestId" in body)) { const { requestId: _validationOnly, ...checked } = parsed; onCommand(checked, dialog.kind === "upload" ? file ?? undefined : undefined); }
      else onCommand(parsed);
    } catch (value) {
      const failure = value as Error & { issues?: { message: string }[] };
      setValidation(failure.issues ? failure.issues.map(i => i.message).join(" ") : failure.message || "Check the entered details.");
    }
  }

  const titleId = "physical-notebook-dialog-title";
  const titleText = titleFor(dialog.kind);
  const reviewerExercise = d?.edition.sourceMode === "sample" || d?.reviewer?.provenance === "sample";
  const availableAssets = d?.assets.filter(a => originalAvailable(a) && d.edition.attachments.some(link => link.assetId === a.id && link.assetHash === a.sha256)) ?? [];
  const submitLabel = ({ create: "Open this notebook", plan: "Save exact conditions", serial: dialog.kind === "serial" && dialog.recovery ? "Recover the original serial save" : "Seal private serial", start: "Start this interval", observe: "Append this observation", finish: "Finish the interval", seal: "Seal reported evidence", sample: "Create three Sample originals", upload: "Save the original upload intent", attach: "Link this exact original", withdraw: "Withdraw private access", remove_upload: "Remove this upload", invite: "Create private invitation", review: reviewerExercise ? "Record Sample review" : "Record exact-scope decision", send: "Send this file once", revoke: "Revoke this invitation", original: "" })[dialog.kind];
  const needsAck = ["create", "seal", "sample", "upload", "withdraw", "remove_upload", "invite", "start", "review"].includes(dialog.kind);
  const disabled = busy || checking || blocked || pending || needsAck && !ackA || ["start", "review"].includes(dialog.kind) && !ackB;

  return <ModalFrame labelledBy={titleId} onClose={close} className={styles.dialog} backdropClassName={styles.backdrop} returnFocusRef={returnFocusRef}>
    <header className={styles.dialogHeader}><div><span className={styles.eyebrow}>{discard ? "UNSAVED DETAILS" : "PRIVATE FIELD NOTEBOOK"}</span><h2 id={titleId}>{discard ? "Close without saving these edits?" : titleText}</h2></div><button type="button" className={styles.iconButton} aria-label="Close notebook editor" onClick={close} disabled={busy || checking}><X size={20}/></button></header>
    {discard ? <div className={styles.discard}><p>{pending ? "The original submitted action still needs explicit recovery. Closing this editor does not cancel it or create a replacement." : "These unsaved form changes will be discarded. Saved observations and original evidence stay in the notebook."}</p><div className={styles.formActions}><button type="button" className={styles.secondary} ref={keepEditing} onClick={() => setDiscard(false)}>Keep editing</button><button type="button" className={styles.button} onClick={onClose}>Discard edits and close</button></div></div> : dialog.kind === "original" ? <><OriginalPreview asset={dialog.asset} runId={d!.runId} reviewer={d!.role === "reviewer"}/><footer className={styles.formActions}><button className={styles.secondary} onClick={close}>Close original</button></footer></> : <form ref={form} onSubmit={submit} onChange={changed}>
      {d && dialog.kind !== "create" && <div className={styles.exactScope}><LockKeyhole size={14}/><span>Edition {d.edition.number} · {benchShort(d.edition.hash)} · {d.edition.sourceMode === "sample" ? "Sample" : "operator-reported scope"}</span></div>}
      {(validation || error) && <div className={styles.inlineError} role="alert"><CircleAlert size={17}/><p>{validation || error}</p></div>}
      {pending && <p className={styles.warning}>This action has an unresolved saved outcome. Keep these details, or close the editor and deliberately recover the original action from the notebook status.</p>}

      {dialog.kind === "create" && <>
        <p className={styles.formIntro}>Start from an exact saved system. Record the equipment, original files and what happened without changing its existing model certificate.</p>
        <div className={styles.formGrid}><Field label="Saved system" wide><select value={subjectIndex} onChange={e => { const index = Number(e.target.value); setSubjectIndex(index); setTitle(`${home.subjects[index]?.title ?? ""} · field notebook`.slice(0, 120)); }}>{home.subjects.map((s, i) => <option key={`${s.subject.kind}:${s.subject.subjectId}:${s.subject.revisionId}`} value={i}>{s.title} · {s.kindLabel} · {s.componentCount} components</option>)}</select></Field>
          <Field label="Notebook title" wide><input required minLength={2} maxLength={120} value={title} onChange={e => setTitle(e.target.value)}/></Field>
          <Field label="Evidence mode" wide><select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="sample">Sample rehearsal · no physical execution claimed</option><option value="operator_recorded">Operator recording · independent review still required</option></select></Field></div>
        <Acknowledge checked={ackA} onChange={acknowledge(setAckA)}>A notebook records declared conditions and evidence. A file fingerprint or elapsed clock does not establish a physical test or human review.</Acknowledge>
      </>}

      {dialog.kind === "plan" && conditions && <>
        <p className={styles.formIntro}>Describe the exact setup before Start. A different model needs a new verified graph and notebook. Conditions freeze when recording starts.</p>
        <h3 className={styles.formSection}>Equipment on the bench</h3>
        {conditions.hardware.map((hardware, index) => <fieldset key={hardware.componentId} className={styles.hardwareForm}><legend>{hardware.model}</legend><div className={styles.formGrid}>
          <Field label={`${hardware.model} hardware revision`}><input required maxLength={120} value={hardware.revision} onChange={e => setConditions(c => c && ({ ...c, hardware: c.hardware.map((h, i) => i === index ? { ...h, revision: e.target.value } : h) }))}/></Field>
          <Field label={`${hardware.model} firmware`}><input required maxLength={160} value={hardware.firmware} onChange={e => setConditions(c => c && ({ ...c, hardware: c.hardware.map((h, i) => i === index ? { ...h, firmware: e.target.value } : h) }))}/></Field></div>
          <Acknowledge checked={hardware.matchesBoundModel} onChange={v => { changed(); setConditions(c => c && ({ ...c, hardware: c.hardware.map((h, i) => i === index ? { ...h, matchesBoundModel: v } : h) })); }}>This is the exact bound {hardware.model}, including its recorded revision.</Acknowledge>
        </fieldset>)}
        <h3 className={styles.formSection}>Operating conditions</h3><div className={styles.formGrid}>{conditionFields.map(f => <Field key={f.key} label={f.label} wide={f.wide}>{f.wide ? <textarea required={!["notes", "locationLabel"].includes(f.key)} maxLength={f.max} value={conditions[f.key]} onChange={e => setConditions(c => c && ({ ...c, [f.key]: e.target.value }))}/> : <input required={f.key !== "locationLabel"} maxLength={f.max} value={conditions[f.key]} onChange={e => setConditions(c => c && ({ ...c, [f.key]: e.target.value }))}/>}</Field>)}
          <Field label="Predeclared duration in seconds" hint="From 1 second to 24 hours. An early finish is retained."><input type="number" required min={1} max={86400} value={conditions.declaredSeconds} onChange={e => setConditions(c => c && ({ ...c, declaredSeconds: Number(e.target.value) }))}/></Field>
          <Field label="Reason for this condition edition" wide><input required minLength={3} maxLength={500} value={note} onChange={e => setNote(e.target.value)}/></Field></div>
      </>}

      {dialog.kind === "serial" && <><p className={styles.formIntro}>The plain serial is sent once for server sealing. Only its keyed fingerprint is returned. It is never placed in browser recovery storage.</p>{dialog.recovery && <p className={styles.warning}>Re-enter the exact original value to recover the same saved request. A changed value cannot replace that request.</p>}<div className={styles.formGrid}><Field label="Bound component" wide><select disabled={!!dialog.recovery} value={componentId} onChange={e => setComponentId(e.target.value)}>{d?.edition.binding.components.map(c => <option key={c.id} value={c.id}>{c.model}</option>)}</select></Field><Field label="Private serial" wide><input type="password" required minLength={2} maxLength={160} autoComplete="off" value={serial} onChange={e => setSerial(e.target.value)}/></Field></div></>}

      {dialog.kind === "start" && <><p className={styles.formIntro}>Freeze this exact equipment and setup for a declared {d?.edition.conditions.declaredSeconds}-second interval. Record interruptions and failures as they occur.</p><div className={styles.warning}><ShieldAlert size={18}/><p>The saved server start time is a clock record. It does not prove the equipment ran or that independent microphone tracks exist.</p></div><Acknowledge checked={ackA} onChange={acknowledge(setAckA)}>I checked the exact equipment and saved operating conditions.</Acknowledge><Acknowledge checked={ackB} onChange={acknowledge(setAckB)}>I will retain the original observations and files, including failures. This remains an operator report until separately reviewed.</Acknowledge></>}

      {dialog.kind === "observe" && <><p className={styles.formIntro}>Append what was actually observed. Earlier entries, including failures, remain in later editions.</p><div className={styles.formGrid}><Field label="Protocol step" wide><select value={stepId} onChange={e => setStepId(e.target.value)}>{d?.edition.binding.steps.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></Field><Field label="Reported outcome"><select value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)}><option value="uncertain">Uncertain / needs evidence</option><option value="observed_failure">Operator observed a failure</option><option value="observed_pass">Operator observed a pass</option><option value="not_performed">Not performed</option></select></Field><Field label="Observed at (UTC)" hint="Use the original observation time inside the recorded interval."><input required type="datetime-local" step="0.001" value={observedAt} onChange={e => setObservedAt(e.target.value)}/></Field><Field label="What you observed" wide><textarea required minLength={3} maxLength={4000} value={note} onChange={e => setNote(e.target.value)}/></Field></div></>}

      {dialog.kind === "finish" && <><p className={styles.formIntro}>Finish at the server's recorded time, even if the declared interval was interrupted or ended early. You can append an observation with its original time before sealing.</p><Field label="Finish note"><textarea required minLength={3} maxLength={2000} value={note} onChange={e => setNote(e.target.value)}/></Field></>}
      {dialog.kind === "seal" && <><p className={styles.formIntro}>Freeze this exact report for scoped review. It cannot reopen. Prepare a new notebook for another test or changed graph.</p><div className={styles.warning}><p>{d?.assessment.label}. {d?.assessment.reportedFailures} reported failures and {d?.assessment.missing.length} evidence gaps stay visible. Sealing is not a passing-test badge.</p></div><Acknowledge checked={ackA} onChange={acknowledge(setAckA)}>This immutable manifest records reported evidence and its limitations. Existing model certificates remain unchanged.</Acknowledge></>}
      {dialog.kind === "sample" && <><p className={styles.formIntro}>Create an isolated-tone WAV, a mix WAV and a diagram PNG. Each original then needs an explicit byte check and a separate attachment to a step.</p><Acknowledge checked={ackA} onChange={acknowledge(setAckA)}>These files are generated Sample material. They prove no equipment operation, microphone independence or actual human review.</Acknowledge></>}

      {dialog.kind === "upload" && <>
        <p className={styles.formIntro}>First save the file's exact upload intent and dated rights. Send that file explicitly, check its original bytes, then link it to a step. Nothing attaches automatically.</p>
        <div className={styles.filePicker}><FileUp size={25}/><Field label="Choose original file"><input type="file" required accept=".wav,.mp3,.mp4,.webm,.png,.jpg,.jpeg,.pdf" onChange={e => chooseFile(e.target.files?.[0])}/></Field>{file && <p>{file.name} · {benchBytes(file.size)}{file.size > BENCH_MAX_BYTES ? " · exceeds 512 MiB limit" : ""}</p>}</div>
        <div className={styles.formGrid}><Field label="Evidence kind"><select value={kind} onChange={e => setKind(e.target.value as BenchFileKind)}>{fileKinds.map(k => <option key={k} value={k}>{fileKindLabel(k)}</option>)}</select></Field><Field label="Declared media type"><select value={mediaType} onChange={e => setMediaType(e.target.value as typeof mediaType)}>{mediaTypes.map(v => <option key={v} value={v}>{v}</option>)}</select></Field><Field label="Source provenance"><select value={provenance} onChange={e => setProvenance(e.target.value as typeof provenance)}><option value="operator_original">Operator-declared original</option><option value="third_party">Third-party original</option><option value="model_export">Model export</option><option value="sample_generated">Generated Sample</option></select></Field><Field label="Expected SHA256 (optional)" hint="Leave blank if unknown. Large files are not read into memory for a client hash."><input maxLength={64} pattern="[a-f0-9]{64}" value={expectedHash} onChange={e => setExpectedHash(e.target.value)}/></Field></div>
        <h3 className={styles.formSection}>Dated permission for these bytes</h3><div className={styles.formGrid}><Field label="Permission basis"><select value={rightsBasis} onChange={e => setRightsBasis(e.target.value as typeof rightsBasis)}><option value="original_creator">Original creator</option><option value="written_permission">Written permission</option><option value="sample_generated">Generated Sample</option></select></Field><Field label="Rights holder"><input required minLength={2} maxLength={200} value={holder} onChange={e => setHolder(e.target.value)}/></Field><Field label="Permission reference" wide><input required minLength={3} maxLength={1000} value={permission} onChange={e => setPermission(e.target.value)}/></Field><Field label="Permission granted at (UTC)"><input required type="datetime-local" step="0.001" value={grantedAt} onChange={e => setGrantedAt(e.target.value)}/></Field><Field label="Permission expires at (UTC, optional)"><input type="datetime-local" step="0.001" value={expiresAt} onChange={e => setExpiresAt(e.target.value)}/></Field><Field label="Attribution (optional)" wide><input maxLength={500} value={attribution} onChange={e => setAttribution(e.target.value)}/></Field><Field label="Restrictions (optional)" wide><textarea maxLength={4000} value={limits} onChange={e => setLimits(e.target.value)}/></Field></div>
        <Acknowledge checked={people} onChange={acknowledge(setPeople)}>The file contains identifiable people.</Acknowledge>{people && <Acknowledge checked={participantConsent} onChange={acknowledge(setParticipantConsent)}>The participants permitted this private review.</Acknowledge>}
        <Acknowledge checked={publicAllowed} onChange={acknowledge(setPublicAllowed)}>Public sharing is permitted by these rights. This records permission only; it publishes nothing.</Acknowledge>
        <Acknowledge checked={ackA} onChange={acknowledge(setAckA)}>I have permission for this exact file to be stored and inspected in private review.</Acknowledge>
      </>}

      {dialog.kind === "send" && <><p className={styles.formIntro}>Send the original to its already scoped private path. No new intent is created. A lost response is checked against this original upload.</p><div className={styles.exactFile}><FileUp size={22}/><div><b>{dialog.upload.file.filename}</b><p>{benchBytes(dialog.upload.file.bytes)} · {dialog.upload.file.mediaType}</p></div></div><Field label="Exact file for this upload"><input type="file" accept=".wav,.mp3,.mp4,.webm,.png,.jpg,.jpeg,.pdf" onChange={e => chooseFile(e.target.files?.[0])}/></Field><p className={styles.smallPrint}>{file ? `Selected: ${file.name} · ${benchBytes(file.size)}` : "Select the exact file again after a reload. Its bytes are not stored in browser recovery."}</p></>}
      {dialog.kind === "attach" && <><p className={styles.formIntro}>Link the checked original <b>{dialog.asset.filename}</b> to one compatible protocol step. Its fingerprint is retained in this exact edition.</p><div className={styles.formGrid}><Field label="Supported protocol step" wide><select value={stepId} onChange={e => setStepId(e.target.value)}>{d?.edition.binding.steps.filter(s => s.evidenceKinds.includes(dialog.asset.kind)).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></Field><Field label="What this original supports" wide><textarea required minLength={3} maxLength={1000} value={note} onChange={e => setNote(e.target.value)}/></Field></div></>}
      {dialog.kind === "withdraw" && <><p className={styles.formIntro}>Private access to <b>{dialog.asset.filename}</b> will stop immediately. Original deletion is then attempted. A failed deletion stays withdrawn; the retained fingerprint and earlier decisions are not erased.</p><Field label="Withdrawal reason"><textarea required minLength={8} maxLength={1000} value={note} onChange={e => setNote(e.target.value)}/></Field><Acknowledge checked={ackA} onChange={acknowledge(setAckA)}>The immutable manifest and fingerprint stay in history, while this unavailable original cannot support a current review.</Acknowledge></>}
      {dialog.kind === "remove_upload" && <><p className={styles.formIntro}>Remove private access to <b>{dialog.upload.file.filename}</b>, even if its type or hash was rejected before an asset existed. Deletion is attempted and any failure remains visible.</p><Field label="Upload removal reason"><textarea required minLength={8} maxLength={1000} value={note} onChange={e => setNote(e.target.value)}/></Field><Acknowledge checked={ackA} onChange={acknowledge(setAckA)}>The original upload intent, rejection and any retained fingerprint stay in history. Removed bytes cannot be verified or attached.</Acknowledge></>}

      {dialog.kind === "invite" && <><p className={styles.formIntro}>Give one person access to this exact sealed edition and its permitted originals. An invitation does not establish identity, expertise or independence.</p><div className={styles.formGrid}><Field label="Reviewer identity" wide><select value={reviewerId} onChange={e => setReviewerId(e.target.value)}><option value="">Register a new unqualified person or Sample reviewer</option>{home.reviewers.map(r => <option key={r.id} value={r.id}>{r.name} · {r.provenance === "sample" ? "Sample" : r.qualification === "current" ? "Currently qualified" : r.qualification === "expired" ? "Qualification expired" : "Qualification unestablished"}</option>)}</select></Field>{!reviewerId && <><Field label="Reviewer name"><input required minLength={2} maxLength={100} value={reviewerName} onChange={e => setReviewerName(e.target.value)}/></Field><Field label="Reviewer provenance"><select value={reviewerProvenance} onChange={e => setReviewerProvenance(e.target.value as typeof reviewerProvenance)}><option value="human">Human · qualification unestablished</option><option value="sample">Sample person · no actual human review</option></select></Field></>}<Field label="Invitation duration in hours" hint="The server also enforces current authority and original expiry."><input required type="number" min={1} max={72} value={hours} onChange={e => setHours(Number(e.target.value))}/></Field></div><Acknowledge checked={ackA} onChange={acknowledge(setAckA)}>This is private, exact-edition review only. I will deliberately copy or open the masked invitation; nothing is sent to anyone.</Acknowledge></>}
      {dialog.kind === "revoke" && <><p className={styles.formIntro}>Revoke {dialog.grant.name}'s invitation to edition {d?.edition.number}. It currently ends {benchTime(dialog.grant.expiresAt)}.</p><p>Earlier decisions and contradictions stay in history. Current support can lose its authority after revocation.</p></>}

      {dialog.kind === "review" && <><p className={styles.formIntro}>{reviewerExercise ? "This is a Sample review exercise. It cannot increase actual qualified reviews or establish a physical test." : "Review only this exact immutable report, original files and declared conditions. Record contradictions and limits in your own decision."}</p><div className={styles.formGrid}><Field label="Review outcome" wide><select value={decision} onChange={e => setDecision(e.target.value as typeof decision)}><option value="needs_evidence">Needs more evidence</option><option value="contradiction">Contradiction found</option><option value="supports_reported_scope">Supports the exact reported scope</option></select></Field><Field label="Review finding" wide><textarea required minLength={20} maxLength={5000} value={note} onChange={e => setNote(e.target.value)}/></Field><Field label="Review limitations" wide><textarea required minLength={10} maxLength={3000} value={limits} onChange={e => setLimits(e.target.value)}/></Field></div><fieldset className={styles.inspected}><legend>Which exact originals did you inspect?</legend>{availableAssets.map(a => <div key={a.id}><label><input type="checkbox" checked={inspected.includes(a.id)} onChange={e => setInspected(ids => e.target.checked ? [...ids, a.id] : ids.filter(id => id !== a.id))}/><span>{a.filename}<small>{benchShort(a.sha256)} · {fileKindLabel(a.kind)}</small></span></label><a href={benchOriginalUrl(a.id, d!.runId, true)} target="_blank" rel="noreferrer">Open original</a></div>)}{!availableAssets.length && <p>No currently permitted originals are attached. A review cannot fill that gap with a badge.</p>}</fieldset><Acknowledge checked={ackA} onChange={acknowledge(setAckA)}>I inspected the selected exact original files, rather than relying on waveform meters or filenames.</Acknowledge><Acknowledge checked={ackB} onChange={acknowledge(setAckB)}>I reviewed the exact equipment, software, interval and reported limitations. My decision applies only to this manifest.</Acknowledge></>}

      <footer className={styles.formActions}><button type="button" className={styles.secondary} onClick={close} disabled={busy || checking}>Cancel</button><button className={styles.button} type="submit" disabled={disabled || dialog.kind === "send" && !file || dialog.kind === "review" && !inspected.length}>{busy ? "Saving the original action…" : checking ? "Refreshing current authority…" : submitLabel}<ArrowRight size={15}/></button></footer>
    </form>}
  </ModalFrame>;
}
