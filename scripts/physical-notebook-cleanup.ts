import { hash } from "../packages/compatibility";
import { closeDatabase } from "../src/server/db";
import { maintainPhysicalNotebook } from "../src/server/physical-notebook-maintenance";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://unconfigured/unconfigured");
const fingerprint = hash({ host: url.hostname, port: url.port || "5432", database: url.pathname, role: url.username });
const apply = process.argv.includes("--apply"), confirmed = process.argv.find(value => value.startsWith("--database-fingerprint="))?.split("=")[1];
if (apply && confirmed !== fingerprint) throw new Error("First run the read-only cleanup preview, then pass its exact database fingerprint with --apply. No original bytes were removed.");
try { process.stdout.write(JSON.stringify({ databaseFingerprint: fingerprint, ...await maintainPhysicalNotebook({ apply }) }, null, 2) + "\n"); }
finally { await closeDatabase(); }
