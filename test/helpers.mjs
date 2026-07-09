// Shared test helpers for the core (src/) suite. Mirrors the connectors' node:test style
// (connectors/imessage/test.mjs): stand up throwaway state, drive real modules, tear down.
// No new deps — node: built-ins only.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Deliberately NOT imported from src/config.js: config.js reads process.env (incl. DB_PATH) at
// module load, and importing it here would freeze that read BEFORE useTempDb() runs. Mirror
// config.js's own default instead (tests never override VECTOR_DIMENSION, so this matches).
const VECTOR_DIMENSION = Number(process.env.VECTOR_DIMENSION) || 1024;

// A Float32Array of the right dimension. `fill` seeds every slot (default 0.1) so vectors are
// non-zero and comparable; pass a different constant to make two vectors distinct for KNN.
export const f32 = (fill = 0.1) => new Float32Array(VECTOR_DIMENSION).fill(fill);

// Point DB_PATH at a fresh temp file BEFORE db.js is imported (it opens the DB at module load).
// Returns { dir, cleanup } — cleanup rm's the dir (WAL + shm siblings included). The caller
// closes the db handle in its own teardown (db.js owns the singleton). Call at the very top of
// a test file, before any dynamic import of src/db.js (or anything that imports it).
export function useTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lc-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A fake local Ollama (OpenAI-compatible) so ingest/search/server tests never need a live
// engine — the connector tests take the same mock-HTTP-server approach. Serves:
//   POST /v1/embeddings         -> a deterministic VECTOR_DIMENSION-length vector
//   POST /v1/chat/completions   -> a fixed pure-semantic plan (the planner's happy path)
// `counts` tracks calls so a test can assert re-embed-only-on-text-change. Set OLLAMA_BASE_URL
// to the returned baseUrl BEFORE importing embeddings.js (or anything that imports it).
export async function startFakeOllama() {
  const counts = { embed: 0, chat: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/embeddings')) {
        counts.embed++;
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* keep default */ }
        // Derive the vector deterministically FROM the input text (not just the index) so distinct
        // texts get distinct vectors — otherwise every artifact embeds identically and the KNN arm
        // can't discriminate, hiding vector-ranking regressions. Same text -> same vector.
        const text = Array.isArray(parsed.input) ? parsed.input.join(' ') : String(parsed.input ?? '');
        let h = 2166136261; // FNV-1a seed
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
        const floats = Array.from({ length: VECTOR_DIMENSION }, (_, i) => Math.sin((h ^ Math.imul(i, 2654435761)) >>> 0));
        // Honor whatever `encoding_format` the request asks for. The OpenAI client used here has
        // been observed to request base64, and returning a plain float array to a base64 request
        // gets mis-decoded — so respond in the requested format and the vector round-trips at full
        // length. (embeddings.js always sees a decoded number[] back from the SDK either way.)
        const format = parsed.encoding_format ?? 'float';
        const embedding = format === 'base64'
          ? Buffer.from(new Float32Array(floats).buffer).toString('base64')
          : floats;
        res.end(JSON.stringify({ data: [{ embedding }] }));
      } else if (req.url.endsWith('/chat/completions')) {
        counts.chat++;
        const plan = { types: [], entities: [], place: null, time_start: null, time_end: null, semantic: '' };
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    counts,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
