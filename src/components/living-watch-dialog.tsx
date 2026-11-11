"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, Check, Fingerprint, RefreshCw, X } from "lucide-react";
import type { CatalogSnapshot, FreshCatalogProduct } from "../../packages/contracts";
import type { InventoryItem } from "../../packages/inventory/contracts";
import type { LivingView } from "../../packages/living-kit/contracts";
import { DeviceArt } from "./device-art";
import { ModalFrame } from "./modal";
import { api, Busy, currency, shortTime } from "./ui";

export function WatchDialog({ items, ready, onClose, onEquipment, onSaved }: { items: InventoryItem[]; ready: boolean; onClose: () => void; onEquipment: () => void; onSaved: (view: LivingView) => void }) {
  const [itemId, setItemId] = useState(items[0]?.id ?? ""); const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null); const [domains, setDomains] = useState<string[]>([]); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const requestId = useRef<string | null>(null); const selection = useRef(0); const mounted = useRef(true); const item = items.find(value => value.id === itemId);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; selection.current++; }; }, []);
  function chooseItem(id: string) { selection.current++; setItemId(id); setSnapshot(null); setDomains([]); setError(""); setBusy(""); requestId.current = null; }
  async function currentOffers() {
    if (!item?.profile.catalogId) return; const sequence = ++selection.current; setBusy("offers"); setError("");
    try {
      const result = await api<FreshCatalogProduct>("/api/catalog", "POST", { kind: "details", productId: item.profile.catalogId, selectedOptions: Object.fromEntries(item.profile.selectedOptions.map(option => [option.name, option.value])) });
      if (sequence === selection.current && mounted.current) { setSnapshot(result.snapshot); setDomains(result.snapshot.offers[0] ? [result.snapshot.offers[0].domain.toLowerCase()] : []); requestId.current = null; }
    } catch (error) { if (sequence === selection.current && mounted.current) setError(error instanceof Error ? error.message : "Current offers could not be checked."); }
    finally { if (sequence === selection.current && mounted.current) setBusy(""); }
  }
  async function save() {
    if (!item || !domains.length || !snapshot || !ready || busy) return; requestId.current ??= crypto.randomUUID(); setBusy("save"); setError("");
    try { const result = await api<LivingView>("/api/living-kit", "POST", { kind: "start_watch", requestId: requestId.current, itemId: item.id, expectedVersion: item.version, domains }); if (mounted.current) onSaved(result); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "The alert could not be saved. Your original request can be retried."); }
    finally { if (mounted.current) setBusy(""); }
  }
  const merchants = [...new Map((snapshot?.offers ?? []).map(offer => [offer.domain.toLowerCase(), offer])).values()];
  return <ModalFrame onClose={onClose} labelledBy="living-watch-title" className="living-dialog">
    <header><span className="eyebrow">FOLLOW THE EXACT PIECE</span><button className="icon-button" aria-label="Close equipment alert" onClick={onClose}><X size={19}/></button></header>
    <div className="living-dialog-icon"><Bell size={23}/></div><h2 id="living-watch-title">A quiet eye on your kit.</h2><p>Choose a saved catalog item, check its current offers, then select the merchants you want to follow.</p>
    {items.length ? <><label htmlFor="living-item">Equipment<select id="living-item" value={itemId} onChange={event => chooseItem(event.target.value)} disabled={Boolean(busy)}>{items.map(item => <option key={item.id} value={item.id}>{item.profile.model} · {item.ownership === "owned" ? "Owned" : "Planned"} · v{item.version}</option>)}</select></label>
      {item && <div className="living-confirmed-item"><DeviceArt kind={item.profile.kind}/><div><b>{item.profile.manufacturer} {item.profile.model}</b><span>{item.profile.variant}</span><small>Saved identity · version {item.version} · {item.ownership === "owned" ? "ownership confirmed" : "planned equipment"}</small></div></div>}
      <button className="button subtle full" disabled={Boolean(busy)} onClick={() => void currentOffers()}><RefreshCw size={14}/>{snapshot ? "Refresh current offers" : "Check current offers"}</button>
      {snapshot && <><div className="living-offer-checked"><Check size={13}/><span>Checked {shortTime(snapshot.observedAt)} · {snapshot.variantExact ? "exact variant" : "variant needs review"}</span></div>
        {merchants.length ? <fieldset className="living-merchant-options"><legend>Merchants to follow</legend>{merchants.map(offer => <label key={offer.domain}><input type="checkbox" checked={domains.includes(offer.domain.toLowerCase())} disabled={Boolean(busy)} onChange={event => { const domain = offer.domain.toLowerCase(); setDomains(previous => event.target.checked ? [...previous, domain] : previous.filter(value => value !== domain)); requestId.current = null; }}/><span><b>{offer.retailer}</b><small>{offer.domain} · {offer.availability === "InStock" ? "In stock" : offer.availability === "OutOfStock" ? "Out of stock" : "Availability unknown"}</small></span><strong>{offer.price ? currency(offer.price.minor) : "Price unknown"}</strong></label>)}</fieldset> : <p className="living-inline-note">No current merchant offers were returned for this exact selection.</p>}
        <p className="fine-print">Prices shown in USD. Shipping and landed cost are unknown. Stock is not reserved.</p></>}
      {!ready && <p className="living-inline-note">Equipment alerts are awaiting delivery endpoint setup. Your current offers remain available to review.</p>}
      <button className="button full" disabled={!ready || !snapshot?.variantExact || !domains.length || Boolean(busy)} onClick={() => void save()}><Bell size={14}/> Save {domains.length ? `${domains.length}-merchant ` : ""}alert</button><p className="fine-print">Watch price, stock, new offers and removed offers for this saved variant. You can stop your workspace alert at any time.</p>
    </> : <div className="living-dialog-empty"><Fingerprint size={27}/><h3>Your equipment comes first.</h3><p>Save an exact catalog identity in your equipment passport to start an alert.</p><button className="button" onClick={onEquipment}>Open equipment passport <ArrowRight size={14}/></button></div>}
    {busy && <Busy text={busy === "offers" ? "Checking the exact current offers…" : "Saving the alert request…"}/>}<p className="living-dialog-error" role="alert">{error}</p>
  </ModalFrame>;
}
