import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSession, createAccessToken, getRevision, revokeAccessToken } from "../src/server/repository";
import { closeDatabase } from "../src/server/db";
const session = await createSession(); const bundle = await getRevision(session.session.id); const grant = await createAccessToken(session.session, ["kit:verify", "kit:propose", "kit:quote"]);
const client = new Client({ name: "worldkit-independent-verifier", version: "0.1.0" });
const endpoint = process.env.WORLDKIT_VERIFY_URL ?? "http://127.0.0.1:4106/api/mcp";
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }));
try {
  const tools = await client.listTools(); assert.deepEqual(tools.tools.map(t => t.name).sort(), ["quote_kit", "repair_kit", "verify_kit"]);
  const verified = await client.callTool({ name: "verify_kit", arguments: { kit_revision_id: bundle.kit.id, expected_graph_hash: bundle.certificate.graphHash, freshness_policy: "historical" } });
  assert.equal(verified.isError, undefined);
  const data = verified.structuredContent as { certificate: { id: string; graphHash: string } }; assert.equal(data.certificate.id, bundle.certificate.id); assert.equal(data.certificate.graphHash, bundle.certificate.graphHash);
  const stale = await client.callTool({ name: "verify_kit", arguments: { kit_revision_id: bundle.kit.id, expected_graph_hash: "0".repeat(64) } }); assert.equal(stale.isError, true);
  const unauthorized = await client.callTool({ name: "capture_payment", arguments: { amount: 1200 } }); assert.equal(unauthorized.isError, true);
  const foreignSession = await createSession(); const foreign = await getRevision(foreignSession.session.id);
  const denied = await client.callTool({ name: "verify_kit", arguments: { kit_revision_id: foreign.kit.id, expected_graph_hash: foreign.certificate.graphHash } }); assert.equal(denied.isError, true);
  await revokeAccessToken(session.session, grant.id);
  let revoked = false; try { await client.listTools(); } catch { revoked = true; } assert.equal(revoked, true);
  const evidence = { observedAt: new Date().toISOString(), transport: "MCP SDK 1.32.2 Streamable HTTP client over actual HTTP", endpoint: new URL(endpoint).pathname, toolNames: tools.tools.map(t => t.name), graphHash: bundle.certificate.graphHash, certificateId: bundle.certificate.id, checks: { sameCertificateAsSavedWorkspace: true, staleDigestDenied: true, foreignTenantDenied: true, paymentToolAbsent: true, revokedTokenDenied: true }, physicalTest: "not_performed", sourceMode: "modelled" };
  await mkdir("docs/evidence", { recursive: true }); await writeFile("docs/evidence/mcp-qualification.json", JSON.stringify(evidence, null, 2) + "\n"); console.log(JSON.stringify({ status: "passed", checks: evidence.checks }));
} finally { await client.close().catch(() => {}); await revokeAccessToken(session.session, grant.id); await closeDatabase(); }
