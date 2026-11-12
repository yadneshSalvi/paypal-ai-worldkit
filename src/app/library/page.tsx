import Link from "next/link";
import type { Metadata } from "next";
import dossierFile from "../../../packages/device-library/curated/library.json";
import checksFile from "../../../packages/device-library/source-checks.json";
import type { Dossier, SourceCheckFile } from "../../../packages/device-library/source-check-contract";
import { SOURCE_CHECK_LABEL } from "../../../packages/contracts/index";

export const metadata: Metadata = { title: "WorldKit — Source-checked device library", description: "Seventeen real devices, every claim tied to a manufacturer passage and cross-checked by an independent model. Not a human review." };
const dossier = dossierFile as unknown as Dossier, checks = checksFile as unknown as SourceCheckFile;
const kinds: Record<string, string> = { microphone: "Microphone", recorder: "Recorder", mixer: "Mixer / recorder", interface: "Audio interface", camera: "Camera", capture: "Capture", host: "Tablet", hub: "Hub", power: "Charger", headphones: "Headphones", cable: "Cable" };
const words = (value: string) => value.replace(/^carries:/, "carries ").replace(/_/g, " ").replace(/([a-z])([A-Z0-9])/g, "$1 $2").toLowerCase();
const shown = (value: unknown, unit: string | null) => `${value === true ? "Yes" : value === false ? "No" : String(value)}${unit && unit !== "count" ? ` ${unit}` : ""}`;
const card = { background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 14, padding: "22px 24px", marginTop: 18 } as const;
const chip = (ok: boolean) => ({ display: "inline-block", fontSize: 10, padding: "2px 8px", borderRadius: 999, border: `1px solid ${ok ? "#cfe0c6" : "#e6dcc3"}`, background: ok ? "#f3f8ee" : "#fbf7ea", color: ok ? "#3f5f33" : "#7a6325", whiteSpace: "nowrap" as const });

export default function LibraryPage() {
  const verdict = (id: string) => checks.items.find(item => item.id === id);
  const checkedOn = new Date(checks.ranAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return <main style={{ maxWidth: 980, margin: "0 auto", padding: "44px 22px 80px" }}>
    <Link href="/" style={{ color: "var(--muted)", fontSize: 12 }}>← Back to WorldKit</Link>
    <p className="eyebrow" style={{ marginTop: 26 }}>EVIDENCE · DEVICE LIBRARY</p>
    <h1 style={{ fontFamily: "var(--font-heading)", fontSize: 34, lineHeight: 1.15, margin: "6px 0 10px", color: "var(--green)" }}>Real devices. Their makers&rsquo; own words.</h1>
    <p style={{ fontSize: 15, maxWidth: 720 }}>Each claim below is tied to a passage quoted from the manufacturer&rsquo;s (or app publisher&rsquo;s) own document. A script first finds the quote word for word in the retained source text. Then a second, independent model reads it in context and decides whether it really establishes the value for that exact device.</p>
    <section style={{ ...card, background: "#f5f9ef", borderColor: "#d7e3d0" }} aria-label="What this tier means">
      <b style={{ fontSize: 14 }}>{SOURCE_CHECK_LABEL}</b>
      <p style={{ margin: "6px 0 0" }}>{checks.summary.confirmed} of {checks.summary.items} claims across {checks.summary.devices} devices were confirmed on {checkedOn}; {checks.summary.insufficient + checks.summary.quoteNotFound + checks.summary.notRun} were left unconfirmed because the passage did not establish them, and {checks.summary.refuted} were refuted. Claims were proposed by {dossier.extractor.replace(/ \(.*/, "")} and checked by {checks.checker.replace("google:", "Google ")}. This is a model cross-check against cited sources. It is not a human review and not a physical test, and the workbench certificate does not count it yet: there, facts stay open until a person reviews them.</p>
    </section>
    {dossier.devices.map(device => {
      const rows = [...device.facts.map(fact => ({ key: `${device.id}:fact:${fact.property}`, name: words(fact.property), value: shown(fact.value, fact.unit), quote: fact.quote, sourceId: fact.sourceId, conditions: fact.conditions })),
        ...device.operatingModes.map(mode => ({ key: `${device.id}:mode:${mode.id}`, name: "operating mode", value: mode.label, quote: mode.quote, sourceId: mode.sourceId, conditions: [] as string[] })),
        ...device.ports.map(port => ({ key: `${device.id}:port:${port.id}`, name: `connection · ${port.label.toLowerCase()}`, value: port.connector, quote: port.quote, sourceId: port.sourceId, conditions: [] as string[] }))];
      const confirmed = rows.filter(row => verdict(row.key)?.verdict === "confirmed").length;
      return <section key={device.id} style={card} aria-labelledby={`device-${device.id}`}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
          <h2 id={`device-${device.id}`} style={{ fontFamily: "var(--font-heading)", fontSize: 19, margin: 0 }}>{device.manufacturer} {device.model}</h2>
          <span style={chip(confirmed === rows.length)}>{confirmed} of {rows.length} confirmed</span>
        </div>
        <p className="secondary" style={{ margin: "2px 0 12px" }}>{kinds[device.kind] ?? device.kind} · {device.variant}</p>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map(row => { const result = verdict(row.key), ok = result?.verdict === "confirmed", source = device.sources.find(item => item.id === row.sourceId);
            return <li key={row.key} style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
              <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
                <span><b>{row.name}</b>: {row.value}</span>
                <span style={chip(ok)}>{ok ? "Confirmed by the independent check" : "Not confirmed · WorldKit won’t count it"}</span>
              </div>
              <blockquote style={{ margin: "6px 0 4px", paddingLeft: 12, borderLeft: "2px solid var(--line)", color: "#4d5a48", whiteSpace: "pre-line" }}>&ldquo;{row.quote}&rdquo;</blockquote>
              <small className="secondary">{source ? <a href={source.url} rel="noreferrer noopener" target="_blank" style={{ color: "inherit" }}>{source.publisher} · {source.title}</a> : null}{row.conditions.length ? ` · Conditions: ${row.conditions.join("; ")}` : ""}{!ok && result ? ` · Checker: ${result.reason}` : ""}</small>
            </li>; })}
        </ul>
        {device.unknowns.length ? <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <b>WorldKit won&rsquo;t guess</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{device.unknowns.map(item => <li key={item.property}>{words(item.property)}: {item.reason}</li>)}</ul>
        </div> : null}
      </section>; })}
    <p className="fine-print" style={{ marginTop: 26 }}>Sources are linked and quoted briefly; the original documents are not redistributed. Physical performance has not been tested.</p>
  </main>;
}
