import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DraftReferenceSchema, type ExtractionDraft } from "../packages/spec-evidence/contracts";
import { corpusDevices, sha256, type SourceDocument } from "../packages/spec-evidence/sources";
import { extractSource, EXTRACTOR_INSTRUCTION, SOURCE_TRANSPORT_VERSION } from "../packages/spec-evidence/extractor";
import { compareDraftReference, evaluationQueries, validateReference } from "../packages/spec-evidence/evaluation";
import type { ModelReceipt } from "../packages/planner";
import { ModelPending } from "../packages/spec-evidence/providers";
import { FileModelStore } from "./lib/file-model-store";

type Attempt = { id: string; profileId: string; provider: "openai" | "gemini"; referenceHash: string; promptHash: string; transportVersion: string; requestedAt: string; completedAt: string | null; status: "running" | "succeeded" | "failed"; durationMs: number; draft: ExtractionDraft | null; receipt: ModelReceipt | null; error: { name: string; status: number | null } | null };
const raw = await readFile("packages/spec-evidence/reference.draft.v1.json", "utf8");
const reference = DraftReferenceSchema.parse(JSON.parse(raw));
const frozen = JSON.parse(await readFile("packages/spec-evidence/reference-manifest.json", "utf8")) as { referenceHash: string; selectedPages: Record<string, number[]> };
if (sha256(raw) !== frozen.referenceHash) throw new Error("The frozen draft reference has changed. Refusing evaluation.");
const sourceManifest = JSON.parse(await readFile("packages/device-library/corpus-source-manifest.json", "utf8")) as { profileId: string; contentHash: string; textHash: string }[];
const profileIds = [...new Set(reference.assertions.map(assertion => assertion.profileId))];
const documents = new Map<string, SourceDocument>();
for (const profileId of profileIds) {
  const source = sourceManifest.find(source => source.profileId === profileId)!;
  const folder = `.artifacts/manufacturer-corpus/${profileId}/${source.contentHash}`;
  const document = JSON.parse(await readFile(`${folder}.json`, "utf8")) as SourceDocument;
  if (sha256(await readFile(`${folder}.source`)) !== source.contentHash || sha256(document.pages.map(page => page.text).join("\n\n")) !== source.textHash) throw new Error("A pinned source artifact failed its hash check.");
  documents.set(profileId, document);
}
validateReference(reference, corpusDevices, documents);
const directory = ".artifacts/source-evaluation/v2";
await mkdir(directory, { recursive: true });
const promptHash = sha256(EXTRACTOR_INSTRUCTION);
const only = process.argv.find(argument => argument.startsWith("--provider="))?.slice(11);
if (process.argv.includes("--retry-failed")) throw new Error("Terminal attempts are immutable. A deliberately changed transport must use a new evaluation version; it cannot hide earlier failures.");
const verifyOnly = process.argv.includes("--verify-only");
const attempts = new Map<string, Attempt>();
const queue = profileIds.flatMap(profileId => (["openai", "gemini"] as const).filter(provider => !only || provider === only).map(provider => ({ profileId, provider })));
if (only && !["openai", "gemini"].includes(only)) throw new Error("Choose openai or gemini.");
console.log(JSON.stringify({ referenceHash: frozen.referenceHash, assertions: reference.assertions.length, devices: profileIds.length, reference: "unreviewed_ai_draft", validation: "passed", providerCalls: verifyOnly ? 0 : queue.length }));
if (!verifyOnly) {
  await writeFile(`${directory}/run-${Date.now()}.json`, JSON.stringify({ startedAt: new Date().toISOString(), referenceHash: frozen.referenceHash, promptHash, transportVersion: SOURCE_TRANSPORT_VERSION, providerFilter: only ?? null, parallelism: 2, sourceHashes: Object.fromEntries([...documents].map(([id, document]) => [id, document.contentHash])) }, null, 2), { mode: 0o600 });
  let reportQueue = Promise.resolve();
  async function save(path: string, attempt: Attempt) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(attempt, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  }
  async function worker() {
    while (queue.length) {
      const { profileId, provider } = queue.shift()!;
      const path = `${directory}/${profileId}.${provider}.json`;
      let prior: Attempt | undefined;
      try { prior = JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (prior && (prior.referenceHash !== frozen.referenceHash || prior.promptHash !== promptHash || prior.transportVersion !== SOURCE_TRANSPORT_VERSION)) throw new Error("The previous run used different frozen inputs; use a new evaluation version.");
      if (prior && prior.status !== "running") { attempts.set(path, prior); console.log(JSON.stringify({ profileId, provider, status: "cached", result: prior.status })); continue; }
      let attempt: Attempt = prior ?? { id: randomUUID(), profileId, provider, referenceHash: frozen.referenceHash, promptHash, transportVersion: SOURCE_TRANSPORT_VERSION, requestedAt: new Date().toISOString(), completedAt: null, durationMs: 0, status: "running", draft: null, receipt: null, error: null };
      // Persist the case intent before any provider call. A restarted run uses its original identity.
      await save(path, attempt); attempts.set(path, attempt); await report();
      const store = new FileModelStore(`${directory}/${profileId}.${provider}.${attempt.id}.provider.json`);
      try {
        let result: Awaited<ReturnType<typeof extractSource>>;
        while (true) {
          try { result = await extractSource(corpusDevices.find(device => device.id === profileId)!, documents.get(profileId)!, evaluationQueries(reference.assertions.filter(assertion => assertion.profileId === profileId)), provider, frozen.selectedPages[profileId], { operationId: attempt.id, store }); break; }
          catch (error) { if (!(error instanceof ModelPending)) throw error; await new Promise(resolve => setTimeout(resolve, error.delaySeconds * 1000)); }
        }
        attempt = { ...attempt, completedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(attempt.requestedAt), status: "succeeded", ...result, error: null };
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : null;
        attempt = { ...attempt, completedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(attempt.requestedAt), status: "failed", draft: null, receipt: null, error: { name: error instanceof Error ? error.name : "ProviderError", status } };
      }
      await save(`${directory}/${profileId}.${provider}.${attempt.id}.attempt.json`, attempt);
      await save(path, attempt); attempts.set(path, attempt);
      console.log(JSON.stringify({ profileId, provider, status: attempt.status, durationMs: attempt.durationMs, counts: attempt.draft?.counts ?? null, error: attempt.error }));
      await report();
    }
  }
  async function writeReport() {
    const allAttempts = [...attempts.values()];
    const providers = (["openai", "gemini"] as const).map(provider => {
      const results = allAttempts.filter(attempt => attempt.provider === provider);
      return {
        provider,
        modelIds: [...new Set(results.map(result => result.receipt?.model).filter(Boolean))],
        jobs: { attempted: results.length, running: results.filter(result => result.status === "running").length, succeeded: results.filter(result => result.status === "succeeded").length, failed: results.filter(result => result.status === "failed").length },
        durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
        inputTokens: results.reduce((sum, result) => sum + (result.receipt?.inputTokens ?? 0), 0),
        outputTokens: results.reduce((sum, result) => sum + (result.receipt?.outputTokens ?? 0), 0),
        comparison: compareDraftReference(reference, results.flatMap(result => result.draft ? [result.draft] : [])),
      };
    });
    const temporary = `docs/evidence/.source-extraction-${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 2, transportVersion: SOURCE_TRANSPORT_VERSION, updatedAt: new Date().toISOString(), sourceMode: "live_provider_calls", referenceMode: "unreviewed_ai_draft", referenceHash: frozen.referenceHash, promptHash, referenceFrozenAt: reference.frozenAt, priorAttempts: "source-extraction-transport-v1-interrupted.json", completion: queue.length === 0 && allAttempts.length === profileIds.length * (only ? 1 : 2) && allAttempts.every(attempt => attempt.status !== "running") ? "finished" : "in_progress", counts: { referenceAssertions: reference.assertions.length, heldOutDevices: profileIds.length, developmentDevices: corpusDevices.filter(device => device.split === "development").length, independentHumanReviews: 0, physicalTests: 0 }, providers }, null, 2) + "\n");
    await rename(temporary, "docs/evidence/source-extraction-evaluation.json");
  }
  function report() { reportQueue = reportQueue.then(writeReport); return reportQueue; }
  await Promise.all([worker(), worker()]);
  await report();
}
