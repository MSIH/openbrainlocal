// Env loading, hashing, batching, the ingest HTTP client, and the spool — self-contained so
// this connector imports nothing from src/ (doc 04 §1.1, enforced by `npm run check:boundary`)
// and nothing from a sibling connector (each connectors/ folder stands alone). Mirrors
// photo-exif/lib/shared.js deliberately: same source_id/hashing/ingest discipline, so the two
// batch connectors behave identically on the wire.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';

// No default `dir` — this module lives in lib/, one level below index.js, so defaulting to
// this module's own directory would look for lib/.env instead of the connector's .env. Callers
// pass their own directory explicitly (matches photo-exif's note).
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

// Streamed sha256 (bare lowercase hex) — matches core's content_hash format exactly
// (docs/04-connector-contract.md §3) and doubles as the dedup key that collapses Takeout's
// same-photo-in-many-folders duplication into one artifact (see index.js).
export function contentHashOfFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function readJsonOr(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
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

// Spool posture (doc 04 §7): when the server is unreachable, append the failed payloads to a
// local JSONL file (one payload per line) and flush them on the next run — lose at most the
// uncommitted window, never buffer unbounded, never require the server to be up to READ the
// Takeout tree. A single shared JSONL is fine here because this is a batch backfill run
// one-at-a-time (cron/manual), not a connector that runs concurrently with itself (§7 caveat).
export function spoolClient({ spoolPath, postIngestBatch, batchMax }) {
  async function spool(payloads) {
    await mkdir(path.dirname(spoolPath), { recursive: true });
    await appendFile(spoolPath, payloads.map((p) => JSON.stringify(p)).join('\n') + '\n');
  }

  async function flushSpool() {
    let lines;
    try {
      lines = (await readFile(spoolPath, 'utf8')).split('\n').filter((l) => l.trim());
    } catch {
      return { flushed: [], remaining: 0 }; // no spool file yet
    }
    const payloads = lines.map((l) => JSON.parse(l));
    const remaining = [];
    const flushed = []; // returned so the caller can mark them sent and skip re-sending in phase 2
    for (const group of chunk(payloads, batchMax)) {
      try {
        const { results } = await postIngestBatch(group);
        results.forEach((r, i) => {
          if (r.error) remaining.push(group[i]); // per-item failure → keep for next run
          else flushed.push(group[i]);
        });
      } catch {
        remaining.push(...group); // whole request failed (server down) → keep all
      }
    }
    if (remaining.length) await writeFile(spoolPath, remaining.map((p) => JSON.stringify(p)).join('\n') + '\n');
    else await rm(spoolPath, { force: true });
    return { flushed, remaining: remaining.length };
  }

  return { spool, flushSpool };
}
