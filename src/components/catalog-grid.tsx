"use client";
import { ArrowRight, Radio, Sparkles } from "lucide-react";
import type { CatalogSnapshot, DeviceKind } from "../../packages/contracts/index";
import { DeviceArt } from "./device-art";
import { currency } from "./ui";

const inferKind = (title: string): DeviceKind => /microphone|sm58|at2020/i.test(title) ? "microphone" : /headphone/i.test(title) ? "headphones" : /hub|dock/i.test(title) ? "hub" : /camera|zv-e/i.test(title) ? "camera" : /interface|scarlett/i.test(title) ? "interface" : /cam.?link|capture/i.test(title) ? "capture" : "recorder";
export function CatalogGrid({ products, busy = false, onSelect, onSimilar }: { products: CatalogSnapshot[]; busy?: boolean; onSelect: (product: CatalogSnapshot) => void; onSimilar?: (product: CatalogSnapshot) => void }) {
  return <div className="product-grid">{products.map(product => {
    const available = product.offers.filter(offer => offer.price && offer.availability === "InStock"); const cheapest = available.length ? Math.min(...available.map(offer => offer.price!.minor)) : null;
    return <article className="catalog-card" key={product.id}><div className="catalog-art"><span>ORIGINAL DIAGRAM</span><DeviceArt kind={inferKind(product.title)} model={product.title}/><span className="catalog-source"><Radio size={10}/> Catalog result</span></div><div className="catalog-card-content"><span className="mini-label">{product.brand || "Brand not returned"}</span><h3>{product.title}</h3><p>{product.selectedOptions.map(option => `${option.name}: ${option.value}`).join(" · ") || "Check the exact model and options in current details."}</p><div className="catalog-price"><b>{cheapest === null ? "Refresh availability" : currency(cheapest)}</b><span>{available.length ? `from ${available.length} in-stock ${available.length === 1 ? "offer" : "offers"}` : "No in-stock USD price"}</span></div><footer><button className="text-button" disabled={busy} onClick={() => onSelect(product)}>Review exact product <ArrowRight size={14}/></button>{onSimilar && <button className="icon-button" disabled={busy} onClick={() => onSimilar(product)} aria-label={`Find alternatives to ${product.title}`}><Sparkles size={16}/></button>}</footer></div></article>;
  })}</div>;
}
