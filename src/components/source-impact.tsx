"use client";
import { useEffect, useId, useState } from "react";
import { ArrowRight, FileSearch, GitBranch, RefreshCw } from "lucide-react";
import type { SourceImpactReport } from "../../packages/spec-evidence/impact";
import { api, Busy, downloadJSON } from "./ui";

const stateLabel = {
  same_document: "Same source content", changed_document: "A different source version",
  unavailable_document: "Source copy unavailable", incomplete_binding: "Exact source binding incomplete",
};
export function SourceImpactView({ profileId, documentId, version }: { profileId: string; documentId: string; version: string }) {
  const [report, setReport] = useState<SourceImpactReport | null>(null), [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0), heading = useId();
  useEffect(() => {
    let active = true; setReport(null); setError("");
    const query = new URLSearchParams({ profileId }); if (documentId) query.set("documentId", documentId);
    void api<SourceImpactReport>(`/api/evidence/impact?${query}`).then(value => { if (active) setReport(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "The source dependencies could not be read."); });
    return () => { active = false; };
  }, [profileId, documentId, version, refresh]);
  const changed = report?.impacts.filter(impact => impact.state !== "same_document").length ?? 0;
  return <section className="source-impact" aria-labelledby={heading}>
    <header><div><span className="mini-label">04 / FOLLOW THE CONSEQUENCES</span><h4 id={heading}>One source. A wider story.</h4></div><GitBranch size={25} strokeWidth={1.3} aria-hidden="true"/></header>
    <p>A source change can reach beyond one piece of equipment. Trace its saved dependencies before deciding what needs another review.</p>
    {error ? <div className="research-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => setRefresh(value => value + 1)}>Try again</button></div> : !report ? <Busy text="Tracing saved source dependencies…"/> : <>
      <div className="source-impact-origin"><FileSearch size={22} aria-hidden="true"/><div><strong>{report.source.model}</strong><span>{report.source.variant}</span><small>{report.source.documentId ? report.source.current ? "Current private source" : "Selected historical private source" : "Pinned library source"} · {report.source.status === "available" ? "content available" : "copy unavailable"}</small><code>{report.source.contentHash?.slice(0, 20) ?? "No confirmed fingerprint"}</code></div></div>
      <div className="source-impact-counts"><div><strong>{report.impacts.length}</strong><span>saved revisions refer to this model</span></div><div><strong>{changed}</strong><span>source comparisons need attention</span></div></div>
      <p className="source-impact-boundary">A changed document is a reason to investigate. It does not prove a change in hardware behavior. These are review targets; every historical certificate keeps its original result.</p>
      {!report.coverage.complete && <p className="research-error" role="status">Inspected {report.coverage.revisionsInspected} of {report.coverage.totalSavedRevisions} saved revisions, prioritizing current kits and then recent history. Other dependencies are outside this report.</p>}
      {report.impacts.length === 0 ? <p className="source-impact-empty">No use of this exact model was found in the inspected kit revisions. A similar model or another generation is not treated as a match.</p> : <div className="source-impact-revisions">{report.impacts.map(impact => <details key={impact.revisionId}>
        <summary><div><small>{impact.current ? "CURRENT KIT" : "SAVED HISTORY"} · REVISION {impact.revision}</small><strong>{impact.title}</strong><span data-state={impact.state}>{stateLabel[impact.state]}</span></div><ArrowRight size={18} aria-hidden="true"/></summary>
        <div className="source-impact-detail"><p>{impact.componentIds.length} component {impact.componentIds.length === 1 ? "instance" : "instances"} · {impact.paths.length} enabled connection {impact.paths.length === 1 ? "target" : "targets"} · {impact.requirements.length} requirement {impact.requirements.length === 1 ? "witness" : "witnesses"}</p>
          <h5>Follow the enabled paths</h5>{impact.paths.length ? <ol className="source-impact-paths">{impact.paths.map(path => <li key={path.id}><div><strong>{path.from}</strong><ArrowRight size={13} aria-hidden="true"/><strong>{path.to}</strong></div><span>{path.cable}</span><small>{path.signal} · {path.direct ? "Direct connection" : "Downstream review target"}</small></li>)}</ol> : <p>No enabled connection depends on this component in the saved graph. Its port map may still be incomplete.</p>}
          <h5>Requirements to revisit</h5>{impact.requirements.length ? <ul className="source-impact-requirements">{impact.requirements.map(item => <li key={item.witnessId}><span>{item.title}</span><small>Historical result: {item.historicalStatus}</small></li>)}</ul> : <p>No matching requirement witness was recorded. That is not a new compatibility verdict.</p>}
          <details className="source-impact-facts"><summary>{impact.facts.length} exact fact records and source bindings</summary><ul>{impact.facts.map(fact => <li key={fact.id}><strong>{fact.property.replace(/([a-z])([A-Z])/g, "$1 $2")}</strong><span>{fact.sourceBound ? "Bound to the saved source" : "Exact source link not established"} · {fact.review} review{fact.critical ? " · critical" : ""}</span></li>)}</ul></details>
          <div className="source-impact-history"><strong>Historical certificate preserved</strong><span>Recorded {new Date(impact.historicalCertificate.issuedAt).toLocaleDateString()} · {impact.historicalCertificate.status}</span><code>Graph {impact.historicalCertificate.graphHash.slice(0, 20)}</code><code>Source {impact.historicalCertificate.sourceHash.slice(0, 20)}</code><span>{impact.previousHashes.length ? `Saved document: ${impact.previousHashes.map(value => value.slice(0, 12)).join(" · ")}` : "No exact document fingerprint was recorded in this profile."}</span></div>
        </div>
      </details>)}</div>}
      <footer><span>{report.coverage.revisionsInspected} saved revisions inspected · no records changed</span><div><button className="text-button" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13}/> Refresh trace</button><button className="text-button" onClick={() => downloadJSON(report, `worldkit-source-impact-${profileId}.json`)}>Download private trace</button></div></footer>
    </>}
  </section>;
}
