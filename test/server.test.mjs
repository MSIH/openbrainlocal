// Integration smoke test for the server (src/server.js): the constant-time auth comparator, the
// x-api-key gate, and the mandated store->recall round-trip over real HTTP (CLAUDE.md pre-commit
// check, automated). All env is set BEFORE importing server.js — it reads config at load, binds
// the listener with app.listen(PORT), and hard-exits if the API key is unset. A fake local
// Ollama serves embeddings so no engine is required.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { useTempDb, startFakeOllama } from './helpers.mjs';

const API_KEY = 'test-key-0123456789-not-the-placeholder';
const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.LIFECONTEXT_API_KEY = API_KEY;
process.env.OLLAMA_BASE_URL = fake.baseUrl;
process.env.PORT = '0'; // ephemeral port — avoids collisions with a real running server

const { app, serverInstance, secureCompare } = await import('../src/server.js');
const { db } = await import('../src/db.js');

if (!serverInstance.listening) await once(serverInstance, 'listening');
const { port } = serverInstance.address();
const base = `http://127.0.0.1:${port}`;

after(async () => {
  // fetch (undici) keeps sockets alive; drop them so serverInstance.close() resolves promptly
  // instead of waiting out undici's keep-alive timeout.
  serverInstance.closeAllConnections?.();
  await new Promise((resolve) => serverInstance.close(resolve));
  db.close();
  await fake.close();
  cleanup();
});

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('secureCompare: rejects non-strings and mismatches, accepts an exact match', () => {
  assert.equal(secureCompare(undefined, API_KEY), false);
  assert.equal(secureCompare(['a'], API_KEY), false); // duplicated ?api_key= yields an array
  assert.equal(secureCompare('wrong', API_KEY), false);
  assert.equal(secureCompare(API_KEY, API_KEY), true);
});

test('auth gate: 401 without a key, 401 with a wrong key, 200 with the right key', async () => {
  assert.equal((await post('/api/remember', { content: 'x' })).status, 401);
  assert.equal((await post('/api/remember', { content: 'x' }, { 'x-api-key': 'nope' })).status, 401);
  const ok = await post('/api/remember', { content: 'auth check note' }, { 'x-api-key': API_KEY });
  assert.equal(ok.status, 200);
});

test('store -> recall round-trip returns the memory with a distance', async () => {
  const stored = await post('/api/remember', { content: 'the smoke test memory about otters' }, { 'x-api-key': API_KEY });
  assert.equal(stored.status, 200);
  const { success, id } = await stored.json();
  assert.equal(success, true);
  assert.ok(Number.isInteger(id));

  const recalled = await post('/api/recall', { query: 'otters' }, { 'x-api-key': API_KEY });
  assert.equal(recalled.status, 200);
  const { results } = await recalled.json();
  assert.ok(Array.isArray(results) && results.length >= 1, 'recall returns at least one result');
  const match = results.find((r) => r.content === 'the smoke test memory about otters');
  assert.ok(match, 'the stored memory is recalled');
  // The row is within the KNN k (few rows, k>=50), so the vector arm populates a real distance —
  // assert its type, not mere key presence (which is always true from executeRecall's mapping).
  assert.equal(typeof match.distance, 'number', 'recall result carries a numeric distance');
});

test('/api/search: filter-then-rank path (planner + prefiltered KNN/FTS) returns typed results', async () => {
  // Exercises the hybrid path the legacy recall skips: usePlanner:true -> parseQuery hits the fake
  // /chat/completions, and types:['note'] drives the SQL prefilter + the IN-constrained
  // knnInStmt/ftsInStmt (filter-then-rank) — the bulk of search.js.
  await post('/api/remember', { content: 'a field note about penguins in antarctica' }, { 'x-api-key': API_KEY });
  const res = await post('/api/search', { query: 'penguins', types: ['note'], limit: 5 }, { 'x-api-key': API_KEY });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.ok(Array.isArray(results) && results.length >= 1, 'search returns results');
  assert.ok(results.every((r) => r.type === 'note'), 'the type filter is applied via the SQL prefilter');
  assert.ok(results.some((r) => /penguins/.test(r.text_repr)), 'the matching artifact is returned');
});
