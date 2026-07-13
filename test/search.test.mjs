// search.js coverage: the pure ranking core (rrf) plus hybridSearch's default_searchable
// enforcement (#121). Importing search.js opens the DB (via db.js) and constructs the embedder
// client, so DB_PATH is pointed at a temp file and a fake local Ollama is stood up (embeddings +
// planner) BEFORE the dynamic imports — the same pattern as ingest.test.mjs. rrf touches neither.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, startFakeOllama } from './helpers.mjs';

const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;

const { rrf, hybridSearch } = await import('../src/search.js');
const { executeIngest } = await import('../src/ingest.js');
const { db } = await import('../src/db.js');

after(async () => { db.close(); await fake.close(); cleanup(); });

test('rrf: a single list preserves its order', () => {
  assert.deepEqual(rrf([[10, 20, 30]]), [10, 20, 30]);
});

test('rrf: an id ranked by two arms outranks ids seen by only one', () => {
  // id 2 appears in both lists → its scores sum and it wins. 1 (rank 0 of one list) beats
  // 3 (rank 1 of one list).
  assert.deepEqual(rrf([[1, 2], [2, 3]]), [2, 1, 3]);
});

test('rrf: empty input is safe', () => {
  assert.deepEqual(rrf([]), []);
  assert.deepEqual(rrf([[], []]), []);
});

test('hybridSearch enforces default_searchable: a no-type search hides a visit; an explicit type surfaces it (#121)', async () => {
  // A visit (default_searchable:false) and a note (searchable) sharing the query terms — the only
  // difference the enforcement can act on is the type.
  await executeIngest({ source: 'srch', source_id: 'note-1', type: 'note', text_repr: 'hiking trip to the alpine lakes', occurred_at: '2026-01-02' });
  await executeIngest({ source: 'srch', source_id: 'visit-1', type: 'visit', text_repr: 'hiking trip to the alpine lakes', occurred_at: '2026-01-02' });

  const dflt = (await hybridSearch('hiking trip alpine lakes', { limit: 10, usePlanner: false })).map((r) => r.type);
  assert.ok(dflt.includes('note'), 'a searchable type is still returned by a default search');
  assert.ok(!dflt.includes('visit'), 'a visit is NOT returned by a no-type search');

  const explicit = (await hybridSearch('hiking trip alpine lakes', { limit: 10, types: ['visit'], usePlanner: false })).map((r) => r.type);
  assert.ok(explicit.includes('visit'), 'an explicit types:[visit] returns the visit — explicit wins over the default');
  assert.ok(!explicit.includes('note'), 'the explicit type filter still excludes other types');
});
