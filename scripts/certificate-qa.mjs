import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "worldkit_certificate_qa";
const stateDir = resolve(root, ".local/certificate-qa");
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const secretFile = resolve(stateDir, "auth-secret");
if (!existsSync(secretFile)) await writeFile(secretFile, randomBytes(48).toString("base64url"), { mode: 0o600 });
const env = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR", "LANG", "TERM"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
// Next loads local .env files itself. Set every declared name to an empty value
// before it starts; never log or reuse any value from those private files.
for (const name of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development", ".env.development.local"]) {
  const content = await readFile(resolve(root, name), "utf8").catch(() => "");
  for (const match of content.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = "";
}
Object.assign(env, {
  DATABASE_URL: `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/${databaseName}`,
  AUTH_SECRET: (await readFile(secretFile, "utf8")).trim(),
  WORLDKIT_PUBLIC_URL: "http://127.0.0.1:4508", WORLDKIT_QA_MODE: "certificate", WORLDKIT_DISABLE_PROVIDERS: "true",
  WORLDKIT_BUILD_DIR: ".next-certificate-qa", NEXT_TELEMETRY_DISABLED: "1",
  PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_ENVIRONMENT: "", PAYPAL_API_BASE_URL: "", PAYPAL_PROJECT_ISOLATED: "",
  CHANNEL3_API_KEY: "", CHANNEL3_WEBHOOK_SECRET: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", BLOB_READ_WRITE_TOKEN: "", CRON_SECRET: "",
});
const args = process.argv.slice(2);
if (args[0] === "--init") {
  const lookup = spawnSync("psql", ["-h", "127.0.0.1", "-d", "postgres", "-Atc", `SELECT 1 FROM pg_database WHERE datname='${databaseName}'`], { env, encoding: "utf8" });
  if (lookup.status !== 0) throw new Error("Local PostgreSQL is required for the isolated certificate QA database.");
  if (lookup.stdout.trim() !== "1") {
    const made = spawnSync("createdb", ["-h", "127.0.0.1", databaseName], { env, stdio: "inherit" });
    if (made.status !== 0) throw new Error("The isolated certificate QA database could not be created.");
  }
  console.log("Certificate QA database ready. Port 4508; separate cookie; external providers disabled. No existing database was changed.");
  process.exit(0);
}
let command;
if (args[0] === "--test") command = ["--import", "tsx", "--test", "--test-concurrency=1", ...args.slice(1)];
else if (args[0] === "--script" && args[1]) command = ["--import", "tsx", ...args.slice(1)];
else if (args[0] === "--build") { env.NODE_ENV = "production"; command = ["node_modules/next/dist/bin/next", "build"]; }
else if (args[0] === "--start") { env.NODE_ENV = "production"; command = ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "4508"]; }
else if (args[0] === "--dev") { env.NODE_ENV = "development"; command = ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "4508"]; }
else throw new Error("Use --init, --test <files>, --script <file>, --build, --start or --dev. This launcher never resets a database.");
const child = spawn(process.execPath, command, { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => process.exit(code ?? 1));
