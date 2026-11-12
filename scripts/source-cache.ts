/** Private source-text cache for the curated device library.
 *
 *   npx tsx scripts/source-cache.ts add --id <sourceId> --from-corpus <corpusProfileId>
 *   npx tsx scripts/source-cache.ts add --id <sourceId> --url <https url>
 *   npx tsx scripts/source-cache.ts grep --id <sourceId> "<regex>" [context chars]
 *   npx tsx scripts/source-cache.ts list
 *
 * Documents stay in the ignored `.local/cut-scope/sources/` directory; only links, hashes and short quotes are published. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { htmlSourcePages, normalizeSourceText, parseSourceBytes, sha256, type SourcePage } from "../packages/spec-evidence/sources";

const root = ".local/cut-scope/sources";
export type CachedSource = { sourceId: string; url: string; retrievedAt: string; contentHash: string; textHash: string; mediaType: string; bytes: number; pages: SourcePage[]; origin: "corpus-cache" | "fetched" };
export const cachedSourcePath = (id: string) => `${root}/${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
export async function readCachedSource(id: string): Promise<CachedSource> { return JSON.parse(await readFile(cachedSourcePath(id), "utf8")); }
/** Whitespace-insensitive form used to locate a verbatim quote. */
export const squash = (text: string) => normalizeSourceText(text).replace(/\s+/g, " ").trim();
export async function fetchSource(sourceId: string, url: string): Promise<CachedSource> {
  const target = new URL(url); if (target.protocol !== "https:") throw new Error("Only https manufacturer sources are accepted.");
  const response = await fetch(target, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; source-reader/1.0)", Accept: "text/html,application/pdf;q=0.9,*/*;q=0.5" }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
  const raw = Buffer.from(await response.arrayBuffer()); if (raw.length > 30_000_000) throw new Error("Source is too large.");
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const pdf = type.includes("pdf") || raw.subarray(0, 5).toString("latin1") === "%PDF-";
  const pages = pdf ? await parseSourceBytes(raw, "application/pdf") : htmlSourcePages(raw.toString("utf8"));
  const clean = pages.map(page => ({ number: page.number, text: normalizeSourceText(page.text) })).filter(page => page.text.length);
  if (!clean.length) throw new Error("No readable text was found in this source.");
  return { sourceId, url: response.url || url, retrievedAt: new Date().toISOString(), contentHash: sha256(raw), textHash: sha256(clean.map(page => page.text).join("\n\f\n")), mediaType: pdf ? "application/pdf" : "text/html", bytes: raw.length, pages: clean, origin: "fetched" };
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const index = rest.indexOf(`--${name}`); return index >= 0 ? rest[index + 1] : undefined; };
  await mkdir(root, { recursive: true });
  if (command === "list") { for (const file of (await readdir(root)).filter(name => name.endsWith(".json")).sort()) { const value = JSON.parse(await readFile(`${root}/${file}`, "utf8")) as CachedSource; console.log(`${value.sourceId}\t${value.mediaType}\t${value.pages.length}p\t${value.pages.reduce((sum, page) => sum + page.text.length, 0)}ch\t${value.url}`); } return; }
  const id = flag("id"); if (!id) throw new Error("--id is required.");
  if (command === "add") {
    let value: CachedSource;
    const corpusId = flag("from-corpus"), url = flag("url");
    if (corpusId) {
      const directory = `.artifacts/manufacturer-corpus/${corpusId}`; const file = (await readdir(directory)).find(name => /^[a-f0-9]{64}\.json$/.test(name)); if (!file) throw new Error("No cached corpus document for that profile.");
      const document = JSON.parse(await readFile(`${directory}/${file}`, "utf8"));
      value = { sourceId: id, url: document.url, retrievedAt: document.retrievedAt, contentHash: document.contentHash, textHash: document.textHash, mediaType: document.mediaType, bytes: document.bytes, pages: document.pages, origin: "corpus-cache" };
    } else if (url) value = await fetchSource(id, url); else throw new Error("Use --from-corpus <profileId> or --url <https url>.");
    await writeFile(cachedSourcePath(id), JSON.stringify(value, null, 1) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ sourceId: id, url: value.url, mediaType: value.mediaType, pages: value.pages.length, characters: value.pages.reduce((sum, page) => sum + page.text.length, 0), contentHash: value.contentHash }));
  } else if (command === "grep") {
    const positional = rest.filter((value, index) => !value.startsWith("--") && !rest[index - 1]?.startsWith("--"));
    const pattern = new RegExp(positional[0] ?? ".", "gi"), context = Number(positional[1] ?? 220); const value = await readCachedSource(id); let shown = 0;
    for (const page of value.pages) for (const match of page.text.matchAll(pattern)) { if (shown++ >= 40) return; const start = Math.max(0, match.index - context), end = Math.min(page.text.length, match.index + match[0].length + context); console.log(`--- p${page.number} @${match.index}\n${page.text.slice(start, end)}\n`); }
    if (!shown) console.log("no match");
  } else throw new Error("Unknown command.");
}
if (process.argv[1]?.endsWith("source-cache.ts")) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
