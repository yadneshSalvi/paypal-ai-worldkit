import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, dirname, join } from "node:path";
import pg from "pg";

if (process.env.WORLDKIT_QA_MODE !== "engineering" || process.env.WORLDKIT_DISABLE_PROVIDERS !== "true") throw new Error("This manifest requires the isolated engineering launcher.");
const root = await realpath(process.cwd()), output = resolve(root, ".local/engineering-review-qa"), buildDir = ".next-engineering-qa";
const sha = value => createHash("sha256").update(value).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const privateValues = [];
function remember(name, value) { if (typeof value === "string" && value.length >= 10 && !privateValues.some(entry => entry.value === value)) privateValues.push({ name, value }); }
function collect(value, prefix = "private") {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      if (/^(databaseUrl|authSecret|password|credential|token|value)$/i.test(key)) remember(`${prefix}.${key}`, item);
      for (const token of item.matchAll(/\bwk[ir]_[A-Za-z0-9_-]{43}\b/g)) remember(`${prefix}.bearer`, token[0]);
    } else collect(item, `${prefix}.${key}`);
  }
}
const working = process.argv.includes("--working"), privateInputs = process.argv.slice(2).filter(value => value !== "--working");
for (const [index, path] of privateInputs.entries()) {
  const content = await readFile(path, "utf8");
  if (path.endsWith(".json")) collect(JSON.parse(content), `input${index}`);
  else for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && /KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL|CLIENT_ID|BUYER|MERCHANT|PAYER|ACCOUNT_ID|STORE_ID|LOGIN/.test(match[1])) remember(`input${index}.${match[1]}`, match[2].replace(/^(['"])(.*)\1$/, "$2"));
  }
}
collect(JSON.parse(await readFile(join(output, "runtime-private.json"), "utf8")), "isolatedRuntime");
try { collect(JSON.parse(await readFile(join(output, "native-private.json"), "utf8")), "nativeFixture"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const findings = [], prohibited = [], escapes = [];
function scan(path, bytes) { for (const entry of privateValues) if (bytes.includes(Buffer.from(entry.value))) findings.push({ file: path, variable: entry.name }); }
async function enumerate(directory, skip = () => false) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name), rel = relative(root, full);
      if (skip(rel)) continue;
      if (entry.isDirectory()) await visit(full); else files.push(rel);
    }
  }
  await visit(resolve(root, directory)); return files.sort();
}
async function fileManifest(paths, scanValues = true) {
  const records = [];
  for (let index = 0; index < paths.length; index += 100) {
    records.push(...await Promise.all(paths.slice(index, index + 100).map(async path => {
      const full = resolve(root, path), status = await lstat(full);
      if (status.isSymbolicLink()) {
        const target = await readlink(full), destination = await realpath(full).catch(() => resolve(dirname(full), target));
        if (!(destination === root || destination.startsWith(root + "/"))) escapes.push({ file: path, reason: "symbolic link outside isolated checkout" });
        return { path, kind: "symlink", target, sha256: sha(target) };
      }
      const bytes = await readFile(full); if (scanValues) scan(path, bytes);
      return { path, kind: "file", bytes: bytes.length, sha256: sha(bytes) };
    })));
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}
const sourcePaths = [...new Set((working ? git("ls-files", "-c", "-o", "--exclude-standard", "-z") : git("ls-files", "-z")).toString().split("\0").filter(Boolean))].sort();
for (const path of sourcePaths) if (/^(plans\/|\.env(?:$|\.(?!example$))|\.artifacts\/|\.local\/|\.private\/|\.next[^/]*\/|node_modules\/)/.test(path)) prohibited.push(path);
const source = [], generated = [];
for (const path of sourcePaths) {
  const actual = await readFile(resolve(root, path)), recorded = working ? actual : git("show", `HEAD:${path}`);
  source.push({ path, bytes: recorded.length, sha256: sha(recorded) }); scan(path, actual);
  if (!actual.equals(recorded)) {
    if (path !== "next-env.d.ts") throw new Error(`The frozen tracked source changed: ${path}`);
    generated.push({ path, sourceSha256: sha(recorded), generatedSha256: sha(actual), reason: "Next.js generated references for the isolated distDir" });
  }
  if (path.endsWith(".tgz")) for (const member of execFileSync("tar", ["-tzf", path], { maxBuffer: 10 * 1024 * 1024 }).toString().split("\n").filter(name => name && !name.endsWith("/"))) scan(`${path}:${member}`, execFileSync("tar", ["-xOf", path, member], { maxBuffer: 20 * 1024 * 1024 }));
}
const untracked = git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean);
if (!working && untracked.length) throw new Error("The frozen checkout has unreviewed untracked source files.");
const dependencies = await fileManifest(await enumerate("node_modules"));
const build = await fileManifest(await enumerate(buildDir, path => path.startsWith(`${buildDir}/cache/`) || path === `${buildDir}/cache`));
for (const record of build.filter(value => value.path.endsWith(".nft.json"))) {
  const trace = JSON.parse(await readFile(resolve(root, record.path), "utf8"));
  for (const file of trace.files ?? []) {
    const full = resolve(dirname(resolve(root, record.path)), file), rel = relative(root, full);
    if (rel.startsWith("../") || rel === "..") escapes.push({ file: record.path, reason: "output trace outside isolated checkout" });
    if (/^(plans\/|\.env(?:$|\.(?!example$))|\.artifacts\/|\.local\/|\.private\/)/.test(rel)) prohibited.push(`${record.path} -> ${rel}`);
  }
}
const packageFiles = dependencies.filter(value => value.path.endsWith("/package.json"));
const packages = [];
for (const record of packageFiles) { try { const value = JSON.parse(await readFile(resolve(root, record.path), "utf8")); if (value.name && value.version) packages.push({ path: record.path, name: value.name, version: value.version, sha256: record.sha256 }); } catch { /* Non-package fixtures still have exact file hashes above. */ } }
const pool = new pg.Client({ connectionString: process.env.DATABASE_URL }); await pool.connect();
let database;
try { database = (await pool.query("SELECT current_database() AS name,current_user AS role,rolsuper,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname=current_user")).rows[0]; } finally { await pool.end(); }
if (!/^wk_engineering_[a-f0-9]{20}$/.test(database.name) || database.rolsuper || database.rolcreatedb || database.rolcreaterole || database.rolinherit) throw new Error("The runtime database role is not the restricted engineering role.");
const logs = (await enumerate(".local/engineering-review-qa", path => /\/(?:build-\d+-archive|manifests)(?:\/|$)/.test(path))).filter(path => /(?:suite|typecheck|production-build).*\.log$/.test(path) || /\/http-.*\.json$/.test(path));
const evidence = await fileManifest(logs, false);
const manifest = { schema: "worldkit.engineering-review-freeze.1", createdAt: new Date().toISOString(), root, workingTreeScan: working, commit: git("rev-parse", "HEAD").toString().trim(), tree: git("rev-parse", "HEAD^{tree}").toString().trim(), node: process.version, platform: process.platform, arch: process.arch,
  source: { count: source.length, digest: sha(JSON.stringify(source)), files: source, generated },
  dependencies: { count: dependencies.length, digest: sha(JSON.stringify(dependencies)), lockSha256: sha(await readFile("package-lock.json")), packages, files: dependencies },
  build: { directory: buildDir, id: (await readFile(`${buildDir}/BUILD_ID`, "utf8")).trim(), count: build.length, digest: sha(JSON.stringify(build)), files: build },
  runtime: { origin: "http://127.0.0.1:4532", database, cookies: ["wk_engineering_qa", "wk_engineering_reviewer_qa"], providers: "disabled", provenance: "sample", actualHumanReviews: 0, physicalTests: 0 },
  audit: { comparedPrivateValues: privateValues.length, privateValueFindings: findings, prohibitedFiles: prohibited, pathEscapes: escapes, status: findings.length || prohibited.length || escapes.length ? "failed" : "passed" }, evidence };
await mkdir(join(output, "manifests"), { recursive: true, mode: 0o700 });
const file = join(output, "manifests", "source-runtime.json"), bytes = JSON.stringify(manifest, null, 2) + "\n";
await writeFile(file, bytes, { mode: 0o600 });
console.log(JSON.stringify({ file, sha256: sha(bytes), workingTreeScan: working, commit: manifest.commit, sourceDigest: manifest.source.digest, dependencyDigest: manifest.dependencies.digest, buildId: manifest.build.id, buildDigest: manifest.build.digest, sourceFiles: source.length, dependencyFiles: dependencies.length, buildFiles: build.length, audit: manifest.audit }));
if (manifest.audit.status !== "passed") process.exitCode = 1;
