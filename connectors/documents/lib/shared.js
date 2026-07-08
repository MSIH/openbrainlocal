// Shared by scan.js and ocr-worker.js. Both scripts must compute source_id identically —
// a mismatch here would silently create duplicate artifacts instead of upserting the same one.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

// No default `dir` — this module lives in lib/, one level below scan.js/ocr-worker.js,
// so defaulting to *this* module's own directory would look for documents/lib/.env instead
// of documents/.env. Callers must pass their own directory explicitly.
export function loadDotEnvIfPresent(dir) {
  const envPath = path.join(dir, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, rawValue = ''] = match;
    if (process.env[key] === undefined) process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

export const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);

// Manual recursive walk rather than fs.readdir's `recursive` option — that option needs
// Node 20.1+ and this connector declares a genuinely-true `>=18` floor.
//
// `root` stays fixed across the whole recursion (only `dir` advances) — relPath must always be
// relative to the original scan root, never to the current subdirectory, or two files with the
// same name in different subfolders (e.g. two years' "report.pdf") collide onto the same
// source_id and silently overwrite each other via upsert instead of being two artifacts.
export async function* walkDocumentFiles(root, dir = root) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDocumentFiles(root, absPath);
    } else if (entry.isFile() && DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield { absPath, relPath: path.relative(root, absPath).split(path.sep).join('/') };
    }
  }
}

// The relative path (POSIX-normalized so it's stable across OSes) IS the source_id — it's
// reproducible from the source data itself (doc 04 §3), simple, and debuggable. A document
// tree reorganized after the first scan orphans history the same way renaming any connector's
// `source` would — documented in README.md, not silently handled.
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

export const BATCH_MAX = 100; // contract cap (docs/04-connector-contract.md §2)
// The ingest API rejects request bodies over 256KB; document text_reprs are big enough that
// 100 of them can blow past that where photo-exif's one-liners never could, so groups are cut
// by serialized size as well as count. 200KB leaves margin for the envelope and JSON escaping.
export const BATCH_BYTE_BUDGET = 200 * 1024;

// Groups pending items ({ payload, ... }) into batches that respect BOTH caps. A single
// payload can never exceed the budget on its own: text_repr is capped at
// DOCUMENTS_TEXT_REPR_MAX_CHARS (hard ceiling 100,000 chars — see scan.js config parsing).
export function chunkByBudget(pending) {
  const groups = [];
  let group = [];
  let bytes = 0;
  for (const item of pending) {
    const size = Buffer.byteLength(JSON.stringify(item.payload));
    if (group.length && (group.length >= BATCH_MAX || bytes + size > BATCH_BYTE_BUDGET)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(item);
    bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
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
