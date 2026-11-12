"use client";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { ArrowLeft, ArrowRight, AudioLines, CircleHelp, Compass, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { Workspace } from "../../packages/contracts";
import type { Edit, WorkbenchPreview } from "../../packages/workbench/contracts";
import { applyFromPreview, checkedGuidedPreview, checkedGuidedReceipt, clearGuidedPending, freshGuidedWorkspace, guidedDigest, guidedLive, guidedRequest, guidedScope, guidedWorkspaceKey, GuidedRequestError, readGuidedPending, retainGuidedPending, type GuidedPending } from "./guided-journey-client";
import { GuidedPreview, GuidedStep, GUIDED_STEPS, type GuidedSection } from "./guided-journey-views";
import { Soundcheck } from "./soundcheck";
import styles from "./guided-journey.module.css";

export function GuidedJourney({ workspace: w, activeSection, onNavigate, onWorkspace, onBusy, onInspect, fallbackFocusRef }: {
  workspace: Workspace; activeSection: string; onNavigate: (section: GuidedSection) => void;
  onWorkspace: (next: Workspace) => boolean; onBusy: (busy: boolean) => void; onInspect: (witnessId: string) => void;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [expanded, setExpanded] = useState(false), [step, setStep] = useState(0), [ready, setReady] = useState(false);
  const [preview, setPreview] = useState<WorkbenchPreview | null>(null), [consent, setConsent] = useState(false), [soundcheck, setSoundcheck] = useState(false);
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<GuidedPending | null>(null), [error, setError] = useState(""), [storageError, setStorageError] = useState(""), [notice, setNotice] = useState("");
  const [clock, setClock] = useState(0), [playback, setPlayback] = useState<{ revisionId: string; bus: string } | null>(null);
  const scope = guidedScope(w), context = `${scope}:${w.kit.id}:${w.certificate.graphHash}:${w.certificate.id}`;
  const current = useRef({ w, context, scope }); current.current = { w, context, scope };
  const mounted = useRef(false), generation = useRef(0), active = useRef(false), ownerBusy = useRef(onBusy); ownerBusy.current = onBusy;
  const heading = useRef<HTMLHeadingElement>(null), opener = useRef<HTMLButtonElement>(null), dialogReturn = useRef<HTMLElement | null>(null), tabButtons = useRef<(HTMLButtonElement | null)[]>([]), focus = useRef<"heading" | "opener" | null>(null);
  const id = useId(), panelId = `${id}-panel`, headingId = `${id}-heading`, live = guidedLive(w) && clock >= 0;
  const progressKey = `worldkit.guided.position.v1:${scope}`;
  useEffect(() => {
    mounted.current = true; generation.current++; active.current = false;
    setPreview(null); setConsent(false); setSoundcheck(false); setPending(null); setError(""); setStorageError(""); setNotice(""); setPlayback(null);
    try {
      setPending(readGuidedPending(window.sessionStorage, w));
      const saved = window.sessionStorage.getItem(progressKey);
      if (saved) { const value = JSON.parse(saved); if (value.schema === "worldkit.guided-position.v1" && Number.isInteger(value.step) && value.step >= 0 && value.step < GUIDED_STEPS.length) { setStep(value.step); setExpanded(value.expanded === true); } }
    } catch (reason) { setStorageError(reason instanceof Error ? reason.message : "The original browser save record is unavailable. Guided saving is paused."); }
    setReady(true);
    const timer = window.setInterval(() => setClock(value => value + 1), 1000);
    return () => { mounted.current = false; generation.current++; window.clearInterval(timer); ownerBusy.current(false); };
    // Scope is the original actor, system and fixed expiry. A later edition keeps
    // an unresolved command recoverable while invalidating its preview below.
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPreview(null); setConsent(false); setSoundcheck(false); }, [context]);
  useEffect(() => { onBusy(busy || !!pending || !!storageError); }, [busy, pending, storageError, onBusy]);
  useEffect(() => { if (focus.current === "heading" && expanded) { heading.current?.focus(); focus.current = null; } else if (focus.current === "opener" && !expanded) { (opener.current ?? fallbackFocusRef?.current)?.focus(); focus.current = null; } }, [expanded, step, notice, pending, fallbackFocusRef]);
  function remember(nextStep: number, open: boolean) { try { window.sessionStorage.setItem(progressKey, JSON.stringify({ schema: "worldkit.guided-position.v1", step: nextStep, expanded: open })); } catch { /* Position is a convenience; mutation storage is checked separately. */ } }
  function open() { setExpanded(true); remember(step, true); focus.current = "heading"; }
  function close() { setExpanded(false); remember(step, false); focus.current = "opener"; }
  function move(next: number, keyboard = false) { setStep(next); setNotice(""); remember(next, true); if (keyboard) tabButtons.current[next]?.focus(); else focus.current = "heading"; }
  function tabKey(event: React.KeyboardEvent, index: number) {
    const next = event.key === "Home" ? 0 : event.key === "End" ? GUIDED_STEPS.length - 1 : event.key === "ArrowRight" ? (index + 1) % GUIDED_STEPS.length : event.key === "ArrowLeft" ? (index + GUIDED_STEPS.length - 1) % GUIDED_STEPS.length : null;
    if (next !== null) { event.preventDefault(); move(next, true); }
  }
  const valid = (ticket: number, originalScope: string) => mounted.current && generation.current === ticket && current.current.scope === originalScope;
  function start() { if (active.current) return null; active.current = true; setBusy(true); ownerBusy.current(true); setError(""); return generation.current; }
  function finish(ticket: number, originalScope: string) { if (valid(ticket, originalScope)) { active.current = false; setBusy(false); } }
  async function showPreview(edit: Edit, trigger: HTMLElement) {
    if (!ready || !live || pending) return;
    const ticket = start(); if (ticket === null) return; const original = current.current;
    dialogReturn.current = trigger; setPreview(null); setConsent(false); setNotice("");
    try {
      const command = { kind: "preview" as const, expectedRevisionId: original.w.kit.id, expectedGraphHash: original.w.certificate.graphHash, edit };
      const value = await checkedGuidedPreview(await guidedRequest(command), original.w, command);
      if (valid(ticket, original.scope) && current.current.context === original.context && guidedLive(current.current.w)) setPreview(value);
    } catch (reason) { if (valid(ticket, original.scope)) setError(reason instanceof Error ? reason.message : "The preview could not be checked. Your saved plan is unchanged."); }
    finally { finish(ticket, original.scope); }
  }
  async function resolve(original: { w: Workspace; scope: string }, action: GuidedPending, ticket: number) {
    if (action.inputHash !== await guidedDigest(action.command) || action.workspaceKey !== await guidedWorkspaceKey(original.w)) throw new Error("The original browser action fingerprint changed. Keep its record for inspection; no save was sent.");
    if (!valid(ticket, original.scope) || !guidedLive(current.current.w)) return;
    let receipt = action.receipt;
    if (!receipt) {
      try { receipt = await checkedGuidedReceipt(await guidedRequest(action.command), action); }
      catch (reason) {
        if (reason instanceof GuidedRequestError && reason.knownRefusal) {
          action = { ...action, refusal: { status: reason.status, message: reason.message.slice(0, 500) } };
          retainGuidedPending(window.sessionStorage, original.w, action);
          if (valid(ticket, original.scope)) setPending(action);
        }
        throw reason;
      }
      action = { ...action, receipt, refusal: null };
      retainGuidedPending(window.sessionStorage, original.w, action);
      if (valid(ticket, original.scope)) setPending(action);
    } else receipt = await checkedGuidedReceipt(receipt, action);
    if (!valid(ticket, original.scope)) return;
    const latest = await freshGuidedWorkspace(original.w, receipt);
    if (!valid(ticket, original.scope)) return;
    if (!onWorkspace(latest)) throw new Error("A newer workspace view is already open. Read its current saved plan before closing the original receipt.");
    clearGuidedPending(window.sessionStorage, original.w, action.command.requestId);
    setPending(null); setPreview(null); setConsent(false); setError(""); setExpanded(true);
    const later = latest.kit.revision > receipt.saved.revision ? ` The current plan is already revision ${latest.kit.revision}; it was preserved.` : "";
    setNotice(`Revision ${receipt.saved.revision} saved and checked.${later} ${latest.certificate.counts.violated} conflicts and ${latest.certificate.counts.unknown} evidence questions remain in the current model.`);
    dialogReturn.current = heading.current; focus.current = "heading";
    if (action.command.edit.kind === "microphone" && action.command.edit.profileId === "at2020-xlr") { setStep(2); remember(2, true); }
  }
  async function savePreview() {
    if (!preview || !consent || !ready || !live || pending || storageError || preview.base.revisionId !== w.kit.id || preview.base.graphHash !== w.certificate.graphHash) return;
    const ticket = start(); if (ticket === null) return; const original = current.current;
    try {
      const command = applyFromPreview(original.w, preview, crypto.randomUUID());
      const action: GuidedPending = { schema: "worldkit.guided-pending.v1", sessionId: original.w.session.id, kitId: original.w.kit.kitId, expiresAt: original.w.session.expiresAt, workspaceKey: preview.workspaceKey, command, inputHash: await guidedDigest(command), proposedGraphHash: preview.after.graphHash, createdAt: new Date().toISOString(), receipt: null, refusal: null };
      if (!valid(ticket, original.scope) || current.current.context !== original.context || !guidedLive(current.current.w)) return;
      retainGuidedPending(window.sessionStorage, original.w, action); setPending(action); dialogReturn.current = heading.current;
      await resolve(original, action, ticket);
    } catch (reason) { if (valid(ticket, original.scope)) setError(reason instanceof Error ? reason.message : "The original save needs recovery before another change."); }
    finally { finish(ticket, original.scope); }
  }
  async function recover() {
    if (!pending || !live || pending.refusal) return; const ticket = start(); if (ticket === null) return; const original = current.current;
    try { await resolve(original, pending, ticket); }
    catch (reason) { if (valid(ticket, original.scope)) setError(reason instanceof Error ? reason.message : "The original save still needs recovery."); }
    finally { finish(ticket, original.scope); }
  }
  async function refresh() {
    if (!ready || !live) return; const ticket = start(); if (ticket === null) return; const original = current.current; setPreview(null); setConsent(false);
    try { const latest = await freshGuidedWorkspace(original.w); if (!valid(ticket, original.scope)) return; if (!onWorkspace(latest)) throw new Error("A newer saved view is already open."); setPreview(null); setConsent(false); setNotice(`Current revision ${latest.kit.revision} read. Reading does not change the plan or replay a save.`); focus.current = "heading"; }
    catch (reason) { if (valid(ticket, original.scope)) setError(reason instanceof Error ? reason.message : "The current plan could not be read."); }
    finally { finish(ticket, original.scope); }
  }
  function dismissRefusal() { if (!pending?.refusal || busy) return; try { clearGuidedPending(window.sessionStorage, w, pending.command.requestId); setPending(null); setError(""); setNotice("The refused request is closed. Refresh the current plan before previewing another change."); focus.current = "heading"; } catch (reason) { setError(reason instanceof Error ? reason.message : "Keep the original save record."); } }
  const blocked = busy || !!pending || !ready || !live;
  if (!expanded && activeSection !== "workbench" && !pending && !storageError) return null;
  return <section className={styles.guide} aria-label="Guided creator journey">
    {!expanded ? <div className={styles.ribbon}><span className={styles.ribbonIcon}><AudioLines size={25}/></span><div><span className={styles.eyebrow}>A SHORT PATH THROUGH YOUR STUDIO</span><h2>Hear it. Change it. Understand it.</h2><p>Follow the saved wiring from a modeled soundcheck to its evidence.</p></div><button ref={opener} className={styles.primary} onClick={open} aria-expanded={false} aria-controls={panelId}>Guide me <ArrowRight size={16}/></button></div> : <>
      <header className={styles.topline}><span className={styles.eyebrow}><Compass size={16}/> GUIDED CREATOR JOURNEY</span><div><span className={styles.scopeLabel}>Modelled · revision {w.kit.revision}</span><button className={styles.iconButton} disabled={busy || !live} onClick={() => void refresh()} aria-label="Refresh guided saved plan"><RefreshCw size={16}/></button><button className={styles.iconButton} onClick={close} aria-label="Close guided journey"><X size={18}/></button></div></header>
      <div className={styles.steps} role="tablist" aria-label="Guided journey steps">{GUIDED_STEPS.map((item, index) => <button key={item} ref={element => { tabButtons.current[index] = element; }} role="tab" id={`${id}-step-${index}`} aria-selected={step === index} aria-controls={panelId} tabIndex={step === index ? 0 : -1} onClick={() => move(index, true)} onKeyDown={event => tabKey(event, index)}><span>{String(index + 1).padStart(2, "0")}</span>{item}</button>)}</div>
      <div id={panelId} role="tabpanel" aria-labelledby={`${id}-step-${step}`} className={styles.panel}>
        {!live ? <div className={styles.expired}><h2 ref={heading} tabIndex={-1} id={headingId}>This workspace has expired.</h2><p>Its original records and deadline are retained. This guide cannot save, renew or recover a change under expired authority.</p></div> : <GuidedStep workspace={w} step={step} headingRef={heading} headingId={headingId} blocked={blocked} playback={playback?.revisionId === w.kit.id ? playback : null} onPlay={() => setSoundcheck(true)} onPreview={(edit, trigger) => void showPreview(edit, trigger)} onNavigate={onNavigate} onInspect={onInspect}/>}
        <footer className={styles.progress}><span>Explore step {step + 1} of {GUIDED_STEPS.length}<small>Your saved checks carry the evidence.</small></span><div><button className={styles.secondary} disabled={step === 0} onClick={() => move(step - 1)}><ArrowLeft size={15}/> Previous</button>{step < GUIDED_STEPS.length - 1 ? <button className={styles.primary} onClick={() => move(step + 1)}>Next <ArrowRight size={15}/></button> : <button className={styles.primary} onClick={() => { onNavigate("workbench"); close(); }}>Return to the workbench <ArrowRight size={15}/></button>}</div></footer>
      </div>
    </>}
    {storageError && <div className={styles.warning} role="alert"><CircleHelp size={20}/><div><b>Keep the original save record</b><p>{storageError}</p></div></div>}
    {pending && <div className={styles.recovery} role="status"><RefreshCw size={19}/><div><b>{pending.refusal ? "This change was refused" : pending.receipt ? `Revision ${pending.receipt.saved.revision} was acknowledged` : "The original save needs an answer"}</b><p>{pending.refusal ? pending.refusal.message : pending.receipt ? "Read the current plan to finish this acknowledgement. No save will be sent again." : "Recover this same request before making another guided change. Opening the guide never sends it automatically."}</p></div>{pending.refusal ? <button className={styles.secondary} disabled={busy} onClick={dismissRefusal}>Dismiss refused request</button> : <button className={styles.secondary} disabled={busy || !live} onClick={() => void recover()}>{pending.receipt ? "Read acknowledged save" : "Recover original save"}</button>}</div>}
    {error && <div className={styles.warning} role="alert"><CircleHelp size={19}/><div><p>{error}</p><button className={styles.textButton} disabled={busy || !live} onClick={() => void refresh()}>Read current saved plan</button></div></div>}
    {busy && <p className={styles.busy} role="status"><LoaderCircle className="spin" size={16}/> {pending ? "Resolving the exact saved request…" : "Checking the current graph…"}</p>}
    {notice && <p className={styles.notice} role="status" aria-live="polite">{notice}</p>}
    {preview && live && <GuidedPreview workspace={w} preview={preview} consent={consent} onConsent={setConsent} busy={busy} blocked={!!pending || !!storageError || !ready} onSave={() => void savePreview()} onClose={() => { setPreview(null); setConsent(false); }} returnFocusRef={dialogReturn}/>}
    {soundcheck && live && <Soundcheck key={w.kit.id} kit={w.kit} contextLabel="Original generated tones follow this saved graph. Press Play when you are ready." onPlaybackStarted={value => setPlayback(value)} onClose={() => setSoundcheck(false)}/>}
  </section>;
}
