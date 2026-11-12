import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, writeFile, readFile, chmod, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { parseVerificationArgs, validateVerificationInput, verifyExistingMcpGrant } from "../scripts/lib/mcp-verification";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = "wk_" + "X".repeat(43); // Synthetic transport credential only.
const graphHash = "a".repeat(64), certificateId = "cert_" + "b".repeat(32), revisionId = "controlled-revision-1";
const certificate = () => ({ id: certificateId, revisionId, graphHash, sourceHash: "c".repeat(64), ruleVersion: "controlled-1", status: "unknown", issuedAt: new Date().toISOString(), sourceMode: "modelled", results: [], counts: { satisfied: 0, violated: 0, unknown: 0 }, review: { required: 0, reviewed: 0, pending: 0 }, scope: "Computational routing and source-backed constraints; physical performance not tested.", physicalTest: "not_performed" });
function input(endpoint: string) { return { schema: "worldkit.mcp-verification-input.v1", endpoint, token, grantExpiresAt: new Date(Date.now() + 3600_000).toISOString(), workspaceExpiresAt: new Date(Date.now() + 86400_000).toISOString(), revisionId, expectedGraphHash: graphHash, expectedCertificateId: certificateId }; }
async function files(endpoint: string, changes: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "worldkit-existing-mcp-"));
  const inputPath = join(dir, "input.private.json"), outputPath = join(dir, "receipt.json");
  await writeFile(inputPath, JSON.stringify({ ...input(endpoint), ...changes }), { mode: 0o600 });
  return { dir, inputPath, outputPath };
}
type Wire = { method: string; path: string; rpc?: string; name?: string; args?: unknown; authenticated: boolean };
async function bodyOf(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
async function peer(options: { mutateCertificate?: (value: ReturnType<typeof certificate>) => void; refuse?: boolean; dropCall?: boolean; redirect?: boolean; oversized?: boolean; initialized?: () => void } = {}) {
  const wire: Wire[] = []; let quoteCalls = 0;
  const server = createServer(async (request, reply) => {
    try {
      const body = await bodyOf(request), message = body.length ? JSON.parse(body.toString()) : null;
      wire.push({ method: request.method!, path: request.url!, rpc: message?.method, name: message?.params?.name, args: message?.params?.arguments, authenticated: request.headers.authorization === `Bearer ${token}` });
      if (request.headers.authorization !== `Bearer ${token}`) { reply.writeHead(401).end(); return; }
      if (options.redirect) { reply.writeHead(302, { location: "/forbidden-redirect" }).end(); return; }
      if (options.oversized) { reply.writeHead(200, { "content-type": "application/json", "content-length": 1_048_577 }).end("x".repeat(1_048_577)); return; }
      const mcp = new McpServer({ name: "worldkit", version: "0.1.0" });
      mcp.registerTool("verify_kit", { inputSchema: z.object({ kit_revision_id: z.string(), expected_graph_hash: z.string(), freshness_policy: z.literal("historical") }) }, async () => {
        if (options.refuse) return { isError: true, content: [{ type: "text", text: `Provider-private diagnostic must never escape: ${token}` }] };
        const saved = certificate(); options.mutateCertificate?.(saved);
        const result = { certificate: saved, selectedResults: [], sourceMode: "modelled", physicalTest: "not_performed" };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      });
      mcp.registerTool("quote_kit", { inputSchema: z.object({}) }, async () => { quoteCalls++; throw Error("A quote must never be invoked"); });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }); await mcp.connect(transport);
      try {
        const headers = new Headers(); for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
        const response = await transport.handleRequest(new Request(`http://127.0.0.1:${(server.address() as { port: number }).port}${request.url}`, { method: request.method, headers, ...(body.length ? { body: new Uint8Array(body) } : {}) }));
        if (message?.method === "initialize") options.initialized?.();
        if (options.dropCall && message?.method === "tools/call") { reply.destroy(); return; }
        reply.writeHead(response.status, Object.fromEntries(response.headers)); reply.end(Buffer.from(await response.arrayBuffer()));
      } finally { await mcp.close(); }
    } catch { if (!reply.destroyed) reply.writeHead(500).end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp`, wire, quotes: () => quoteCalls, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
async function journal(path: string) { return (await readFile(path + ".journal.jsonl", "utf8")).trim().split("\n").map(line => JSON.parse(line)); }

test("missing or ambiguous arguments cannot select a database, session or default endpoint", () => {
  assert.deepEqual(parseVerificationArgs(["--help"]), { help: true });
  for (const args of [[], ["--input", "/a"], ["--input", "/a", "--input", "/b"], ["--input", "relative", "--output", "/b"], ["--input", "/a", "--output", "/a"]]) assert.throws(() => parseVerificationArgs(args));
  assert.deepEqual(parseVerificationArgs(["--output", "/b", "--input", "/a"]), { inputPath: "/a", outputPath: "/b" });
});
test("strict input refuses foreign paths, remote HTTP, authority in URLs and expired original declarations", () => {
  for (const endpoint of ["http://example.com/api/mcp", "https://example.com/api/workspace", "https://example.com/api/mcp?token=secret", "https://x:y@example.com/api/mcp", "https://example.com/api/mcp#fragment"]) assert.throws(() => validateVerificationInput(input(endpoint)));
  assert.throws(() => validateVerificationInput({ ...input("https://example.com/api/mcp"), grantExpiresAt: "2000-01-01T00:00:00Z" }));
  assert.throws(() => validateVerificationInput({ ...input("https://example.com/api/mcp"), createSession: true }));
});
test("official client and server over real HTTP verify only the exact historical certificate; journal precedes dispatch", async () => {
  const server = await peer(), paths = await files(server.endpoint);
  try {
    const receipt = await verifyExistingMcpGrant(paths, { fetch: async (url, init) => {
      assert.equal(String(url), server.endpoint); const entries = await journal(paths.outputPath);
      assert.equal(entries.at(-1).kind, "request_started");
      return fetch(url, init);
    } });
    assert.equal(receipt.status, "passed"); assert.equal(receipt.certificate?.id, certificateId); assert.equal(receipt.certificate?.graphHash, graphHash);
    assert.equal(receipt.certificate?.physicalTest, "not_performed"); assert.equal(server.quotes(), 0);
    const calls = server.wire.filter(row => row.rpc === "tools/call"); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, { kit_revision_id: revisionId, expected_graph_hash: graphHash, freshness_policy: "historical" });
    assert(server.wire.every(row => row.path === "/api/mcp" && row.authenticated));
    const lines = await journal(paths.outputPath); let prior = "0".repeat(64);
    lines.forEach((entry, index) => { const { hash: current, ...body } = entry; assert.equal(body.sequence, index + 1); assert.equal(body.previousHash, prior); assert.equal(hash(JSON.stringify(body)), current); prior = current; });
    assert.equal(receipt.journalHead, prior); const text = (await readFile(paths.outputPath, "utf8")) + JSON.stringify(lines);
    assert(!text.includes(token)); assert.equal((await stat(paths.outputPath)).mode & 0o077, 0);
    const before = await readFile(paths.outputPath, "utf8"), count = server.wire.length;
    await assert.rejects(verifyExistingMcpGrant(paths), /OUTPUT_ALREADY_EXISTS/); assert.equal(server.wire.length, count); assert.equal(await readFile(paths.outputPath, "utf8"), before);
  } finally { await server.close(); }
});
test("exact saved certificate mismatch is held without a repair, quote, payment or retry", async () => {
  const server = await peer({ mutateCertificate: saved => { saved.graphHash = "d".repeat(64); } }), paths = await files(server.endpoint);
  try { const result = await verifyExistingMcpGrant(paths); assert.equal(result.status, "held"); assert.equal(result.failure?.code, "SAVED_CERTIFICATE_MISMATCH"); assert.equal(server.wire.filter(row => row.rpc === "tools/call").length, 1); assert.equal(server.quotes(), 0); } finally { await server.close(); }
});
test("current server refusal remains a sanitized held result, including hostile secret-bearing messages", async () => {
  const server = await peer({ refuse: true }), paths = await files(server.endpoint);
  try { const result = await verifyExistingMcpGrant(paths); assert.equal(result.status, "held"); assert.equal(result.failure?.code, "VERIFY_TOOL_REFUSED"); assert(!(await readFile(paths.outputPath, "utf8")).includes(token)); assert(!JSON.stringify(await journal(paths.outputPath)).includes(token)); } finally { await server.close(); }
});
test("a socket destroyed after exact verification stays unresolved and is never redispatched", async () => {
  const server = await peer({ dropCall: true }), paths = await files(server.endpoint);
  try {
    const result = await verifyExistingMcpGrant(paths); assert.equal(result.status, "held");
    assert.equal(server.wire.filter(row => row.rpc === "tools/call").length, 1); assert.equal((await journal(paths.outputPath)).filter(row => row.kind === "request_unresolved").length, 1);
    const other = { ...paths, outputPath: join(paths.dir, "existing-journal.json") }; await writeFile(other.outputPath + ".journal.jsonl", "unresolved original", { mode: 0o600 }); const count = server.wire.length;
    await assert.rejects(verifyExistingMcpGrant(other), /OUTPUT_ALREADY_EXISTS/); assert.equal(server.wire.length, count);
  } finally { await server.close(); }
});
test("redirects never forward the existing grant to another path", async () => {
  const server = await peer({ redirect: true }), paths = await files(server.endpoint);
  try { const result = await verifyExistingMcpGrant(paths); assert.equal(result.status, "held"); assert.equal(server.wire.length, 1); assert.equal(server.wire[0]!.path, "/api/mcp"); } finally { await server.close(); }
});
test("oversized actual HTTP response is held after a single request", async () => {
  const server = await peer({ oversized: true }), paths = await files(server.endpoint);
  try { const result = await verifyExistingMcpGrant(paths); assert.equal(result.status, "held"); assert.equal(server.wire.length, 1); assert((await journal(paths.outputPath)).some(row => row.code === "MCP_RESPONSE_TOO_LARGE")); } finally { await server.close(); }
});
test("unending oversized stream is cancelled within bounded reads", async () => {
  const paths = await files("https://controlled.invalid/api/mcp"); let pulls = 0, cancelled = false, requests = 0;
  const result = await verifyExistingMcpGrant(paths, { fetch: async () => { requests++; return new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(262144)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }); } });
  assert.equal(result.status, "held"); assert.equal(requests, 1); assert(pulls <= 6); assert.equal(cancelled, true);
});
test("authority expiry between actual HTTP requests prevents further disclosure", async () => {
  let clock = Date.now(); const initial = clock; const server = await peer({ initialized: () => { clock += 120000; } });
  const paths = await files(server.endpoint, { grantExpiresAt: new Date(initial + 60000).toISOString() });
  try { const result = await verifyExistingMcpGrant(paths, { now: () => clock }); assert.equal(result.status, "held"); assert.equal(server.wire.length, 1); assert.equal(server.wire[0]!.rpc, "initialize"); } finally { await server.close(); }
});
test("private input permissions and symlinks are refused before any network or output", async () => {
  const paths = await files("https://controlled.invalid/api/mcp"); let requests = 0; const network: typeof fetch = async () => { requests++; throw Error("No network permitted"); };
  await chmod(paths.inputPath, 0o644); await assert.rejects(verifyExistingMcpGrant(paths, { fetch: network }), /PRIVATE_INPUT_PERMISSIONS_REQUIRED/);
  await chmod(paths.inputPath, 0o600); const link = join(paths.dir, "linked.json"); await symlink(paths.inputPath, link);
  await assert.rejects(verifyExistingMcpGrant({ ...paths, inputPath: link }, { fetch: network }), /INVALID_PRIVATE_INPUT_FILE/); assert.equal(requests, 0);
});
test("actual CLI requires explicit input, ignores inherited database config and retains sanitized output", async () => {
  const server = await peer(), paths = await files(server.endpoint); const run = promisify(execFile);
  const env = { ...process.env, DATABASE_URL: "postgresql://must-not-connect.invalid/no_database", AUTH_SECRET: "MCP_CLI_INHERITED_VALUE_MUST_NOT_PRINT" };
  try {
    const result = await run(process.execPath, ["--import", "tsx", "scripts/verify-mcp.ts", "--input", paths.inputPath, "--output", paths.outputPath], { cwd: resolve("."), env, timeout: 20000 });
    assert.equal(JSON.parse(result.stdout).status, "passed"); assert(!result.stdout.includes(token)); assert(!result.stdout.includes(env.AUTH_SECRET));
    const help = await run(process.execPath, ["--import", "tsx", "scripts/verify-mcp.ts", "--help"], { cwd: resolve("."), env }); assert.match(help.stdout, /existing grant/);
    const packageJson = JSON.parse(await readFile("package.json", "utf8")); assert.equal(packageJson.scripts["verify:mcp"], "node --import tsx scripts/verify-mcp.ts");
  } finally { await server.close(); }
});
