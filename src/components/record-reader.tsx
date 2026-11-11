"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft, ArrowRight, BookOpen, CircleHelp, Download, Fingerprint, Globe2, LockKeyhole, Printer, RefreshCw } from "lucide-react";
import type { PublicRecordView } from "../../packages/public-record";
import { RecordContents, recordApiPath, recordPath, type RecordMode } from "./record-content";

export function RecordReader({ initialView, slug, edition, mode }: { initialView: PublicRecordView; slug: string; edition?: number; mode: RecordMode }) {
  const [view, setView] = useState<PublicRecordView | null>(initialView), [checking, setChecking] = useState(false), [error, setError] = useState("");
  const [paper, setPaper] = useState<"A4" | "Letter">("A4"), [printBlocked, setPrintBlocked] = useState(false), [printing, setPrinting] = useState(false);
  const sequence = useRef(0), lastChecked = useRef(Date.parse(initialView.checkedAt)), mounted = useRef(true), openedForPrint = useRef<HTMLDetailsElement[]>([]);
  const refresh = useCallback(async (hide = false) => {
    const turn = ++sequence.current;
    if (hide) setChecking(true);
    try {
      const path = `/api/public-records/${encodeURIComponent(slug)}${edition === undefined ? "" : `/e/${edition}`}`;
      const response = await fetch(path, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(10000), headers: { Accept: "application/json" } });
      const value = await response.json() as PublicRecordView;
      if (!response.ok && ![404, 410].includes(response.status) || !["published", "withdrawn", "unavailable"].includes(value.state)) throw new Error("Sharing status is temporarily unavailable.");
      if (mounted.current && turn === sequence.current) { lastChecked.current = Date.now(); setView(value); setError(""); setChecking(false); }
      return value;
    } catch {
      if (mounted.current && turn === sequence.current) { setView(null); setError("We cannot confirm that this edition is still shared. Its content is hidden until the connection is restored."); setChecking(false); }
      return null;
    }
  }, [slug, edition]);
  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    const freshness = window.setInterval(() => { if (Date.now() - lastChecked.current > 30000) { setView(null); setError("Sharing status needs a fresh check. Reconnect to open this edition."); } }, 1000);
    const focus = () => { void refresh(true); };
    const visibility = () => { if (document.hidden) { ++sequence.current; setChecking(true); } else focus(); };
    const offline = () => { ++sequence.current; setView(null); setChecking(false); setError("You are offline. Reconnect to check this edition’s current sharing state."); };
    const pageshow = () => { flushSync(() => setChecking(true)); void refresh(); };
    window.addEventListener("focus", focus); window.addEventListener("pageshow", pageshow); window.addEventListener("online", focus); window.addEventListener("offline", offline); document.addEventListener("visibilitychange", visibility);
    return () => { mounted.current = false; ++sequence.current; clearInterval(timer); clearInterval(freshness); window.removeEventListener("focus", focus); window.removeEventListener("pageshow", pageshow); window.removeEventListener("online", focus); window.removeEventListener("offline", offline); document.removeEventListener("visibilitychange", visibility); };
  }, [refresh]);
  useEffect(() => {
    if (!view?.expiresAt) return;
    const timer = window.setTimeout(() => { ++sequence.current; setView(null); setChecking(false); setError("The sharing session has ended. This edition is no longer available publicly."); }, Math.max(0, Date.parse(view.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [view?.expiresAt]);
  useEffect(() => {
    const before = () => {
      const allowed = view?.state === "published" && !checking && Date.now() - lastChecked.current < 30000 && (!view.expiresAt || Date.parse(view.expiresAt) > Date.now());
      flushSync(() => setPrintBlocked(!allowed));
      openedForPrint.current = Array.from(document.querySelectorAll<HTMLDetailsElement>(".record-paper details:not([open])"));
      for (const details of openedForPrint.current) details.open = true;
    };
    const after = () => { for (const details of openedForPrint.current) details.open = false; openedForPrint.current = []; setPrinting(false); setPrintBlocked(false); };
    window.addEventListener("beforeprint", before); window.addEventListener("afterprint", after);
    return () => { window.removeEventListener("beforeprint", before); window.removeEventListener("afterprint", after); };
  }, [view, checking]);
  async function print() {
    setPrinting(true); const current = await refresh(true);
    if (current?.state === "published") { flushSync(() => { setView(current); setChecking(false); setPrintBlocked(false); }); requestAnimationFrame(() => window.print()); }
    else setPrinting(false);
  }
  const active = !checking && view?.state === "published" && view.record && (!view.expiresAt || Date.parse(view.expiresAt) > Date.now());
  return <div className={`record-reader ${printBlocked ? "record-print-blocked" : ""}`}><style>{`@page { size: ${paper}; margin: 12mm; }`}</style><a className="skip-link" href="#public-record">Skip to the certificate</a><header className="record-public-header no-print"><a href="/" aria-label="WorldKit workbench"><span className="record-wordmark">worldkit</span></a><span><Globe2 size={14}/> Shared verification record</span><a href="/verification">What verified means <ArrowRight size={13}/></a></header>
    <main id="public-record">{active && view?.record ? <><div className="record-public-toolbar no-print"><nav aria-label="Shared record views"><a href={recordPath(view.record)} aria-current={mode === "certificate" ? "page" : undefined}><Fingerprint size={15}/> Certificate</a><a href={`${recordPath(view.record)}/guide`} aria-current={mode === "guide" ? "page" : undefined}><BookOpen size={15}/> Assembly guide</a><a href={`${recordPath(view.record)}/print`} aria-current={mode === "print" ? "page" : undefined}><Printer size={15}/> Complete print view</a></nav><div className="record-print-tools"><label><span className="sr-only">Print paper size</span><select value={paper} onChange={event => setPaper(event.target.value as typeof paper)}><option value="A4">A4</option><option value="Letter">Letter</option></select></label><button className="button subtle" disabled={printing} onClick={() => void print()}><Printer size={15}/>{printing ? "Checking…" : "Print"}</button><a className="button subtle" href={recordApiPath(view.record)} target="_blank" rel="noopener noreferrer"><Download size={14}/> JSON</a></div></div>
      <div className="record-public-state"><span><span className="record-live-dot"/> Shared now · edition {view.record.edition}</span><p>{view.revisionState === "superseded" ? "A newer private kit revision exists. This edition preserves the earlier saved results." : "This edition identifies the current saved kit revision."}{view.sourceState === "changed" ? " A source version has changed since preparation; these historical results have not been rerun." : ""}</p></div>
      <RecordContents record={view.record} mode={mode} publicUrl={view.editionUrl}/>
      <p className="record-refresh-note no-print"><RefreshCw size={13}/> Sharing is checked every 15 seconds and when you return. A lost connection hides the record. Printed and downloaded copies cannot be recalled.</p>
    </> : <section className="record-unavailable" role="status"><span><LockKeyhole size={30} strokeWidth={1.3}/></span><span className="record-kicker">WORLDKIT VERIFICATION RECORD</span><h1>{checking ? "Checking current access." : view?.state === "withdrawn" ? "This edition is no longer shared." : error ? "Let’s check the connection." : "This record is unavailable."}</h1><p>{checking ? "Confirming that this exact edition is still shared before displaying its contents." : error || (view?.state === "withdrawn" ? "Its public certificate, guide, QR and print views are closed. The owner may retain a private history. A saved copy cannot establish current sharing or technical validity." : "The address may be incomplete, private, or unknown. No certificate content is available here.")}</p><button className="button" onClick={() => void refresh(true)} disabled={checking}><RefreshCw size={15}/> Check sharing state</button><a href="/verification"><CircleHelp size={14}/> Read what verified means</a></section>}</main>
    <div className="record-print-denial print-only"><h1>Sharing could not be confirmed.</h1><p>Open this edition online and check its current status before printing. No certificate content is included in this copy.</p></div><footer className="record-public-footer no-print"><span>WORLDKIT</span><span>One saved graph. Clearly scoped evidence.</span><a href="/"><ArrowLeft size={13}/> Open a private workbench</a></footer>
  </div>;
}
