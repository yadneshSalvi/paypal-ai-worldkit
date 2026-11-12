"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Activity, ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Check, ChevronRight, CircleAlert, Clipboard, Clock3, FileCheck2, FileClock, FileUp, Fingerprint, FlaskConical, History, Link2, LockKeyhole, NotebookPen, Plus, RefreshCw, ShieldAlert, ShieldCheck, UserRoundCheck, X } from "lucide-react";
import { BenchCommandSchema, type BenchCommand, type BenchCommandResult, type BenchHome, type BenchUpload } from "../../packages/physical-notebook/contracts";
import { ModalFrame } from "./modal";
import { Assessment, BenchWaveform, BoundSystem, fileKindLabel, originalAvailable, OriginalIcon, provenanceLabel } from "./physical-notebook-evidence";
import { NotebookActionDialog, type NotebookDialog } from "./physical-notebook-dialogs";
import { benchBytes, benchContextKey, benchEndpoint, benchExportUrl, benchHomePath, benchOriginalUrl, benchRequest, BenchRequestError, benchShort, benchTime, clearBenchPending, commandRecovery, readBenchPending, replaceBenchUploadCheck, saveBenchPending, sendBenchOriginal, type BenchCommandBody, type PendingBenchAction } from "./physical-notebook-client";
import styles from "./physical-notebook.module.css";

type Tab = "protocol" | "conditions" | "originals" | "review" | "history";
const tabs: { id: Tab; label: string; icon: typeof BookOpen }[] = [
  { id: "protocol", label: "Protocol", icon: NotebookPen }, { id: "conditions", label: "Conditions", icon: AudioLines },
  { id: "originals", label: "Original files", icon: FileUp }, { id: "review", label: "Review", icon: UserRoundCheck }, { id: "history", label: "History", icon: History },
];
type Invitation = { workspaceKey: string; runId: string; grantId: string; token: string; name: string; expiresAt: string };
const cleanError = (error: unknown) => error instanceof Error ? error.message : "The notebook could not complete this request.";
const actionName = (pending: PendingBenchAction) => pending.mode === "private_serial" ? "private serial save" : pending.mode === "upload_check" ? "original upload" : pending.command.kind.replaceAll("_", " ");

function RecordedClock({ startedAt, duration }: { startedAt: string; duration: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [startedAt]);
  const elapsed = now === null ? null : Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return <div className={styles.clock}><Clock3 size={17}/><div><strong>{elapsed === null ? "—" : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}</strong><span>browser estimate / {duration} s declared</span></div><small>Saved start: {benchTime(startedAt)}. A clock is not physical evidence.</small></div>;
}

export function PhysicalNotebook({ reviewer = false }: { reviewer?: boolean }) {
  const [home, setHome] = useState<BenchHome | null>(null); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [readIssue, setReadIssue] = useState(false);
  const [pending, setPending] = useState<PendingBenchAction | null>(null); const [storageIssue, setStorageIssue] = useState("");
  const [tab, setTab] = useState<Tab>(reviewer ? "review" : "protocol"); const [dialog, setDialog] = useState<NotebookDialog | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null); const [invitationOpen, setInvitationOpen] = useState(false); const [copied, setCopied] = useState(false);
  const [redeemReady, setRedeemReady] = useState(false); const [redeemPending, setRedeemPending] = useState(false);
  const mounted = useRef(true); const generation = useRef(0); const busyRef = useRef(false); const reading = useRef(true);
  const homeRef = useRef<BenchHome | null>(null); const dialogRef = useRef<NotebookDialog | null>(null); dialogRef.current = dialog;
  const pendingRef = useRef<PendingBenchAction | null>(null); const storageIssueRef = useRef(""); const readIssueRef = useRef(false);
  const roleRef = useRef(reviewer); roleRef.current = reviewer;
  const initial = useRef<{ reviewer: boolean; promise: Promise<BenchHome> } | null>(null);
  const redeem = useRef<{ invitation: string; requestId?: string } | null>(null);
  const files = useRef(new Map<string, File>());
  const focusHeading = useRef(false); const focusError = useRef(false); const noticeElement = useRef<HTMLDivElement>(null); const heading = useRef<HTMLHeadingElement>(null); const root = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null); const baseId = useId();
  const setRecovery = (value: PendingBenchAction | null) => { pendingRef.current = value; setPending(value); };
  const setReadFailure = (value: boolean) => { readIssueRef.current = value; setReadIssue(value); };
  const setStorageFailure = (value: string) => { storageIssueRef.current = value; if (value) focusError.current = true; setStorageIssue(value); };

  function clearPrivateView() {
    homeRef.current = null; setHome(null); dialogRef.current = null; setDialog(null); setInvitation(null); setInvitationOpen(false); files.current.clear(); setRecovery(null);
  }
  function accept(value: BenchHome, focus = false) {
    if (!value || typeof value.workspaceKey !== "string" || !Array.isArray(value.runs) || !Array.isArray(value.subjects) || !Array.isArray(value.reviewers) || value.selected && value.selected.role !== (roleRef.current ? "reviewer" : "owner")) throw new Error("The notebook response has a different access scope. Refresh its original access.");
    if (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) throw new BenchRequestError("This notebook access has ended. The original expiry has not been renewed.", "access_expired", 403);
    const before = homeRef.current; const changed = !before || benchContextKey(before) !== benchContextKey(value);
    if (changed) { dialogRef.current = null; setDialog(null); setInvitation(null); setInvitationOpen(false); setCopied(false); files.current.clear(); }
    if (before && before.workspaceKey !== value.workspaceKey) { setNotice(""); setError(""); setTab(roleRef.current ? "review" : "protocol"); }
    homeRef.current = value; setHome(value); setReadFailure(false); focusHeading.current = focus;
    try { setRecovery(readBenchPending(window.sessionStorage, value.workspaceKey, roleRef.current)); setStorageFailure(""); }
    catch (failure) { setRecovery(null); setStorageFailure(cleanError(failure)); }
    if (!roleRef.current) {
      const url = new URL(window.location.href);
      if (value.selected) url.searchParams.set("runId", value.selected.runId); else url.searchParams.delete("runId");
      if (value.selected?.historical) url.searchParams.set("editionId", value.selected.edition.id); else url.searchParams.delete("editionId");
      window.history.replaceState(window.history.state, "", url);
    }
  }
  const read = useCallback(async (runId?: string, editionId?: string, focus = false) => {
    const epoch = ++generation.current;
    try {
      const value = await benchRequest<BenchHome>(benchHomePath(reviewer, runId, editionId));
      if (mounted.current && epoch === generation.current) accept(value, focus);
      return value;
    } catch (failure) {
      if (mounted.current && epoch === generation.current) {
        setReadFailure(true);
        if (failure instanceof BenchRequestError && [401, 403, 404].includes(failure.status ?? 0)) { focusError.current = !!homeRef.current; clearPrivateView(); }
      }
      throw failure;
    }
  }, [reviewer]);

  useEffect(() => {
    mounted.current = true; reading.current = true; setLoading(true);
    const epoch = ++generation.current;
    if (initial.current?.reviewer !== reviewer) {
      clearPrivateView(); setError(""); setNotice(""); setTab(reviewer ? "review" : "protocol");
      if (reviewer) {
        const url = new URL(window.location.href); const fragment = new URLSearchParams(url.hash.slice(1)); const token = fragment.get("invite");
        if (url.hash) { url.hash = ""; window.history.replaceState(window.history.state, "", url); }
        if (token && /^wkbi_[A-Za-z0-9_-]{43}$/.test(token)) { redeem.current = { invitation: token }; setRedeemReady(true); }
      }
      const url = new URL(window.location.href);
      initial.current = { reviewer, promise: benchRequest<BenchHome>(benchHomePath(reviewer, reviewer ? undefined : url.searchParams.get("runId") ?? undefined, reviewer ? undefined : url.searchParams.get("editionId") ?? undefined)) };
    }
    initial.current.promise.then(value => { if (mounted.current && epoch === generation.current) { accept(value); if (!redeem.current) setRedeemReady(false); } }).catch(failure => { if (mounted.current && epoch === generation.current) { setError(cleanError(failure)); setReadFailure(true); } }).finally(() => { if (mounted.current && epoch === generation.current) { reading.current = false; setLoading(false); } });
    return () => { mounted.current = false; generation.current++; };
  }, [reviewer]);

  async function refresh(runId = homeRef.current?.selected?.runId, editionId?: string, focus = true) {
    if (busyRef.current || reading.current) return;
    reading.current = true; setLoading(true);
    try { await read(runId, editionId, focus); if (mounted.current && !pendingRef.current) setError(""); }
    catch (failure) { if (mounted.current) setError(cleanError(failure)); }
    finally { reading.current = false; if (mounted.current) setLoading(false); }
  }
  function selectReport(runId: string, editionId?: string) {
    if (busyRef.current || reading.current) return;
    setNotice("");
    void refresh(runId, editionId);
  }
  useEffect(() => {
    const check = () => { if (document.visibilityState === "visible") void refresh(undefined, homeRef.current?.selected?.historical ? homeRef.current.selected.edition.id : undefined, false); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [read]);
  useEffect(() => {
    if (!home) return;
    const expiries = [home.expiresAt, ...home.selected?.assets.map(a => a.rights.expiresAt).filter((s): s is string => !!s) ?? [], ...home.selected?.grants.filter(g => g.status !== "revoked").map(g => g.expiresAt) ?? []].map(Date.parse).filter(v => v > Date.now());
    if (!expiries.length) return;
    const timer = setTimeout(() => { setDialog(null); dialogRef.current = null; setInvitationOpen(false); void refresh(undefined, homeRef.current?.selected?.historical ? homeRef.current.selected.edition.id : undefined, false); }, Math.min(2_147_000_000, Math.max(1, Math.min(...expiries) - Date.now() + 10)));
    return () => clearTimeout(timer);
  }, [home]);
  useEffect(() => {
    if (dialog || invitationOpen || busy || loading) return;
    const target = focusError.current && (error || storageIssue) ? noticeElement.current : focusHeading.current ? heading.current : null;
    if (!target) return;
    focusHeading.current = false; focusError.current = false;
    queueMicrotask(() => { if (mounted.current && !dialogRef.current && !busyRef.current && !reading.current && target.isConnected) target.focus(); });
  }, [home, dialog, invitationOpen, busy, loading, error, storageIssue]);

  function open(next: NotebookDialog) {
    if (!homeRef.current || busyRef.current || reading.current || pendingRef.current || storageIssueRef.current || readIssueRef.current) return;
    returnFocus.current = document.activeElement as HTMLElement; dialogRef.current = next; setDialog(next); setError("");
  }
  const closeDialog = () => { if (!busyRef.current && !reading.current) { dialogRef.current = null; setDialog(null); } };

  async function execute(body: BenchCommandBody | BenchCommand, recovering = false, chosenFile?: File) {
    const scope = homeRef.current;
    if (!scope || busyRef.current || reading.current || storageIssueRef.current || readIssueRef.current || pendingRef.current && !recovering) return;
    let command: BenchCommand;
    try { command = BenchCommandSchema.parse("requestId" in body ? body : { ...body, requestId: crypto.randomUUID() }); }
    catch (failure) { setError(cleanError(failure)); return; }
    if (reviewer && command.kind !== "review" || !reviewer && command.kind === "review") { setError("This command is outside the current notebook role."); return; }
    const entry = commandRecovery(scope.workspaceKey, reviewer, command);
    try { saveBenchPending(window.sessionStorage, entry); }
    catch (failure) { setStorageFailure(cleanError(failure)); return; }
    busyRef.current = true; setBusy(true); setRecovery(entry); setError(""); setNotice("");
    const epoch = generation.current;
    try {
      const result = await benchRequest<BenchCommandResult>(benchEndpoint(reviewer), command);
      if (!mounted.current || epoch !== generation.current || homeRef.current?.workspaceKey !== scope.workspaceKey) return;
      const value = await read(result.runId, undefined, true);
      if (!mounted.current || homeRef.current?.workspaceKey !== scope.workspaceKey || value.workspaceKey !== scope.workspaceKey) return;
      clearBenchPending(window.sessionStorage, entry); setRecovery(null); setDialog(null); dialogRef.current = null;
      if (result.upload && chosenFile) files.current.set(`${scope.workspaceKey}:${result.runId}:${result.upload.id}`, chosenFile);
      setNotice(command.kind === "upload_intent" ? "Upload intent saved. Send the exact file, check its bytes, then link it explicitly." : command.kind === "verify_upload" ? "The original byte-check response was retained. Inspect the current file status; nothing was attached automatically." : command.kind === "sample_originals" ? "Three generated Sample upload intents were saved. Check each original before linking it to a protocol step." : recovering ? "The original action was recovered. Its original identity and later history are retained." : "Saved to the original notebook. The current report is shown below.");
      if (result.grant?.invitation && value.selected?.runId === result.runId && value.selected.grants.some(g => g.id === result.grant!.id && g.status !== "revoked")) {
        returnFocus.current = heading.current;
        setInvitation({ workspaceKey: scope.workspaceKey, runId: result.runId, grantId: result.grant.id, token: result.grant.invitation, name: result.grant.name, expiresAt: result.grant.expiresAt }); setCopied(false); setInvitationOpen(true);
      }
    } catch (failure) {
      if (!mounted.current || homeRef.current && homeRef.current.workspaceKey !== scope.workspaceKey) return;
      const ambiguous = !(failure instanceof BenchRequestError) || !failure.status || failure.status >= 500 || failure.status === 408;
      if (!ambiguous && !recovering) { try { clearBenchPending(window.sessionStorage, entry); setRecovery(null); } catch (storageFailure) { setStorageFailure(cleanError(storageFailure)); } }
      focusError.current = true; setError(`${cleanError(failure)}${ambiguous || recovering ? " Recover the saved original action deliberately; no replacement has been sent." : ""}`);
      if (failure instanceof BenchRequestError && [401, 403].includes(failure.status ?? 0)) clearPrivateView();
      else if (failure instanceof BenchRequestError && failure.status === 409) setReadFailure(true);
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function sendOriginal(upload: BenchUpload, file: File) {
    const scope = homeRef.current;
    if (!scope || reviewer || busyRef.current || reading.current || pendingRef.current || storageIssueRef.current || readIssueRef.current || scope.selected?.runId !== upload.runId || upload.generatedSample !== false) return;
    if (scope.selected.uploads.find(current => current.id === upload.id)?.generatedSample !== false) return;
    const entry: PendingBenchAction = { version: 1, workspaceKey: scope.workspaceKey, reviewer: false, mode: "upload_check", runId: upload.runId, uploadId: upload.id };
    try { saveBenchPending(window.sessionStorage, entry); } catch (failure) { setStorageFailure(cleanError(failure)); return; }
    busyRef.current = true; setBusy(true); setRecovery(entry); setError("");
    const epoch = generation.current;
    try {
      await sendBenchOriginal(upload, file, upload.runId);
      if (!mounted.current || epoch !== generation.current) return;
      const value = await read(upload.runId, undefined, true);
      if (!mounted.current || value.workspaceKey !== scope.workspaceKey) return;
      clearBenchPending(window.sessionStorage, entry); setRecovery(null); setDialog(null); dialogRef.current = null;
      setNotice("The original upload was acknowledged. Check its bytes next; it is not yet evidence attached to the report.");
    } catch (failure) { if (mounted.current) setError(`${cleanError(failure)} Check this original upload. Its PUT has not been repeated and no new intent was created.`); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  function recoverAction() {
    const entry = pendingRef.current; if (!entry || busyRef.current || reading.current) return;
    if (entry.mode === "command") void execute(entry.command, true);
    else if (entry.mode === "private_serial") { returnFocus.current = document.activeElement as HTMLElement; const next: NotebookDialog = { kind: "serial", recovery: entry.identity }; dialogRef.current = next; setDialog(next); setError(""); }
    else {
      const command: BenchCommand = { kind: "verify_upload", requestId: crypto.randomUUID(), runId: entry.runId, uploadId: entry.uploadId };
      const next = commandRecovery(entry.workspaceKey, false, command);
      try { replaceBenchUploadCheck(window.sessionStorage, entry, next); setRecovery(next); void execute(command, true); }
      catch (failure) { setStorageFailure(cleanError(failure)); }
    }
  }
  async function redeemInvitation() {
    if (!redeem.current || busyRef.current || reading.current) return;
    busyRef.current = true; setBusy(true); setError(""); redeem.current.requestId ??= crypto.randomUUID();
    const original = { ...redeem.current };
    try {
      const result = await benchRequest<{ runId: string; expiresAt: string }>("/api/physical-notebook/redeem", original);
      if (!mounted.current || redeem.current?.requestId !== original.requestId) return;
      await read(result.runId, undefined, true);
      if (mounted.current) { redeem.current = null; setRedeemReady(false); setRedeemPending(false); setNotice("The original scoped reviewer access is open. Its fixed expiry is retained."); setError(""); }
    } catch (failure) { if (mounted.current) { setRedeemPending(true); setError(`${cleanError(failure)} Keep this tab open to retry its same in-memory redemption. Reload cannot recreate that original request.`); } }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  function invitationUrl() { if (!invitation || invitation.workspaceKey !== homeRef.current?.workspaceKey) return null; return `${window.location.origin}/bench/review#invite=${encodeURIComponent(invitation.token)}`; }
  async function copyInvitation() { const url = invitationUrl(); if (!url) return; try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setError("Clipboard access was unavailable. Use the deliberate Open reviewer room action instead."); } }

  const d = home?.selected; const edition = d?.edition;
  const locked = busy || loading || !!pending || !!storageIssue || readIssue;
  const owner = !!d && !reviewer && d.role === "owner"; const currentOwner = !!d && owner && !d.historical;
  const editable = currentOwner && edition?.phase !== "sealed";
  const canStart = currentOwner && edition?.phase === "planning" && !!edition.declaredAt && !edition.conditions.hardware.some(h => !h.matchesBoundModel) && d.subjectCurrent;
  const canReview = !!d && reviewer && d.role === "reviewer" && !d.historical && edition?.phase === "sealed" && !!d.reviewer && (d.reviewer.provenance === "sample" || d.reviewer.qualified) && !d.decisions.some(decision => d.grants.some(grant => grant.id === decision.grantId)) && d.assets.some(a => originalAvailable(a) && edition.attachments.some(l => l.assetId === a.id && l.assetHash === a.sha256));
  const submit = (body: BenchCommandBody | BenchCommand, file?: File) => void execute(body, !!pendingRef.current && "requestId" in body, file);

  return <section ref={root} className={styles.shell} aria-label={reviewer ? "Physical notebook reviewer room" : "Physical test notebook"}>
    <header className={styles.hero}><div><span className={styles.kicker}><span/>WORLDKIT FIELD NOTES <b>{reviewer ? "PRIVATE REVIEW" : "PHYSICAL NOTEBOOK"}</b></span><h1>{reviewer ? <>A careful review.<br/>An exact <em>scope.</em></> : <>Keep the originals.<br/>Record the <em>conditions.</em></>}</h1><p>{reviewer ? "Inspect one sealed report, the original files and the conditions behind every claim. Keep contradictions and limits in view." : "Take a saved system to the bench. Retain what you tried, what happened, and the evidence a reviewer can inspect."}</p></div><div className={styles.notebookArt} aria-hidden="true"><span className={styles.artRule}/><div className={styles.artPaper}><span>FIELD NOTEBOOK / {edition ? String(edition.number).padStart(2, "0") : "01"}</span><NotebookPen size={40}/><b>Every condition.<br/>Every original.</b><i/><i/><small>CONDITIONS · OBSERVATIONS · REVIEW</small></div><div className={styles.artSeal}><Fingerprint size={25}/><span>EXACT SYSTEM</span></div></div></header>
    <div className={styles.boundary}><ShieldCheck size={18}/><p><b>Three kinds of evidence, kept clear.</b> Model verification, operator observations and qualified independent review have distinct scopes. A file hash or timer proves neither physical execution nor microphone independence. Existing certificates remain unchanged.</p></div>
    <div ref={noticeElement} tabIndex={-1} className={`${styles.notice} ${error || storageIssue ? styles.noticeError : ""}`} role={error || storageIssue ? "alert" : "status"} aria-live="polite" hidden={!error && !notice && !pending && !storageIssue}>
      <CircleAlert size={19}/><div><p>{storageIssue || error || notice || `The original ${pending ? actionName(pending) : "action"} needs its saved outcome recovered.`}</p>{pending && <small>A retained action is waiting. Reloading or refreshing never resends it automatically.</small>}</div>
      {pending && home && <button className={styles.secondary} disabled={busy || loading || !!storageIssue || readIssue} onClick={recoverAction}>{pending.mode === "upload_check" ? "Check that original upload" : "Recover the original action"}<RefreshCw size={14}/></button>}
      {(error || storageIssue) && <button className={styles.textButton} disabled={busy || loading} onClick={() => void refresh()}>Refresh current access<RefreshCw size={14}/></button>}
    </div>

    {reviewer && home && redeemReady && <div className={styles.stateBanner}><LockKeyhole size={19}/><p>A different private invitation is ready in this tab. Current access below stays on its original scope until you explicitly open that invitation.</p><button className={styles.secondary} disabled={busy || loading} onClick={() => void redeemInvitation()}>{redeemPending ? "Recover this invitation redemption" : "Open the private invitation"}<ArrowRight size={14}/></button></div>}
    {!home ? loading ? <div className={styles.loading} role="status"><RefreshCw size={23}/><h2>Opening the private notebook…</h2><p>Reading current access. No notebook or workspace is being created.</p></div> : <div className={styles.welcome}><span className={styles.welcomeIcon}>{reviewer ? <LockKeyhole size={35}/> : <BookOpen size={35}/>}</span><h2>{reviewer ? "Your private reviewer room" : "Reopen your saved notebook"}</h2><p>{reviewer ? redeemReady ? "A private invitation was read into this tab and removed from its address. Opening it is an explicit action; it does not establish reviewer qualification." : "Use a private invitation from the notebook owner. An interrupted redemption can be recovered only in its still-open tab with its original in-memory request." : "Current workspace access is required. This page does not create a new workspace, extend a session or replace ended access."}</p>{reviewer && redeemReady ? <button className={styles.button} disabled={busy || loading} onClick={() => void redeemInvitation()}>{redeemPending ? "Recover this invitation redemption" : "Open the private invitation"}<ArrowRight size={16}/></button> : <button className={styles.secondary} disabled={busy || loading} onClick={() => void refresh()}>Check original access<RefreshCw size={15}/></button>}</div> : <>
      <div className={styles.toolbar}><div><span className={styles.eyebrow}>{reviewer ? "SCOPED REVIEWER ACCESS" : "YOUR SAVED NOTEBOOKS"}</span><p>Access ends {benchTime(home.expiresAt)}</p></div><div className={styles.toolbarActions}>{!reviewer && <button className={styles.button} disabled={locked || !home.subjects.length} onClick={() => open({ kind: "create" })}><Plus size={16}/>New notebook</button>}<button className={styles.secondary} disabled={busy || loading} onClick={() => void refresh(undefined, d?.historical ? d.edition.id : undefined)} aria-label="Refresh the notebook and current authority"><RefreshCw size={15}/>{loading ? "Refreshing…" : "Refresh"}</button></div></div>
      {!d ? <div className={styles.empty}><BookOpen size={40}/><span className={styles.eyebrow}>A SYSTEM WITH A MEMORY</span><h2>{home.subjects.length ? "Start from a saved system." : "Save a system before testing it."}</h2><p>{home.subjects.length ? "Choose an exact graph, declare the equipment and conditions, then retain your original evidence. Nothing is recorded until you choose to begin." : "The creator workbench and domain packs supply the exact systems this notebook can bind. This page creates no equipment or test result."}</p>{home.subjects.length > 0 && <button className={styles.button} disabled={locked} onClick={() => open({ kind: "create" })}>Choose a saved system<ArrowRight size={16}/></button>}</div> : <>
        {home.runs.length > 1 && !reviewer && <label className={styles.switcher}>Saved notebook<select value={d.runId} disabled={busy || loading} onChange={e => selectReport(e.target.value)}>{home.runs.map(r => <option key={r.id} value={r.id}>{r.title} · {r.sourceMode === "sample" ? "Sample" : "Operator"} · {r.phase} · v{r.version}</option>)}</select></label>}
        <header className={styles.reportHeading}><div><span className={styles.eyebrow}>{edition!.sourceMode === "sample" ? "GENERATED SAMPLE REHEARSAL" : "OPERATOR EVIDENCE NOTEBOOK"}</span><h2 ref={heading} tabIndex={-1} aria-describedby={`${baseId}-edition`}>{edition!.title}</h2><p id={`${baseId}-edition`}>Edition {edition!.number} · {d.historical ? "Historical edition · read only" : "Current saved report"} · {edition!.phase} · <span title={edition!.hash}>{benchShort(edition!.hash)}</span></p></div><span className={`${styles.phase} ${edition!.phase === "sealed" ? styles.sealed : ""}`}><span/>{edition!.phase === "sealed" ? "Sealed report" : edition!.phase === "running" ? "Recording observations" : edition!.phase === "recorded" ? "Interval retained" : "Planning"}</span></header>
        {d.historical && <div className={styles.stateBanner}><FileClock size={19}/><p>Earlier evidence is retained exactly. Current rights and access still govern its originals.</p><button className={styles.textButton} disabled={busy || loading} onClick={() => selectReport(d.runId)}>Return to current report<ArrowRight size={14}/></button></div>}
        {!d.subjectCurrent && <div className={`${styles.stateBanner} ${styles.warning}`}><ShieldAlert size={20}/><div><b>The saved system's current basis has changed.</b><ul>{d.subjectIssues.map((s, i) => <li key={i}>{s}</li>)}</ul><p>This immutable report keeps its original graph and conditions. Prepare a new report for the changed system.</p></div></div>}
        {readIssue && <p className={styles.warning}>Current authority could not be refreshed. This retained view is read only until a successful current read.</p>}
        <BoundSystem detail={d}/>
        <div className={styles.tabs} role="tablist" aria-label="Notebook sections" onKeyDown={e => { const i = tabs.findIndex(t => t.id === tab); const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1; if (next !== -1) { e.preventDefault(); const id = tabs[next]!.id; setTab(id); document.getElementById(`${baseId}-tab-${id}`)?.focus(); } }}>{tabs.map(t => <button key={t.id} id={`${baseId}-tab-${t.id}`} role="tab" aria-controls={`${baseId}-panel-${t.id}`} aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)}><t.icon size={16}/>{t.label}{t.id === "originals" && <small>{d.assets.length}</small>}</button>)}</div>
        {tabs.filter(item => item.id !== tab).map(item => <div key={item.id} role="tabpanel" id={`${baseId}-panel-${item.id}`} aria-labelledby={`${baseId}-tab-${item.id}`} hidden/>)}
        <div className={styles.reportGrid}>
          <div role="tabpanel" className={styles.panel} id={`${baseId}-panel-${tab}`} aria-labelledby={`${baseId}-tab-${tab}`}>
            {tab === "protocol" && <>
              <div className={styles.panelHeader}><div><span className={styles.eyebrow}>THE OBSERVATION PLAN</span><h3>What happened on the bench?</h3><p>Keep every attempt and failure. Original files are linked explicitly to the step they support.</p></div><div className={styles.panelActions}>{edition!.phase === "planning" && owner && <button className={styles.button} disabled={locked || !canStart} onClick={() => open({ kind: "start" })}>Start declared interval<ArrowRight size={15}/></button>}{edition!.phase === "running" && currentOwner && <button className={styles.button} disabled={locked} onClick={() => open({ kind: "finish" })}>Finish interval<Check size={15}/></button>}{edition!.phase === "recorded" && currentOwner && <button className={styles.button} disabled={locked} onClick={() => open({ kind: "seal" })}><LockKeyhole size={15}/>Seal exact report</button>}</div></div>
              {edition!.phase === "planning" && <p className={styles.help}>Save the exact conditions and confirm every bound hardware model before Start. A changed source basis needs a new notebook.</p>}
              {edition!.phase === "running" && edition!.startedAt && <RecordedClock startedAt={edition!.startedAt} duration={edition!.conditions.declaredSeconds}/>}
              {edition!.finishedAt && <div className={styles.interval}><Clock3 size={18}/><p><b>Server-recorded interval:</b> {d.assessment.elapsedSeconds === null ? "Not available" : `${d.assessment.elapsedSeconds.toFixed(2)} s`} / {edition!.conditions.declaredSeconds} s declared.<br/><span>Started {benchTime(edition!.startedAt)} · finished {benchTime(edition!.finishedAt)}</span></p></div>}
              <ol className={styles.protocol}>{edition!.binding.steps.map((step, index) => { const observed = edition!.observations.filter(o => o.stepId === step.id); const attachments = edition!.attachments.filter(a => a.stepId === step.id); return <li key={step.id} className={observed.some(o => o.outcome === "observed_failure") ? styles.protocolFailure : ""}><span className={styles.stepNumber}>{String(index + 1).padStart(2, "0")}</span><div><header><div><h4>{step.title}</h4><span>{step.required ? "Required" : "Optional"}</span></div>{editable && ["running", "recorded"].includes(edition!.phase) && <button className={styles.textButton} disabled={locked} onClick={() => open({ kind: "observe", stepId: step.id })}><Plus size={14}/>Record observation</button>}</header><p>{step.instruction}</p><small className={styles.evidenceHint}>Supporting originals: {step.evidenceKinds.map(fileKindLabel).join(" / ") || "No specific file kind"}</small>{observed.length ? <ul className={styles.observations}>{observed.map(o => <li key={o.id} data-outcome={o.outcome}><span>{o.outcome === "observed_failure" ? "Operator reported failure" : o.outcome === "observed_pass" ? "Operator reported pass" : o.outcome === "not_performed" ? "Not performed" : "Uncertain"}</span><p>{o.detail}</p><small>Observed {benchTime(o.observedAt)} · recorded {benchTime(o.recordedAt)}</small></li>)}</ul> : <p className={styles.noObservation}>No observation recorded.</p>}{attachments.length > 0 && <div className={styles.attachmentList}>{attachments.map(a => { const asset = d.assets.find(v => v.id === a.assetId && v.sha256 === a.assetHash); return <div key={a.id}><Link2 size={13}/><span>{asset?.filename ?? "Original fingerprint retained"}<small>{a.note} · {benchShort(a.assetHash)}{asset && !originalAvailable(asset) ? " · unavailable" : ""}</small></span></div>; })}</div>}</div></li>; })}</ol>
            </>}
            {tab === "conditions" && <>
              <div className={styles.panelHeader}><div><span className={styles.eyebrow}>FROZEN WHEN RECORDING STARTS</span><h3>Exact equipment. Exact conditions.</h3><p>Compare the actual model, firmware and setup with this saved graph.</p></div>{currentOwner && edition!.phase === "planning" && <button className={styles.button} disabled={locked} onClick={() => open({ kind: "plan" })}>Edit conditions<ArrowRight size={15}/></button>}</div>
              <div className={styles.hardware}>{edition!.conditions.hardware.map(h => <article key={h.componentId}><span className={styles.sectionIcon}><AudioLines size={20}/></span><div><h4>{h.model}</h4><p>Revision {h.revision} · firmware {h.firmware}</p><span className={styles.badge}>{h.matchesBoundModel ? "Operator confirmed exact model" : "Exact model not confirmed"}</span>{h.serialRecordId && <small>Private serial fingerprint: {benchShort(d.serials.find(s => s.id === h.serialRecordId)?.hash ?? "unavailable")}</small>}</div>{currentOwner && edition!.phase === "planning" && <button className={styles.textButton} disabled={locked} onClick={() => open({ kind: "serial", componentId: h.componentId })}><LockKeyhole size={13}/>{h.serialRecordId ? "Record another private serial" : "Seal private serial"}</button>}</article>)}</div>
              <dl className={styles.conditions}>{([{ key: "operator", label: "Operator" }, { key: "locationLabel", label: "Location" }, { key: "hostOs", label: "Host / OS" }, { key: "appAndVersion", label: "Application / version" }, { key: "recordingSettings", label: "Recording settings" }, { key: "streamSettings", label: "Stream settings" }, { key: "storage", label: "Storage" }, { key: "power", label: "Power" }, { key: "hubsAndCables", label: "Hubs / cables" }, { key: "monitoring", label: "Monitoring" }, { key: "notes", label: "Conditions / limitations" }] as const).map(f => <div key={f.key}><dt>{f.label}</dt><dd>{edition!.conditions[f.key] || "Not recorded"}</dd></div>)}<div><dt>Predeclared interval</dt><dd>{edition!.conditions.declaredSeconds} seconds · declared {benchTime(edition!.declaredAt)}</dd></div></dl>
            </>}
            {tab === "originals" && <>
              <div className={styles.panelHeader}><div><span className={styles.eyebrow}>PRIVATE ORIGINAL-FILE VAULT</span><h3>The bytes behind the report.</h3><p>Upload intent → original bytes → independent byte check → explicit step attachment. None of these alone proves physical origin.</p></div><div className={styles.panelActions}>{editable && <button className={styles.button} disabled={locked || home.storage === "unavailable"} onClick={() => open({ kind: "upload" })}><Plus size={15}/>Add original</button>}{editable && edition!.sourceMode === "sample" && <button className={styles.secondary} disabled={locked || home.storage === "unavailable"} onClick={() => open({ kind: "sample" })}><FlaskConical size={15}/>Generate Sample originals</button>}</div></div>
              {home.storage === "unavailable" && <p className={styles.warning}>Private original storage is unavailable. Saved manifests remain inspectable; no upload or Sample original is being created.</p>}
              {d.uploads.length > 0 && <section className={styles.uploadQueue} aria-label="Original upload and verification queue"><h4>Originals in progress</h4>{d.uploads.map(u => <div key={u.id}><span className={styles.sectionIcon}><FileUp size={17}/></span><div><b>{u.file.filename}</b><span>{u.purgedAt ? "Removed · bytes purged" : u.withdrawnAt ? "Withdrawn · deletion may need retry" : u.phase.replaceAll("_", " ")} · {benchBytes(u.file.bytes)} · {u.attempts} byte-check attempts</span>{u.failure && <p className={styles.failureText}>{u.failure}</p>}{!u.assetId && <small>Not attached to any protocol step.</small>}</div>{currentOwner && u.phase !== "verified" && <div className={styles.queueActions}>{!u.withdrawnAt && u.generatedSample === false && ["awaiting_upload", "rejected"].includes(u.phase) && <button className={styles.secondary} disabled={locked} onClick={() => open({ kind: "send", upload: u, file: files.current.get(`${home.workspaceKey}:${d.runId}:${u.id}`) })}>Send original</button>}<button className={styles.textButton} disabled={locked || !!u.withdrawnAt || u.phase === "verifying"} onClick={() => void execute({ kind: "verify_upload", runId: d.runId, uploadId: u.id })}>Check original bytes<RefreshCw size={13}/></button>{!u.assetId && !u.purgedAt && <button className={styles.dangerText} disabled={locked} onClick={() => open({ kind: "remove_upload", upload: u })}>{u.withdrawnAt ? "Retry upload removal" : "Remove upload"}</button>}</div>}</div>)}</section>}
              {!d.assets.length && <div className={styles.emptySmall}><FileUp size={31}/><h4>No checked originals yet.</h4><p>Waiting uploads are not evidence. Add an original, check its bytes, then choose which protocol step it supports.</p></div>}
              <div className={styles.assetList}>{d.assets.map(a => { const available = originalAvailable(a); const linked = edition!.attachments.filter(l => l.assetId === a.id && l.assetHash === a.sha256); const supported = edition!.binding.steps.some(s => s.evidenceKinds.includes(a.kind)); return <article key={a.id} className={`${styles.asset} ${!available ? styles.assetUnavailable : ""}`}><header><span className={styles.sectionIcon}><OriginalIcon asset={a}/></span><div><h4>{a.filename}</h4><p>{fileKindLabel(a.kind)} · {benchBytes(a.bytes)} · {provenanceLabel(a.provenance)}</p></div><span className={styles.badge}>{available ? "Bytes checked" : a.availability === "purged" ? "Original purged" : "Original unavailable"}</span></header>{(a.detectedModelExport || a.provenance === "model_export" || a.provenance === "sample_generated") && <div className={styles.warning} role="note"><FlaskConical size={18}/><p><b>Model or Sample evidence · cannot support physical execution</b><br/>Any declared original and detected model/Sample marker remain separate. Byte checks do not turn these files into a physical recording.</p></div>}<p className={styles.assetScope}>Declared provenance is retained. Byte checks do not establish physical execution.</p><BenchWaveform asset={a}/><div className={styles.assetHash}><Fingerprint size={13}/><code>{a.sha256}</code></div><p className={styles.assetLinks}>{linked.length ? `${linked.length} explicit protocol ${linked.length === 1 ? "attachment" : "attachments"}` : "Not attached to a protocol step"} · verified {benchTime(a.verifiedAt)}</p><footer><button className={styles.secondary} disabled={busy || loading || !available || readIssue} onClick={() => { if (!busyRef.current && !reading.current) { returnFocus.current = document.activeElement as HTMLElement; const next: NotebookDialog = { kind: "original", asset: a }; dialogRef.current = next; setDialog(next); } }}>Inspect original<ArrowRight size={14}/></button>{available && !readIssue && <a className={styles.textButton} href={benchOriginalUrl(a.id, d.runId, reviewer)} download><ArrowDownToLine size={14}/>Download</a>}{editable && available && <button className={styles.textButton} disabled={locked || !supported} onClick={() => open({ kind: "attach", asset: a })}><Link2 size={14}/>Link to step</button>}{currentOwner && a.availability !== "purged" && <button className={styles.dangerText} disabled={locked} onClick={() => open({ kind: "withdraw", asset: a })}>{a.availability === "withdrawn" ? "Retry private deletion" : "Withdraw access"}</button>}</footer></article>; })}</div>
            </>}
            {tab === "review" && <>
              <div className={styles.panelHeader}><div><span className={styles.eyebrow}>INDEPENDENCE HAS ITS OWN EVIDENCE</span><h3>{reviewer ? "Review this exact sealed report." : "A private second set of eyes."}</h3><p>{reviewer ? "Your authority is limited to this original manifest and its currently permitted attached originals." : "Invite an established reviewer, or register a new unqualified person or Sample reviewer. An invitation cannot establish qualification."}</p></div>{currentOwner && edition!.phase === "sealed" && <button className={styles.button} disabled={locked} onClick={() => open({ kind: "invite" })}><Plus size={15}/>Invite reviewer</button>}{reviewer && <button className={styles.button} disabled={locked || !canReview} onClick={() => open({ kind: "review" })}>{edition!.sourceMode === "sample" || d.reviewer?.provenance === "sample" ? "Record Sample review" : "Record review decision"}<ArrowRight size={15}/></button>}</div>
              {reviewer && d.reviewer && <div className={styles.reviewerCard}><UserRoundCheck size={24}/><div><h4>{d.reviewer.name}</h4><p>{d.reviewer.provenance === "sample" ? "Sample person · no actual human review" : d.reviewer.qualified ? "Current independently qualified reviewer for this scope" : "Human identity / qualification not established for this scope"}</p><small>Access ends {benchTime(d.reviewer.expiresAt)}</small></div></div>}
              {edition!.phase !== "sealed" && <p className={styles.help}>Finish and seal the exact report before inviting a reviewer. Incomplete and failed observations may be sealed; they stay visible.</p>}
              {reviewer && !canReview && <p className={styles.warning}>A decision requires the exact sealed manifest, current appropriate reviewer authority and at least one permitted attached original. Sample review never increases actual qualified review counts.</p>}
              {owner && <div className={styles.grants}>{d.grants.length ? d.grants.map(g => <article key={g.id}><div><b>{g.name}</b><p>{g.provenance === "sample" ? "Sample reviewer" : g.qualification === "current" ? "Currently qualified" : "Qualification unestablished or ended"} · {g.status} · edition {d.history.find(e => e.id === g.editionId)?.number ?? benchShort(g.editionHash)}</p><small>Expires {benchTime(g.expiresAt)} · grant version {g.version}</small></div>{currentOwner && g.status !== "revoked" && <button className={styles.dangerText} disabled={locked} onClick={() => open({ kind: "revoke", grant: g })}>Revoke invitation</button>}</article>) : <div className={styles.emptySmall}><UserRoundCheck size={27}/><h4>No scoped invitation yet.</h4><p>Nothing has been sent to a reviewer.</p></div>}</div>}
              <h4 className={styles.formSection}>Retained decisions</h4><div className={styles.decisions}>{d.decisions.length ? d.decisions.map(decision => <article key={decision.id} className={decision.outcome === "contradiction" ? styles.reviewContradiction : ""}><header><b>{decision.actorName}</b><span className={styles.badge}>{decision.provenance === "sample" || edition!.sourceMode === "sample" ? "Sample review" : decision.currentlyQualified && decision.currentAuthority ? "Current qualified decision" : "Historical / authority ended"}</span></header><h4>{decision.outcome === "contradiction" ? "Contradiction retained" : decision.outcome === "needs_evidence" ? "Needs more evidence" : "Supports the exact reported scope"}</h4><p>{decision.finding}</p><p><b>Limits:</b> {decision.limitations}</p><small>{benchTime(decision.createdAt)} · exact edition {benchShort(decision.editionHash)} · {decision.inspectedAssetIds.length} inspected originals</small></article>) : <p className={styles.help}>No decision is recorded against this exact report. A sealed manifest alone is not independent review.</p>}</div>
            </>}
            {tab === "history" && <>
              <div className={styles.panelHeader}><div><span className={styles.eyebrow}>A RETAINED RECORD, NOT A RESET</span><h3>Every saved edition has a place.</h3><p>Earlier conditions, observations and failures stay inspectable. Current permission still controls original access.</p></div></div><ol className={styles.history}>{d.history.map(h => <li key={h.id}><span className={styles.historyDot}/><div><b>Edition {h.number} · {h.phase}</b><p>{h.reason}</p><small>{benchTime(h.createdAt)} · {benchShort(h.hash)}</small></div><button className={styles.textButton} disabled={busy || loading || h.id === edition!.id} onClick={() => selectReport(d.runId, h.id === d.currentEditionId ? undefined : h.id)}>{h.id === edition!.id ? "Viewing" : `Open edition ${h.number}`}<ChevronRight size={14}/></button></li>)}</ol><h4 className={styles.formSection}>Recent activity</h4><ol className={styles.activity}>{d.events.map(event => <li key={event.id}><Activity size={13}/><div><p>{event.summary}</p><small>{benchTime(event.at)} · {event.kind}</small></div></li>)}</ol>
            </>}
          </div>
          <aside className={styles.rail}><Assessment detail={d}/><section className={styles.export}><FileCheck2 size={23}/><h3>Take the exact manifest.</h3><p>Private export retains its scoped details. Redacted export omits personal/free-form text and original filenames. Neither creates a public share.</p><a className={styles.secondary} href={benchExportUrl(d, reviewer, "private")} download aria-disabled={readIssue || undefined} onClick={e => { if (readIssue) e.preventDefault(); }}><ArrowDownToLine size={14}/>Private report</a><a className={styles.textButton} href={benchExportUrl(d, reviewer, "redacted")} download aria-disabled={readIssue || undefined} onClick={e => { if (readIssue) e.preventDefault(); }}>Redacted manifest<ArrowRight size={14}/></a></section></aside>
        </div>
      </>}
    </>}
    {dialog && home && <NotebookActionDialog key={`${dialog.kind}:${benchContextKey(home)}`} dialog={dialog} home={home} busy={busy} checking={loading} blocked={!!storageIssue || readIssue} pending={!!pending && !(dialog.kind === "serial" && !!dialog.recovery)} error={error || storageIssue} returnFocusRef={returnFocus} onClose={closeDialog} onCommand={submit} onSend={(upload, file) => void sendOriginal(upload, file)}/>}
    {invitationOpen && invitation && home?.workspaceKey === invitation.workspaceKey && <ModalFrame labelledBy={`${baseId}-invitation`} onClose={() => setInvitationOpen(false)} className={styles.dialog} backdropClassName={styles.backdrop} returnFocusRef={returnFocus}><header className={styles.dialogHeader}><div><span className={styles.eyebrow}>ONE PRIVATE HANDOFF</span><h2 id={`${baseId}-invitation`}>Your invitation is masked.</h2></div><button className={styles.iconButton} aria-label="Close private invitation" onClick={() => setInvitationOpen(false)}><X size={19}/></button></header><div className={styles.invitation}><LockKeyhole size={35}/><b>Private invitation · ••••••••••••</b><p>{invitation.name} · exact sealed report · expires {benchTime(invitation.expiresAt)}</p><p>Copy or open it deliberately. The invitation is kept only in this tab, never in browser storage or a query. It does not establish reviewer qualification.</p><div className={styles.formActions}><button className={styles.secondary} onClick={() => void copyInvitation()}><Clipboard size={15}/>{copied ? "Invitation copied" : "Copy private invitation"}</button><button className={styles.button} onClick={() => { const url = invitationUrl(); if (url) window.open(url, "_blank", "noopener,noreferrer"); }}>Open reviewer room<ArrowRight size={15}/></button></div></div></ModalFrame>}
  </section>;
}
