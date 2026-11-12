"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import type { Workspace } from "../../packages/contracts";
import type { AdmissionJournal } from "../../packages/workspace-entry";
import { clearAdmissionJournal, entryError, newAdmissionJournal, parseEntryWorkspace, readAdmissionJournal, writeAdmissionJournal } from "./workspace-entry-client";
import { DeviceArt } from "./device-art";
import { Busy } from "./ui";
import styles from "./workspace-entry.module.css";

type Phase = "checking" | "ready" | "reading_failed" | "posting" | "recover" | "expired" | "storage_hold";
export function WorkspaceEntry({ brand, onOpen }: { brand: ReactNode; onOpen: (workspace: Workspace) => void }) {
  const [phase, setPhase] = useState<Phase>("checking"), [error, setError] = useState("");
  const [pending, setPending] = useState<AdmissionJournal | null>(null);
  const generation = useRef(0), occupied = useRef(false), open = useRef(onOpen); open.current = onOpen;
  async function checkSaved(stamp: number) {
    occupied.current = true; setPhase("checking"); setError("");
    let journal: AdmissionJournal | null = null, storageError = "";
    try { journal = readAdmissionJournal(window.sessionStorage, window.location.origin); }
    catch { storageError = "This browser cannot read a reliable recovery record. Check your saved workbench before starting another Sample."; }
    try {
      const response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30000), headers: { Accept: "application/json" } });
      if (generation.current !== stamp) return;
      if (response.status === 401) {
        setPending(journal); setError(storageError); setPhase(storageError ? "storage_hold" : journal ? "recover" : "ready"); return;
      }
      const value = await response.json(); if (generation.current !== stamp) return;
      if (!response.ok) throw new Error(entryError(value, "The saved workbench could not be checked. Try the read again before starting anything new."));
      open.current(parseEntryWorkspace(value));
    } catch (failure) { if (generation.current === stamp) { setError(failure instanceof Error ? failure.message : "The saved workbench could not be checked."); setPhase("reading_failed"); } }
    finally { if (generation.current === stamp) occupied.current = false; }
  }
  useEffect(() => { const stamp = ++generation.current; void checkSaved(stamp); return () => { generation.current++; occupied.current = false; }; }, []);
  function refresh() { if (occupied.current) return; void checkSaved(++generation.current); }
  async function start() {
    if (occupied.current || !["ready", "recover", "expired"].includes(phase)) return;
    occupied.current = true; const stamp = ++generation.current; const replacingExpired = phase === "expired";
    setError(""); setPhase("posting");
    let journal: AdmissionJournal;
    try {
      const saved = readAdmissionJournal(window.sessionStorage, window.location.origin);
      if (replacingExpired) {
        // The 410 acknowledgement ended this exact original request. Only this
        // deliberate button can replace it; mounting or a read never does.
        if (!pending || !saved || JSON.stringify(saved) !== JSON.stringify(pending)) throw new Error("The original expired request changed. Check the saved workbench before continuing.");
        clearAdmissionJournal(window.sessionStorage, saved);
        journal = newAdmissionJournal(window.location.origin);
      } else journal = saved ?? newAdmissionJournal(window.location.origin);
      writeAdmissionJournal(window.sessionStorage, journal); setPending(journal);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "This browser cannot save the recovery record. No request was sent."); setPhase("storage_hold"); occupied.current = false; return;
    }
    try {
      const response = await fetch("/api/workspace", { method: "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(journal.command) });
      const value = await response.json(); if (generation.current !== stamp) return;
      if (!response.ok) { setError(entryError(value, "The original Sample request was not acknowledged. Keep it for recovery.")); setPhase(response.status === 410 ? "expired" : "recover"); return; }
      const disposition = response.headers.get("x-worldkit-admission");
      if (response.headers.get("x-worldkit-admission-request") !== journal.command.requestId || !["created", "recovered", "existing"].includes(disposition ?? "") || ![200, 201].includes(response.status) || (response.status === 201) !== (disposition === "created")) throw new Error("The Sample acknowledgement could not be matched. Recover the same original request; do not create another one.");
      const workspace = parseEntryWorkspace(value);
      try { clearAdmissionJournal(window.sessionStorage, journal); } catch { /* The acknowledged workspace is usable; the exact receipt remains recoverable. */ }
      open.current(workspace);
    } catch (failure) { if (generation.current === stamp) { setError(failure instanceof Error ? failure.message : "The response was lost. Recover the original Sample request."); setPhase("recover"); } }
    finally { if (generation.current === stamp) occupied.current = false; }
  }
  const waiting = phase === "checking" || phase === "posting";
  return <div className={`boot-screen ${styles.entry}`}><header>{brand}<span className="eyebrow">MAKE THINGS WORK, TOGETHER.</span></header><main className={`boot-content ${styles.content}`}>
    <div className="boot-illustration" aria-hidden="true"><DeviceArt kind="microphone"/><DeviceArt kind="recorder"/><DeviceArt kind="headphones"/></div>
    <span className="eyebrow">YOUR NEXT GREAT SETUP STARTS HERE</span><h1>Good gear.<br/>Better together.</h1>
    <p className={styles.intro}>Plan a connected system. Trace the evidence. Change one piece and see what follows.</p>
    <div className={styles.card} aria-busy={waiting}>
      <span className={styles.label}><LockKeyhole size={15}/> Your private Sample workbench</span>
      <p>Start with a saved two-musician setup, then explore a desk or shared podcast. Sample gear and modelled checks stay clearly labelled.</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {phase === "checking" && <p role="status"><Busy text="Checking for your saved workbench…"/></p>}
      {phase === "posting" && <p role="status"><Busy text="Opening the original Sample request…"/></p>}
      {phase === "ready" && <button className="button" onClick={() => void start()}>Start Sample <ArrowRight size={16}/></button>}
      {phase === "recover" && <><p className={styles.recovery}>An original Sample request is saved in this browser. Recovery reopens that same workspace and keeps its original deadline.</p><button className="button" onClick={() => void start()}><RefreshCw size={15}/> Recover this Sample</button></>}
      {phase === "expired" && <><p className={styles.recovery}>The original saved workspace has expired. A new Sample will have its own separate history.</p><button className="button" onClick={() => void start()}>Start another Sample <ArrowRight size={16}/></button></>}
      {!waiting && <button className={`text-button ${styles.check}`} onClick={refresh}>Check saved workbench <RefreshCw size={13}/></button>}
      <p className={styles.boundary}><ShieldCheck size={14}/> Seven-day private workspace. Creating it uses no model calls, merchant purchase or real funds.</p>
    </div>
    <p className="fine-print">Real sources. Honest unknowns. Physical performance and human findings need their own evidence. <a href="/library" style={{ color: "inherit", textDecoration: "underline" }}>See the source-checked device library</a>.</p>
  </main></div>;
}
