import { constants } from "node:fs";
import { mkdir, open, lstat, realpath, link, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { del, get, put } from "@vercel/blob";
import type { BenchHome, BenchUpload } from "../../packages/physical-notebook/contracts";
import { benchFail } from "./physical-notebook-authority";

const pathPattern = /^physical-notebook\/(sample|operator_recorded)\/[a-zA-Z0-9_-]{1,100}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(wav|mp3|mp4|webm|png|jpg|pdf)$/;
export function benchStorageMode(): BenchHome["storage"] {
  if (process.env.WORLDKIT_QA_MODE === "physical-notebook" && process.env.WORLDKIT_DISABLE_PROVIDERS === "true" && process.env.WORLDKIT_PHYSICAL_LOCAL_STORAGE === "true" && process.env.WORLDKIT_PHYSICAL_LOCAL_DIR) return "controlled_local";
  if (process.env.WORLDKIT_DISABLE_PROVIDERS !== "true" && process.env.BLOB_READ_WRITE_TOKEN) return "private_blob";
  return "unavailable";
}
function storageIdentity(upload: Pick<BenchUpload, "pathname" | "transport">) {
  if (!pathPattern.test(upload.pathname) || benchStorageMode() !== upload.transport) benchFail("The report's original-file store is unavailable. No alternate store is used.", "needs_evidence");
}
async function localFile(pathname: string, create = false) {
  const root = process.env.WORLDKIT_PHYSICAL_LOCAL_DIR;
  if (!root || !isAbsolute(root) || !pathPattern.test(pathname)) benchFail("The controlled original-file location is invalid.");
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const resolved = await realpath(root);
  if (resolved !== root || (await lstat(root)).isSymbolicLink()) benchFail("The original-file root must be an owned real directory.");
  const file = join(root, pathname), rel = relative(root, file);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) benchFail("The original-file path is invalid.");
  let current = root;
  for (const part of pathname.split("/").slice(0, -1)) {
    current = join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) benchFail("Original-file paths cannot traverse links.");
  }
  return file;
}
export async function readBenchObject(upload: Pick<BenchUpload, "pathname" | "transport">): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null> {
  storageIdentity(upload);
  if (upload.transport === "private_blob") {
    const value = await get(upload.pathname, { access: "private", useCache: false });
    if (!value) return null;
    if (value.statusCode !== 200 || value.blob.pathname !== upload.pathname) benchFail("The private store did not return the exact original.", "needs_evidence");
    return { stream: value.stream, size: value.blob.size };
  }
  try {
    const file = await localFile(upload.pathname), handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat(); if (!stat.isFile()) { await handle.close(); benchFail("The original is not a regular file."); }
    let closed = false, position = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const buffer = Buffer.alloc(64 * 1024), result = await handle.read(buffer, 0, buffer.length, position);
          if (closed) return;
          if (!result.bytesRead) { closed = true; await handle.close(); controller.close(); return; }
          position += result.bytesRead; controller.enqueue(buffer.subarray(0, result.bytesRead));
        } catch (error) { if (!closed) { closed = true; await handle.close().catch(() => undefined); controller.error(error); } }
      },
      async cancel() { if (!closed) { closed = true; await handle.close().catch(() => undefined); } },
    });
    return { stream, size: stat.size };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/** Local controlled intake only; exclusive link commits the complete original once. */
export async function writeControlledBenchObject(upload: BenchUpload, stream: ReadableStream<Uint8Array>) {
  storageIdentity(upload); if (upload.transport !== "controlled_local") benchFail("This intake is available only in the isolated controlled runtime.");
  const file = await localFile(upload.pathname, true), tmp = join(dirname(file), `.upload-${randomUUID()}`), handle = await open(tmp, "wx", 0o600);
  const reader = stream.getReader(), digest = createHash("sha256"); let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length; if (bytes > upload.file.bytes) benchFail("The original exceeds its exact declared byte count.", "invalid_request", 413);
      // FileHandle.write may be partial; writeFile completes this bounded chunk.
      digest.update(part.value); await handle.writeFile(part.value);
    }
    if (bytes !== upload.file.bytes) benchFail("The original byte count is incomplete.", "invalid_request");
    await handle.sync(); await handle.close();
    const incomingHash = digest.digest("hex");
    await link(tmp, file).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW), priorHash = createHash("sha256");
      try { for await (const part of prior.createReadStream()) priorHash.update(part); }
      finally { await prior.close().catch(() => undefined); }
      if (priorHash.digest("hex") !== incomingHash) benchFail("Different bytes already occupy this immutable original-file intent. The first original was retained.", "stale_revision");
    });
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); await handle.close().catch(() => undefined); await unlink(tmp).catch(() => undefined); }
}
export async function writeBenchGeneratedObject(upload: BenchUpload, bytes: Buffer) {
  storageIdentity(upload);
  if (upload.transport === "controlled_local") return writeControlledBenchObject(upload, new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
  await put(upload.pathname, bytes, { access: "private", contentType: upload.file.mediaType, addRandomSuffix: false, allowOverwrite: false });
}
export async function deleteBenchObject(upload: Pick<BenchUpload, "pathname" | "transport">) {
  storageIdentity(upload);
  if (upload.transport === "private_blob") { await del(upload.pathname); return; }
  try { const file = await localFile(upload.pathname); if ((await lstat(file)).isSymbolicLink()) benchFail("A linked file cannot be purged through this store."); await unlink(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Single-range support keeps private audio/video seekable without a public URL. */
export function benchByteRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) benchFail("Use one valid byte range.", "invalid_request", 416);
  const suffix = !match[1], first = Number(match[1] || 0), second = Number(match[2] || size - 1);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) benchFail("The requested range is invalid.", "invalid_request", 416);
  const start = suffix ? Math.max(0, size - second) : first, end = suffix ? size - 1 : Math.min(size - 1, second);
  if (start >= size || start > end || suffix && second <= 0) benchFail("The requested range is outside the original.", "invalid_request", 416);
  return { start, end };
}
export function sliceBenchStream(source: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  const reader = source.getReader(); let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      try { for (;;) {
        const next = await reader.read(); if (next.done) { controller.close(); reader.releaseLock(); return; }
        const left = Math.max(0, start - offset), right = Math.min(next.value.length, end + 1 - offset); offset += next.value.length;
        if (right > left) controller.enqueue(next.value.subarray(left, right));
        if (offset > end) { controller.close(); await reader.cancel(); reader.releaseLock(); return; }
        if (right > left) return;
      } } catch (error) { controller.error(error); await reader.cancel().catch(() => undefined); }
    }, async cancel(reason) { await reader.cancel(reason); },
  });
}
