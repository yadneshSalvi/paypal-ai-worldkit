import { trustedOrigin } from "../../packages/security/origin";
import { ResearchCommandSchema } from "../../packages/research-notebook/contracts";
import { errorResponse } from "./http";
import { researchFail, type ResearchAccess } from "./research-notebook-authority";
import { researchNotebookCommand, researchNotebookHome } from "./research-notebook";

export const RESEARCH_MAX_BODY_BYTES = 262_144;
export const researchHeaders = { "Cache-Control": "private, no-store, max-age=0, must-revalidate", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export function researchError(error: unknown) { const response = errorResponse(error); for (const [name, value] of Object.entries(researchHeaders)) response.headers.set(name, value); return response; }
export function researchOrigin(request: Request) { if (!trustedOrigin(request, process.env.WORLDKIT_PUBLIC_URL, process.env.VERCEL_URL)) researchFail("This action must start from the same private WorldKit research notebook."); }
export async function readResearchJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") researchFail("Send an application/json research command.", "invalid_request", 415);
  const length = request.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > RESEARCH_MAX_BODY_BYTES)) researchFail("This research command exceeds 256 KiB.", "invalid_request", 413);
  const reader = request.body?.getReader(); if (!reader) researchFail("Send a research command.", "invalid_request");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > RESEARCH_MAX_BODY_BYTES) { await reader.cancel(); researchFail("This research command exceeds 256 KiB.", "invalid_request", 413); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { researchFail("The research command is not valid UTF-8 JSON.", "invalid_request"); }
}
export async function handleResearchNotebook(request: Request, access: ResearchAccess) {
  try {
    const url = new URL(request.url);
    if (request.method === "GET") return Response.json(await researchNotebookHome(access, url.searchParams.get("studyId") ?? undefined, url.searchParams.get("protocolId") ?? undefined), { headers: researchHeaders });
    if (request.method !== "POST") researchFail("Research records are read with GET or recorded with POST.", "invalid_request", 405);
    researchOrigin(request); const command = ResearchCommandSchema.parse(await readResearchJson(request));
    return Response.json(await researchNotebookCommand(access, command), { headers: researchHeaders });
  } catch (error) { return researchError(error); }
}
