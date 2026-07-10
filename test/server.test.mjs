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
const { db, insertEntityStmt, insertAliasStmt, storeArtifactTxn } = await import('../src/db.js');
const { embedToFloat32 } = await import('../src/embeddings.js');

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

const get = (path, headers = {}) => fetch(`${base}${path}`, { headers });

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

test('/api/search: near + radius_km geo-filters by coordinate (#68)', async () => {
  // Two coord-bearing photos ~4100km apart; a `near` search with a tight radius must return only
  // the one inside the circle. Stored straight through storeArtifactTxn (the fake Ollama embeds)
  // since /api/remember only makes coordinate-less notes.
  const sfVec = await embedToFloat32('a sunny afternoon photo by the bay');
  const nyVec = await embedToFloat32('a rainy afternoon photo in the city');
  const sf = storeArtifactTxn({ type: 'photo', source: 'geo-test', source_id: 'sf', text_repr: 'a sunny afternoon photo by the bay', latitude: 37.7749, longitude: -122.4194, place_label: 'San Francisco, CA' }, sfVec, []);
  const ny = storeArtifactTxn({ type: 'photo', source: 'geo-test', source_id: 'ny', text_repr: 'a rainy afternoon photo in the city', latitude: 40.7128, longitude: -74.006, place_label: 'New York, NY' }, nyVec, []);

  const byName = await post('/api/search', { query: 'afternoon photo', near: 'San Francisco', radius_km: 50, limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(byName.status, 200);
  const nameIds = (await byName.json()).results.map((r) => r.id);
  assert.ok(nameIds.includes(sf.id), 'the SF photo is within 50km of San Francisco');
  assert.ok(!nameIds.includes(ny.id), 'the NY photo is excluded by the radius');

  const byCoord = await post('/api/search', { query: 'afternoon photo', near: { lat: 40.71, lon: -74.0 }, radius_km: 50, limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(byCoord.status, 200);
  const coordIds = (await byCoord.json()).results.map((r) => r.id);
  assert.ok(coordIds.includes(ny.id) && !coordIds.includes(sf.id), 'explicit {lat,lon} filters to NY');

  // Demote-never-drop: an unresolvable place name must not empty the search.
  const bogus = await post('/api/search', { query: 'afternoon photo', near: 'Xyzzyville Nowhere Land', limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(bogus.status, 200);
  assert.ok((await bogus.json()).results.length > 0, 'an unresolvable near folds into search text, not an empty result');

  // Out-of-range explicit coordinates are rejected at the schema (400), not silently ignored.
  const badCoord = await post('/api/search', { query: 'afternoon photo', near: { lat: 999, lon: 999 } }, { 'x-api-key': API_KEY });
  assert.equal(badCoord.status, 400, 'garbage coordinates 400 rather than disabling the filter silently');
});

test('/api/v1/entities/duplicates + /api/v1/entities/merge (#75): surfaces, merges, and rejects bad merges', async () => {
  // Two entities sharing a phone number — the residue contacts.js's own auto-merge (email/exact
  // name only) never catches, and exactly the gap list_probable_duplicates exists to surface.
  const a = Number(insertEntityStmt.run('person', 'REST Dup One', JSON.stringify({ phones: ['5559990001'] })).lastInsertRowid);
  const b = Number(insertEntityStmt.run('person', 'REST Dup Two', JSON.stringify({ phones: ['5559990001'] })).lastInsertRowid);
  insertAliasStmt.run(a, 'rest dup one', 'name');
  insertAliasStmt.run(b, 'rest dup two', 'name');

  const dupRes = await get('/api/v1/entities/duplicates?limit=50', { 'x-api-key': API_KEY });
  assert.equal(dupRes.status, 200);
  const { pairs } = await dupRes.json();
  assert.ok(
    pairs.some((p) => [p.a.id, p.b.id].includes(a) && [p.a.id, p.b.id].includes(b)),
    'the shared-phone pair is surfaced over REST'
  );

  const mergeRes = await post('/api/v1/entities/merge', { keep_id: a, absorb_id: b }, { 'x-api-key': API_KEY });
  assert.equal(mergeRes.status, 200);
  const merged = await mergeRes.json();
  assert.equal(merged.merged, true);
  assert.equal(merged.absorb_id, b);

  const selfRes = await post('/api/v1/entities/merge', { keep_id: a, absorb_id: a }, { 'x-api-key': API_KEY });
  assert.equal(selfRes.status, 422, 'self-merge is rejected');

  const reMergeRes = await post('/api/v1/entities/merge', { keep_id: a, absorb_id: b }, { 'x-api-key': API_KEY });
  assert.equal(reMergeRes.status, 404, 're-merging an already-tombstoned entity is rejected');
});
