import { trustedOrigin } from "../../packages/security/origin";
import { BenchCommandSchema, type BenchAccess } from "../../packages/physical-notebook/contracts";
import { transaction } from "./db";
import { errorResponse } from "./http";
import { physicalNotebookCommand, physicalNotebookHome } from "./physical-notebook";
import { authorizeBench, benchFail, benchRun } from "./physical-notebook-authority";
import { assertBenchRights, benchAssets, benchUploadDto, purgeBenchAsset, purgeBenchUpload, verifyBenchUpload } from "./physical-notebook-assets";
import { benchByteRange, readBenchObject, sliceBenchStream } from "./physical-notebook-storage";

export const benchHeaders = { "Cache-Control": "private, no-store, max-age=0, must-revalidate", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export const benchReviewerCookie = process.env.WORLDKIT_QA_MODE === "physical-notebook" ? "wk_bench_review_qa" : "wk_bench_review";
export function benchOrigin(request: Request) { if (!trustedOrigin(request, process.env.WORLDKIT_PUBLIC_URL, process.env.VERCEL_URL)) benchFail("This action must start from the same WorldKit notebook."); }
export async function readBenchJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") benchFail("Send an application/json notebook request.", "invalid_request", 415);
  const length = request.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65_536)) benchFail("The notebook request exceeds 64 KiB.", "invalid_request", 413);
  const reader = request.body?.getReader(); if (!reader) benchFail("Send a notebook command.", "invalid_request");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 65_536) { await reader.cancel(); benchFail("The notebook request exceeds 64 KiB.", "invalid_request", 413); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { benchFail("The notebook command is not valid UTF-8 JSON.", "invalid_request"); }
}
export function benchError(error: unknown) { const response = errorResponse(error); for (const [name, value] of Object.entries(benchHeaders)) response.headers.set(name, value); return response; }
export async function handlePhysicalNotebook(request: Request, access: BenchAccess) {
  try {
    const url = new URL(request.url);
    if (request.method === "GET") return Response.json(await physicalNotebookHome(access, url.searchParams.get("runId") ?? undefined, url.searchParams.get("editionId") ?? undefined), { headers: benchHeaders });
    if (request.method !== "POST") benchFail("This notebook operation requires GET or POST.", "invalid_request", 405);
    benchOrigin(request); const input = BenchCommandSchema.parse(await readBenchJson(request));
    const result = await physicalNotebookCommand(access, input);
    if (input.kind === "verify_upload") result.upload = await verifyBenchUpload(access, input.runId, input.uploadId);
    if (input.kind === "withdraw_asset") await purgeBenchAsset(access, input.runId, input.assetId);
    if (input.kind === "withdraw_upload") await purgeBenchUpload(access, input.runId, input.uploadId);
    return Response.json(result, { headers: benchHeaders });
  } catch (error) { return benchError(error); }
}
async function originalAuthority(access: BenchAccess, runId: string, assetId: string) {
  return transaction(async db => {
    await authorizeBench(db, access, runId); const { edition } = await benchRun(db, access, runId);
    const asset = (await benchAssets(db, access.tenantId, runId)).find(value => value.id === assetId && value.availability === "available");
    if (!asset || access.kind === "reviewer" && !edition.attachments.some(link => link.assetId === asset.id && link.assetHash === asset.sha256)) benchFail("This original is unavailable or outside the exact review manifest.", "not_found");
    assertBenchRights(asset);
    const row = (await db.query("SELECT * FROM wk_bench_uploads WHERE id=$1 AND tenant_id=$2 AND run_id=$3 AND phase='verified' AND asset_id=$4", [asset.uploadId, access.tenantId, runId, assetId])).rows[0];
    if (!row) benchFail("The original's verification record is unavailable.", "not_found");
    await authorizeBench(db, access, runId); return { asset, upload: benchUploadDto(row) };
  });
}
function monitoredStream(source: ReadableStream<Uint8Array>, check: () => Promise<unknown>) {
  const reader = source.getReader(); let bytes = 0, last = Date.now();
  return new ReadableStream<Uint8Array>({ async pull(controller) {
    try {
      if (bytes >= 8 * 1024 * 1024 || Date.now() - last >= 10_000) { await check(); bytes = 0; last = Date.now(); }
      const value = await reader.read(); if (value.done) { controller.close(); reader.releaseLock(); return; }
      bytes += value.value.length; controller.enqueue(value.value);
    } catch (error) { controller.error(error); await reader.cancel().catch(() => undefined); }
  }, async cancel(reason) { await reader.cancel(reason); } });
}
export async function physicalOriginalResponse(request: Request, access: BenchAccess, assetId: string) {
  try {
    if (request.method !== "GET") benchFail("Originals are read with GET.", "invalid_request", 405);
    const runId = new URL(request.url).searchParams.get("runId") ?? "", found = await originalAuthority(access, runId, assetId);
    const range = benchByteRange(request.headers.get("range"), found.asset.bytes), object = await readBenchObject(found.upload);
    if (!object) benchFail("The original is absent from its private store. Its retained fingerprint alone is not available original evidence.", "not_found");
    if (object.size !== found.asset.bytes) { await object.stream.cancel(); benchFail("The stored original's size changed. It cannot be served as the verified original.", "needs_evidence"); }
    try { await originalAuthority(access, runId, assetId); } catch (error) { await object.stream.cancel(); throw error; }
    const headers = new Headers({ ...benchHeaders, "Content-Type": found.asset.mediaType, "Content-Length": String(range ? range.end - range.start + 1 : found.asset.bytes), "Accept-Ranges": "bytes", "X-WorldKit-Original-SHA256": found.asset.sha256, "Content-Disposition": `${found.asset.mediaType === "application/pdf" || new URL(request.url).searchParams.get("download") === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(found.asset.filename)}`, "Content-Security-Policy": "default-src 'none'; sandbox" });
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${found.asset.bytes}`);
    const stream = range ? sliceBenchStream(object.stream, range.start, range.end) : object.stream;
    return new Response(monitoredStream(stream, () => originalAuthority(access, runId, assetId)), { status: range ? 206 : 200, headers });
  } catch (error) { return benchError(error); }
}
