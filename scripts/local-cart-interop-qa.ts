import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, access, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { Client } from "pg";

const root = resolve(".local/cart-interop-unit"); const envFile = join(root, "runtime.env"); const configFile = join(root, "runtime.json");
const minimalEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "development", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", env: minimalEnv });
  if (result.status !== 0) throw new Error(`${command} did not complete. Inspect the private PostgreSQL log; no connection secrets are displayed.`);
}
async function free(port: number) { await new Promise<void>((yes, no) => { const server = createServer(); server.once("error", () => no(new Error(`Port ${port} is already in use; no process was stopped.`))); server.listen(port, "127.0.0.1", () => server.close(error => error ? no(error) : yes())); }); }
await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
let existing = false; try { await access(configFile); existing = true; } catch { /* Fresh isolated unit. */ }
if (existing) {
  const config = JSON.parse(await readFile(configFile, "utf8")) as { directory: string; socket: string; port: number; unit: string };
  if (config.unit !== "worldkit-cart-interop" || config.directory !== join(root, "postgres") || config.port !== 55570 || !/^\/tmp\/wkc_[a-f0-9]{20}$/.test(config.socket)) throw new Error("The private launcher identity does not match this unit.");
  const status = spawnSync("pg_ctl", ["-D", config.directory, "status"], { encoding: "utf8", env: minimalEnv });
  if (status.status !== 0) { await free(55570); run("pg_ctl", ["-D", config.directory, "-l", join(root, "postgres.log"), "-o", `-h 127.0.0.1 -p 55570 -k ${config.socket}`, "-w", "start"]); }
  await access(envFile);
  console.log(JSON.stringify({ unit: config.unit, database: "existing isolated cluster ready", envFile, port: 55570, sessionExpiry: "unchanged" }));
} else {
  await free(55570); await free(4577);
  const suffix = randomBytes(10).toString("hex"); const directory = join(root, "postgres"); const socket = `/tmp/wkc_${suffix}`; const role = `wkc_${suffix}`; const name = `wk_cart_${suffix}`; const password = randomBytes(32).toString("base64url");
  await mkdir(socket, { mode: 0o700 });
  run("initdb", ["-D", directory, "-U", "wkc_unit_admin", "--auth-local=trust", "--auth-host=scram-sha-256", "--encoding=UTF8", "--locale=C"]);
  run("pg_ctl", ["-D", directory, "-l", join(root, "postgres.log"), "-o", `-h 127.0.0.1 -p 55570 -k ${socket}`, "-w", "start"]);
  const admin = new Client({ host: socket, port: 55570, user: "wkc_unit_admin", database: "postgres" }); await admin.connect();
  try {
    // Names and password are generated from restricted alphabets. No user value
    // is interpolated into DDL, and credentials never enter command arguments.
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await admin.query(`CREATE DATABASE ${name} OWNER ${role}`);
  } finally { await admin.end(); }
  const connection = `postgresql://${role}:${password}@127.0.0.1:55570/${name}`;
  await writeFile(envFile, [`DATABASE_URL=${connection}`, "WORLDKIT_QA_MODE=cart-interop", `AUTH_SECRET=${randomBytes(48).toString("base64url")}`, "WORLDKIT_DISABLE_PROVIDERS=true", "WORLDKIT_PUBLIC_URL=http://127.0.0.1:4577", "NEXT_TELEMETRY_DISABLED=1", ""].join("\n"), { mode: 0o600, flag: "wx" });
  await writeFile(configFile, JSON.stringify({ unit: "worldkit-cart-interop", directory, socket, port: 55570, createdAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ unit: "worldkit-cart-interop", database: "fresh limited-role cluster ready", envFile, port: 55570, providers: "disabled", existingRuntimes: "untouched" }));
}
