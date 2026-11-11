"use client";
import { useEffect, useState } from "react";
import { ArrowRight, Check, Clock3, Fingerprint, History, LockKeyhole, RefreshCw, ScanLine, X } from "lucide-react";
import type { CommerceOrder } from "../../packages/commerce/contracts";
import type { ToolkitDesk, ToolkitReadInput, ToolkitReadRecord } from "../../packages/commerce/toolkit-contracts";
import { api, Busy, currency } from "./ui";
import { ModalFrame } from "./modal";

const labels = { get_order: "Order & capture", list_transactions: "Transaction report" };
const when = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
export function PaymentEvidence({ orders }: { orders: CommerceOrder[] }) {
  const [desk, setDesk] = useState<ToolkitDesk | null>(null), [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [opened, setOpened] = useState<ToolkitReadRecord | null>(null);
  const eligible = orders.filter(order => order.sourceMode === "live_sandbox" && order.captureId && order.providerOrderId && order.capturedMinor > 0);
  const chosen = eligible.find(order => order.id === selected) ?? eligible[0];
  useEffect(() => { let active = true; api<ToolkitDesk>("/api/payment-evidence").then(value => { if (active) setDesk(value); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  async function reload() { setError(""); try { setDesk(await api<ToolkitDesk>("/api/payment-evidence")); } catch (e) { setError(e instanceof Error ? e.message : "Saved evidence could not be loaded."); } }
  async function read(operation: ToolkitReadInput["operation"]) {
    if (!chosen || busy || !desk?.available) return; setBusy(true); setError("");
    try {
      const result = await api<{ record: ToolkitReadRecord; desk: ToolkitDesk }>("/api/payment-evidence", "POST", { requestId: crypto.randomUUID(), orderId: chosen.id, expectedGraphHash: chosen.graphHash, operation });
      setDesk(result.desk); setOpened(result.record);
    } catch (e) { setError(e instanceof Error ? e.message : "The read did not finish. Refresh saved observations before starting another."); }
    finally { setBusy(false); }
  }
  return <section className="payment-evidence" aria-labelledby="payment-evidence-title">
    <div className="payment-evidence-intro"><span className="eyebrow">THE RECEIPT, THEN THE LATEST WORD</span><h3 id="payment-evidence-title">Ask the source.</h3><p>Keep the receipt you paid against. Add a separate observation of what PayPal reports now, tied to that same setup.</p><span className="payment-read-boundary"><LockKeyhole size={14}/> Read only · no charge or refund</span></div>
    <div className="payment-evidence-controls">
      <label htmlFor="payment-evidence-order">Your captured sandbox order</label>
      <select id="payment-evidence-order" value={chosen?.id ?? ""} onChange={e => setSelected(e.target.value)} disabled={busy || !eligible.length}>
        {!eligible.length && <option value="">No captured sandbox order yet</option>}
        {eligible.map(order => <option key={order.id} value={order.id}>{when(order.createdAt)} · {currency(order.capturedMinor)} · {order.id.slice(0, 8)}</option>)}
      </select>
      <p className="fine-print">{desk?.message ?? "Loading saved evidence…"}</p>
      <div className="payment-evidence-actions"><button className="button" disabled={busy || !chosen || !desk?.available} onClick={() => void read("get_order")}><ScanLine size={16}/> Read order <ArrowRight size={15}/></button><button className="button subtle" disabled={busy || !chosen || !desk?.available} onClick={() => void read("list_transactions")}><History size={16}/> Read reporting page</button></div>
      {busy && <div role="status"><Busy text="Reading the exact owned resource…"/></div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <div className="payment-observation-list"><header><span className="mini-label">SAVED OBSERVATIONS · LATEST 20</span><button className="text-button" disabled={busy} onClick={() => void reload()}><RefreshCw size={13}/> Refresh saved list</button></header>
      {desk && !desk.records.length && <p className="payment-evidence-empty">Your first read will appear here. Opening this panel does not call PayPal.</p>}
      {desk?.records.map(record => <button className="payment-observation-row" key={record.id} onClick={() => setOpened(record)}><span className={`payment-observation-symbol ${record.state}`}>{record.state === "succeeded" ? <Check size={16}/> : <Clock3 size={16}/>}</span><span><b>{labels[record.operation]}</b><small>{when(record.createdAt)} · {record.orderId.slice(0, 8)}</small></span><span className="payment-observation-state">{record.state === "succeeded" ? record.observation?.source === "synthetic_transport" ? "Synthetic transport" : "Sandbox observation" : record.state === "failed" ? "Read incomplete" : "Awaiting saved result"}</span><ArrowRight size={15}/></button>)}
    </div>
    {opened && <ObservationDialog record={opened} onClose={() => setOpened(null)}/>}
  </section>;
}
function ObservationDialog({ record, onClose }: { record: ToolkitReadRecord; onClose: () => void }) {
  const receipt = record.observation, report = receipt?.reporting;
  return <ModalFrame labelledBy="payment-observation-title" onClose={onClose} className="payment-observation-dialog">
    <header className="payment-observation-heading"><span className="eyebrow">SAVED SOURCE OBSERVATION</span><button className="icon-button" aria-label="Close payment observation" onClick={onClose}><X size={20}/></button></header>
    <Fingerprint size={30}/><h3 id="payment-observation-title">{labels[record.operation]}</h3><p>{record.message}</p>
    {receipt && <><div className="payment-observation-result"><span>{receipt.source === "synthetic_transport" ? "SYNTHETIC TRANSPORT · NO PROVIDER CALL" : "PAYPAL SANDBOX"}</span><strong>{receipt.order ? receipt.order.captureStatus.replaceAll("_", " ") : report?.observed ? `Reporting status ${report.status}` : "Not observed on this page"}</strong><p>{receipt.order ? `Order ${receipt.order.status.replaceAll("_", " ")} · capture ${currency(receipt.order.amountMinor)}` : report?.observed ? `${currency(report.amountMinor!)} capture observed in one bounded page.` : "Reporting can lag. An empty page does not prove that a payment or refund is missing."}</p></div>
      <p className="fine-print">{receipt.disclosure}</p>
      <dl className="key-values"><div><dt>Observed</dt><dd>{when(receipt.observedAt)}</dd></div><div><dt>Saved graph</dt><dd><code>{receipt.binding.graphHash}</code></dd></div><div><dt>Saved revision</dt><dd><code>{receipt.binding.revisionId}</code></dd></div><div><dt>Provider order</dt><dd><code>{receipt.binding.providerOrderId}</code></dd></div><div><dt>Owned capture</dt><dd><code>{receipt.binding.captureId}</code></dd></div>{report && <><div><dt>Reporting window</dt><dd>{when(report.start)} — {when(report.end)}</dd></div><div><dt>Coverage</dt><dd>Page 1 · up to 100 rows · completeness not asserted</dd></div><div><dt>Provider refreshed</dt><dd>{report.refreshedAt ? when(report.refreshedAt) : "Not supplied"}</dd></div></>}<div><dt>Evidence digest</dt><dd><code>{receipt.bodyHash}</code></dd></div><div><dt>Read mechanism</dt><dd>{receipt.package}</dd></div></dl></>}
    <p className="keep-note"><LockKeyhole size={15}/> This read changes no financial state and grants no purchase permission.</p>
    <button className="button full subtle" onClick={onClose}>Back to saved observations</button>
  </ModalFrame>;
}
