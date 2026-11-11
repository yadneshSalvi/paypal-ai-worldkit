/** Private server-side operator tool. Never expose this entry point to a browser. */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { closeDatabase, database } from "../src/server/db";
import { initializeLiving } from "../src/server/living-db";
import { attestSubscriptionOwnership } from "../src/server/subscriptions";

const Input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect"), subscriptionId: z.uuid() }).strict(),
  z.object({ action: z.literal("attest_exclusive_ownership"), subscriptionId: z.uuid(), providerId: z.string().min(1).max(200), expectedScopeHash: z.string().length(64), actor: z.string().min(1).max(100), statement: z.string().min(40).max(2000) }).strict(),
]);
async function main() {
  const path = process.argv[2]; if (!path || process.argv.length !== 3) throw new Error("Pass one private JSON input file containing an explicit inspect or attest_exclusive_ownership action.");
  const input = Input.parse(JSON.parse(await readFile(path, "utf8"))); await initializeLiving();
  if (input.action === "attest_exclusive_ownership") await attestSubscriptionOwnership(input);
  const record = (await database().query("SELECT id,source_mode,scope_hash,scope,provider_id,phase,ownership,preflight_ids,preflight_complete,attempts,failures,error FROM wk_offer_subscriptions WHERE id=$1", [input.subscriptionId])).rows[0];
  if (!record) throw new Error("The requested saved subscription does not exist.");
  const consumers = (await database().query("SELECT count(*)::int AS count FROM wk_offer_watch_resources r JOIN wk_offer_watches w ON w.id=r.watch_id JOIN wk_sessions s ON s.id=w.tenant_id WHERE r.subscription_id=$1 AND w.stopped_at IS NULL AND s.expires_at>now()", [input.subscriptionId])).rows[0].count;
  process.stdout.write(`${JSON.stringify({ action: input.action, subscription: record, activeConsumers: consumers, cancellationEligible: record.ownership === "operator_confirmed" && consumers === 0, providerMutationsInThisCommand: 0 }, null, 2)}\n`);
}
try { await main(); } catch (error) { process.stderr.write(`${error instanceof z.ZodError ? "The operator input does not match the required schema." : error instanceof Error ? error.message : "The operator check failed."}\n`); process.exitCode = 1; } finally { await closeDatabase(); }
