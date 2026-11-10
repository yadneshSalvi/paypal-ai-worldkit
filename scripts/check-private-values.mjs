import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
const files = [...new Set(execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
const privateValues = [];
for (const envFile of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (!existsSync(envFile)) continue;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (value.length >= 10 && /KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL|CLIENT_ID|BUYER|MERCHANT_EMAIL|LOGIN/.test(match[1])) privateValues.push({ name: match[1], value });
  }
}
const findings = [];
function check(path, bytes) { const text = bytes.toString('utf8'); for (const entry of privateValues) if (text.includes(entry.value)) findings.push({ file: path, variable: entry.name }); }
for (const file of files) {
  if (!existsSync(file) || file.startsWith('plans/') || /(^|\/)\.env($|\.)/.test(file) && file !== '.env.example') continue;
  if (file.endsWith('.tgz')) {
    for (const member of execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(name => name && !name.endsWith('/'))) check(`${file}:${member}`, execFileSync('tar', ['-xOf', file, member], { maxBuffer: 10 * 1024 * 1024 }));
  } else check(file, readFileSync(file));
}
const prohibited = files.filter(file => /^(plans\/|\.env$|\.env\.(?!example$)|\.artifacts\/|\.setup-evidence\/|\.private\/)/.test(file));
console.log(JSON.stringify({ checkedFiles: files.length, comparedPrivateVariables: privateValues.length, privateValueFindings: findings, prohibitedFiles: prohibited }));
if (findings.length || prohibited.length) process.exitCode = 1;
