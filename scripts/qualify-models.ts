import { mkdir, writeFile } from "node:fs/promises";
import { proposeGoal } from "../packages/planner/index";
import { defaultGoal } from "../packages/device-library/index";
await mkdir("docs/evidence", { recursive: true });
const results = await Promise.allSettled((["openai", "gemini"] as const).map(async provider => {
  const result = await proposeGoal("Help two musicians livestream a camera performance and keep two isolated microphone files. Reuse our camera, iPad and headphones; keep new equipment below $600.", defaultGoal, provider);
  console.log(JSON.stringify({ provider, status: "succeeded", model: result.receipt.model, durationMs: result.receipt.durationMs, tracks: result.proposal.tracks, budgetMinor: result.proposal.budgetMinor }));
  return result;
}));
const evidence = results.map((r, i) => r.status === "fulfilled" ? r.value : { provider: i === 0 ? "openai" : "gemini", status: "failed", error: r.reason instanceof Error ? r.reason.name : "UnknownError" });
await writeFile("docs/evidence/model-qualification.json", JSON.stringify({ observedAt: new Date().toISOString(), results: evidence, evaluation: "Two live integration probes, not a held-out accuracy benchmark." }, null, 2) + "\n");
if (results.some(r => r.status === "rejected")) { console.log(JSON.stringify({ status: "one_or_more_probes_failed", evidence: "docs/evidence/model-qualification.json" })); process.exitCode = 1; }
