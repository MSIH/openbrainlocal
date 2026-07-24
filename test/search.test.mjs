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

const { rrf, hybridSearch, timeline, aboutEntity, warmUpQueryModel } = await import('../src/search.js');
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

test('#227 candidate temp table: two sequential searches with different type filters do not cross-contaminate', async () => {
  // A note and a message sharing a distinctive keyword — the shared candidate temp table is
  // cleared + refilled per search, so search N's candidate set must never leak into search N+1.
  // 'zebra-widget' is rare enough to drive the FTS (EXISTS) arm; the type filter is the only
  // discriminator, exactly as the temp table constrains both the KNN (IN) and FTS (EXISTS) arms.
  await executeIngest({ source: 'iso', source_id: 'iso-note', type: 'note', text_repr: 'zebra-widget quarterly recap', occurred_at: '2026-02-01' });
  await executeIngest({ source: 'iso', source_id: 'iso-msg', type: 'message', text_repr: 'zebra-widget quarterly recap', occurred_at: '2026-02-01' });

  const first = (await hybridSearch('zebra-widget quarterly recap', { limit: 10, types: ['note'], usePlanner: false })).map((r) => r.source_id);
  const second = (await hybridSearch('zebra-widget quarterly recap', { limit: 10, types: ['message'], usePlanner: false })).map((r) => r.source_id);

  assert.ok(first.includes('iso-note') && !first.includes('iso-msg'), 'search 1 (types:[note]) returns only the note');
  assert.ok(second.includes('iso-msg') && !second.includes('iso-note'), 'search 2 (types:[message]) returns only the message — no leftover candidates from search 1');
});

test('#227 recent sort orders the candidate set via the temp table (occurred_at DESC)', async () => {
  // sort:'recent' bypasses KNN/FTS and orders the temp-table candidate set directly — exercise it
  // so the recentOrderStmt rewrite (json_each -> temp table) is covered end-to-end.
  await executeIngest({ source: 'rec', source_id: 'rec-old', type: 'note', text_repr: 'sprint retro notes', occurred_at: '2026-04-01' });
  await executeIngest({ source: 'rec', source_id: 'rec-new', type: 'note', text_repr: 'sprint retro notes', occurred_at: '2026-05-01' });
  const ids = (await hybridSearch('sprint retro notes', { limit: 10, types: ['note'], sort: 'recent', usePlanner: false })).map((r) => r.source_id);
  const iOld = ids.indexOf('rec-old');
  const iNew = ids.indexOf('rec-new');
  assert.ok(iNew !== -1 && iOld !== -1, 'both notes are candidates');
  assert.ok(iNew < iOld, 'the newer note (May) sorts before the older (April) under sort:recent');
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

test('warmUpQueryModel: hits the native /api/generate endpoint with the query model, keep_alive, and a non-streamed request (#247)', async () => {
  const before = fake.counts.generate;
  await warmUpQueryModel();
  assert.equal(fake.counts.generate, before + 1, 'exactly one warm-up call is made');
  const body = fake.getLastGenerateBody();
  assert.equal(body.prompt, '', 'an empty prompt preloads the model without generating tokens');
  assert.equal(body.stream, false, 'a streamed reply would otherwise never be drained');
  assert.ok(body.model && body.keep_alive, 'model and keep_alive are both forwarded');
});
