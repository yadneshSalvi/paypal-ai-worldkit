import { businessErrorSchema, completeCheckoutSchema2, errorSchema, payPalCartSchema, type CompleteCheckoutResponse } from "@paypal/agentic-commerce-spec";
import { ZodError } from "zod";
import { CartProblem } from "../../packages/cart-interop/contracts";
import { trustedOrigin } from "../../packages/security/origin";
import { completeMerchantCheckout, createMerchantCart, getMerchantCart, replaceMerchantCart } from "./cart-interop";
import { authenticateCartRequest } from "./cart-interop-store";

export const cartResponseHeaders = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive", "Referrer-Policy": "no-referrer", "X-WorldKit-Execution": "sample", "X-Content-Type-Options": "nosniff",
};
export async function readCartJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new CartProblem(415, "UNSUPPORTED_MEDIA_TYPE", "Send an application/json request.");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65_536)) throw new CartProblem(413, "REQUEST_TOO_LARGE", "This cart request exceeds the supported size.");
  const reader = request.body?.getReader(); if (!reader) throw new CartProblem(400, "INVALID_REQUEST", "Send a JSON cart document.");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65_536) { await reader.cancel(); throw new CartProblem(413, "REQUEST_TOO_LARGE", "This cart request exceeds the supported size."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new CartProblem(400, "INVALID_REQUEST", "The cart document could not be read as UTF-8 JSON."); }
}
export function cartProtocolError(error: unknown): Response {
  if (error instanceof CartProblem) {
    const body = error.status === 422 ? businessErrorSchema.parse({ name: error.code, message: error.message, ...(error.issue ? { business_context: error.issue } : {}) }) : errorSchema.parse({ name: error.code, message: error.message });
    return Response.json(body, { status: error.status, headers: cartResponseHeaders });
  }
  if (error instanceof ZodError) return Response.json(errorSchema.parse({ name: "INVALID_REQUEST", message: "One or more cart fields do not match this operation's contract." }), { status: 400, headers: cartResponseHeaders });
  console.error(JSON.stringify({ area: "cart-interop", error: error instanceof Error ? error.name : "UnknownError", message: "The operation did not complete; private details withheld." }));
  return Response.json(errorSchema.parse({ name: "INTERNAL_SERVER_ERROR", message: "The cart operation could not complete. Retry with the same request identity to recover its saved outcome." }), { status: 500, headers: cartResponseHeaders });
}
export async function handleCartProtocol(request: Request, operation: "create" | "get" | "replace" | "checkout", cartId?: string): Promise<Response> {
  try {
    const expectedMethod = operation === "get" ? "GET" : operation === "replace" ? "PUT" : "POST";
    if (request.method !== expectedMethod) throw new CartProblem(405, "METHOD_NOT_ALLOWED", "This method is not supported for the cart operation.");
    if (request.headers.has("origin") && !trustedOrigin(request, process.env.WORLDKIT_PUBLIC_URL, process.env.VERCEL_URL)) throw new CartProblem(403, "ORIGIN_NOT_ALLOWED", "This browser origin cannot access the merchant cart interface.");
    const actor = await authenticateCartRequest(request, operation === "checkout" ? "checkout" : "cart");
    const requestId = request.headers.get("idempotency-key") ?? undefined;
    let response: CompleteCheckoutResponse;
    if (operation === "get") response = await getMerchantCart(actor, cartId ?? "");
    else {
      const body = await readCartJson(request);
      response = operation === "create" ? await createMerchantCart(actor, body, requestId)
        : operation === "replace" ? await replaceMerchantCart(actor, cartId ?? "", body, requestId)
        : await completeMerchantCheckout(actor, cartId ?? "", body, requestId);
    }
    if (!(operation === "checkout" ? completeCheckoutSchema2 : payPalCartSchema).safeParse(response).success) throw new CartProblem(500, "INVALID_MERCHANT_RESPONSE", "The merchant could not construct a valid cart response.");
    return Response.json(response, { status: operation === "create" ? 201 : 200, headers: cartResponseHeaders });
  } catch (error) { return cartProtocolError(error); }
}
