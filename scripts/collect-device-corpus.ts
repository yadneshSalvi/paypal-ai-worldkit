import { mkdir, readFile, writeFile } from "node:fs/promises";
import { corpusDevices, retrieveManufacturerSource, type SourceDocument } from "../packages/spec-evidence/sources";

const root = ".artifacts/manufacturer-corpus";
await mkdir(root, { recursive: true });
const selected = process.argv.filter(argument => argument.startsWith("--id=")).map(argument => argument.slice(5));
const refresh = process.argv.includes("--refresh");
type Outcome = { profileId: string; sourceId: string; url: string; publisher: string; status: "retrieved" | "identity_unresolved" | "failed"; contentHash: string; textHash: string | null; retrievedAt: string; bytes: number; pages: number; characters: number; mediaType: string | null; error: string | null; humanReview: "pending" };
let previous: Outcome[] = []; try { previous = JSON.parse(await readFile("packages/device-library/corpus-source-manifest.json", "utf8")); } catch {}
const outcomes = new Map(previous.map(outcome => [outcome.profileId, outcome]));
const queue = corpusDevices.filter(device => !selected.length || selected.includes(device.id));
async function worker() {
  while (queue.length) {
    const device = queue.shift()!;
    if (!refresh && outcomes.get(device.id)?.status === "retrieved") { try { await readFile(`${root}/${device.id}/${outcomes.get(device.id)!.contentHash}.json`); console.log(JSON.stringify({ id: device.id, status: "cached" })); continue; } catch {} }
    const at = new Date().toISOString();
    try {
      const { document, raw } = await retrieveManufacturerSource(device);
      const path = `${root}/${device.id}`; await mkdir(path, { recursive: true });
      await writeFile(`${path}/${document.contentHash}.source`, raw, { mode: 0o600 });
      await writeFile(`${path}/${document.contentHash}.json`, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 });
      const outcome: Outcome = { profileId: device.id, sourceId: document.sourceId, url: document.url, publisher: device.manufacturer, status: document.identityMentioned ? "retrieved" : "identity_unresolved", contentHash: document.contentHash, textHash: document.textHash, retrievedAt: document.retrievedAt, bytes: document.bytes, pages: document.pages.length, characters: document.pages.reduce((sum,page) => sum + page.text.length, 0), mediaType: document.mediaType, error: null, humanReview: "pending" };
      outcomes.set(device.id, outcome); console.log(JSON.stringify({ id: device.id, status: outcome.status, pages: outcome.pages, characters: outcome.characters }));
    } catch (error) {
      const outcome: Outcome = { profileId: device.id, sourceId: device.source.id, url: device.source.url, publisher: device.manufacturer, status: "failed", contentHash: "unretrieved", textHash: null, retrievedAt: at, bytes: 0, pages: 0, characters: 0, mediaType: null, error: error instanceof Error ? error.message : "Source unavailable", humanReview: "pending" };
      await writeFile(`${root}/${device.id}-failure-${Date.now()}.json`, JSON.stringify(outcome, null, 2) + "\n", { mode: 0o600 });
      if (!outcomes.has(device.id) || outcomes.get(device.id)!.status !== "retrieved") outcomes.set(device.id, outcome);
      console.log(JSON.stringify({ id: device.id, status: "failed", error: outcome.error }));
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
const manifest = corpusDevices.map(device => outcomes.get(device.id)).filter(Boolean);
await writeFile("packages/device-library/corpus-source-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ total: manifest.length, retrieved: manifest.filter(outcome => outcome?.status === "retrieved").length, humanReviewed: 0 }));
