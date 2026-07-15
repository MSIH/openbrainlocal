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

const { rrf, hybridSearch, timeline, aboutEntity } = await import('../src/search.js');
const { executeIngest } = await import('../src/ingest.js');
const { db, insertEntityStmt, insertAliasStmt, normalizePhone } = await import('../src/db.js');

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

test('planner: a filter it returns within the timeout is applied (fake-Ollama) (#179)', async () => {
  // Two notes with identical text (identical embeddings → both are semantic candidates) on
  // different dates. The query text names no date, so only a planner-supplied time filter can
  // select June over January — proving the plan is both fetched (chat call) and applied.
  await executeIngest({ source: 'plan', source_id: 'p-jan', type: 'note', text_repr: 'quarterly planning offsite', occurred_at: '2026-01-10' });
  await executeIngest({ source: 'plan', source_id: 'p-jun', type: 'note', text_repr: 'quarterly planning offsite', occurred_at: '2026-06-10' });
  const before = fake.counts.chat;
  fake.setChatPlan({ time_start: '2026-06-01', time_end: '2026-06-30', semantic: 'quarterly planning offsite' });
  const rows = await hybridSearch('quarterly planning offsite', { limit: 10, usePlanner: true });
  assert.equal(fake.counts.chat, before + 1, 'the planner LLM was called (planner enabled, responds within the timeout)');
  const ids = rows.map((r) => r.source_id);
  assert.ok(ids.includes('p-jun'), 'the June note (inside the planner time window) is returned');
  assert.ok(!ids.includes('p-jan'), 'the January note is excluded by the planner time filter');
});

test('timeline + about_entity annotate handles with the resolved contact name (#149)', async () => {
  // A contact with a phone alias, then a message from that number — the ingest hint links it.
  const eid = Number(insertEntityStmt.run('person', 'Marta Reyes', null).lastInsertRowid);
  insertAliasStmt.run(eid, normalizePhone('+13105550188'), 'phone');
  insertAliasStmt.run(eid, 'marta reyes', 'name'); // so aboutEntity('Marta Reyes') resolves by name
  await executeIngest({
    source: 'tl', source_id: 'msg-149', type: 'message',
    text_repr: 'Message from +13105550188: "dinner at 7?"', occurred_at: '2026-03-15',
    entity_hints: [{ alias: '+13105550188', alias_type: 'phone', role: 'sender' }],
  });

  const row = timeline('2026-03-01', '2026-03-31').find((r) => r.source_id === 'msg-149');
  assert.ok(row, 'the message is in the timeline range');
  assert.equal(row.text_repr, 'Message from +13105550188: "dinner at 7?"', 'text_repr stays raw');
  assert.equal(row.display_text, 'Message from Marta Reyes (+13105550188): "dinner at 7?"');

  const about = aboutEntity('Marta Reyes');
  const linked = about.entities[0].artifacts.find((a) => a.source_id === 'msg-149');
  assert.equal(linked.display_text, 'Message from Marta Reyes (+13105550188): "dinner at 7?"');
});
