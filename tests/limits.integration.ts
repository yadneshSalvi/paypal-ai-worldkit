import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authenticateAccess, createAccessToken, createSession, revokeAccessToken } from "../src/server/repository";
import { closeDatabase } from "../src/server/db";
import { claimTool, releaseTool, type LimitedTool } from "../src/server/tool-limits";
import { claimSessionCreation, SessionLimitError } from "../src/server/session-limits";
after(async () => closeDatabase());
async function principal() { const { session } = await createSession(); const grant = await createAccessToken(session, ["kit:verify", "kit:propose", "kit:quote"]); return { session, grant, principal: (await authenticateAccess(grant.token))! }; }
test("two concurrent MCP tool leases are permitted and a third is refused atomically", async () => {
  const p = await principal(); const results = await Promise.allSettled([claimTool(p.principal, "verify_kit"), claimTool(p.principal, "verify_kit"), claimTool(p.principal, "verify_kit")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 2); assert.equal(results.filter(r => r.status === "rejected").length, 1);
  for (const r of results) if (r.status === "fulfilled") await releaseTool(p.principal, r.value);
  const next = await claimTool(p.principal, "verify_kit"); await releaseTool(p.principal, next);
});
test("MCP per-tool limits apply to completed calls and current revocation", async () => {
  for (const [tool, count] of [["verify_kit", 60], ["repair_kit", 5], ["quote_kit", 2]] as [LimitedTool, number][]) {
    const p = await principal(); for (let index = 0; index < count; index++) { const lease = await claimTool(p.principal, tool); await releaseTool(p.principal, lease); }
    await assert.rejects(claimTool(p.principal, tool), /permits/);
  }
  const p = await principal(); await revokeAccessToken(p.session, p.grant.id); await assert.rejects(claimTool(p.principal, "verify_kit"), /revoked/);
});
test("deployment-wide session window admits exactly its atomic allowance under concurrency", async () => {
  const namespace = `sample-limit-${randomUUID()}`; const results = await Promise.allSettled(Array.from({ length: 8 }, () => claimSessionCreation(namespace, { hour: 2, day: 10 })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 2); assert.equal(results.filter(r => r.status === "rejected" && r.reason instanceof SessionLimitError).length, 6);
  const { session } = await createSession(); assert.ok(session.id); // Existing independent session work is outside the public creation counter.
});
