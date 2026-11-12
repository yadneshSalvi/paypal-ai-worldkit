import { WorldKitError } from "../../packages/contracts";
import { trustedOrigin } from "../../packages/security/origin";
import { WorkspaceAdmissionSchema } from "../../packages/workspace-entry";
import { errorResponse, sessionCookie } from "./http";
import { findSession, getWorkspace } from "./repository";
import { admitWorkspace } from "./workspace-admission";
import { SessionLimitError } from "./session-limits";

export const ADMISSION_MAX_BYTES = 2048;
const headers = { "Cache-Control": "private, no-store, max-age=0", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
export function workspaceCookie(request: Request): string | undefined {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${sessionCookie}=`));
  if (matches.length > 1) throw new WorldKitError("forbidden", "Multiple saved workspace credentials were sent. Check the original browser workspace before continuing.", 401);
  return matches[0]?.slice(sessionCookie.length + 1);
}
export async function readAdmissionJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new WorldKitError("invalid_request", "Send a JSON Sample request.", 415);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > ADMISSION_MAX_BYTES)) throw new WorldKitError("invalid_request", "The Sample request is too large.", 413);
  const reader = request.body?.getReader(); if (!reader) throw new WorldKitError("invalid_request", "Choose Start Sample to open a private workbench.");
  let count = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const part = await reader.read(); if (part.done) break; count += part.value.byteLength; if (count > ADMISSION_MAX_BYTES) { await reader.cancel(); throw new WorldKitError("invalid_request", "The Sample request is too large.", 413); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new WorldKitError("invalid_request", "The Sample request must be valid UTF-8 JSON."); }
}
export async function handleWorkspace(request: Request): Promise<Response> {
  try {
    if (request.method === "GET" || request.method === "HEAD") {
      const session = await findSession(workspaceCookie(request));
      if (!session) throw new WorldKitError("forbidden", "Choose Start Sample to open a private workbench, or recover your original saved request.", 401);
      const workspace = await getWorkspace(session);
      if (Date.parse(session.expiresAt) <= Date.now()) throw new WorldKitError("forbidden", "This saved workspace has expired. Reading it does not renew its deadline.", 401);
      return request.method === "HEAD" ? new Response(null, { headers }) : Response.json(workspace, { headers });
    }
    if (request.method !== "POST") throw new WorldKitError("invalid_request", "Read with GET or explicitly start a Sample with POST.", 405);
    if (!trustedOrigin(request, process.env.WORLDKIT_PUBLIC_URL, process.env.VERCEL_URL)) throw new WorldKitError("forbidden", "Start the Sample from this WorldKit page.", 403);
    const input = WorkspaceAdmissionSchema.parse(await readAdmissionJson(request));
    const result = await admitWorkspace(input, workspaceCookie(request));
    const workspace = await getWorkspace(result.session);
    if (Date.parse(result.session.expiresAt) <= Date.now()) throw new WorldKitError("forbidden", "This original workspace expired before its response was ready. Recovery cannot renew it.", 410);
    const response = Response.json(workspace, { status: result.disposition === "created" ? 201 : 200, headers });
    response.headers.set("X-WorldKit-Admission", result.disposition);
    response.headers.set("X-WorldKit-Admission-Request", input.requestId);
    if (result.setCookie) {
      // Token alphabet is generated base64url. An absolute expiry preserves the
      // original lifetime even when a lost response is recovered days later.
      const secure = process.env.NODE_ENV === "production" && new URL(request.url).protocol === "https:" ? "; Secure" : "";
      response.headers.set("Set-Cookie", `${sessionCookie}=${result.token}; Path=/; Expires=${new Date(result.session.expiresAt).toUTCString()}; HttpOnly; SameSite=Lax${secure}`);
    }
    return response;
  } catch (error) {
    const response = errorResponse(error); for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    if (error instanceof SessionLimitError) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
}
