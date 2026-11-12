import { spawn } from "node:child_process";

// Load only this unit's owner-only configuration. Passing --env-file directly to
// Next propagates an unsupported option into its worker NODE_OPTIONS.
process.loadEnvFile(".local/domain-packs-unit/runtime.env");
const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (process.env.WORLDKIT_QA_MODE !== "domain-packs" || process.env.WORLDKIT_DISABLE_PROVIDERS !== "true"
  || url.hostname !== "127.0.0.1" || url.port !== "55565" || !/^\/wk_domain_[a-f0-9]{20}$/.test(url.pathname)
  || url.username !== `wkd_${url.pathname.slice("/wk_domain_".length)}` || process.env.WORLDKIT_PUBLIC_URL !== "http://127.0.0.1:4565") throw new Error("This runner only accepts the dedicated local domain-packs fixture.");
const commands = {
  build: ["node_modules/next/dist/bin/next", "build"],
  start: ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "4565"],
  typecheck: ["node_modules/typescript/bin/tsc", "--noEmit"],
  test: ["--import", "tsx", "--test", "--test-concurrency=1", "tests/domain-packs.test.ts", "tests/domain-packs.integration.ts"],
};
const command = process.argv[2];
if (!Object.hasOwn(commands, command ?? "")) throw new Error("Choose build, start, typecheck or test.");
const child = spawn(process.execPath, commands[command], { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
child.on("error", () => { console.error("The isolated domain-packs process did not start."); process.exitCode = 1; });
