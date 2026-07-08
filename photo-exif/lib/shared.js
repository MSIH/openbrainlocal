// Shared by scan.js and caption-worker.js. Both scripts must compute source_id identically —
// a mismatch here would silently create duplicate artifacts instead of upserting the same one.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadDotEnvIfPresent(dir = path.dirname(fileURLToPath(import.meta.url))) {
  const envPath = path.join(dir, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, rawValue = ''] = match;
    if (process.env[key] === undefined) process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff']);

// Manual recursive walk rather than fs.readdir's `recursive` option — that option needs
// Node 20.1+; this connector has zero native dependencies, so it's worth the extra lines to
// keep a genuinely-true `>=18` floor (see the engines.node bug Copilot caught in the imessage
// connector's package.json — this avoids repeating it).
export async function* walkImageFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkImageFiles(absPath);
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield { absPath, relPath: path.relative(rootDir, absPath).split(path.sep).join('/') };
    }
  }
}

// The relative path (POSIX-normalized so it's stable across OSes) IS the source_id — it's
// reproducible from the source data itself (doc 04 §3), simple, and debuggable. A photo
// library reorganized after the first scan orphans history the same way renaming any
// connector's `source` would (doc 04 §3's "source" field rule) — documented, not silently
// handled.
export function sourceIdFor(relPath) {
  return relPath;
}

export function contentHashOfFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function ingestClient({ url, apiKey }) {
  async function postIngest(payload) {
    const res = await fetch(`${url}/api/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`ingest returned ${res.status}`);
    return res.json();
  }

  async function postIngestBatch(payloads) {
    const res = await fetch(`${url}/api/v1/ingest/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ artifacts: payloads }),
    });
    if (!res.ok) throw new Error(`ingest batch returned ${res.status}`);
    return res.json();
  }

  return { postIngest, postIngestBatch };
}
