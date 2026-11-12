"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, ChevronDown, CircleAlert, ClipboardList, Clock3, History, Layers3, LoaderCircle, LockKeyhole, Plus, RefreshCw, ShieldCheck, Timer, Users } from "lucide-react";
import { RESEARCH_POLICY, ResearchCommandSchema, type ResearchCommandResult, type ResearchHome } from "../../packages/research-notebook/contracts";
import { clearResearchPending, readResearchPending, recordResearchPending, researchActionLabel, researchQuery, researchRequest, ResearchRequestError, researchShort, researchTime, validateResearchHome, validateResearchResult, type PendingResearchAction, type ResearchDraft } from "./research-notebook-client";
import { ResearchDialog, type ResearchDialogChoice } from "./research-notebook-dialogs";
import { HistoryPanel, NotebookArt, ParticipantsPanel, ProtocolPanel, SummaryPanel, TasksPanel } from "./research-notebook-evidence";
import s from "./research-notebook.module.css";

const tabs = ["protocol", "participants", "tasks", "summary", "history"] as const;
type Tab = typeof tabs[number];
const tabItems = [{ id: "protocol", label: "Task protocol", icon: ClipboardList }, { id: "participants", label: "Participants", icon: Users }, { id: "tasks", label: "Observe tasks", icon: Timer }, { id: "summary", label: "Summary", icon: Layers3 }, { id: "history", label: "History", icon: History }] as const;
type Query = { studyId?: string; protocolId?: string };
const authorityError = (error: unknown) => error instanceof ResearchRequestError && [401, 403, 410].includes(error.status);

export function ResearchNotebook() {
  const [home, setHome] = useState<ResearchHome | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [readHeld, setReadHeld] = useState(false), [storageHeld, setStorageHeld] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [pending, setPending] = useState<PendingResearchAction | null>(null), [dialog, setDialog] = useState<ResearchDialogChoice | null>(null), [tab, setTab] = useState<Tab>("protocol"), [now, setNow] = useState(() => Date.now());
  const accepted = useRef<ResearchHome | null>(null), pendingRef = useRef<PendingResearchAction | null>(null), busyRef = useRef(false), loadingRef = useRef(true), readHeldRef = useRef(false), storageHeldRef = useRef(false), started = useRef(false), mounted = useRef(false), generation = useRef(0), query = useRef<Query>({}), offset = useRef(0), focusAfter = useRef<"report" | "notice" | null>(null);
  const opener = useRef<HTMLElement | null>(null), reportHeading = useRef<HTMLHeadingElement>(null), noticeElement = useRef<HTMLDivElement>(null);
  const expired = !!home && now >= Date.parse(home.expiresAt);
  const consentNeedsRefresh = !!home?.selected?.participants.some(person => person.availability === "current" && person.currentConsent?.status === "current" && !!person.currentConsent.expiresAt && Date.parse(person.currentConsent.expiresAt) <= now);
  const holdRead = (value: boolean) => { readHeldRef.current = value; setReadHeld(value); };
  const holdStorage = (value: boolean) => { storageHeldRef.current = value; setStorageHeld(value); };
  const updatePending = (value: PendingResearchAction | null) => { pendingRef.current = value; setPending(value); };

  const refresh = useCallback(async (requested?: Query, focus = false) => {
    const read = ++generation.current;
    if (requested) query.current = requested;
    const target = { ...query.current };
    loadingRef.current = true; setLoading(true); setDialog(null); setError("");
    try {
      const value = validateResearchHome(await researchRequest<ResearchHome>(researchQuery(target.studyId, target.protocolId)));
      if (!mounted.current || read !== generation.current) return;
      let retained: PendingResearchAction | null = null;
      try { retained = readResearchPending(window.sessionStorage, value.workspaceKey); holdStorage(false); }
      catch (caught) { holdStorage(true); setError(caught instanceof Error ? caught.message : "The original action cannot be recovered in this browser."); }
      accepted.current = value; setHome(value); updatePending(retained); offset.current = Date.parse(value.serverTime) - Date.now(); setNow(Date.now() + offset.current); holdRead(false);
      const url = new URL(window.location.href); url.searchParams.delete("studyId"); url.searchParams.delete("protocolId");
      if (value.selected) { url.searchParams.set("studyId", value.selected.study.id); if (value.selected.historical) url.searchParams.set("protocolId", value.selected.protocol.id); }
      window.history.replaceState({}, "", url);
      if (focus) focusAfter.current = value.selected ? "report" : "notice";
    } catch (caught) {
      if (!mounted.current || read !== generation.current) return;
      holdRead(true); setError(caught instanceof Error ? caught.message : "The notebook could not be read."); focusAfter.current = "notice";
      if (authorityError(caught)) { accepted.current = null; setHome(null); updatePending(null); setDialog(null); }
    } finally {
      if (mounted.current && read === generation.current) { loadingRef.current = false; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!started.current) { started.current = true; const params = new URLSearchParams(window.location.search); query.current = { ...(params.get("studyId") ? { studyId: params.get("studyId")! } : {}), ...(params.get("protocolId") ? { protocolId: params.get("protocolId")! } : {}) }; void refresh(); }
    const reread = () => { if (!busyRef.current && !loadingRef.current) void refresh(); };
    const visible = () => { if (document.visibilityState === "visible") reread(); };
    const navigate = () => { if (busyRef.current) return; const params = new URLSearchParams(window.location.search); void refresh({ ...(params.get("studyId") ? { studyId: params.get("studyId")! } : {}), ...(params.get("protocolId") ? { protocolId: params.get("protocolId")! } : {}) }, true); };
    window.addEventListener("focus", reread); document.addEventListener("visibilitychange", visible); window.addEventListener("popstate", navigate);
    const clock = window.setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => { mounted.current = false; window.clearInterval(clock); window.removeEventListener("focus", reread); document.removeEventListener("visibilitychange", visible); window.removeEventListener("popstate", navigate); };
  }, [refresh]);
  useEffect(() => { if (expired || consentNeedsRefresh) { setDialog(null); focusAfter.current = "notice"; } }, [expired, consentNeedsRefresh]);
  useEffect(() => { if (!busy && !loading && !dialog && focusAfter.current) { const target = focusAfter.current; focusAfter.current = null; (target === "report" ? reportHeading.current : noticeElement.current)?.focus(); } }, [busy, loading, dialog, home, error, expired, consentNeedsRefresh]);

  const locked = busy || loading || readHeld || storageHeld || !!pending || !home || expired || consentNeedsRefresh;
  const detail = home?.selected ?? null;
  const canEdit = !!detail && !locked && !detail.historical && detail.study.phase === "open";
  const canWithdraw = !!detail && !locked;
  const open = (choice: ResearchDialogChoice, trigger: HTMLElement) => { if (locked) return; opener.current = trigger; setError(""); setNotice(""); setDialog(choice); };

  const dispatch = async (draft: ResearchDraft | PendingResearchAction) => {
    const value = accepted.current;
    const currentTime = Date.now() + offset.current;
    if (busyRef.current || loadingRef.current || readHeldRef.current || storageHeldRef.current || !value || currentTime >= Date.parse(value.expiresAt) || value.selected?.participants.some(person => person.availability === "current" && person.currentConsent?.status === "current" && !!person.currentConsent.expiresAt && Date.parse(person.currentConsent.expiresAt) <= currentTime)) return;
    const recovering = "command" in draft;
    if (recovering && (draft.workspaceKey !== value.workspaceKey || JSON.stringify(draft) !== JSON.stringify(pendingRef.current))) return;
    if (!recovering && pendingRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    let retained: PendingResearchAction | null = null;
    try {
      const command = recovering ? ResearchCommandSchema.parse(draft.command) : ResearchCommandSchema.parse({ ...draft, requestId: crypto.randomUUID() });
      if (!recovering && command.kind !== "create" && (!value.selected || command.studyId !== value.selected.study.id || command.expectedVersion !== value.selected.study.version || command.expectedStudyHash !== value.selected.study.hash)) throw new ResearchRequestError("The saved study changed. Refresh before recording anything else.", "stale_context", 409);
      retained = { version: 1, workspaceKey: value.workspaceKey, command };
      try { recordResearchPending(window.sessionStorage, retained); } catch (caught) { holdStorage(true); throw caught; }
      updatePending(retained);
      const result = validateResearchResult(await researchRequest<ResearchCommandResult>("/api/research-notebook", command));
      clearResearchPending(window.sessionStorage, retained); updatePending(null); setDialog(null);
      setNotice(`${recovering ? "The original action was recovered" : researchActionLabel[command.kind] + " was saved"}. Its identity and evidence are retained.`);
      await refresh({ studyId: result.studyId, ...(result.protocolId ? { protocolId: result.protocolId } : {}) }, true);
    } catch (caught) {
      if (!mounted.current) return;
      if (retained && caught instanceof ResearchRequestError && !caught.unknown) {
        try { clearResearchPending(window.sessionStorage, retained); updatePending(null); } catch { holdStorage(true); }
      }
      setError(caught instanceof Error ? caught.message : "The action could not be recorded. Recover its original identity.");
      if (authorityError(caught)) { accepted.current = null; setHome(null); setDialog(null); updatePending(null); holdRead(true); focusAfter.current = "notice"; }
      else if (caught instanceof ResearchRequestError && caught.status === 409) { holdRead(true); setDialog(null); focusAfter.current = "notice"; }
      else if (retained && (!(caught instanceof ResearchRequestError) || caught.unknown)) { setDialog(null); focusAfter.current = "notice"; }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };

  return <main className={s.notebook} aria-busy={loading || busy}>
    <nav className={s.breadcrumb} aria-label="Notebook navigation"><a href="/"><ArrowLeft size={14}/>Back to workbench</a><span>WORLDKIT / RESEARCH NOTEBOOK</span><span><LockKeyhole size={13}/>Private workspace</span></nav>
    <header className={s.hero}><div><span className={s.eyebrow}><span className={s.labelDot}/> THE RESEARCH NOTEBOOK</span><h1>Listen carefully.<br/>Keep an <em>honest record.</em></h1><p>Make room for the pauses, the unexpected answer, the first try. Observe how people understand a saved system, with permission and a clear task.</p><div className={s.heroFacts}><span><ClipboardList size={15}/>A predeclared protocol</span><span><ShieldCheck size={15}/>Consent kept in scope</span><span><History size={15}/>Every attempt retained</span></div></div><NotebookArt/></header>
    <div ref={noticeElement} tabIndex={-1} className={`${s.notice} ${error ? s.noticeError : ""} ${error || notice || expired || pending || storageHeld || loading || consentNeedsRefresh ? s.noticeVisible : ""}`} role={error && !dialog ? "alert" : "status"} aria-live="polite"><span>{loading || busy ? <LoaderCircle size={18} className={s.spinner}/> : error || expired || storageHeld ? <CircleAlert size={18}/> : <CheckCircle2 size={18}/>}</span><div><p>{error || (expired ? "This workspace has reached its original expiry. Recording is held; this notebook does not renew access." : consentNeedsRefresh ? "A recorded consent has reached its expiry. Refresh current consent before displaying current summary counts or recording another action." : loading ? "Reading the exact saved notebook and current consent…" : notice || (pending ? `The original “${researchActionLabel[pending.command.kind]}” action needs explicit recovery. No replacement action will be sent.` : ""))}</p>{pending && <small>Original request {researchShort(pending.command.requestId)} · {researchActionLabel[pending.command.kind]}. Recovery rechecks current authority.</small>}</div>{pending ? <button disabled={busy || loading || readHeld || storageHeld || expired || consentNeedsRefresh} className={s.noticeAction} onClick={() => void dispatch(pending)}>Recover original action<RefreshCw size={14}/></button> : (error || consentNeedsRefresh) && !dialog ? <button disabled={busy || loading} className={s.noticeAction} onClick={() => void refresh(undefined, true)}>Refresh saved view<RefreshCw size={14}/></button> : null}</div>
    {!home || expired ? loading ? <div className={s.loadingState}><LoaderCircle className={s.spinner} size={24}/><p>Opening your private research notebook…</p><span>Reading saved work. No study or workspace is created.</span></div> : <section className={s.emptyPanel}><BookOpen size={37}/><h2>{expired ? "This workspace has reached its expiry." : "Let’s reopen the saved notebook."}</h2><p>{expired ? "Private notebook content is hidden. This view does not renew the original authority." : "Current workspace access is needed before private research can be read or recorded."}</p><button className={s.primary} onClick={() => void refresh(undefined, true)}>Try the saved view again<RefreshCw size={14}/></button><a href="/" className={s.textButton}>Return to workbench<ArrowRight size={13}/></a></section> : <>
      <section className={s.studyBoard} aria-label="Study board"><header><div><span className={s.eyebrow}>YOUR PRIVATE STUDY BOARD</span><h2>A purpose for every page.</h2></div><div className={s.actions}><button className={s.refreshButton} disabled={busy || loading} onClick={() => void refresh(undefined, true)} aria-label="Refresh current notebook"><RefreshCw size={15}/><span>Refresh</span></button><button className={s.primary} disabled={locked || home.subjects.length === 0} onClick={event => open({ kind: "create" }, event.currentTarget)}><Plus size={15}/>New study</button></div></header>{home.studies.length > 0 ? <div className={s.studyCards}>{home.studies.map((study, index) => <button key={study.id} className={`${s.studyCard} ${study.id === detail?.study.id ? s.studySelected : ""}`} disabled={busy || loading || !!pending || storageHeld || expired} aria-pressed={study.id === detail?.study.id} onClick={() => { setTab("protocol"); void refresh({ studyId: study.id }, true); }}><span className={s.studyNumber}>{String(index + 1).padStart(2, "0")}<ArrowRight size={15}/></span><span className={study.mode === "sample" ? s.sampleBadge : s.operatorBadge}>{study.mode === "sample" ? "Sample practice" : "Operator reported"}</span><strong>{study.title}</strong><small>{study.participantCount} participant records · {study.attemptCount} attempts</small><span className={s.studyCardFoot}>Version {study.version} · {study.phase === "sealed" ? "Sealed" : "Open notebook"}</span></button>)}</div> : <div className={s.boardEmpty}><div><BookOpen size={27}/></div><p><strong>Start with a question worth asking.</strong>Your first study will bind a saved system to an editable five-task protocol.</p><span>Sample practice or operator-recorded research.<br/>Always separate, always labelled.</span></div>}{home.subjects.length === 0 && <p className={s.warning}>Save a creator or domain system in the workbench first. A study needs an exact revision and graph.</p>}</section>
      {detail ? <section className={s.studyDetail} aria-label="Selected research study"><header className={s.reportHeader}><div><span className={s.eyebrow}>{detail.study.mode === "sample" ? "FICTIONAL SAMPLE PRACTICE" : "OPERATOR-REPORTED OBSERVATIONS"}</span><h2 ref={reportHeading} tabIndex={-1} aria-describedby="research-study-status">{detail.study.title}</h2><p>{detail.study.objective}</p><div id="research-study-status" className={s.reportStatus}><span>Study version {detail.study.version}</span><span>Protocol {detail.protocol.number} · {detail.historical ? "Historical, read only" : "Current"}</span><span>{detail.study.phase === "sealed" ? "Sealed notebook" : "Open notebook"}</span><code title={detail.study.hash}>{researchShort(detail.study.hash)}</code></div></div><div>{detail.historical ? <button className={s.secondary} disabled={busy || loading} onClick={() => { setTab("protocol"); void refresh({ studyId: detail.study.id }, true); }}>Open current protocol<ArrowRight size={14}/></button> : <button className={s.secondary} disabled={!canEdit || detail.attempts.some(attempt => attempt.state === "running")} onClick={event => open({ kind: "seal" }, event.currentTarget)}><LockKeyhole size={14}/>{detail.study.phase === "sealed" ? "Notebook sealed" : "Seal notebook"}</button>}</div></header>
        <div className={detail.study.mode === "sample" ? s.sampleScope : s.operatorScope}><ShieldCheck size={19}/><p>{detail.study.mode === "sample" ? <><strong>Sample people. Zero real participants.</strong> Fictional practice cannot satisfy the consented novice or audio-engineer research gate.</> : <><strong>Recorded by an operator. Independently unverified.</strong> Identity, experience, consent and performance remain reported observations. No recruitment is sent.</>}</p></div>
        {detail.historical && <div className={s.historyBanner}><History size={17}/><p>Historical protocol {detail.protocol.number}. Its task snapshots and fingerprints remain readable; current consent governs participant text. New recording uses the current protocol.</p></div>}
        <div className={s.tabsRow}><div role="tablist" aria-label="Research notebook views" className={s.tabs} onKeyDown={event => { const index = tabs.indexOf(tab); const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1; if (next !== -1) { event.preventDefault(); const target = tabs[next]!; setTab(target); document.getElementById(`research-tab-${target}`)?.focus(); } }}>{tabItems.map(item => <button key={item.id} id={`research-tab-${item.id}`} role="tab" aria-controls={`research-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)}><item.icon size={15}/>{item.label}</button>)}</div><span className={s.tabHint}><ChevronDown size={13}/>Read at your own pace</span></div>
        <div id={`research-panel-${tab}`} role="tabpanel" aria-labelledby={`research-tab-${tab}`} className={s.tabPanel} tabIndex={0}>{tab === "protocol" ? <ProtocolPanel detail={detail} canEdit={canEdit} open={open}/> : tab === "participants" ? <ParticipantsPanel detail={detail} canEdit={canEdit} canWithdraw={canWithdraw} locked={locked} now={now} open={open}/> : tab === "tasks" ? <TasksPanel detail={detail} canEdit={canEdit} locked={locked} now={now} open={open}/> : tab === "summary" ? consentNeedsRefresh || readHeld ? <div className={s.warning}>Current summary counts are held until the saved notebook and current consent are refreshed.</div> : <SummaryPanel detail={detail}/> : <HistoryPanel detail={detail} locked={busy || loading || !!pending || expired} readProtocol={protocolId => { setTab("protocol"); void refresh({ studyId: detail.study.id, ...(protocolId ? { protocolId } : {}) }, true); }}/>}</div>
      </section> : <section className={s.getStarted}><span><ClipboardList size={30}/></span><div><span className={s.eyebrow}>A THOUGHTFUL FIRST STEP</span><h3>A protocol before a stopwatch.</h3><p>Choose a saved system, edit the five starter tasks, and record a dated consent declaration. Nothing starts until you explicitly choose it.</p></div><button className={s.secondary} disabled={locked || home.subjects.length === 0} onClick={event => open({ kind: "create" }, event.currentTarget)}>Create your first study<ArrowRight size={14}/></button></section>}
      <footer className={s.notebookFooter}><p><ShieldCheck size={15}/>{RESEARCH_POLICY}</p><span><Clock3 size={13}/>Original workspace expiry: {researchTime(home.expiresAt)}</span></footer>
    </>}
    {dialog && home && !expired && !consentNeedsRefresh && <ResearchDialog key={`${home.workspaceKey}:${detail?.study.hash ?? "new"}:${detail?.protocol.hash ?? "new"}:${dialog.kind}:${"participantId" in dialog ? dialog.participantId : "attemptId" in dialog ? dialog.attemptId : ""}`} home={home} detail={detail} choice={dialog} now={now} busy={busy} locked={locked} error={error} onClose={() => { setDialog(null); setError(""); }} onSubmit={dispatch} returnFocusRef={opener}/>}
  </main>;
}
