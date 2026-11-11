import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Reconstruct only traced files, then forbid Node from falling back to the development install.
const root = process.cwd();
const routes = ["evidence", "jobs", "jobs/recover", "planner", "inventory"];
const traces: { route: string; files: string[] }[] = [];
for (const route of routes) {
  const path = join(root, `.next/server/app/api/${route}/route.js.nft.json`);
  const trace = JSON.parse(await readFile(path, "utf8")) as { files: string[] };
  const files = trace.files.map(file => resolve(dirname(path), file));
  assert.ok(files.some(file => file.endsWith("/pdfjs-dist/legacy/build/pdf.worker.mjs")), `${route} lacks its PDF worker`);
  assert.ok(files.some(file => file.endsWith("/@napi-rs/canvas/index.js")), `${route} lacks its canvas loader`);
  assert.ok(files.some(file => /@napi-rs\/canvas-[^/]+\/.+\.node$/.test(file)), `${route} lacks its native canvas binary`);
  traces.push({ route, files });
}
const fixture = join(root, ".artifacts", `source-runtime-${randomUUID()}`);
await mkdir(fixture, { recursive: true });
for (const path of traces[0]!.files) {
  const local = relative(root, path);
  if (local.startsWith("..") || isAbsolute(local)) throw new Error("A runtime trace escapes the project directory.");
  const destination = join(fixture, local); await mkdir(dirname(destination), { recursive: true });
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    const target = resolve(dirname(path), await readlink(path)); const targetLocal = relative(root, target);
    if (targetLocal.startsWith("..") || isAbsolute(targetLocal)) throw new Error("A traced symlink escapes the project directory.");
    await symlink(relative(dirname(destination), join(fixture, targetLocal)), destination);
  } else if (stat.isDirectory()) await mkdir(destination, { recursive: true });
  else await copyFile(path, destination);
}
const manifest = JSON.parse(await readFile("packages/device-library/corpus-source-manifest.json", "utf8")) as { profileId: string; contentHash: string }[];
const source = manifest.find(source => source.profileId === "at2020-xlr")!;
const bytes = await readFile(`.artifacts/manufacturer-corpus/at2020-xlr/${source.contentHash}.source`);
assert.equal(createHash("sha256").update(bytes).digest("hex"), source.contentHash);
await writeFile(join(fixture, "source.pdf"), bytes, { mode: 0o600 });
const probe = `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PDFParse} from 'pdf-parse';
const parser=new PDFParse({data:new Uint8Array(await readFile(new URL('./source.pdf',import.meta.url))),isEvalSupported:false,useSystemFonts:false,verbosity:0});
try {const result=await parser.getText();assert.equal(result.total,1);assert.match(result.text,/AT2020/);assert.match(result.text,/48\\s*V/i);console.log(JSON.stringify({pages:result.total,characters:result.text.length,identityLocated:true,powerTextLocated:true}));}finally{await parser.destroy();}
`;
await writeFile(join(fixture, "probe.mjs"), probe, { mode: 0o600 });
const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${fixture}`, "--allow-addons", join(fixture, "probe.mjs")], { cwd: fixture, encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" } });
if (result.status !== 0) { process.stderr.write(result.stderr); throw new Error("The traced PDF runtime failed under restricted filesystem permissions."); }
const output = result.stdout.trim().split("\n").filter(line => line.startsWith("{"));
const parsed = JSON.parse(output.at(-1)!);
const receipt = { checkedAt: new Date().toISOString(), sourceMode: "recorded_manufacturer_document", sourceHash: source.contentHash, node: process.version, platform: process.platform, architecture: process.arch, tracedRoutes: traces.map(trace => ({ route: `/api/${trace.route}`, files: trace.files.length, workerIncluded: true, nativeCanvasIncluded: true })), developmentDependenciesOutsideBundleDenied: true, result: parsed, newProviderCalls: 0, limitation: "This local operating-system package proof does not replace the hosted Linux parser check." };
await writeFile("docs/evidence/source-runtime-qualification.json", JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt));
