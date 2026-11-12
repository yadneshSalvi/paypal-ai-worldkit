import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../scripts/check-release.mjs", import.meta.url));
const childEnv = { NODE_ENV: "test" as const, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
type Result = { ok: boolean; files: number; markdown: { filesystemLinks: number; routes: number; anchors: number; external: number }; licenses: { declared: { license: string; count: number }[]; missing: { path: string; name: string; version: string }[]; limitation: string }; failures: { code: string; path: string; message: string }[] };

function inspect(directory: string, git = false) {
  const child = spawnSync(process.execPath, [checker, "--json", ...(git ? [] : ["--archive", directory])], { cwd: directory, env: childEnv, encoding: "utf8", timeout: 10000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.ok(child.stdout, child.stderr);
  return { status: child.status, result: JSON.parse(child.stdout) as Result, stdout: child.stdout };
}
function git(directory: string, args: string[], binary = false) {
  const child = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: directory, env: childEnv, timeout: 10000, ...(binary ? {} : { encoding: "utf8" as const }) });
  assert.equal(child.status, 0, String(child.stderr));
  return child.stdout;
}
async function fixture(t: TestContext, withGit = false) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "worldkit-release-inputs-")), directory = path.join(parent, "source");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "vendor"), { recursive: true });
  await fs.mkdir(path.join(directory, "docs"));
  const bytes = Buffer.from("Synthetic vendor fixture; only its locked bytes are verified.\n");
  const dependencies = { "fixture-core": "file:vendor/core.tgz" };
  const pkg = { name: "release-fixture", version: "1.0.0", license: "MIT", dependencies, scripts: { test: "exit 99", postinstall: "exit 99" } };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    "": { name: pkg.name, version: pkg.version, license: "MIT", dependencies: { ...dependencies } },
    "node_modules/fixture-core": { version: "1.0.0", resolved: dependencies["fixture-core"], integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, license: "MIT" },
  } };
  const writeMetadata = async () => { await fs.writeFile(path.join(directory, "package.json"), JSON.stringify(pkg)); await fs.writeFile(path.join(directory, "package-lock.json"), JSON.stringify(lock)); };
  await writeMetadata(); await fs.writeFile(path.join(directory, "vendor/core.tgz"), bytes);
  await fs.writeFile(path.join(directory, "docs/guide.md"), "# Guide\n\nSource fixture.\n");
  await fs.writeFile(path.join(directory, "docs/a file.md"), "# A file\n");
  await fs.writeFile(path.join(directory, "docs/nested(guide).md"), "# Nested guide\n");
  await fs.writeFile(path.join(directory, "README.md"), [
    "# Release fixture", "[Guide](docs/guide.md#section)", "[Route](/studio?tab=sample)", "[Anchor](#section)",
    "[External](https://example.invalid/does-not-have-to-exist)", "[Reference][guide]", "[Nested [label]](docs/guide.md)",
    "[Space](<docs/a file.md>)", "[Parentheses](docs/nested(guide).md \"title\")", "[guide]: docs/guide.md", "`[code](missing-code.md)`",
    "```md", "[fenced](missing-fence.md)", "```", "",
  ].join("\n"));
  await fs.writeFile(path.join(directory, ".gitignore"), ".env\n.local/\nnode_modules/\n");
  if (withGit) git(directory, ["init", "--quiet"]);
  return { parent, directory, pkg, lock, bytes, writeMetadata };
}
function codes(result: Result) { return result.failures.map(failure => failure.code); }

// Extract a trusted, temporary Git fixture archive without a third-party library.
async function extractFixtureTar(bytes: Buffer, directory: string) {
  await fs.mkdir(directory);
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const field = (start: number, end: number) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join("/"), size = Number.parseInt(field(124, 136).trim() || "0", 8), kind = field(156, 157);
    assert.ok(name && !path.isAbsolute(name) && !name.split("/").includes(".."));
    if (kind === "5") await fs.mkdir(path.join(directory, name), { recursive: true });
    else if (kind === "0" || kind === "") { await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await fs.writeFile(path.join(directory, name), bytes.subarray(offset + 512, offset + 512 + size)); }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

test("Git selection and an actual clean Git archive validate without ignored private content or package execution", async t => {
  const f = await fixture(t, true);
  await fs.writeFile(path.join(f.directory, ".env"), "SYNTHETIC_PRIVATE_VALUE_MUST_NOT_BE_READ");
  await fs.mkdir(path.join(f.directory, ".local")); await fs.writeFile(path.join(f.directory, ".local/private-proof.json"), "SYNTHETIC_PRIVATE_PROOF");
  const original = await fs.readFile(path.join(f.directory, "package-lock.json"));
  let checked = inspect(f.directory, true); assert.equal(checked.status, 0, checked.stdout); assert.equal(checked.result.ok, true);
  assert.equal(checked.result.markdown.routes, 1); assert.equal(checked.result.markdown.anchors, 1); assert.equal(checked.result.markdown.external, 1);
  assert.equal(checked.result.markdown.filesystemLinks, 5);
  await fs.writeFile(path.join(f.directory, "new-unignored.md"), "[Broken new file](missing-new-file.md)");
  checked = inspect(f.directory, true); assert.equal(checked.status, 1); assert.ok(codes(checked.result).includes("BROKEN_MARKDOWN_FILE_LINK"));
  await fs.rm(path.join(f.directory, "new-unignored.md"));
  git(f.directory, ["add", "--all"]); const tree = String(git(f.directory, ["write-tree"])).trim();
  const archive = path.join(f.parent, "archive"); await extractFixtureTar(git(f.directory, ["archive", "--format=tar", tree], true) as Buffer, archive);
  checked = inspect(archive); assert.equal(checked.status, 0, checked.stdout); assert.equal(checked.result.ok, true);
  assert.equal(existsSync(path.join(archive, ".env")), false); assert.equal(existsSync(path.join(archive, ".git")), false);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "package-lock.json")), original);
  assert.equal(existsSync(path.join(f.directory, "package-executed.txt")), false);
});

test("archive traversal, symlinks and private material fail without revealing or following their contents", async t => {
  const f = await fixture(t);
  const privateValue = "SYNTHETIC_PRIVATE_VALUE_MUST_NOT_BE_READ";
  await fs.writeFile(path.join(f.parent, "outside.txt"), privateValue);
  await fs.writeFile(path.join(f.directory, ".env"), privateValue);
  await fs.mkdir(path.join(f.directory, ".local")); await fs.writeFile(path.join(f.directory, ".local/proof.json"), privateValue);
  await fs.symlink(path.join(f.parent, "outside.txt"), path.join(f.directory, "linked.txt"));
  await fs.appendFile(path.join(f.directory, "README.md"), "[Escape](%2e%2e/outside.txt)\n[Private](.env)\n");
  const checked = inspect(f.directory); assert.equal(checked.status, 1);
  for (const code of ["PRIVATE_OR_GENERATED_INPUT", "SYMLINK_INPUT", "MARKDOWN_PATH_ESCAPE", "PRIVATE_MARKDOWN_TARGET"]) assert.ok(codes(checked.result).includes(code), checked.stdout);
  assert.equal(checked.stdout.includes(privateValue), false);
});

test("tracked private files are rejected even when Git ignore rules would hide an ordinary new copy", async t => {
  const f = await fixture(t, true);
  await fs.writeFile(path.join(f.directory, ".env"), "SYNTHETIC_TRACKED_ENV_MUST_NOT_BE_READ");
  git(f.directory, ["add", "--all"]); git(f.directory, ["add", "--force", "--", ".env"]);
  const checked = inspect(f.directory, true); assert.equal(checked.status, 1); assert.ok(codes(checked.result).includes("PRIVATE_OR_GENERATED_INPUT"));
  assert.equal(checked.stdout.includes("SYNTHETIC_TRACKED_ENV_MUST_NOT_BE_READ"), false);
});

test("root alignment, malformed JSON and unpinned Git references are concrete failures", async t => {
  const f = await fixture(t);
  f.lock.packages[""].dependencies["fixture-core"] = "file:vendor/changed.tgz"; await f.writeMetadata();
  assert.ok(codes(inspect(f.directory).result).includes("ROOT_DEPENDENCY_MISMATCH"));
  f.lock.packages[""].dependencies["fixture-core"] = f.pkg.dependencies["fixture-core"];
  const pkg = f.pkg as typeof f.pkg & { dependencies: Record<string, string> }, lock = f.lock as typeof f.lock & { packages: Record<string, Record<string, unknown>> };
  pkg.dependencies["git-fixture"] = "https://git.example.invalid/owner/repo.git#main";
  (lock.packages[""].dependencies as Record<string, string>)["git-fixture"] = pkg.dependencies["git-fixture"];
  lock.packages["node_modules/git-fixture"] = { version: "1.0.0", resolved: pkg.dependencies["git-fixture"], license: "MIT" }; await f.writeMetadata();
  assert.ok(codes(inspect(f.directory).result).includes("UNPINNED_GIT_DEPENDENCY"));
  pkg.dependencies["git-fixture"] = `https://git.example.invalid/owner/repo.git#${"a".repeat(40)}`;
  (lock.packages[""].dependencies as Record<string, string>)["git-fixture"] = pkg.dependencies["git-fixture"]; lock.packages["node_modules/git-fixture"].resolved = pkg.dependencies["git-fixture"]; await f.writeMetadata();
  assert.equal(inspect(f.directory).status, 0);
  lock.packages["../escape"] = { version: "1.0.0", license: "MIT" }; await f.writeMetadata(); assert.ok(codes(inspect(f.directory).result).includes("LOCK_PATH_ESCAPE"));
  await fs.writeFile(path.join(f.directory, "package-lock.json"), "{"); assert.ok(codes(inspect(f.directory).result).includes("MALFORMED_JSON"));
});

test("vendor bytes and local path escapes fail before a different tarball can be accepted", async t => {
  const f = await fixture(t);
  f.pkg.dependencies["fixture-core"] = "file:./vendor/core.tgz"; f.lock.packages[""].dependencies["fixture-core"] = f.pkg.dependencies["fixture-core"]; f.lock.packages["node_modules/fixture-core"].resolved = f.pkg.dependencies["fixture-core"]; await f.writeMetadata();
  assert.equal(inspect(f.directory).status, 0);
  await fs.appendFile(path.join(f.directory, "vendor/core.tgz"), "changed");
  let checked = inspect(f.directory); assert.equal(checked.status, 1); assert.ok(codes(checked.result).includes("VENDOR_INTEGRITY_MISMATCH"));
  f.pkg.dependencies["fixture-core"] = "file:../outside.tgz"; f.lock.packages[""].dependencies["fixture-core"] = f.pkg.dependencies["fixture-core"]; f.lock.packages["node_modules/fixture-core"].resolved = f.pkg.dependencies["fixture-core"]; await f.writeMetadata();
  checked = inspect(f.directory); assert.equal(checked.status, 1); assert.ok(codes(checked.result).includes("LOCAL_VENDOR_PATH"));
});

test("used reference and ordinary relative file links fail while route, anchor and literal examples remain distinct", async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.directory, "README.md"), "[Inline](missing-inline.md)\n[Reference][missing]\n[missing]: docs/missing-reference.md\n");
  const checked = inspect(f.directory); assert.equal(checked.status, 1);
  const broken = checked.result.failures.filter(failure => failure.code === "BROKEN_MARKDOWN_FILE_LINK");
  assert.equal(broken.length, 2); assert.ok(broken.some(failure => failure.message.includes("missing-inline.md"))); assert.ok(broken.some(failure => failure.message.includes("missing-reference.md")));
  assert.equal(checked.result.markdown.routes, 1); assert.equal(checked.result.markdown.anchors, 1); assert.equal(checked.result.markdown.external, 1);
});

test("missing upstream license metadata is reported as a limitation and does not become an invented license or failure", async t => {
  const f = await fixture(t);
  const pkg = f.pkg as typeof f.pkg & { dependencies: Record<string, string> }, lock = f.lock as typeof f.lock & { packages: Record<string, Record<string, unknown>> };
  pkg.dependencies["@channel3/sdk"] = "4.9.0"; (lock.packages[""].dependencies as Record<string, string>)["@channel3/sdk"] = "4.9.0"; lock.packages["node_modules/@channel3/sdk"] = { version: "4.9.0" }; await f.writeMetadata();
  const checked = inspect(f.directory); assert.equal(checked.status, 0, checked.stdout);
  assert.deepEqual(checked.result.licenses.missing, [{ path: "node_modules/@channel3/sdk", name: "@channel3/sdk", version: "4.9.0" }]);
  assert.ok(checked.result.licenses.declared.every(entry => entry.license === "MIT")); assert.match(checked.result.licenses.limitation, /not an inferred license/);
});
