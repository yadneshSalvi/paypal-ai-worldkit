import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { corpusDevices, sha256, type SourceDocument } from "../packages/spec-evidence/sources";
import { extractSource, SOURCE_TRANSPORT_VERSION } from "../packages/spec-evidence/extractor";
import { sourceQueries, suggestedPages } from "../packages/spec-evidence/queries";
import { ModelPending } from "../packages/spec-evidence/providers";
import { FileModelStore } from "./lib/file-model-store";
import type { ExtractionDraft } from "../packages/spec-evidence/contracts";
import type { ModelReceipt } from "../packages/planner";

type Result = { id: string; profileId: string; provider: "openai"; transportVersion: string; sourceHash: string; requestedAt: string; completedAt: string | null; status: "running" | "succeeded" | "failed"; draft: ExtractionDraft | null; receipt: ModelReceipt | null; error: string | null };
const directory = ".artifacts/development-source-extraction/v1";
await mkdir(directory, { recursive: true });
const manifest = JSON.parse(await readFile("packages/device-library/corpus-source-manifest.json", "utf8")) as { profileId: string; contentHash: string; textHash: string }[];
const queue = corpusDevices.filter(device => device.split === "development");
const results = new Map<string, Result>();
async function save(path: string, value: unknown) { const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path); }
async function worker() {
  while (queue.length) {
    const device = queue.shift()!; const entry = manifest.find(row => row.profileId === device.id)!;
    const sourcePath = `.artifacts/manufacturer-corpus/${device.id}/${entry.contentHash}`;
    const document = JSON.parse(await readFile(`${sourcePath}.json`, "utf8")) as SourceDocument;
    if (sha256(await readFile(`${sourcePath}.source`)) !== entry.contentHash || sha256(document.pages.map(page => page.text).join("\n\n")) !== entry.textHash) throw new Error("The manufacturer copy does not match its recorded fingerprint.");
    const path = `${directory}/${device.id}.json`; let prior: Result | null = null;
    try { prior = JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (prior && (prior.transportVersion !== SOURCE_TRANSPORT_VERSION || prior.sourceHash !== entry.contentHash)) throw new Error("Use a new version for changed inputs; retained attempts cannot be overwritten.");
    if (prior?.status === "succeeded" || prior?.status === "failed") { results.set(device.id, prior); continue; }
    let result: Result = prior ?? { id: randomUUID(), profileId: device.id, provider: "openai", transportVersion: SOURCE_TRANSPORT_VERSION, sourceHash: entry.contentHash, requestedAt: new Date().toISOString(), completedAt: null, status: "running", draft: null, receipt: null, error: null };
    await save(path, result); results.set(device.id, result);
    const store = new FileModelStore(`${directory}/${device.id}.${result.id}.provider.json`);
    try {
      let extracted: Awaited<ReturnType<typeof extractSource>>;
      while (true) {
        try { extracted = await extractSource(device, document, sourceQueries(device), "openai", suggestedPages(document), { operationId: result.id, store }); break; }
        catch (error) { if (!(error instanceof ModelPending)) throw error; await new Promise(resolve => setTimeout(resolve, error.delaySeconds * 1000)); }
      }
      result = { ...result, ...extracted, completedAt: new Date().toISOString(), status: "succeeded" };
    } catch (error) { result = { ...result, completedAt: new Date().toISOString(), status: "failed", error: error instanceof Error ? error.name : "ProviderError" }; }
    await save(path, result); results.set(device.id, result);
    console.log(JSON.stringify({ profileId: device.id, status: result.status, counts: result.draft?.counts ?? null, durationMs: Date.parse(result.completedAt!) - Date.parse(result.requestedAt) }));
  }
}
console.log(JSON.stringify({ scope: "30 development-family devices", referenceAnswersLoaded: false, provider: "openai", primaryLibraryProviderChosenBeforeRun: true, transportVersion: SOURCE_TRANSPORT_VERSION }));
await Promise.all([worker(), worker()]);
await save("docs/evidence/development-source-extraction.json", { version: 1, completedAt: new Date().toISOString(), sourceMode: "live_provider_calls", purpose: "Source proposals for the development half of the corpus; not a held-out accuracy evaluation.", primaryProvider: "openai", providerSelection: "Declared before the run. Gemini held-out alternatives are retained separately, not chosen by answer agreement.", transportVersion: SOURCE_TRANSPORT_VERSION, humanReviews: 0, verifiedPromotions: 0, physicalTests: 0, jobs: [...results.values()].map(result => ({ profileId: result.profileId, status: result.status, sourceHash: result.sourceHash, requestedAt: result.requestedAt, completedAt: result.completedAt, counts: result.draft?.counts ?? null, receipt: result.receipt, error: result.error })) });
