import { readdir, readFile, lstat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const skip = new Set(['.git', 'node_modules', '.terraform', 'coverage']);
const findings = [];
const signatures = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['google-key', /AIza[0-9A-Za-z_-]{35}/],
  ['github-token', /gh[pousr]_[0-9A-Za-z]{30,}/],
  ['github-token', /github_pat_[0-9A-Za-z_]{50,}/],
  ['aws-id', /AKIA[0-9A-Z]{16}/],
  ['jwt', /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ['credential-json', /"private_key"\s*:\s*"[^"]{24,}/],
  ['assigned-secret', /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9_+\/-]{24,}["']/i],
  ['personal-email', /[A-Za-z0-9._%+-]+@(?:gmail|hotmail|outlook)\.com/i],
  ['local-user-path', /[A-Z]:[\\/]Users[\\/][^\s]+/i],
];
const denyTerms = process.env.PRIVATE_TERMS_FILE
  ? (await readFile(process.env.PRIVATE_TERMS_FILE, 'utf8')).split(/\r?\n/).filter(Boolean) : [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = resolve(dir, entry.name), name = relative(root, path).replaceAll('\\', '/');
    if ((await lstat(path)).isSymbolicLink()) { findings.push(name + ': symlink'); continue; }
    if (entry.isDirectory()) { await walk(path); continue; }
    if ((/^\.env/.test(entry.name) && entry.name !== '.env.example') || /\.(pem|key|p12|tfstate|tfplan|log)$/.test(entry.name) || /^(credentials|service-account).*\.json$/.test(entry.name)) findings.push(name + ': forbidden file');
    const bytes = await readFile(path);
    if (bytes.length > 5_000_000) findings.push(name + ': oversized artifact');
    if (/\.(png|jpg)$/.test(name)) continue;
    const text = bytes.toString('utf8');
    for (const [label, pattern] of signatures) if (pattern.test(text)) findings.push(name + ': ' + label);
    for (const term of denyTerms) if (text.toLowerCase().includes(term.toLowerCase())) findings.push(name + ': private term');
  }
}
await walk(root);
if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
else console.log('Publication checks passed. Pattern scanning supplements manual review; it cannot prove the absence of all secrets.');
