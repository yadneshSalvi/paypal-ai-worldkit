import { cookies } from "next/headers";
import { ZodError } from "zod";
import { WorldKitError } from "../../packages/contracts/index";
import { findSession, type Session } from "./repository";
import { trustedOrigin } from "../../packages/security/origin";

export const sessionCookie = process.env.WORLDKIT_QA_MODE === "guided-journey" ? "wk_guided_qa" : process.env.WORLDKIT_QA_MODE === "research-notebook" ? "wk_research_qa" : process.env.WORLDKIT_QA_MODE === "physical-notebook" ? "wk_physical_qa" : process.env.WORLDKIT_QA_MODE === "cart-interop" ? "wk_cart_qa" : process.env.WORLDKIT_QA_MODE === "domain-packs" ? "wk_domain_packs_qa" : process.env.WORLDKIT_QA_MODE === "engineering" ? "wk_engineering_qa" : process.env.WORLDKIT_QA_MODE === "certificate" ? "wk_certificate_qa" : process.env.WORLDKIT_QA_MODE === "source-impact" ? "wk_source_impact_qa" : process.env.WORLDKIT_QA_MODE === "toolkit" ? "wk_payment_evidence_qa" : "wk_session";
export async function requireSession(): Promise<Session> {
  const token = (await cookies()).get(sessionCookie)?.value; const session = await findSession(token);
  if (!session) throw new WorldKitError("forbidden", "Open a private workbench to continue.", 401, "Create a workbench");
  return session;
}
export function sameOrigin(request: Request, maxBytes = 20_000) {
  if (!trustedOrigin(request, process.env.WORLDKIT_PUBLIC_URL, process.env.VERCEL_URL)) throw new WorldKitError("forbidden", "This action must start from your WorldKit workbench.", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new WorldKitError("invalid_request", "Send a JSON request.", 415);
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new WorldKitError("invalid_request", "This request is too large.", 413);
}
export function errorResponse(error: unknown): Response {
  if (error instanceof WorldKitError) return Response.json({ error: { code: error.code, message: error.message, nextAction: error.nextAction } }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  if (error instanceof ZodError) return Response.json({ error: { code: "invalid_request", message: "One or more values do not match the action’s expected format.", nextAction: "Review the form and try again" } }, { status: 400 });
  console.error(JSON.stringify({ area: "worldkit", error: error instanceof Error ? error.name : "UnknownError", message: "Unhandled operation failed; details withheld from public responses." }));
  return Response.json({ error: { code: "provider_unavailable", message: "That operation did not complete. Your previous saved plan is still available.", nextAction: "Refresh and try again" } }, { status: 503 });
}
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 20_000) throw new WorldKitError("invalid_request", "This request is too large.", 413);
  try { return JSON.parse(text); } catch { throw new WorldKitError("invalid_request", "The request could not be read as JSON.", 400); }
}
