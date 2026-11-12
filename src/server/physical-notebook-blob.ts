import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { z } from "zod";
import { hash } from "../../packages/compatibility";
import type { BenchAccess } from "../../packages/physical-notebook/contracts";
import { transaction } from "./db";
import { initializePhysicalNotebook } from "./physical-notebook-db";
import { authorizeBench, benchEvent, benchFail, benchIso } from "./physical-notebook-authority";
import { assertBenchRights } from "./physical-notebook-assets";
import { benchStorageMode } from "./physical-notebook-storage";
import { benchError, benchHeaders, benchOrigin, readBenchJson } from "./physical-notebook-http";

const ClientScope = z.object({ runId: z.uuid(), uploadId: z.uuid() }).strict();
const ProviderScope = ClientScope.extend({ tenantId: z.string().min(1).max(100), fileHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export async function benchUploadTokenOptions(access: BenchAccess, pathname: string, clientPayload: string | null) {
  let parsed: unknown; try { parsed = JSON.parse(clientPayload ?? ""); } catch { benchFail("The original-file scope is invalid.", "invalid_request"); }
  const input = ClientScope.parse(parsed); await initializePhysicalNotebook();
  return transaction(async db => {
    const auth = await authorizeBench(db, access, input.runId, "owner");
    const row = (await db.query("SELECT * FROM wk_bench_uploads WHERE id=$1 AND run_id=$2 AND tenant_id=$3 FOR UPDATE", [input.uploadId, input.runId, access.tenantId])).rows[0];
    if (!row || row.pathname !== pathname || row.transport !== "private_blob" || row.completed_receipt?.generator) benchFail("This upload path is outside the declared original-file intent.", "not_found");
    if (Date.parse(benchIso(row.expires_at)) <= Date.now() || row.phase !== "awaiting_upload") benchFail("This original-file intent is no longer open.", "stale_revision");
    assertBenchRights(row.file);
    const validUntil = Math.min(Date.parse(auth.expiresAt), Date.parse(benchIso(row.expires_at)), row.file.rights.expiresAt ? Date.parse(row.file.rights.expiresAt) : Infinity, Date.now() + 15 * 60_000);
    const tokenPayload = JSON.stringify({ ...input, tenantId: access.tenantId, fileHash: hash(row.file) });
    await db.query("UPDATE wk_bench_uploads SET token_expires_at=GREATEST(token_expires_at,$2::timestamptz) WHERE id=$1", [input.uploadId, new Date(validUntil).toISOString()]);
    await benchEvent(db, access, input.runId, "original.upload_access", "Short-lived upload access was scoped to one exact private path, size and declared media type. The token is not evidence that bytes arrived.", { uploadId: input.uploadId, validUntil: new Date(validUntil).toISOString(), fileHash: hash(row.file) });
    await authorizeBench(db, access, input.runId, "owner");
    return { allowedContentTypes: [row.file.mediaType as string], maximumSizeInBytes: row.file.bytes as number, validUntil, addRandomSuffix: false, allowOverwrite: false, tokenPayload, ttlDays: Math.max(1, Math.min(7, Math.ceil((Date.parse(auth.expiresAt) - Date.now()) / 86400000))) };
  });
}
/** Called only after the installed Blob SDK authenticates its callback signature. */
async function recordAuthenticatedCompletion(blob: { pathname: string; contentType: string; [key: string]: unknown }, tokenPayload: string | null | undefined) {
  let parsed: unknown; try { parsed = JSON.parse(tokenPayload ?? ""); } catch { benchFail("The signed original-file callback scope is invalid.", "invalid_request"); }
  const input = ProviderScope.parse(parsed); await initializePhysicalNotebook();
  return transaction(async db => {
    // A delayed authentic delivery can be retained after expiry; it never grants
    // access, attaches bytes, renews the workspace or verifies physical origin.
    const session = (await db.query("SELECT id FROM wk_sessions WHERE id=$1 FOR UPDATE", [input.tenantId])).rows[0];
    if (!session) benchFail("The signed original-file workspace is unavailable.", "not_found");
    const row = (await db.query("SELECT * FROM wk_bench_uploads WHERE id=$1 AND run_id=$2 AND tenant_id=$3 FOR UPDATE", [input.uploadId, input.runId, input.tenantId])).rows[0];
    if (!row || row.transport !== "private_blob" || row.pathname !== blob.pathname || row.file.mediaType !== blob.contentType || hash(row.file) !== input.fileHash || row.completed_receipt?.generator) benchFail("The signed callback does not match the exact private original intent.", "not_found");
    const deliveryHash = hash({ blob, scope: input });
    if (row.completed_receipt) {
      if (row.completed_receipt.deliveryHash !== deliveryHash) benchFail("A different completion was already recorded for this immutable original path.", "stale_revision"); return;
    }
    const controlled = !!process.env.WORLDKIT_QA_MODE;
    await db.query("UPDATE wk_bench_uploads SET completed_receipt=$2,phase=CASE WHEN phase='awaiting_upload' THEN 'uploaded' ELSE phase END WHERE id=$1", [input.uploadId, { source: controlled ? "controlled_blob_signature_test" : "vercel_blob_authenticated_callback", deliveryHash, receivedAt: new Date().toISOString(), blob, scope: input }]);
    await benchEvent(db, { tenantId: input.tenantId, actorId: controlled ? "controlled:blob-signature" : "provider:vercel-blob", kind: "owner", grantId: null }, input.runId, "original.authenticated_callback", controlled ? "A controlled SDK signature test matched the exact original path. No authentic provider delivery or original byte arrival is claimed." : "The installed Blob SDK authenticated a completion for the exact private original path. Byte verification and attachment still require current owner authority.", { uploadId: input.uploadId, deliveryHash, provenance: controlled ? "controlled" : "provider_authenticated" });
  });
}
export async function handleBenchBlob(request: Request, owner: () => Promise<BenchAccess>) {
  try {
    if (benchStorageMode() !== "private_blob") benchFail("Private Blob intake is not configured for this runtime.", "needs_evidence");
    const body = await readBenchJson(request) as HandleUploadBody;
    if (!body || !["blob.generate-client-token", "blob.upload-completed"].includes(body.type)) benchFail("Unknown original-file upload operation.", "invalid_request");
    let access: BenchAccess | null = null;
    if (body.type === "blob.generate-client-token") { benchOrigin(request); access = await owner(); }
    else if (!request.headers.get("x-vercel-signature")) benchFail("The original-file callback signature is missing.");
    let response;
    try {
      response = await handleUpload({ request, body,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          if (!access) benchFail("Creator access is required for an upload token.");
          return { ...await benchUploadTokenOptions(access, pathname, clientPayload), callbackUrl: new URL("/api/physical-notebook/uploads", request.url).toString() };
        },
        onUploadCompleted: async ({ blob, tokenPayload }) => { await recordAuthenticatedCompletion({ ...blob }, tokenPayload); },
      });
    } catch (error) {
      if (error instanceof Error && /(?:Invalid|Missing) callback signature/.test(error.message)) benchFail("The original-file callback signature could not be authenticated.");
      throw error;
    }
    return Response.json(response, { headers: benchHeaders });
  } catch (error) { return benchError(error); }
}
