#!/usr/bin/env node
/**
 * `npm run test:connectors` — run each connector's own `node --test test.mjs` suite.
 *
 * Connectors are isolated packages (doc 04 §1.1) with their own deps, so their tests aren't
 * part of the root `npm test` glob. This walks each `connectors/<name>/` folder, and for each
 * one that has a `test.mjs` AND an installed `node_modules`, runs its suite in-place. A connector whose deps
 * aren't installed is **skipped, not failed** — a fresh checkout runs zero connector suites, and
 * a dev who `npm ci`'d only the connector they're working on tests just that one. Exit 1 if any
 * run suite failed; exit 0 if every present suite passed (or all were skipped).
 *
 * Portable (spawns `process.execPath`, no shell), so it runs the same on Windows and Unix.
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const connectorsRoot = join(repoRoot, 'connectors');
if (!existsSync(connectorsRoot)) { console.log('test:connectors — no connectors/ directory'); process.exit(0); }

let ran = 0, failed = 0, skipped = 0;
for (const name of readdirSync(connectorsRoot)) {
  const dir = join(connectorsRoot, name);
  if (!statSync(dir).isDirectory()) continue;
  if (!existsSync(join(dir, 'test.mjs'))) continue;
  if (!existsSync(join(dir, 'node_modules'))) { console.log(`  skip ${name} (deps not installed)`); skipped++; continue; }
  console.log(`  test ${name}…`);
  const r = spawnSync(process.execPath, ['--test', 'test.mjs'], { cwd: dir, stdio: 'inherit' });
  ran++;
  if (r.status !== 0) { failed++; console.error(`  FAIL ${name} (exit ${r.status})`); }
}

console.log(`test:connectors — ${ran} suite(s) run, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
