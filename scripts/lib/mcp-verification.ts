import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CertificateSchema } from "../../packages/contracts/index";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,159}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const McpVerificationInputSchema = z.object({
  schema: z.literal("worldkit.mcp-verification-input.v1"), endpoint: z.string().max(2048),
  token: z.string().regex(/^wk_[A-Za-z0-9_-]{43}$/),
  grantExpiresAt: z.iso.datetime({ offset: true }), workspaceExpiresAt: z.iso.datetime({ offset: true }),
  revisionId: identity, expectedGraphHash: digest, expectedCertificateId: identity,
}).strict();
export type McpVerificationInput = z.infer<typeof McpVerificationInputSchema>;
export class VerificationFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = "VerificationFailure"; }
}
function requireFact(condition: unknown, code: string): asserts condition { if (!condition) throw new VerificationFailure(code); }
const safeCode = (error: unknown) => error instanceof VerificationFailure ? error.code : "MCP_VERIFICATION_HELD";

export function parseVerificationArgs(args: string[]): { help: true } | { inputPath: string; outputPath: string } {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const values = new Map<string, string>(); requireFact(args.length === 4, "EXPLICIT_INPUT_AND_NEW_OUTPUT_REQUIRED");
  for (let i = 0; i < args.length; i += 2) {
    requireFact(["--input", "--output"].includes(args[i]!) && !values.has(args[i]!), "INVALID_ARGUMENTS");
    requireFact(isAbsolute(args[i + 1]!), "ABSOLUTE_FILE_PATHS_REQUIRED"); values.set(args[i]!, args[i + 1]!);
  }
  const inputPath = values.get("--input"), outputPath = values.get("--output");
  requireFact(inputPath && outputPath && inputPath !== outputPath && inputPath !== outputPath + ".journal.jsonl", "DISTINCT_INPUT_AND_OUTPUT_REQUIRED");
  return { inputPath, outputPath };
}
export function validateVerificationInput(value: unknown, now = Date.now()): McpVerificationInput {
  const parsed = McpVerificationInputSchema.safeParse(value); requireFact(parsed.success, "INVALID_PRIVATE_INPUT");
  let url: URL;
  try { url = new URL(parsed.data.endpoint); } catch { throw new VerificationFailure("INVALID_MCP_ENDPOINT"); }
  requireFact(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/api/mcp", "INVALID_MCP_ENDPOINT");
  requireFact(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "HTTPS_OR_LOOPBACK_REQUIRED");
  requireFact(url.href === parsed.data.endpoint, "CANONICAL_ENDPOINT_REQUIRED"); assertLive(parsed.data, now); return parsed.data;
}
function assertLive(input: McpVerificationInput, now: number) {
  requireFact(Date.parse(input.grantExpiresAt) > now && Date.parse(input.workspaceExpiresAt) > now, "ORIGINAL_AUTHORITY_EXPIRED");
}
async function privateInput(path: string, now: number) {
  requireFact(isAbsolute(path), "ABSOLUTE_FILE_PATHS_REQUIRED"); let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = await file.stat();
    requireFact(stat.isFile() && stat.size > 0 && stat.size <= 65536, "INVALID_PRIVATE_INPUT_FILE");
    requireFact(process.platform === "win32" || (stat.mode & 0o077) === 0, "PRIVATE_INPUT_PERMISSIONS_REQUIRED");
    return validateVerificationInput(JSON.parse(await file.readFile("utf8")), now);
  } catch (error) { throw error instanceof VerificationFailure ? error : new VerificationFailure("INVALID_PRIVATE_INPUT_FILE"); }
  finally { await file?.close(); }
}
async function mustNotExist(path: string) {
  try { await lstat(path); throw new VerificationFailure("OUTPUT_ALREADY_EXISTS"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function writeReceipt(file: FileHandle, receipt: unknown) {
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n"); await file.truncate(0);
  for (let position = 0; position < bytes.length;) {
    const result = await file.write(bytes, position, bytes.length - position, position);
    requireFact(result.bytesWritten > 0, "RECEIPT_WRITE_FAILED"); position += result.bytesWritten;
  }
  await file.sync();
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new VerificationFailure("TRANSPORT_ABORTED"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new VerificationFailure("TRANSPORT_ABORTED")); signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function boundedBytes(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    requireFact(Number(response.headers.get("content-length") ?? 0) <= 1_048_576, "MCP_RESPONSE_TOO_LARGE");
    while (reader) {
      const part = await abortable(reader.read(), signal); if (part.done) break;
      size += part.value.byteLength; requireFact(size <= 1_048_576, "MCP_RESPONSE_TOO_LARGE"); chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } catch (error) { void reader?.cancel().catch(() => {}); throw error; }
  finally { reader?.releaseLock(); }
}
export type VerificationReceipt = {
  schema: "worldkit.mcp-verification-receipt.v1"; status: "started" | "passed" | "held"; startedAt: string; finishedAt?: string;
  endpoint: string; grantFingerprint: string; grantExpiresAt: string; workspaceExpiresAt: string;
  revisionId: string; graphHash: string; expectedCertificateId: string;
  transport: "Official MCP SDK Streamable HTTP"; tool: "verify_kit"; freshnessPolicy: "historical";
  requestCount: number; journalHead: string; failure?: { code: string; automaticRetry: false };
  certificate?: { id: string; revisionId: string; graphHash: string; sourceHash: string; ruleVersion: string; status: string; counts: { satisfied: number; violated: number; unknown: number }; physicalTest: "not_performed"; sourceMode: string };
  boundary: { newOwners: 0; newGrants: 0; quoteOrPaymentCalls: 0; applicationRequestAccountingMayChange: true; optionalServerPush: "declined_before_network" };
};

/** Existing authority only: no repository, database, admission or provider adapter imports. */
export async function verifyExistingMcpGrant(paths: { inputPath: string; outputPath: string }, options: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}): Promise<VerificationReceipt> {
  const now = options.now ?? Date.now; const input = await privateInput(paths.inputPath, now());
  requireFact(isAbsolute(paths.outputPath) && paths.outputPath !== paths.inputPath && paths.outputPath + ".journal.jsonl" !== paths.inputPath, "DISTINCT_INPUT_AND_OUTPUT_REQUIRED");
  const journalPath = paths.outputPath + ".journal.jsonl"; await mustNotExist(paths.outputPath); await mustNotExist(journalPath);
  const output = await open(paths.outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let journalFile: FileHandle | undefined; let sequence = 0, head = "0".repeat(64), requests = 0, unresolved = 0; let writes = Promise.resolve();
  const receipt: VerificationReceipt = {
    schema: "worldkit.mcp-verification-receipt.v1", status: "started", startedAt: new Date(now()).toISOString(), endpoint: input.endpoint,
    grantFingerprint: sha(input.token), grantExpiresAt: input.grantExpiresAt, workspaceExpiresAt: input.workspaceExpiresAt,
    revisionId: input.revisionId, graphHash: input.expectedGraphHash, expectedCertificateId: input.expectedCertificateId,
    transport: "Official MCP SDK Streamable HTTP", tool: "verify_kit", freshnessPolicy: "historical", requestCount: 0, journalHead: head,
    boundary: { newOwners: 0, newGrants: 0, quoteOrPaymentCalls: 0, applicationRequestAccountingMayChange: true, optionalServerPush: "declined_before_network" },
  };
  const record = (event: Record<string, unknown>) => {
    writes = writes.then(async () => {
      const value = { sequence: ++sequence, previousHash: head, at: new Date(now()).toISOString(), ...event }; head = sha(JSON.stringify(value));
      await journalFile!.appendFile(JSON.stringify({ ...value, hash: head }) + "\n"); await journalFile!.sync();
    }); return writes;
  };
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  const inflight = new Set<Promise<Response>>(), sent = new Set<string>(); let client: Client | undefined;
  try {
    journalFile = await open(journalPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    await writeReceipt(output, receipt); const parent = await open(dirname(paths.outputPath), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
    await record({ kind: "verification_started", revisionId: input.revisionId, graphHash: input.expectedGraphHash, certificateId: input.expectedCertificateId });
    const dispatch = async (target: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      assertLive(input, now()); const url = target instanceof Request ? target.url : String(target); requireFact(url === input.endpoint, "UNEXPECTED_TRANSPORT_TARGET");
      const method = (init?.method ?? (target instanceof Request ? target.method : "GET")).toUpperCase();
      // The official client attempts an optional server-push GET after its
      // initialized notification. This exact verifier needs only the server's
      // stateless JSON POST replies. Decline locally, without inventing an HTTP
      // response or transmitting the grant to an unneeded long-lived stream.
      if (method === "GET") {
        requireFact(!sent.has("GET"), "AUTOMATIC_REDISPATCH_REFUSED"); sent.add("GET");
        await record({ kind: "optional_stream_declined", method: "GET", networkDispatch: false });
        throw new VerificationFailure("OPTIONAL_SSE_DISABLED");
      }
      const headers = new Headers(target instanceof Request ? target.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      requireFact(headers.get("authorization") === `Bearer ${input.token}` && !headers.has("cookie"), "UNEXPECTED_TRANSPORT_AUTHORITY");
      let body: string | undefined, rpc = "GET";
      if (method === "POST") {
        requireFact(typeof init?.body === "string" && Buffer.byteLength(init.body) <= 20000, "INVALID_RPC_BODY"); body = init.body;
        const message = JSON.parse(body) as { method?: string; params?: { name?: string; arguments?: unknown } }; rpc = message.method ?? "";
        requireFact(["initialize", "notifications/initialized", "tools/list", "tools/call"].includes(rpc), "UNEXPECTED_RPC_METHOD");
        if (rpc === "tools/call") {
          requireFact(message.params?.name === "verify_kit", "UNEXPECTED_TOOL"); const args = message.params.arguments as Record<string, unknown>;
          requireFact(args && Object.keys(args).sort().join(",") === "expected_graph_hash,freshness_policy,kit_revision_id" && args.kit_revision_id === input.revisionId && args.expected_graph_hash === input.expectedGraphHash && args.freshness_policy === "historical", "UNEXPECTED_TOOL_ARGUMENTS");
        }
      } else requireFact(method === "GET", "UNEXPECTED_HTTP_METHOD");
      requireFact(!sent.has(rpc), "AUTOMATIC_REDISPATCH_REFUSED"); sent.add(rpc); const number = ++requests;
      await record({ kind: "request_started", request: number, method, rpc, requestBodySha256: body ? sha(body) : null });
      const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : [])]);
      try {
        const response = await abortable((options.fetch ?? globalThis.fetch)(url, { method, headers, body, redirect: "error", credentials: "omit", signal: requestSignal }), requestSignal);
        requireFact(response.status < 300 || response.status >= 400, "REDIRECT_REFUSED"); const bytes = await boundedBytes(response, requestSignal);
        await record({ kind: "request_completed", request: number, status: response.status, responseBytes: bytes.length, responseSha256: sha(bytes) });
        return new Response(bytes.length ? new Uint8Array(bytes) : null, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) { unresolved++; await record({ kind: "request_unresolved", request: number, code: safeCode(error), automaticRetry: false }); throw error; }
    };
    const boundedFetch: typeof fetch = (target, init) => {
      const pending = dispatch(target, init); inflight.add(pending); void pending.then(() => inflight.delete(pending), () => inflight.delete(pending)); return pending;
    };
    client = new Client({ name: "worldkit-existing-grant-verifier", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(input.endpoint), {
      requestInit: { headers: { authorization: `Bearer ${input.token}` }, redirect: "error", credentials: "omit" }, fetch: boundedFetch, redirectPolicy: "same-origin",
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    await client.connect(transport, { timeout: 20_000 }); requireFact(client.getServerVersion()?.name === "worldkit", "UNEXPECTED_MCP_SERVER");
    const tools = await client.listTools(undefined, { timeout: 20_000 }); requireFact(tools.tools.some(tool => tool.name === "verify_kit") && !tools.nextCursor, "VERIFY_TOOL_UNAVAILABLE");
    const result = await client.callTool({ name: "verify_kit", arguments: { kit_revision_id: input.revisionId, expected_graph_hash: input.expectedGraphHash, freshness_policy: "historical" } }, undefined, { timeout: 20_000 });
    requireFact(result.isError !== true, "VERIFY_TOOL_REFUSED"); const value = result.structuredContent as Record<string, unknown> | undefined;
    requireFact(value?.sourceMode === "modelled" && value.physicalTest === "not_performed", "INVALID_VERIFICATION_SCOPE");
    const parsed = CertificateSchema.safeParse(value.certificate); requireFact(parsed.success, "INVALID_SAVED_CERTIFICATE"); const certificate = parsed.data;
    requireFact(certificate.id === input.expectedCertificateId && certificate.revisionId === input.revisionId && certificate.graphHash === input.expectedGraphHash, "SAVED_CERTIFICATE_MISMATCH");
    requireFact(digest.safeParse(certificate.sourceHash).success && certificate.ruleVersion.length <= 100, "INVALID_CERTIFICATE_SOURCE");
    for (const count of Object.values(certificate.counts)) requireFact(Number.isSafeInteger(count) && count >= 0, "INVALID_CERTIFICATE_COUNTS");
    assertLive(input, now()); receipt.certificate = { id: certificate.id, revisionId: certificate.revisionId, graphHash: certificate.graphHash, sourceHash: certificate.sourceHash, ruleVersion: certificate.ruleVersion, status: certificate.status, counts: certificate.counts, sourceMode: certificate.sourceMode, physicalTest: certificate.physicalTest };
    receipt.status = "passed"; await record({ kind: "exact_saved_certificate_verified", certificateId: certificate.id, graphHash: certificate.graphHash });
  } catch (error) { receipt.status = "held"; receipt.failure = { code: safeCode(error), automaticRetry: false }; }
  finally {
    await client?.close().catch(() => {}); controller.abort(); await Promise.allSettled([...inflight]); clearTimeout(timeout);
    await writes.catch(() => { receipt.status = "held"; receipt.failure = { code: "JOURNAL_WRITE_FAILED", automaticRetry: false }; });
    if (receipt.status === "passed" && unresolved) { receipt.status = "held"; receipt.failure = { code: "UNRESOLVED_TRANSPORT", automaticRetry: false }; }
    receipt.finishedAt = new Date(now()).toISOString(); receipt.requestCount = requests; receipt.journalHead = head;
    try { await writeReceipt(output, receipt); } finally { await output.close(); await journalFile?.close(); }
  }
  return receipt;
}
