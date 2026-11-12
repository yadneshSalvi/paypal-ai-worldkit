/** Captures one Channel3 offer observation per library device and saves it as WorldKit Studio's sandbox listing.
 *
 * A captured price is an observation at `observedAt`, not a live quote, a reservation or a retailer order.
 * A device is priced only when the returned product title names the exact model; otherwise it stays unmatched
 * and the application refuses to quote it.
 *
 *   node --env-file=.env --import tsx scripts/capture-price-book.ts [--device <id>]...
 */
import { readFile, writeFile } from "node:fs/promises";
import { searchProducts, CatalogFailure } from "../packages/channel3/client";
import type { CatalogSnapshot } from "../packages/contracts/index";
import type { PriceBook, PriceBookEntry } from "../packages/device-library/pricing";

type Target = { id: string; query: string; must: string[]; any?: string[]; reject?: string[]; minMinor: number; maxMinor: number };
/** Plausibility bounds stop an accessory, bundle or mislabelled listing from standing in for the device. */
const targets: Target[] = [
  { id: "shure-sm58-lc", query: "Shure SM58-LC dynamic vocal microphone", must: ["shure", "sm58"], reject: ["wireless", "bundle", "kit", "pack", "sm58s", "cable", "stand", "beta", "windscreen", "grille", "clip", "used"], minMinor: 7000, maxMinor: 14000 },
  { id: "rode-podmic", query: "RODE PodMic dynamic podcasting microphone XLR", must: ["podmic"], reject: ["usb", "bundle", "kit", "arm", "stand", "white", "used"], minMinor: 6000, maxMinor: 14000 },
  { id: "at2020-xlr", query: "Audio-Technica AT2020 cardioid condenser XLR microphone", must: ["at2020"], reject: ["usb", "at2020usb", "bundle", "kit", "pack", "at2020v", "at2020pk", "used"], minMinor: 6000, maxMinor: 14000 },
  { id: "zoom-h4essential", query: "Zoom H4essential handy recorder", must: ["zoom", "h4essential"], reject: ["bundle", "kit", "case", "accessory", "pack", "used"], minMinor: 12000, maxMinor: 30000 },
  { id: "zoom-h6essential", query: "Zoom H6essential handy recorder", must: ["zoom", "h6essential"], reject: ["bundle", "kit", "case", "accessory", "pack", "used"], minMinor: 20000, maxMinor: 45000 },
  { id: "zoom-podtrak-p4", query: "Zoom PodTrak P4 podcast recorder", must: ["zoom", "p4"], reject: ["bundle", "kit", "case", "pack", "p4next", "next", "used"], minMinor: 9000, maxMinor: 26000 },
  { id: "zoom-livetrak-l8", query: "Zoom LiveTrak L-8 digital mixer recorder", must: ["zoom", "l-8"], reject: ["bundle", "kit", "case", "bag", "pack", "used"], minMinor: 25000, maxMinor: 60000 },
  { id: "focusrite-2i2-4", query: "Focusrite Scarlett 2i2 4th Gen USB audio interface", must: ["scarlett", "2i2", "4th"], reject: ["bundle", "studio", "kit", "pack", "3rd", "used"], minMinor: 12000, maxMinor: 26000 },
  { id: "elgato-camlink-4k", query: "Elgato Cam Link 4K HDMI capture", must: ["elgato", "cam link"], reject: ["pro", "bundle", "kit", "used", "neo"], minMinor: 6000, maxMinor: 16000 },
  { id: "anker-555-a8383", query: "Anker 555 USB-C Hub 8-in-1 A8383", must: ["anker", "8-in-1"], any: ["555", "a8383", "powerexpand"], reject: ["bundle", "used"], minMinor: 3000, maxMinor: 12000 },
  { id: "anker-735-a2668", query: "Anker 735 Charger GaNPrime 65W A2668", must: ["anker", "65w"], any: ["735", "a2668", "ganprime"], reject: ["bundle", "used", "cable only"], minMinor: 2500, maxMinor: 9000 },
  { id: "hosa-hmic010", query: "Hosa HMIC-010 Pro Microphone Cable XLR 10 ft", must: ["hosa", "hmic-010"], reject: ["bundle", "pack of", "used"], minMinor: 900, maxMinor: 4000 },
  { id: "startech-hdmiadmm3", query: "StarTech HDMIADMM3 Micro HDMI to HDMI cable 3 ft", must: ["hdmiadmm3"], reject: ["bundle", "used"], minMinor: 400, maxMinor: 3000 },
  { id: "startech-usb315cc1m", query: "StarTech USB315CC1M USB-C cable 1m", must: ["usb315cc1m"], reject: ["bundle", "used"], minMinor: 400, maxMinor: 4000 },
  { id: "sony-zve10", query: "Sony ZV-E10 mirrorless vlog camera body", must: ["sony", "zv-e10"], reject: ["ii", "bundle", "kit", "lens", "used", "case", "battery"], minMinor: 40000, maxMinor: 110000 },
  { id: "apple-ipad-air5", query: "Apple iPad Air 5th generation M1 64GB Wi-Fi", must: ["ipad air"], any: ["5th", "m1", "2022"], reject: ["case", "cover", "used", "refurbished", "renewed", "screen", "keyboard"], minMinor: 30000, maxMinor: 90000 },
  { id: "sony-mdr7506", query: "Sony MDR-7506 professional headphones", must: ["sony", "mdr"], any: ["7506"], reject: ["bundle", "pads", "cushion", "cable", "used", "case"], minMinor: 6000, maxMinor: 16000 },
];
const text = (snapshot: CatalogSnapshot) => `${snapshot.brand ?? ""} ${snapshot.title}`.toLowerCase();
function exact(target: Target, snapshot: CatalogSnapshot) {
  const value = text(snapshot);
  return target.must.every(token => value.includes(token)) && (!target.any || target.any.some(token => value.includes(token))) && !(target.reject ?? []).some(token => new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(value));
}
function bestOffer(target: Target, snapshot: CatalogSnapshot) {
  return snapshot.offers.filter(offer => offer.price && /in.?stock|available/i.test(offer.availability) && !/used|refurb|open/i.test(offer.condition) && offer.price.minor >= target.minMinor && offer.price.minor <= target.maxMinor).sort((a, b) => a.price!.minor - b.price!.minor)[0] ?? null;
}
const args = process.argv.slice(2), only = args.flatMap((value, index) => value === "--device" && args[index + 1] ? [args[index + 1]!] : []);
const path = "packages/device-library/price-book.json"; const book = JSON.parse(await readFile(path, "utf8")) as PriceBook;
let requests = 0; const report: unknown[] = [];
for (const target of targets) {
  if (only.length && !only.includes(target.id)) continue;
  let entry: (PriceBookEntry & { rejected?: string }) | null = null, candidates: string[] = [];
  try {
    requests++; const result = await searchProducts(target.query, "worldkit-price-book");
    candidates = result.value.slice(0, 6).map(snapshot => `${snapshot.title.slice(0, 70)} [${snapshot.offers.filter(offer => offer.price).map(offer => `${offer.domain} $${(offer.price!.minor / 100).toFixed(2)} ${offer.availability}`).slice(0, 3).join("; ")}]`);
    for (const snapshot of result.value) {
      if (!exact(target, snapshot)) continue; const offer = bestOffer(target, snapshot); if (!offer) continue;
      entry = { profileId: target.id, query: target.query, channel3ProductId: snapshot.productId, title: snapshot.title, brand: snapshot.brand, selectedOptions: snapshot.selectedOptions,
        offer: { id: offer.id, retailer: offer.retailer, domain: offer.domain, unitMinor: offer.price!.minor, currency: "USD", availability: offer.availability, condition: offer.condition, observedAt: offer.observedAt },
        responseHash: snapshot.responseHash, receiptId: result.receipt.id, match: "exact_model" };
      break;
    }
    if (!entry) entry = { profileId: target.id, query: target.query, channel3ProductId: result.value[0]?.productId ?? "none", title: result.value[0]?.title ?? "No product returned", brand: result.value[0]?.brand ?? null, selectedOptions: [],
      offer: { id: "none", retailer: "none", domain: "none", unitMinor: 0, currency: "USD", availability: "unknown", condition: "unknown", observedAt: new Date().toISOString() }, responseHash: result.value[0]?.responseHash ?? "none", receiptId: result.receipt.id, match: "unmatched", rejected: "No returned product named the exact model with an in-stock new USD offer inside the plausibility bounds." };
  } catch (error) { console.log(JSON.stringify({ id: target.id, status: "failed", error: error instanceof CatalogFailure ? error.message : error instanceof Error ? error.message.slice(0, 160) : "unknown" })); continue; }
  book.entries = [...book.entries.filter(value => value.profileId !== target.id), entry];
  report.push({ id: target.id, match: entry.match, title: entry.title.slice(0, 80), retailer: entry.offer.retailer, price: entry.offer.unitMinor / 100, candidates });
  console.log(JSON.stringify(report.at(-1)));
}
book.capturedAt = new Date().toISOString(); book.entries.sort((a, b) => a.profileId.localeCompare(b.profileId));
await writeFile(path, JSON.stringify(book, null, 1) + "\n");
console.log(JSON.stringify({ requests, matched: book.entries.filter(entry => entry.match === "exact_model").length, unmatched: book.entries.filter(entry => entry.match !== "exact_model").map(entry => entry.profileId) }));
