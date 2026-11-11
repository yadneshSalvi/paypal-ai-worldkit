import { mkdir, writeFile } from "node:fs/promises";
import { extractSource, SOURCE_TRANSPORT_VERSION } from "../packages/spec-evidence/extractor";
import { ModelPending } from "../packages/spec-evidence/providers";
import { corpusDevices, sha256, type SourceDocument } from "../packages/spec-evidence/sources";
import { FileModelStore } from "./lib/file-model-store";
import type { ExtractionQuery } from "../packages/spec-evidence/contracts";

await mkdir(".artifacts/source-transport", { recursive: true });
const device = { ...corpusDevices[0]!, id: "synthetic-fixture", manufacturer: "Fictional test manufacturer", model: "Fixture Recorder", variant: "Synthetic integration case, not hardware", aliases: ["Fixture Recorder"] };
const text = "Fixture Recorder. This synthetic test sheet states: USB capture channels: 2. Phantom power: 48 V. Simultaneous USB and SD recording: not supported. The sheet contains no camera or app compatibility information.";
const document: SourceDocument = { sourceId: "synthetic-source", url: "https://example.com/fictional-fixture", retrievedAt: new Date().toISOString(), contentHash: sha256(text), textHash: sha256(text), mediaType: "text/html", bytes: Buffer.byteLength(text), pages: [{ number: 1, text }], parser: "worldkit-text.1", identityMentioned: true };
const queries: ExtractionQuery[] = [
  { id: "fixture:channels", property: "usbChannels", question: "How many USB capture channels are stated?", valueType: "number", unit: "count", scope: "Fixture Recorder; USB capture", critical: true },
  { id: "fixture:simultaneous", property: "simultaneous", question: "Is simultaneous USB and SD recording supported?", valueType: "boolean", unit: null, scope: "Fixture Recorder; simultaneous USB and SD recording", critical: true },
  { id: "fixture:camera", property: "cameraApp", question: "Does this source establish Camo iPad application support?", valueType: "boolean", unit: null, scope: "Fixture Recorder; Camo iPad", critical: true },
];
const observations: unknown[] = [];
const tasks = [{ provider: "openai" as const, case: 1 }, ...Array.from({ length: 5 }, (_, index) => ({ provider: "gemini" as const, case: index + 1 }))];
const queue = [...tasks];
async function worker() {
  while (queue.length) {
    const task = queue.shift()!; const key = `${task.provider}-${task.case}`; const start = Date.now();
    try {
      let result: Awaited<ReturnType<typeof extractSource>>;
      const store = new FileModelStore(`.artifacts/source-transport/${key}.background.json`);
      while (true) {
        try { result = await extractSource(device, document, queries, task.provider, [], { operationId: `source-transport-${key}`, store }); break; }
        catch (error) { if (!(error instanceof ModelPending)) throw error; await new Promise(resolve => setTimeout(resolve, error.delaySeconds * 1000)); }
      }
      const values = result.draft.facts.map(fact => ({ id: fact.assertionId, state: fact.state, value: fact.value, validation: fact.validation }));
      const passed = values[0]?.value === 2 && values[1]?.value === false && values[2]?.state === "unknown" && result.draft.counts.rejected === 0;
      const observation = { provider: task.provider, case: task.case, status: "succeeded", fixtureAssertionsCorrect: passed, durationMs: Date.now() - start, values, receipt: result.receipt };
      await writeFile(`.artifacts/source-transport/${key}.result.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
      observations.push(observation); console.log(JSON.stringify({ provider: task.provider, case: task.case, status: "succeeded", passed, durationMs: Date.now() - start }));
    } catch (error) {
      observations.push({ provider: task.provider, case: task.case, status: "failed", name: error instanceof Error ? error.name : "UnknownError", durationMs: Date.now() - start });
      console.log(JSON.stringify({ provider: task.provider, case: task.case, status: "failed", name: error instanceof Error ? error.name : "UnknownError" }));
    }
  }
}
await Promise.all([worker(), worker()]);
await writeFile("docs/evidence/source-provider-transport-qualification.json", JSON.stringify({ sourceMode: "live_provider_calls", fixtureMode: "synthetic", transportVersion: SOURCE_TRANSPORT_VERSION, completedAt: new Date().toISOString(), purpose: "Transport and schema qualification only; no hardware correctness or recognition accuracy measured.", observedEarlierFailures: { sourceBatchGeminiHttp400: 3, sourceBatchAstraForegroundTimeouts: 2, schemaOnlyJsonSchemaHttp400: 1, schemaOnlyResponseSchemaExclusiveMinimumHttp400: 1, schemaOnlyResponseSchemaPassed: 1 }, changes: ["Google Schema removes unsupported exclusiveMinimum and grammar-expanding bounds; Zod still validates every returned value.", "Astra background creation stores its response identity before yielding. Recovery polls that identity with store=false.", "Frozen reference, source bytes and extraction instructions are unchanged."], references: ["https://developers.openai.com/api/docs/guides/background", "https://aistudio.google.com/docs/structured-output"], observations }, null, 2) + "\n");
