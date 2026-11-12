#!/usr/bin/env node
// Read source inputs only. Never import the application or execute package scripts.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const MAX_FILES = 20000, MAX_TEXT = 8 * 1024 * 1024, MAX_VENDOR = 64 * 1024 * 1024;
const forbiddenDirectories = new Set([".git", ".local", ".private", ".data", ".artifacts", ".setup-evidence", ".vercel", ".turbo", "node_modules", "plans", "private", "private-proof", "private-evidence", "recordings", "browser-recordings", "backups", "out", "dist", "build", "coverage", "playwright-report", "test-results"]);
const dependencyGroups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const failures = [], files = new Set(), directories = new Set([""]);
const report = { ok: false, mode: "git", files: 0, markdown: { files: 0, filesystemLinks: 0, routes: 0, anchors: 0, external: 0 }, dependencies: { rootDeclarations: 0, pinnedGitReferences: 0, vendorTarballs: [] }, licenses: { declared: [], missing: [], limitation: "Declared package-lock license metadata only. Missing metadata is a clarification gap, not an inferred license or a permission determination." }, failures };
let root, jsonOutput = false;

function fail(code, file, message, line) {
  if (failures.length < 100) failures.push({ code, path: file, ...(line ? { line } : {}), message });
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function lexicalPath(value) {
  return typeof value === "string" && value.length > 0 && !/[\\\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value) && !/^[a-z]:/i.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
}
function privatePath(value) {
  const parts = value.split("/");
  return parts.some(part => forbiddenDirectories.has(part) || part.startsWith(".next") || (part === ".env" || part.startsWith(".env.")) && part !== ".env.example") || parts.some(part => /^(?:\.envrc|\.npmrc(?:\..*)?|\.DS_Store)$/.test(part) || /(?:\.pem|\.key|\.p12|\.tsbuildinfo|\.log|\.har|\.sqlite3?|\.db|\.dump|\.sql\.gz)$/i.test(part));
}
function includeFile(relative) {
  if (!lexicalPath(relative)) { fail("INPUT_PATH_ESCAPE", relative, "Input paths must stay inside the source tree and use portable separators."); return; }
  if (privatePath(relative)) { fail("PRIVATE_OR_GENERATED_INPUT", relative, "Private or generated material must not be in release inputs."); return; }
  let absolute = root;
  try {
    const parts = relative.split("/");
    for (let i = 0; i < parts.length; i++) {
      absolute = path.join(absolute, parts[i]);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) { fail("SYMLINK_INPUT", relative, "Symbolic input paths are not followed."); return; }
      if (i < parts.length - 1 && !stat.isDirectory() || i === parts.length - 1 && !stat.isFile()) { fail("NON_FILE_INPUT", relative, "Release inputs must be ordinary files beneath ordinary directories."); return; }
    }
    files.add(relative);
    let parent = path.posix.dirname(relative);
    while (parent !== ".") { directories.add(parent); parent = path.posix.dirname(parent); }
  } catch { fail("MISSING_OR_UNREADABLE_INPUT", relative, "A selected source file is missing or unreadable."); }
}
function walkArchive(relative = "") {
  let entries;
  try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); }
  catch { fail("UNREADABLE_DIRECTORY", relative || ".", "Cannot inspect the explicit archive directory."); return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (!lexicalPath(name)) { fail("INPUT_PATH_ESCAPE", name, "Input paths must stay inside the source tree and use portable separators."); continue; }
    if (privatePath(name)) { fail("PRIVATE_OR_GENERATED_INPUT", name, "Private or generated material must not be in an archive."); continue; }
    if (entry.isSymbolicLink()) { fail("SYMLINK_INPUT", name, "Symbolic input paths are not followed."); continue; }
    if (files.size >= MAX_FILES) { fail("INPUT_LIMIT", ".", `The checker is bounded to ${MAX_FILES} files.`); return; }
    if (entry.isDirectory()) { directories.add(name); walkArchive(name); }
    else includeFile(name);
  }
}
function read(file, limit = MAX_TEXT) {
  if (!files.has(file)) { fail("REQUIRED_SOURCE_MISSING", file, "Required content is not an included ordinary source file."); return null; }
  try {
    const absolute = path.join(root, file), stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) { fail("INPUT_LIMIT_OR_TYPE", file, "The selected file exceeds the checker's size limit or changed type."); return null; }
    return fs.readFileSync(absolute);
  } catch { fail("UNREADABLE_INPUT", file, "Cannot read this included source file."); return null; }
}
function readJson(file) {
  const bytes = read(file); if (!bytes) return null;
  try { const value = JSON.parse(bytes.toString("utf8")); if (!object(value)) throw Error(); return value; }
  catch { fail("MALFORMED_JSON", file, "Expected a JSON object."); return null; }
}
function gitReference(value, file) {
  if (typeof value !== "string") return;
  const git = /^(?:git(?:\+[^:]+)?:|ssh:|git@|github:|gitlab:|bitbucket:|gist:)/i.test(value) || /^https?:\/\/[^#]+\.git(?:#.*)?$/i.test(value) || /^(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\//i.test(value) || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(value);
  if (!git) return;
  const ref = value.slice(value.lastIndexOf("#") + 1);
  if (value.includes("#") && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref) || /\/(?:archive|tarball|zipball)\/(?:[a-f0-9]{40}|[a-f0-9]{64})(?:\.(?:tar\.gz|zip))?(?:$|[?#])/i.test(value)) report.dependencies.pinnedGitReferences++;
  else fail("UNPINNED_GIT_DEPENDENCY", file, "Git dependency references must use a full 40- or 64-character commit, not a branch, tag or abbreviated hash.");
}
function dependencyMap(value, file, group) {
  if (value === undefined) return {};
  if (!object(value) || Object.values(value).some(item => typeof item !== "string" || !item)) { fail("MALFORMED_DEPENDENCIES", file, `${group} must map dependency names to nonempty strings.`); return {}; }
  return value;
}
function verifyDependencies() {
  const pkg = readJson("package.json"), lock = readJson("package-lock.json");
  if (!pkg || !lock) return;
  if (![2, 3].includes(lock.lockfileVersion) || !object(lock.packages) || !object(lock.packages[""])) { fail("MALFORMED_LOCK_ROOT", "package-lock.json", "A lockfileVersion 2 or 3 packages map with its root entry is required."); return; }
  const lockedRoot = lock.packages[""];
  if (typeof pkg.name !== "string" || !pkg.name || typeof pkg.version !== "string" || !pkg.version || pkg.name !== lock.name || pkg.version !== lock.version || lockedRoot.name !== undefined && lockedRoot.name !== pkg.name || lockedRoot.version !== pkg.version) fail("PACKAGE_LOCK_IDENTITY_MISMATCH", "package-lock.json", "Nonempty package and lock root names/versions must agree.");
  const local = new Map();
  for (const group of dependencyGroups) {
    const declared = dependencyMap(pkg[group], "package.json", group), locked = dependencyMap(lockedRoot[group], "package-lock.json", group);
    const keys = [...new Set([...Object.keys(declared), ...Object.keys(locked)])].sort();
    for (const name of keys) {
      if (declared[name] !== locked[name]) fail("ROOT_DEPENDENCY_MISMATCH", "package-lock.json", `${group} entry ${JSON.stringify(name)} differs from package.json.`);
      if (declared[name] !== undefined) {
        report.dependencies.rootDeclarations++;
        gitReference(declared[name], "package.json");
        if (declared[name].startsWith("file:")) local.set(name, declared[name]);
      }
    }
  }
  function overrides(value) { if (typeof value === "string") gitReference(value, "package.json"); else if (object(value)) for (const item of Object.values(value)) overrides(item); }
  overrides(pkg.overrides);
  const licenses = new Map();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key !== "" && !lexicalPath(key)) fail("LOCK_PATH_ESCAPE", "package-lock.json", "A lock package path escapes the source tree or uses unsafe separators.");
    if (!object(entry)) { fail("MALFORMED_LOCK_PACKAGE", "package-lock.json", "Every lock package entry must be an object."); continue; }
    gitReference(entry.resolved, "package-lock.json"); gitReference(entry.version, "package-lock.json");
    if (typeof entry.license === "string" && entry.license.trim()) licenses.set(entry.license, (licenses.get(entry.license) ?? 0) + 1);
    else report.licenses.missing.push({ path: key || ".", name: entry.name ?? (key ? key.split("node_modules/").at(-1) : pkg.name), version: entry.version ?? "unspecified" });
  }
  report.licenses.declared = [...licenses].sort(([a], [b]) => a.localeCompare(b)).map(([license, count]) => ({ license, count }));
  for (const [name, spec] of local) {
    let relative;
    try { relative = decodeURIComponent(spec.slice(5)); } catch { fail("LOCAL_VENDOR_PATH", "package.json", "A local dependency contains invalid path encoding."); continue; }
    if (/[\\\x00-\x1f\x7f]/.test(relative) || path.posix.isAbsolute(relative) || /^[a-z]:/i.test(relative)) { fail("LOCAL_VENDOR_PATH", "package.json", "Local dependencies must stay inside the source tree."); continue; }
    relative = path.posix.normalize(relative);
    if (!lexicalPath(relative) || !relative.startsWith("vendor/") || !/\.(?:tgz|tar\.gz)$/i.test(relative) || privatePath(relative)) { fail("LOCAL_VENDOR_PATH", "package.json", "Local dependencies must be included vendor tarballs inside the source tree."); continue; }
    const entry = lock.packages[`node_modules/${name}`];
    if (!object(entry) || entry.resolved !== spec || typeof entry.integrity !== "string" || !entry.integrity.split(/\s+/).some(token => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(token))) { fail("MISSING_VENDOR_INTEGRITY", "package-lock.json", `Local vendor dependency ${JSON.stringify(name)} needs its exact file resolution and SHA-512 integrity.`); continue; }
    const bytes = read(relative, MAX_VENDOR); if (!bytes) continue;
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (!entry.integrity.split(/\s+/).includes(integrity)) fail("VENDOR_INTEGRITY_MISMATCH", relative, "Vendor tarball bytes do not match their locked SHA-512 integrity.");
    else report.dependencies.vendorTarballs.push({ path: relative, bytes: bytes.length, sha512Verified: true });
  }
}

function blank(value) { return value.replace(/[^\n]/g, " "); }
function markdownContent(text) {
  let fence = "", fenceLength = 0;
  const lines = text.split("\n").map(line => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) { if (match && match[1][0] === fence && match[1].length >= fenceLength && /^\s*$/.test(line.slice(match[0].length))) fence = ""; return blank(line); }
    if (match) { fence = match[1][0]; fenceLength = match[1].length; return blank(line); }
    return line;
  }).join("\n");
  return lines.replace(/<!--[\s\S]*?-->/g, blank).replace(/(`+)([^`]|(?!\1)`)*?\1/g, blank);
}
function destination(text, start, inline) {
  let i = start; while (/\s/.test(text[i] ?? "") && i < text.length) i++;
  let target = "";
  if (text[i] === "<") {
    const end = text.indexOf(">", i + 1); if (end < 0 || text.slice(i, end).includes("\n")) return null;
    target = text.slice(i + 1, end); i = end + 1;
  } else {
    const from = i; let depth = 0;
    for (; i < text.length; i++) {
      const char = text[i];
      if (char === "\\") { i++; continue; }
      if (char === "(") { if (++depth > 32) return null; }
      else if (char === ")") { if (depth === 0) break; depth--; }
      if (/\s/.test(char) && depth === 0) break;
    }
    target = text.slice(from, i);
  }
  if (!inline) return { target, end: i };
  while (/\s/.test(text[i] ?? "") && i < text.length) i++;
  if (text[i] === '"' || text[i] === "'" || text[i] === "(") {
    const close = text[i] === "(" ? ")" : text[i++]; if (close === ")") i++;
    while (i < text.length && text[i] !== close) { if (text[i] === "\\") i++; i++; }
    if (text[i++] !== close) return null;
    while (/\s/.test(text[i] ?? "") && i < text.length) i++;
  }
  return text[i] === ")" ? { target, end: i } : null;
}
function markdownLinks(text) {
  let content = markdownContent(text);
  const definitions = new Map(), links = [], normalize = value => value.replace(/\s+/g, " ").trim().toLowerCase();
  content = content.replace(/^ {0,3}\[([^\]\n]{1,1024})\]:[ \t]*(.*)$/gm, (all, label, rest) => { const parsed = destination(rest, 0, false); if (parsed) definitions.set(normalize(label), parsed.target); return blank(all); });
  const stack = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\\") { i++; continue; }
    if (content[i] === "[") { if (stack.length < 64) stack.push(i); else stack.length = 0; continue; }
    if (content[i] !== "]" || !stack.length) continue;
    const start = stack.pop(); if (i - start > 1024) continue;
    if (content[i + 1] === "(") {
      const parsed = destination(content, i + 2, true);
      if (parsed) { links.push({ target: parsed.target, offset: start }); i = parsed.end; }
    } else {
      let label = content.slice(start + 1, i);
      if (content[i + 1] === "[") {
        const end = content.indexOf("]", i + 2);
        if (end < 0 || end - i > 1024) continue;
        label = content.slice(i + 2, end) || label; i = end;
      }
      const target = definitions.get(normalize(label)); if (target !== undefined) links.push({ target, offset: start });
    }
  }
  for (const match of content.matchAll(/<(?:a|img|source)\b[^>]*?\b(?:href|src)\s*=\s*(["'])(.*?)\1[^>]*>/gi)) links.push({ target: match[2], offset: match.index });
  return links;
}
function verifyMarkdown() {
  for (const file of [...files].filter(name => /\.(?:md|mdx)$/i.test(name)).sort()) {
    const bytes = read(file); if (!bytes) continue; report.markdown.files++;
    const text = bytes.toString("utf8");
    let cursor = 0, line = 1;
    for (const link of markdownLinks(text).sort((a, b) => a.offset - b.offset)) {
      while (cursor < link.offset) if (text[cursor++] === "\n") line++;
      const target = link.target.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~ ])/g, "$1");
      if (!target || target.startsWith("#") || target.startsWith("?")) { report.markdown.anchors++; continue; }
      if (/^(?:file:|[a-z]:[\\/])/i.test(target)) { fail("MARKDOWN_PATH_ESCAPE", file, "Local machine file URLs and drive paths are not portable source links.", line); continue; }
      if (target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target)) { report.markdown.external++; continue; }
      if (target.startsWith("/")) { report.markdown.routes++; continue; }
      report.markdown.filesystemLinks++;
      let decoded;
      try { decoded = decodeURIComponent(target.split(/[?#]/, 1)[0]); } catch { fail("MALFORMED_MARKDOWN_LINK", file, "Relative link has invalid URL encoding.", line); continue; }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded));
      if (!decoded || /[\\\x00-\x1f\x7f]/.test(decoded) || path.posix.isAbsolute(decoded) || /^[a-z]:/i.test(decoded) || resolved === ".." || resolved.startsWith("../")) { fail("MARKDOWN_PATH_ESCAPE", file, "Relative filesystem link escapes the source tree or uses unsafe separators.", line); continue; }
      if (privatePath(resolved)) { fail("PRIVATE_MARKDOWN_TARGET", file, "A filesystem link points into private or generated material.", line); continue; }
      if (!files.has(resolved) && !directories.has(resolved === "." ? "" : resolved)) fail("BROKEN_MARKDOWN_FILE_LINK", file, `Relative target ${JSON.stringify(decoded)} is not included in source inputs.`, line);
    }
  }
}

try {
  let archive;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--json") jsonOutput = true;
    else if (arg === "--archive" && !archive && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) archive = process.argv[++i];
    else if (arg === "--help") { console.log("Usage: node scripts/check-release.mjs [--json] [--archive <directory>]\nDefault: Git tracked and ordinary unignored new files. Archive mode inspects only the explicit tree. No environment files, ignored trees, package execution or network requests are used."); process.exit(0); }
    else throw Error("Usage: node scripts/check-release.mjs [--json] [--archive <directory>]");
  }
  if (archive) {
    report.mode = "archive";
    const candidate = path.resolve(archive), stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("The explicit archive root must be an ordinary directory.");
    root = fs.realpathSync(candidate); walkArchive();
  } else {
    const git = args => spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const location = git(["rev-parse", "--show-toplevel"]);
    if (location.status !== 0) throw Error("Run inside a Git worktree or supply --archive <directory>.");
    root = fs.realpathSync(location.stdout.trim());
    const selected = git(["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z"]);
    if (selected.status !== 0) throw Error("Cannot enumerate Git source inputs.");
    const paths = [...new Set(selected.stdout.split("\0").filter(Boolean))].sort();
    if (paths.length > MAX_FILES) fail("INPUT_LIMIT", ".", `The checker is bounded to ${MAX_FILES} files.`);
    else paths.forEach(includeFile);
  }
  report.files = files.size; verifyDependencies(); verifyMarkdown(); report.ok = failures.length === 0;
} catch (error) { fail("CHECKER_INPUT_ERROR", ".", error instanceof Error && error.message.startsWith("Usage:") ? error.message : "Cannot inspect the selected source root; use an ordinary Git worktree or explicit archive directory."); }

if (jsonOutput) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`${report.ok ? "PASS" : "FAIL"}: ${report.mode} release inputs; ${report.files} files, ${report.markdown.filesystemLinks} relative file links, ${report.dependencies.vendorTarballs.length} verified vendor tarball${report.dependencies.vendorTarballs.length === 1 ? "" : "s"}.`);
  for (const failure of failures) console.log(`${failure.code}: ${JSON.stringify(failure.path)}${failure.line ? `:${failure.line}` : ""} ${failure.message}`);
  console.log(`License metadata: ${report.licenses.declared.length} declared expressions; ${report.licenses.missing.length} entries without a declaration. This is a reported limitation, not a license determination.`);
  for (const gap of report.licenses.missing.slice(0, 20)) console.log(`  Missing declaration: ${JSON.stringify(gap.name)}@${JSON.stringify(gap.version)}`);
}
process.exitCode = report.ok ? 0 : 1;
