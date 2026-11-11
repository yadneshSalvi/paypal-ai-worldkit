import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { Schema } from "@google/genai";
import { hash } from "../compatibility";
import { WorldKitError } from "../contracts";

/** Runtime validation retains the bounds omitted from Google's Schema transport. */
export function geminiResponseSchema(schema: Record<string, unknown>): Schema {
  const result: Record<string, unknown> = {};
  const omitted = new Set(["$schema", "additionalProperties", "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);
  for (const [key, value] of Object.entries(schema)) {
    if (omitted.has(key)) continue;
    if (key === "type") {
      if (typeof value !== "string" || !["object", "array", "string", "number", "integer", "boolean"].includes(value)) throw new Error("Unsupported Google schema type.");
      result.type = value.toUpperCase();
    } else if (key === "properties") {
      result.properties = Object.fromEntries(Object.entries(value as Record<string, Record<string, unknown>>).map(([name, property]) => [name, geminiResponseSchema(property)]));
      result.propertyOrdering = Object.keys(value as object);
    } else if (key === "items") result.items = geminiResponseSchema(value as Record<string, unknown>);
    else if (key === "anyOf") {
      const alternatives = value as Record<string, unknown>[];
      const nonNull = alternatives.filter(item => item.type !== "null");
      if (nonNull.length !== alternatives.length) result.nullable = true;
      if (nonNull.length === 1) Object.assign(result, geminiResponseSchema(nonNull[0]!));
      else result.anyOf = nonNull.map(geminiResponseSchema);
    } else if (["required", "enum", "description", "title"].includes(key)) result[key] = value;
    else throw new Error(`Unsupported Google schema field: ${key}.`);
  }
  return result as Schema;
}

export type BackgroundObservation = {
  id: string; model: string; status: string;
  output: { type: string; content?: { type: string; text?: string }[] }[];
  usage?: { input_tokens: number; output_tokens: number } | null;
};
export type BackgroundCheckpoint = {
  operationId: string; requestHash: string; model: string;
  phase: "dispatching" | "polling" | "received" | "failed" | "indeterminate";
  responseId: string | null; requestedAt: string; observedAt: string; pollAfter: string | null;
  providerStatus: string | null; observation: BackgroundObservation | null; failure: string | null;
  pollCount: number;
};
export interface BackgroundStore {
  reserve(initial: BackgroundCheckpoint): Promise<{ created: boolean; checkpoint: BackgroundCheckpoint }>;
  save(checkpoint: BackgroundCheckpoint): Promise<void>;
}
export interface BackgroundGateway {
  create(request: ResponseCreateParamsNonStreaming): Promise<BackgroundObservation>;
  retrieve(id: string): Promise<BackgroundObservation>;
  cancel(id: string): Promise<BackgroundObservation>;
}
export class OpenAIBackgroundGateway implements BackgroundGateway {
  private client: OpenAI;
  constructor() {
    if (!process.env.OPENAI_API_KEY) throw new WorldKitError("provider_unavailable", "OpenAI source extraction is not configured.", 503);
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 30000 });
  }
  async create(request: ResponseCreateParamsNonStreaming) { return await this.client.responses.create(request, { timeout: 60000 }) as BackgroundObservation; }
  async retrieve(id: string) { return await this.client.responses.retrieve(id) as BackgroundObservation; }
  async cancel(id: string) { return await this.client.responses.cancel(id) as BackgroundObservation; }
}
export class ModelPending extends Error {
  constructor(public progress = "The saved model request is still working", public delaySeconds = 10) { super(progress); this.name = "ModelPending"; }
}
export function validResponseId(id: unknown): id is string { return typeof id === "string" && /^resp_[a-zA-Z0-9_-]{1,240}$/.test(id); }
export function responseText(observation: BackgroundObservation): string {
  return observation.output.filter(item => item.type === "message").flatMap(item => item.content ?? []).filter(item => item.type === "output_text").map(item => item.text ?? "").join("");
}
export function safeObservation(observation: BackgroundObservation): BackgroundObservation {
  return { id: observation.id, model: observation.model, status: observation.status, output: Array.isArray(observation.output) ? observation.output.filter(item => item.type === "message").map(item => ({ type: "message", content: (item.content ?? []).filter(content => ["output_text", "refusal"].includes(content.type)).map(content => ({ type: content.type, ...(content.text ? { text: content.text } : {}) })) })) : [], usage: observation.usage ?? null };
}

/** At most one create per operation. Recovery only reads the retained response identity. */
export async function backgroundStep(operationId: string, request: ResponseCreateParamsNonStreaming, store: BackgroundStore, gateway: BackgroundGateway): Promise<BackgroundCheckpoint> {
  if (typeof request.model !== "string" || !request.model) throw new WorldKitError("invalid_request", "A model identity is required for a saved request.", 400);
  const at = new Date().toISOString();
  const reservation = await store.reserve({ operationId, requestHash: hash(request), model: request.model, phase: "dispatching", responseId: null, requestedAt: at, observedAt: at, pollAfter: null, providerStatus: null, observation: null, failure: null, pollCount: 0 });
  let checkpoint = reservation.checkpoint;
  if (checkpoint.operationId !== operationId || checkpoint.requestHash !== hash(request) || checkpoint.model !== request.model) throw new WorldKitError("stale_revision", "This saved model request has different inputs. Its original request is retained.", 409);
  if (checkpoint.phase === "received") return checkpoint;
  if (checkpoint.phase === "failed" || checkpoint.phase === "indeterminate" || (!reservation.created && checkpoint.phase === "dispatching")) throw new WorldKitError("needs_evidence", checkpoint.responseId ? "The saved provider response needs attention. Its identity is retained; another request has not been sent." : "The original model request has no confirmed response identity. Its outcome is preserved as uncertain; it will not be sent again automatically.", 422);
  if (checkpoint.pollAfter && Date.parse(checkpoint.pollAfter) > Date.now()) throw new ModelPending();
  let observation: BackgroundObservation;
  try {
    if (reservation.created) observation = await gateway.create(request);
    else {
      if (!validResponseId(checkpoint.responseId)) throw new WorldKitError("needs_evidence", "The saved response identity is invalid.", 422);
      checkpoint.pollCount++;
      observation = await gateway.retrieve(checkpoint.responseId);
    }
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : null;
    if (!reservation.created && checkpoint.responseId && status !== 404 && status !== 410) {
      await store.save({ ...checkpoint, failure: "poll_unavailable", pollAfter: new Date(Date.now() + 15000).toISOString(), observedAt: new Date().toISOString() });
      throw new ModelPending("Waiting for the connection to the saved model response", 15);
    }
    const definitive = status !== null && [400, 401, 403, 404, 410, 422, 429].includes(status);
    await store.save({ ...checkpoint, phase: definitive ? "failed" : "indeterminate", failure: reservation.created ? definitive ? `dispatch_http_${status}` : "dispatch_unknown" : "response_unavailable", observedAt: new Date().toISOString() });
    throw new WorldKitError("needs_evidence", reservation.created ? "The model request did not return a confirmed result. The original dispatch is retained for inspection." : "The provider can no longer return the saved response. Its identity is retained; another request has not been sent.", 422);
  }
  if (!validResponseId(observation.id) || checkpoint.responseId && observation.id !== checkpoint.responseId || typeof observation.model !== "string" || !(observation.model === checkpoint.model || observation.model.startsWith(`${checkpoint.model}-`))) {
    await store.save({ ...checkpoint, phase: "indeterminate", failure: "response_identity_mismatch", observedAt: new Date().toISOString() });
    throw new WorldKitError("needs_evidence", "The provider response did not match the saved request identity. No facts were accepted.", 422);
  }
  // Commit the provider identity before interpreting status or yielding the worker.
  checkpoint = { ...checkpoint, responseId: observation.id, phase: "polling", providerStatus: observation.status, observedAt: new Date().toISOString(), failure: null };
  await store.save(checkpoint);
  if (["queued", "in_progress"].includes(observation.status)) {
    await store.save({ ...checkpoint, pollAfter: new Date(Date.now() + 10000).toISOString() });
    throw new ModelPending();
  }
  if (!["completed", "failed", "incomplete", "cancelled"].includes(observation.status)) {
    await store.save({ ...checkpoint, failure: "provider_status_unknown", pollAfter: new Date(Date.now() + 15000).toISOString() });
    throw new ModelPending("Checking the saved provider response", 15);
  }
  const safe = safeObservation(observation);
  const refused = safe.output.some(item => item.content?.some(content => content.type === "refusal"));
  checkpoint = { ...checkpoint, phase: observation.status === "completed" && responseText(safe) && !refused ? "received" : "failed", observation: safe, pollAfter: null, failure: observation.status === "completed" && responseText(safe) && !refused ? null : refused ? "provider_refusal" : `provider_${observation.status}` };
  await store.save(checkpoint);
  if (checkpoint.phase !== "received") throw new WorldKitError("needs_evidence", "The saved model response ended without a complete source proposal. Its result is retained.", 422);
  return checkpoint;
}

/** Foreground reads also retain their dispatch intent; an uncertain create is not repeated. */
export async function foregroundStep(operationId: string, model: string, request: unknown, store: BackgroundStore, create: () => Promise<BackgroundObservation>): Promise<BackgroundCheckpoint> {
  const at = new Date().toISOString();
  const reservation = await store.reserve({ operationId, model, requestHash: hash(request), phase: "dispatching", responseId: null, requestedAt: at, observedAt: at, pollAfter: null, providerStatus: null, observation: null, failure: null, pollCount: 0 });
  const previous = reservation.checkpoint;
  if (previous.requestHash !== hash(request) || previous.operationId !== operationId || previous.model !== model) throw new WorldKitError("stale_revision", "The saved model request has different source inputs.", 409);
  if (previous.phase === "received") return previous;
  if (!reservation.created) throw new WorldKitError("needs_evidence", "The original model read did not produce a saved result. Its dispatch is retained and will not be repeated automatically.", 422);
  let observation: BackgroundObservation;
  try { observation = await create(); }
  catch (error) {
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : null;
    await store.save({ ...previous, phase: status !== null && [400,401,403,404,422,429].includes(status) ? "failed" : "indeterminate", failure: status === null ? "dispatch_unknown" : `dispatch_http_${status}`, observedAt: new Date().toISOString() });
    throw new WorldKitError("needs_evidence", "The source model read did not return a saved proposal. Its original dispatch is preserved for inspection.", 422);
  }
  const safe = safeObservation(observation);
  const identityMatches = typeof safe.id === "string" && safe.id.length > 0 && typeof safe.model === "string" && (safe.model === model || safe.model.startsWith(`${model}-`));
  const complete = identityMatches && safe.status === "completed" && responseText(safe) && !safe.output.some(item => item.content?.some(content => content.type === "refusal"));
  const checkpoint: BackgroundCheckpoint = { ...previous, phase: complete ? "received" : "failed", responseId: safe.id || null, providerStatus: safe.status, observation: safe, observedAt: new Date().toISOString(), failure: complete ? null : !identityMatches ? "response_identity_mismatch" : "provider_incomplete" };
  await store.save(checkpoint);
  if (checkpoint.phase !== "received") throw new WorldKitError("needs_evidence", "The provider returned no source proposal. Its response is retained.", 422);
  return checkpoint;
}
