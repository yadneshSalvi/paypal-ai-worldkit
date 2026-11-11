import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PublicRecordDesk, PublicRecordSnapshot, PublicRecordView } from "../packages/public-record";

if (process.env.WORLDKIT_QA_MODE !== "certificate" || process.env.WORLDKIT_PUBLIC_URL !== "http://127.0.0.1:4508") throw new Error("Use the isolated certificate QA launcher on port 4508.");
const origin = process.env.WORLDKIT_PUBLIC_URL;
const fixture = JSON.parse(await readFile(".local/certificate-qa/render-fixture.json", "utf8")) as { cookie: string; record: PublicRecordSnapshot; publicUrl: string };
async function call<T>(path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
  const response = await fetch(`${origin}${path}`, { method, headers: { Cookie: fixture.cookie, ...(body ? { Origin: origin, "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  assert.equal(response.status, 200, `${method} ${path}`);
  return response.json() as Promise<T>;
}
async function action(body: Record<string, unknown>) { return call<{ record: PublicRecordSnapshot }>("/api/records", { requestId: randomUUID(), ...body }); }
function exact(record: PublicRecordSnapshot) { return { recordId: record.id, expectedVersion: record.version, expectedContentHash: record.contentHash, expectedRevisionId: record.payload.revisionId, expectedGraphHash: record.payload.graphHash, expectedShareVersion: record.shareVersion }; }
let desk = await call<PublicRecordDesk>("/api/records");
const existing = desk.records.find(record => record.state === "published" && record.payload.assembly.some(step => step.connectionId === "mic2-audio" && !step.enabled));
let disabled: PublicRecordSnapshot | undefined = existing;
if (!disabled) {
  await call("/api/kit", { expectedRevisionId: desk.revisionId, expectedGraphHash: desk.graphHash, edit: { kind: "connection", connectionId: "mic2-audio", enabled: false } }, "PATCH");
  desk = await call<PublicRecordDesk>("/api/records");
  const draft = (await action({ action: "prepare", title: "Sample studio · one disconnected voice", expectedRevisionId: desk.revisionId, expectedGraphHash: desk.graphHash, expectedShareVersion: desk.share?.version ?? 0 })).record;
  // These explicit test actions establish a fictional rendering fixture; they
  // are neither independent engineering review nor an equipment observation.
  const reviewed = (await action({ action: "review", ...exact(draft), reviewedDisplayFields: true, understoodScope: true })).record;
  disabled = (await action({ action: "publish", ...exact(reviewed), confirmPublicAccess: true })).record;
}
const base = `/record/${fixture.record.slug}`;
const prior = await call<PublicRecordView>(`/api/public-records/${fixture.record.slug}/e/${fixture.record.edition}`);
assert.equal(prior.revisionState, "superseded");
assert.ok(disabled);
assert.equal(disabled.payload.assembly.find(step => step.connectionId === "mic2-audio")?.enabled, false);
const output = { mode: "Sample", generatedBy: "Automated fixture preparation; no human engineering review", currentUrl: `${origin}${base}`, historicalUrl: fixture.publicUrl, disabledUrl: `${origin}${base}/e/${disabled.edition}`, disabledGuideUrl: `${origin}${base}/e/${disabled.edition}/guide`, disabledConnection: "mic2-audio" };
await writeFile(".local/certificate-qa/native-specimens.json", JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(output));
