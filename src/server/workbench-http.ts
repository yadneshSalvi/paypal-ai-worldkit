import { WorldKitError } from "../../packages/contracts";
import { trustedOrigin } from "../../packages/security/origin";
import { WorkbenchCommandSchema } from "../../packages/workbench/contracts";
import { errorResponse } from "./http";
import { findSession } from "./repository";
import { workspaceCookie } from "./workspace-admission-http";
import { workbenchCommand } from "./workbench-commands";

export const WORKBENCH_MAX_BYTES = 32_768;
const headers = { "Cache-Control": "private, no-store, max-age=0, must-revalidate", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export async function readWorkbenchJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new WorldKitError("invalid_request", "Send an application/json workbench action.", 415);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > WORKBENCH_MAX_BYTES)) throw new WorldKitError("invalid_request", "This workbench action exceeds 32 KiB.", 413);
  const reader = request.body?.getReader(); if (!reader) throw new WorldKitError("invalid_request", "Choose a workbench action.", 400);
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > WORKBENCH_MAX_BYTES) { await reader.cancel(); throw new WorldKitError("invalid_request", "This workbench action exceeds 32 KiB.", 413); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new WorldKitError("invalid_request", "The workbench action is not valid UTF-8 JSON.", 400); }
}
export async function handleWorkbench(request: Request) {
  try {
    if (request.method !== "POST") throw new WorldKitError("invalid_request", "Choose Preview or Save to send a workbench action.", 405);
    if (!trustedOrigin(request, process.env.WORLDKIT_PUBLIC_URL, process.env.VERCEL_URL)) throw new WorldKitError("forbidden", "This action must start from the same private WorldKit workbench.", 403);
    const session = await findSession(workspaceCookie(request));
    if (!session) throw new WorldKitError("forbidden", "Open the original private workspace to continue.", 401);
    const input = WorkbenchCommandSchema.parse(await readWorkbenchJson(request));
    return Response.json(await workbenchCommand(session, input), { headers });
  } catch (error) { const response = errorResponse(error); for (const [name, value] of Object.entries(headers)) response.headers.set(name, value); return response; }
}
