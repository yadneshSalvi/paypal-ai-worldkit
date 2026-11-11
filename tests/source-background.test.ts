import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ExtractionResponseSchema } from "../packages/spec-evidence/contracts";
import { backgroundStep, foregroundStep, geminiResponseSchema, ModelPending, responseText, type BackgroundCheckpoint, type BackgroundGateway, type BackgroundObservation, type BackgroundStore } from "../packages/spec-evidence/providers";

const request = { model: "gpt-6-astra", background: true, store: false, input: "Synthetic model transport test" };
const observation = (status = "queued", id = "resp_fixture", output = ""): BackgroundObservation => ({ id, model: request.model, status, output: output ? [{ type: "message", content: [{ type: "output_text", text: output }] }] : [], usage: { input_tokens: 1, output_tokens: 2 } });
class MemoryStore implements BackgroundStore {
  checkpoint: BackgroundCheckpoint | null = null;
  async reserve(initial: BackgroundCheckpoint) { if (this.checkpoint) return { created: false, checkpoint: structuredClone(this.checkpoint) }; this.checkpoint = structuredClone(initial); return { created: true, checkpoint: initial }; }
  async save(checkpoint: BackgroundCheckpoint) { this.checkpoint = structuredClone(checkpoint); }
  ready() { this.checkpoint!.pollAfter = "2020-01-01T00:00:00Z"; }
}
function gateway() {
  let creates = 0, reads = 0;
  const value: BackgroundGateway = { create: async () => { creates++; return observation(); }, retrieve: async () => { reads++; return observation("completed", "resp_fixture", '{"facts":[],"limitations":[]}'); }, cancel: async () => observation("cancelled") };
  return { value, creates: () => creates, reads: () => reads };
}

test("a restarted worker reads the saved provider identity without another create", async () => {
  const store = new MemoryStore(); const fake = gateway();
  await assert.rejects(() => backgroundStep("operation-1", request, store, fake.value), ModelPending);
  assert.equal(store.checkpoint?.responseId, "resp_fixture"); assert.equal(store.checkpoint?.phase, "polling"); store.ready();
  const completed = await backgroundStep("operation-1", request, store, fake.value);
  assert.equal(completed.phase, "received"); assert.equal(responseText(completed.observation!), '{"facts":[],"limitations":[]}');
  await backgroundStep("operation-1", request, store, fake.value);
  assert.equal(fake.creates(), 1); assert.equal(fake.reads(), 1);
});
test("an ambiguous create is permanently retained and never retried under that operation", async () => {
  const store = new MemoryStore(); let creates = 0; const fake = gateway().value;
  fake.create = async () => { creates++; throw new Error("Connection ended after submission"); };
  await assert.rejects(() => backgroundStep("uncertain", request, store, fake), /original dispatch/);
  assert.equal(store.checkpoint?.phase, "indeterminate");
  await assert.rejects(() => backgroundStep("uncertain", request, store, fake), /no confirmed response identity/);
  assert.equal(creates, 1);
});
test("a lost dispatch lease cannot manufacture a replacement request", async () => {
  const store = new MemoryStore(); const fake = gateway();
  await store.reserve({ operationId: "lost", requestHash: (await import("../packages/compatibility")).hash(request), model: request.model, phase: "dispatching", responseId: null, requestedAt: new Date().toISOString(), observedAt: new Date().toISOString(), pollAfter: null, providerStatus: null, observation: null, failure: null, pollCount: 0 });
  await assert.rejects(() => backgroundStep("lost", request, store, fake.value), /no confirmed response identity/);
  assert.equal(fake.creates(), 0);
});
test("poll transport errors are recoverable reads and do not repeat creation", async () => {
  const store = new MemoryStore(); const fake = gateway();
  await assert.rejects(() => backgroundStep("poll", request, store, fake.value), ModelPending); store.ready();
  const broken = { ...fake.value, retrieve: async () => { throw new Error("Read timeout"); } };
  await assert.rejects(() => backgroundStep("poll", request, store, broken), ModelPending);
  assert.equal(store.checkpoint?.phase, "polling"); assert.equal(store.checkpoint?.failure, "poll_unavailable"); store.ready();
  assert.equal((await backgroundStep("poll", request, store, fake.value)).phase, "received"); assert.equal(fake.creates(), 1);
});
test("an expired provider response retains its identity and cannot generate a duplicate", async () => {
  const store = new MemoryStore(); const fake = gateway(); await assert.rejects(() => backgroundStep("expired", request, store, fake.value), ModelPending); store.ready();
  const gone = { ...fake.value, retrieve: async () => { throw Object.assign(new Error("Gone"), { status: 404 }); } };
  await assert.rejects(() => backgroundStep("expired", request, store, gone), /no longer return/);
  await assert.rejects(() => backgroundStep("expired", request, store, fake.value), /identity is retained/);
  assert.equal(store.checkpoint?.responseId, "resp_fixture"); assert.equal(fake.creates(), 1);
});
test("changed source inputs and mismatched response identities fail closed", async () => {
  const store = new MemoryStore(); const fake = gateway(); await assert.rejects(() => backgroundStep("binding", request, store, fake.value), ModelPending); store.ready();
  await assert.rejects(() => backgroundStep("binding", { ...request, input: "changed" }, store, fake.value), /different inputs/);
  await assert.rejects(() => backgroundStep("binding", request, store, { ...fake.value, retrieve: async () => observation("completed", "resp_other", "{}") }), /did not match/);
  assert.equal(store.checkpoint?.failure, "response_identity_mismatch"); assert.equal(fake.creates(), 1);
});
test("a refusal and an incomplete response never become a usable result", async () => {
  for (const result of [observation("incomplete", "resp_fixture", "partial"), { ...observation("completed", "resp_fixture"), output: [{ type: "message", content: [{ type: "refusal", text: "Not available" }] }] }]) {
    const store = new MemoryStore(); const fake = gateway().value; fake.create = async () => result;
    await assert.rejects(() => backgroundStep("refusal", request, store, fake), /without a complete/);
    assert.equal(store.checkpoint?.phase, "failed"); assert.ok(store.checkpoint?.observation);
  }
});
test("Google transport removes unsupported constraints while strict runtime validation retains them", () => {
  const value = geminiResponseSchema(z.toJSONSchema(ExtractionResponseSchema)); const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /exclusiveMinimum|maxItems|maxLength|additionalProperties|\$schema/);
  assert.match(serialized, /propertyOrdering/); assert.match(serialized, /nullable/);
  assert.equal(ExtractionResponseSchema.safeParse({ facts: [{ assertionId: "a", state: "unknown", value: null, unit: null, scope: "x", conditions: [], evidence: [{ page: 0, quote: "abc" }], explanation: "test" }], limitations: [] }).success, false);
});
test("a foreground response is retained before parsing, including an invalid structured answer", async () => {
  const store = new MemoryStore(); let calls = 0;
  const create = async () => { calls++; return observation("completed", "response-fixture", "invalid JSON retained for inspection"); };
  const first = await foregroundStep("foreground", request.model, request, store, create);
  assert.equal(first.phase, "received"); assert.throws(() => JSON.parse(responseText(first.observation!)));
  const resumed = await foregroundStep("foreground", request.model, request, store, create);
  assert.equal(responseText(resumed.observation!), "invalid JSON retained for inspection"); assert.equal(calls, 1);
});
test("uncertain and incomplete foreground calls never repeat automatically", async () => {
  for (const create of [async () => { throw new Error("Connection interrupted"); }, async () => observation("incomplete", "response-fixture", "partial")]) {
    const store = new MemoryStore(); let calls = 0; const send = async () => { calls++; return create(); };
    await assert.rejects(() => foregroundStep("uncertain-foreground", request.model, request, store, send));
    await assert.rejects(() => foregroundStep("uncertain-foreground", request.model, request, store, send), /will not be repeated/);
    assert.equal(calls, 1); assert.notEqual(store.checkpoint?.phase, "received");
  }
});
