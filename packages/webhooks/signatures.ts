import { Webhook } from "svix";
import { WorldKitError } from "../contracts";

export const webhookBodyLimit = 1_048_576;
export async function rawWebhookBody(request: Request): Promise<string> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new WorldKitError("invalid_request", "A JSON webhook body is required.", 415);
  if (![null, "identity"].includes(request.headers.get("content-encoding"))) throw new WorldKitError("invalid_request", "Encoded webhook bodies are not accepted.", 415);
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > webhookBodyLimit)) throw new WorldKitError("invalid_request", "The webhook exceeds its intake limit.", 413);
  if (!request.body) throw new WorldKitError("invalid_request", "A webhook body is required.");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > webhookBodyLimit) { await reader.cancel(); throw new WorldKitError("invalid_request", "The webhook exceeds its intake limit.", 413); }
      chunks.push(part.value);
    }
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
    catch { throw new WorldKitError("invalid_request", "The webhook body is not valid UTF-8."); }
  } finally { reader.releaseLock(); }
}
export function channel3Headers(headers: Headers): { "svix-id": string; "svix-timestamp": string; "svix-signature": string } {
  const values = { "svix-id": headers.get("svix-id") ?? "", "svix-timestamp": headers.get("svix-timestamp") ?? "", "svix-signature": headers.get("svix-signature") ?? "" };
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(values["svix-id"]) || !/^\d{1,12}$/.test(values["svix-timestamp"]) || !values["svix-signature"] || values["svix-signature"].length > 2048) throw new WorldKitError("forbidden", "The webhook signature could not be verified.", 400);
  return values;
}
/** Svix 2.10 verifies bytes and returns void. Parse JSON only after this succeeds. */
export function verifyChannel3(rawBody: string, headers: Headers, secrets: string[]): { transmissionId: string; verification: "standard_webhooks" } {
  if (Buffer.byteLength(rawBody) > webhookBodyLimit) throw new WorldKitError("invalid_request", "The webhook exceeds its intake limit.", 413);
  if (!secrets.length || secrets.length > 2 || secrets.some(secret => !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || Buffer.from(secret.slice(6), "base64").length < 24)) throw new WorldKitError("provider_unavailable", "The Channel3 webhook endpoint is not configured.", 503);
  const signed = channel3Headers(headers);
  for (const secret of secrets) {
    try { new Webhook(secret).verify(rawBody, signed); return { transmissionId: signed["svix-id"], verification: "standard_webhooks" }; }
    catch { /* Rotation accepts only a signature validated by one configured endpoint key. */ }
  }
  throw new WorldKitError("forbidden", "The webhook signature could not be verified.", 400);
}
export function paypalHeaders(headers: Headers): Record<string, string> {
  const limits = { "paypal-transmission-id": 256, "paypal-transmission-time": 80, "paypal-cert-url": 2048, "paypal-auth-algo": 80, "paypal-transmission-sig": 2048 };
  return Object.fromEntries(Object.entries(limits).map(([key, max]) => {
    const value = headers.get(key);
    if (!value || value.length > max) throw new WorldKitError("forbidden", "The webhook signature could not be verified.", 400);
    return [key, value];
  }));
}
