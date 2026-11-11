import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { authenticateAccess, createAccessToken, createSession, getRevision, revokeAccessToken } from "../src/server/repository";
import { createMcpServer, readScopedRecord } from "../src/server/mcp";
import { mutatePublicRecord, publicRecordDesk } from "../src/server/public-records";
import { closeDatabase, database } from "../src/server/db";

import { requireIsolatedDatabase } from "./support/isolated-database";
requireIsolatedDatabase();
after(closeDatabase);
async function fixture() {
  const { session } = await createSession(), desk = await publicRecordDesk(session);
  const record = (await mutatePublicRecord(session, { action: "prepare", requestId: randomUUID(), expectedRevisionId: desk.revisionId, expectedGraphHash: desk.graphHash, expectedShareVersion: 0, title: "Scoped Sample studio" })).record!;
  const grant = await createAccessToken(session, ["kit:verify"]), principal = (await authenticateAccess(grant.token))!;
  return { session, record, grant, principal };
}
test("an actual MCP SDK client lists and reads certificate and assembly resources with the app's exact graph identity", async () => {
  const f = await fixture(), server = createMcpServer(f.principal), client = new Client({ name: "certificate-resource-qa", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools(); assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["quote_kit", "repair_kit", "verify_kit"]);
    const templates = await client.listResourceTemplates(); assert.equal(templates.resourceTemplates.length, 4);
    const list = await client.listResources(); assert.equal(list.resources.length, 2);
    for (const resource of list.resources) {
      assert.equal(resource.uri.includes(f.grant.token), false);
      const result = await client.readResource({ uri: resource.uri });
      const value = JSON.parse((result.contents[0] as { text: string }).text);
      assert.equal(value.graphHash, f.record.payload.graphHash); assert.equal(value.certificateId, f.record.payload.certificateId); assert.equal(value.contentHash, f.record.contentHash); assert.equal(value.physicalTest, "not_performed");
      if (resource.uri.endsWith("/assembly")) assert.deepEqual(value.assembly, f.record.payload.assembly);
      else assert.deepEqual(value.payload, f.record.payload);
    }
    await revokeAccessToken(f.session, f.grant.id);
    await assert.rejects(() => client.readResource({ uri: list.resources[0]!.uri }), /revoked|expired/);
    await assert.rejects(() => client.listResources(), /revoked|expired/);
  } finally { await client.close(); await server.close(); }
});
test("scoped resources reject cross-tenant, missing scope, wrong graph and a narrowed current kit grant", async () => {
  const f = await fixture(), foreign = await fixture();
  await assert.rejects(() => readScopedRecord(foreign.principal, f.record.payload.revisionId, f.record.payload.graphHash, f.record.id, "certificate"), /does not belong/);
  const quoteOnly = await createAccessToken(f.session, ["kit:quote"]), quotePrincipal = (await authenticateAccess(quoteOnly.token))!;
  await assert.rejects(() => readScopedRecord(quotePrincipal, f.record.payload.revisionId, f.record.payload.graphHash, f.record.id, "assembly"), /does not allow/);
  await assert.rejects(() => readScopedRecord(f.principal, f.record.payload.revisionId, "0".repeat(64), f.record.id, "assembly"), /does not match/);
  await database().query("UPDATE wk_access_tokens SET kit_ids='[]' WHERE id=$1", [f.grant.id]);
  await assert.rejects(() => readScopedRecord(f.principal, f.record.payload.revisionId, f.record.payload.graphHash, f.record.id, "certificate"), /outside the current grant/);
});
test("an expired grant or owner session cannot read resources through a previously authenticated principal", async () => {
  const a = await fixture(); await database().query("UPDATE wk_access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [a.grant.id]);
  await assert.rejects(() => readScopedRecord(a.principal, a.record.payload.revisionId, a.record.payload.graphHash, a.record.id, "certificate"), /expired/);
  const b = await fixture(); await database().query("UPDATE wk_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [b.session.id]);
  await assert.rejects(() => readScopedRecord(b.principal, b.record.payload.revisionId, b.record.payload.graphHash, b.record.id, "assembly"), /expired/);
  assert.equal((await getRevision(b.session.id)).certificate.graphHash, b.record.payload.graphHash);
});
test("payment read tool is advertised only with its separate scope and rejects foreign orders", async () => {
  const { session } = await createSession(), grant = await createAccessToken(session, ["payment:read"]), principal = (await authenticateAccess(grant.token))!;
  const server = createMcpServer(principal), client = new Client({ name: "payment-read-scope-qa", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tools = await client.listTools(); assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["quote_kit", "read_payment_evidence", "repair_kit", "verify_kit"]);
    const tool = tools.tools.find(tool => tool.name === "read_payment_evidence")!; assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.inputSchema.additionalProperties, false);
    const response = await client.callTool({ name: "read_payment_evidence", arguments: { requestId: randomUUID(), orderId: "foreign-order", expectedGraphHash: "a".repeat(64), operation: "get_order" } }); assert.equal(response.isError, true); assert.match(JSON.stringify(response.content), /outside/);
    await revokeAccessToken(session, grant.id); const revoked = await client.callTool({ name: "read_payment_evidence", arguments: { requestId: randomUUID(), orderId: "foreign-order", expectedGraphHash: "a".repeat(64), operation: "get_order" } }); assert.equal(revoked.isError, true); assert.match(JSON.stringify(revoked.content), /revoked/);
  } finally { await client.close(); await server.close(); }
});
