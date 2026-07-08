#!/usr/bin/env node
/**
 * `npm run check:boundary` — enforce the connector boundary (issue #49, doc 04 §1.1/§10).
 *
 * Connectors are isolated HTTP clients; the contract is their ONLY coupling to core. This
 * walks connectors/**\/*.{js,mjs,cjs} and fails if any import/require specifier resolves
 * into the repo's src/ — the mistake that would silently turn the HTTP contract into an
 * in-process plugin API. Exit 0 clean; exit 1 listing each violating file:line.
 * No deps — node:fs walk + a line regex (connectors are plain ESM; no bundler indirection).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(repoRoot, 'src') + sep;
const IMPORT_RE = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(js|mjs|cjs)$/.test(name)) yield p;
  }
}

const violations = [];
let checked = 0;
for (const file of walk(join(repoRoot, 'connectors'))) {
  checked++;
  const text = readFileSync(file, 'utf8');
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // bare specifiers (deps, node:*) can't reach src/
    const target = resolve(dirname(file), spec);
    if ((target + sep).startsWith(srcRoot) || target.startsWith(srcRoot)) {
      const line = text.slice(0, m.index).split('\n').length;
      violations.push(`${file}:${line} imports ${spec}`);
    }
  }
}

if (violations.length) {
  console.error(`boundary VIOLATED — connectors must talk HTTP, never import src/ (doc 04 §1.1):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`boundary OK (${checked} connector files checked)`);
