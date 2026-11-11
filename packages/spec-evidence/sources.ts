import { createHash } from "node:crypto";
import { load } from "cheerio";
import { WorldKitError } from "../contracts/index";
import { publicProductUrl } from "../security/url";
import corpus from "../device-library/corpus.json";

export type CorpusDevice = typeof corpus[number];
export type SourceDefinition = CorpusDevice["source"];
export type SourcePage = { number: number; text: string };
export type SourceDocument = { sourceId: string; url: string; retrievedAt: string; contentHash: string; textHash: string; mediaType: "application/pdf" | "text/html" | "application/json"; bytes: number; pages: SourcePage[]; parser: "worldkit-text.1"; identityMentioned: boolean };
export const corpusDevices: CorpusDevice[] = corpus;
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 25_000_000;
const MAX_TEXT = 600_000;
const officialHosts: Record<string, string[]> = {
  Zoom: ["zoomcorp.com"], Focusrite: ["focusrite.com"], Shure: ["shure.com"], "Audio-Technica": ["audio-technica.com"],
  "RØDE": ["rode.com"], TASCAM: ["tascam.com"], Apple: ["apple.com"], Microsoft: ["microsoft.com"],
  "Raspberry Pi": ["raspberrypi.com"], Sony: ["sony.com", "sony.net", "pro.sony"], Canon: ["canon"], Panasonic: ["panasonic.com"],
  Elgato: ["elgato.com"], Anker: ["anker.com"], AVerMedia: ["avermedia.com"], "Blackmagic Design": ["blackmagicdesign.com"],
  CalDigit: ["caldigit.com"], OWC: ["owc.com", "macsales.com"], Hosa: ["hosatech.com"], "StarTech.com": ["startech.com"],
  beyerdynamic: ["beyerdynamic.com", "beyerdynamic.de"], Sennheiser: ["sennheiser.com"], "König & Meyer": ["k-m.de"],
};
export function isManufacturerUrl(url: URL, publisher: string): boolean {
  return (officialHosts[publisher] ?? []).some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
}
export function normalizeSourceText(text: string): string {
  return text.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function htmlSourcePages(html: string): SourcePage[] {
  const $ = load(html); const title = $("title").text(); const structured: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record["@graph"]) visit(record["@graph"]);
    if (record["@type"] !== "Product" && !(Array.isArray(record["@type"]) && record["@type"].includes("Product"))) return;
    for (const key of ["name", "description", "sku", "model", "color", "weight", "width", "height", "depth"]) {
      const item = record[key]; if (typeof item === "string" || typeof item === "number") structured.push(`${key}: ${load(String(item)).text()}`);
    }
    if (Array.isArray(record.additionalProperty)) for (const item of record.additionalProperty) {
      if (item && typeof item === "object" && typeof item.name === "string" && ["string", "number", "boolean"].includes(typeof item.value)) structured.push(`${item.name}: ${String(item.value)} ${typeof item.unitText === "string" ? item.unitText : ""}`);
    }
  };
  $("script[type='application/ld+json']").each((_, element) => { try { visit(JSON.parse($(element).text())); } catch { /* Malformed structured metadata is not evidence. */ } });
  $("script,style,noscript,nav,footer,iframe,svg,input,select,button").remove();
  $("br").replaceWith("\n");
  $("h1,h2,h3,h4,h5,h6,p,li,tr,dt,dd,section,div").each((_, element) => { $(element).append("\n"); });
  $("td,th").each((_, element) => { $(element).append(" | "); });
  const main = $("main").first(); const article = $("article").first();
  const selected = main.text().trim().length > 150 ? main : article.text().trim().length > 150 ? article : $("body");
  return [{ number: 1, text: normalizeSourceText(`${title}\n\n${selected.text()}`) }, ...(structured.length ? [{ number: 2, text: normalizeSourceText(`Manufacturer structured product data\n${structured.join("\n")}`) }] : [])];
}
export function sourceMentionsDevice(pages: SourcePage[], device: Pick<CorpusDevice, "aliases">): boolean {
  const compact = (text: string) => text.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
  const text = compact(pages.map(page => page.text).join("\n"));
  return device.aliases.some(alias => text.includes(compact(alias)));
}
export async function parseSourceBytes(bytes: Buffer, mediaType: SourceDocument["mediaType"]): Promise<SourcePage[]> {
  if (mediaType === "text/html") return htmlSourcePages(bytes.toString("utf8"));
  if (mediaType === "application/json") {
    const article = JSON.parse(bytes.toString("utf8"))?.article;
    if (!article || typeof article.body !== "string" || typeof article.title !== "string") throw new WorldKitError("needs_evidence", "The official help article did not contain readable documentation.", 422);
    return htmlSourcePages(`<html><head><title>${article.title.replace(/[<>&]/g, " ")}</title></head><body>${article.body}</body></html>`);
  }
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  try {
    const info = await parser.getInfo();
    if (info.total > 400) throw new WorldKitError("invalid_request", "This source exceeds the 400-page extraction limit; select a manufacturer specification sheet.");
    const result = await parser.getText({ pageJoiner: "" });
    return result.pages.map(page => ({ number: page.num, text: normalizeSourceText(page.text) }));
  } finally { await parser.destroy(); }
}
export async function retrieveManufacturerSource(device: CorpusDevice): Promise<{ document: SourceDocument; raw: Buffer }> {
  let url = await publicProductUrl(device.source.url); const signal = AbortSignal.timeout(35000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!isManufacturerUrl(url, device.manufacturer)) throw new WorldKitError("invalid_request", "The source must remain on this manufacturer’s approved documentation domains.");
    const response = await fetch(url, { redirect: "manual", signal, headers: { Accept: "text/html,application/pdf,application/json" }, cache: "no-store" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel(); const location = response.headers.get("location");
      if (!location) throw new WorldKitError("provider_unavailable", "The manufacturer returned an incomplete redirect.", 502);
      url = await publicProductUrl(new URL(location, url).href); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new WorldKitError("provider_unavailable", `The manufacturer document returned HTTP ${response.status}. Its prior evidence remains unchanged.`, 502); }
    if (Number(response.headers.get("content-length")) > MAX_BYTES) { await response.body?.cancel(); throw new WorldKitError("invalid_request", "This manufacturer document exceeds the 25 MB source limit."); }
    if (!response.body) throw new WorldKitError("provider_unavailable", "The manufacturer document was empty.", 502);
    const chunks: Uint8Array[] = []; const reader = response.body.getReader(); let length = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > MAX_BYTES) { await reader.cancel(); throw new WorldKitError("invalid_request", "This manufacturer document exceeds the 25 MB source limit."); } chunks.push(part.value); } } finally { reader.releaseLock(); }
    const raw = Buffer.concat(chunks); const isPdf = raw.subarray(0, 5).toString() === "%PDF-"; const contentType = response.headers.get("content-type") ?? "";
    if (!isPdf && !/text\/html|application\/xhtml|application\/json/.test(contentType)) throw new WorldKitError("invalid_request", "Only readable manufacturer HTML or PDF documents can be extracted.");
    const mediaType = isPdf ? "application/pdf" : contentType.includes("application/json") ? "application/json" : "text/html"; const pages = await parseSourceBytes(raw, mediaType); const text = pages.map(page => page.text).join("\n\n");
    if (text.length < 120 || text.length > MAX_TEXT) throw new WorldKitError("needs_evidence", "This document has no usable text or exceeds the text limit. A readable manufacturer sheet is needed.", 422);
    if (/^(?:just a moment|access denied|verify you are human)/i.test(text)) throw new WorldKitError("provider_unavailable", "The manufacturer requires an interactive document retrieval. No facts were accepted.", 502);
    return { document: { sourceId: device.source.id, url: url.href, retrievedAt: new Date().toISOString(), contentHash: sha256(raw), textHash: sha256(text), mediaType, bytes: length, pages, parser: "worldkit-text.1", identityMentioned: sourceMentionsDevice(pages, device) }, raw };
  }
  throw new WorldKitError("provider_unavailable", "The manufacturer redirected too many times. The prior evidence remains available.", 502);
}
