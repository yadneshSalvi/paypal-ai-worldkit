import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = resolve(root, ".local/engineering-review-qa"), configPath = resolve(state, "runtime-private.json");
await mkdir(state, { recursive: true, mode: 0o700 });
const args = process.argv.slice(2);
const port = process.env.WORLDKIT_ENGINEERING_QA_PORT ?? "4532";
if (!/^\d{4,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error("Invalid local QA port.");
if (args[0] === "--init") {
  let existing; try { existing = JSON.parse(await readFile(configPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) { console.log("Existing isolated engineering configuration retained. No reset performed."); process.exit(0); }
  const suffix = randomBytes(10).toString("hex"), name = `wk_engineering_${suffix}`, role = `wke_${suffix}`, password = randomBytes(32).toString("hex");
  const admin = new pg.Client({ host: "127.0.0.1", port: 5432, user: userInfo().username, database: "postgres" });
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`CREATE DATABASE ${name} OWNER ${role}`);
    await writeFile(configPath, JSON.stringify({ databaseUrl: `postgresql://${role}:${password}@127.0.0.1:5432/${name}`, authSecret: randomBytes(48).toString("base64url"), createdAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: "wx" });
  } finally { await admin.end(); }
  console.log("Created a restricted engineering QA role and separate database. Port 4532; all providers disabled."); process.exit(0);
}
const config = JSON.parse(await readFile(configPath, "utf8"));
const url = new URL(config.databaseUrl);
if (url.hostname !== "127.0.0.1" || !/^\/wk_engineering_[a-f0-9]{20}$/.test(url.pathname) || url.username !== `wke_${url.pathname.slice("/wk_engineering_".length)}` || url.port !== "5432") throw new Error("Refusing a nonisolated engineering database.");
const env = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR", "LANG", "TERM"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
for (const name of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development", ".env.development.local"]) {
  const content = await readFile(resolve(root, name), "utf8").catch(() => "");
  for (const match of content.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = "";
}
Object.assign(env, { DATABASE_URL: config.databaseUrl, AUTH_SECRET: config.authSecret, WORLDKIT_PUBLIC_URL: `http://127.0.0.1:${port}`, WORLDKIT_QA_MODE: "engineering", WORLDKIT_DISABLE_PROVIDERS: "true", NEXT_TELEMETRY_DISABLED: "1", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", CHANNEL3_API_KEY: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", BLOB_READ_WRITE_TOKEN: "", BLOB_STORE_ID: "", CRON_SECRET: "" });
let command;
if (args[0] === "--test") command = ["--import", "tsx", "--test", "--test-concurrency=1", ...args.slice(1)];
else if (args[0] === "--script" && args[1]) command = ["--import", "tsx", ...args.slice(1)];
else if (args[0] === "--build") { env.NODE_ENV = "production"; command = ["node_modules/next/dist/bin/next", "build"]; }
else if (args[0] === "--start") { env.NODE_ENV = "production"; command = ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", port]; }
else throw new Error("Use --init, --test <files>, --script <file>, --build or --start. There is no reset operation.");
const child = spawn(process.execPath, command, { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => process.exit(code ?? 1));
