// Reciprocal-rank-fusion math (search.js): the pure ranking core of hybrid search. Importing
// search.js opens the DB (via db.js) and constructs the embedder client (no network call at
// import), so DB_PATH is pointed at a temp file first; rrf itself touches neither.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers.mjs';

const { cleanup } = useTempDb();
const { rrf } = await import('../src/search.js');
const { db } = await import('../src/db.js');

after(() => { db.close(); cleanup(); });

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
