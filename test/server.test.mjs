// Integration smoke test for the server (src/server.js): the constant-time auth comparator, the
// x-api-key gate, and the mandated store->recall round-trip over real HTTP (CLAUDE.md pre-commit
// check, automated). All env is set BEFORE importing server.js — it reads config at load, binds
// the listener with app.listen(PORT), and hard-exits if the API key is unset. A fake local
// Ollama serves embeddings so no engine is required.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { useTempDb, startFakeOllama, f32 } from './helpers.mjs';

const API_KEY = 'test-key-0123456789-not-the-placeholder';
const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.LIFECONTEXT_API_KEY = API_KEY;
process.env.OLLAMA_BASE_URL = fake.baseUrl;
process.env.PORT = '0'; // ephemeral port — avoids collisions with a real running server
// Real on-disk photo store: the /entities/photos + /:id/photo routes existence-check files (#112),
// so contact photos in these tests must be real files under CONTACTS_RAW_DIR. Set before the app
// import — server.js resolves CONTACT_PHOTO_DIR from CONTACTS_RAW_DIR at load.
const rawDir = mkdtempSync(path.join(tmpdir(), 'lc-server-raw-'));
process.env.CONTACTS_RAW_DIR = rawDir;
const writePhoto = (name) => { const p = path.join(rawDir, name); writeFileSync(p, 'img-bytes'); return p; };

const { app, serverInstance, secureCompare } = await import('../src/server.js');
const { db, insertEntityStmt, insertAliasStmt, storeArtifactTxn, upsertEntityRelation } = await import('../src/db.js');
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
  rmSync(rawDir, { recursive: true, force: true });
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

  // Omitting radius_km falls back to GEO_RADIUS_DEFAULT_KM (25km): SF stays in, NY (~4100km) out.
  const byDefault = await post('/api/search', { query: 'afternoon photo', near: 'San Francisco', limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(byDefault.status, 200);
  const defaultIds = (await byDefault.json()).results.map((r) => r.id);
  assert.ok(defaultIds.includes(sf.id) && !defaultIds.includes(ny.id), 'default radius keeps SF and still excludes NY');

  // An absurd radius_km is clamped to GEO_RADIUS_MAX_KM (500km), so NY (~4100km away) stays excluded.
  const clamped = await post('/api/search', { query: 'afternoon photo', near: 'San Francisco', radius_km: 999999, limit: 10 }, { 'x-api-key': API_KEY });
  assert.equal(clamped.status, 200);
  const clampedIds = (await clamped.json()).results.map((r) => r.id);
  assert.ok(clampedIds.includes(sf.id) && !clampedIds.includes(ny.id), 'radius_km is clamped to the max; NY stays excluded');

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

  // A whitespace-only place name is rejected at the schema (trim().min(1)), not a silent no-op.
  const blankNear = await post('/api/search', { query: 'afternoon photo', near: '   ' }, { 'x-api-key': API_KEY });
  assert.equal(blankNear.status, 400, 'whitespace-only near is rejected rather than silently ignored');
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

test('/api/v1/entities/photos (#84): only photographed live person entities, for face-worker reference matching', async () => {
  const importedPath = writePhoto('rest-photo.jpg');
  const photographed = Number(insertEntityStmt.run('person', 'REST Photo Person', JSON.stringify({})).lastInsertRowid);
  insertAliasStmt.run(photographed, 'rest photo person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: 'rest-photo-test', source_id: `contact-${photographed}`, text_repr: 'REST Photo Person contact card', raw_path: importedPath },
    f32(0.5),
    [{ entity_id: photographed, role: 'self', confidence: 1.0 }],
  );
  const noPhoto = Number(insertEntityStmt.run('person', 'REST No Photo Person', JSON.stringify({})).lastInsertRowid);
  insertAliasStmt.run(noPhoto, 'rest no photo person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: 'rest-photo-test', source_id: `contact-${noPhoto}`, text_repr: 'REST No Photo Person contact card' },
    f32(0.5),
    [{ entity_id: noPhoto, role: 'self', confidence: 1.0 }],
  );

  const res = await get('/api/v1/entities/photos?limit=50', { 'x-api-key': API_KEY });
  assert.equal(res.status, 200);
  const { contacts } = await res.json();
  const found = contacts.find((c) => c.entity_id === photographed);
  assert.ok(found, 'the photographed contact is returned');
  assert.equal(found.raw_path, importedPath);
  assert.ok(!contacts.some((c) => c.entity_id === noPhoto), 'a contact with no preserved photo is excluded');
});

test('/api/v1/entities/photos (#112): honors the uploaded-photo precedence for face matching', async () => {
  // (a) uploaded-only — attrs.photoFile set, NO imported raw_path. Pre-#112 this was dropped
  // (WHERE raw_path IS NOT NULL); it must now appear with the uploaded file (the core bug).
  const uploadedFile = writePhoto('uploaded-only.jpg');
  const uploadedOnly = Number(insertEntityStmt.run('person', 'Uploaded Only Person', JSON.stringify({ photoFile: 'uploaded-only.jpg' })).lastInsertRowid);
  insertAliasStmt.run(uploadedOnly, 'uploaded only person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: 'prec-test', source_id: `contact-${uploadedOnly}`, text_repr: 'Uploaded Only Person contact card' },
    f32(0.5), [{ entity_id: uploadedOnly, role: 'self', confidence: 1.0 }],
  );
  // (b) both — uploaded override wins over the imported vCard photo.
  const bothUpload = writePhoto('both-upload.jpg');
  const bothImport = writePhoto('both-import.jpg');
  const both = Number(insertEntityStmt.run('person', 'Both Photos Person', JSON.stringify({ photoFile: 'both-upload.jpg' })).lastInsertRowid);
  insertAliasStmt.run(both, 'both photos person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: 'prec-test', source_id: `contact-${both}`, text_repr: 'Both Photos Person contact card', raw_path: bothImport },
    f32(0.5), [{ entity_id: both, role: 'self', confidence: 1.0 }],
  );
  // (c) missing uploaded file on disk → fall back to the imported photo (mirrors the UI route).
  const fallbackImport = writePhoto('fallback-import.jpg');
  const fallback = Number(insertEntityStmt.run('person', 'Fallback Person', JSON.stringify({ photoFile: 'ghost-missing.jpg' })).lastInsertRowid);
  insertAliasStmt.run(fallback, 'fallback person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: 'prec-test', source_id: `contact-${fallback}`, text_repr: 'Fallback Person contact card', raw_path: fallbackImport },
    f32(0.5), [{ entity_id: fallback, role: 'self', confidence: 1.0 }],
  );

  const res = await get('/api/v1/entities/photos?limit=200', { 'x-api-key': API_KEY });
  assert.equal(res.status, 200);
  const { contacts } = await res.json();
  const byId = new Map(contacts.map((c) => [c.entity_id, c]));
  assert.equal(byId.get(uploadedOnly)?.raw_path, uploadedFile, 'uploaded-only contact appears with the uploaded file');
  assert.equal(byId.get(both)?.raw_path, bothUpload, 'uploaded override wins over imported');
  assert.equal(byId.get(fallback)?.raw_path, fallbackImport, 'missing uploaded file falls back to imported');
  // Wire contract unchanged: every entry is { entity_id, name, raw_path } with an absolute path.
  for (const c of contacts) {
    assert.ok(typeof c.entity_id === 'number' && typeof c.name === 'string' && path.isAbsolute(c.raw_path),
      'each entry is {entity_id, name, absolute raw_path}');
  }
});

test('/api/about_entity (#88): an org carries its employees in relations_in (reverse worksAt edge)', async () => {
  const org = Number(insertEntityStmt.run('org', 'Acme REST Corp', JSON.stringify({})).lastInsertRowid);
  insertAliasStmt.run(org, 'acme rest corp', 'name');
  const person = Number(insertEntityStmt.run('person', 'Dana Employee', JSON.stringify({})).lastInsertRowid);
  insertAliasStmt.run(person, 'dana employee', 'name');
  upsertEntityRelation({ from_entity_id: person, to_entity_id: org, relation_type: 'worksAt', raw_label: 'worksAt', source: 'test' });

  const res = await post('/api/about_entity', { name: 'Acme REST Corp' }, { 'x-api-key': API_KEY });
  assert.equal(res.status, 200);
  const body = await res.json();
  const e = body.entities.find((x) => x.entity.id === org);
  assert.ok(e, 'the org resolves');
  assert.ok(e.relations_in.some((r) => r.relation_type === 'worksAt' && r.name === 'Dana Employee'), 'relations_in lists the employee');
  assert.equal(e.relations.length, 0, 'the org has no outgoing edges');
});

test('#119 proposed entities: ingest→propose→approve links the artifact; re-approve 409', async () => {
  const ing = await post('/api/v1/ingest', { source: 'documents', source_id: 'srv-receipt', type: 'document', text_repr: 'ProbeCo invoice total 12.00', entity_hints: [{ alias: 'ProbeCo', alias_type: 'name', role: 'mentioned', suggested_kind: 'org' }] }, { 'x-api-key': API_KEY });
  assert.ok(ing.status === 201 || ing.status === 200, 'ingest accepted');

  let r = await get('/api/v1/entities/proposed?status=pending', { 'x-api-key': API_KEY });
  assert.equal(r.status, 200);
  const prop = (await r.json()).proposals.find((p) => p.suggested_name === 'ProbeCo');
  assert.ok(prop && prop.suggested_kind === 'org', 'ProbeCo staged as a pending org proposal');

  let ab = await (await post('/api/about_entity', { name: 'ProbeCo' }, { 'x-api-key': API_KEY })).json();
  assert.equal(ab.resolved, false, 'no entity before approval');

  r = await fetch(`${base}/api/v1/entities/proposed/${prop.id}/approve`, { method: 'POST', headers: { 'x-api-key': API_KEY } });
  assert.equal(r.status, 200);
  assert.ok(Number.isInteger((await r.json()).entity_id));

  ab = await (await post('/api/about_entity', { name: 'ProbeCo' }, { 'x-api-key': API_KEY })).json();
  assert.equal(ab.resolved, true, 'entity created on approve');
  assert.ok(ab.entities[0].artifacts.length >= 1, 'origin artifact retroactively linked');

  const again = await fetch(`${base}/api/v1/entities/proposed/${prop.id}/approve`, { method: 'POST', headers: { 'x-api-key': API_KEY } });
  assert.equal(again.status, 409, 'already-approved proposal is 409');
});

test('#119 proposed entities: reject retains + auth-gated; no-suggested_kind hint stages nothing', async () => {
  await post('/api/v1/ingest', { source: 'documents', source_id: 'srv-spam', type: 'document', text_repr: 'JunkCo promo blast', entity_hints: [{ alias: 'JunkCo', alias_type: 'name', role: 'mentioned', suggested_kind: 'org' }] }, { 'x-api-key': API_KEY });
  let r = await get('/api/v1/entities/proposed?status=pending', { 'x-api-key': API_KEY });
  const prop = (await r.json()).proposals.find((p) => p.suggested_name === 'JunkCo');
  assert.ok(prop, 'JunkCo staged');

  assert.equal((await fetch(`${base}/api/v1/entities/proposed/${prop.id}/reject`, { method: 'POST' })).status, 401, 'reject is auth-gated');

  r = await fetch(`${base}/api/v1/entities/proposed/${prop.id}/reject`, { method: 'POST', headers: { 'x-api-key': API_KEY } });
  assert.equal(r.status, 200);
  r = await get('/api/v1/entities/proposed?status=pending', { 'x-api-key': API_KEY });
  assert.equal((await r.json()).proposals.some((p) => p.suggested_name === 'JunkCo'), false, 'rejected leaves the pending queue');
  r = await get('/api/v1/entities/proposed?status=rejected', { 'x-api-key': API_KEY });
  assert.ok((await r.json()).proposals.some((p) => p.suggested_name === 'JunkCo'), 'rejected proposal retained');

  // a hint WITHOUT suggested_kind must not stage anything
  await post('/api/v1/ingest', { source: 'documents', source_id: 'srv-plain', type: 'document', text_repr: 'PlainCo memo', entity_hints: [{ alias: 'PlainCo', alias_type: 'name', role: 'mentioned' }] }, { 'x-api-key': API_KEY });
  r = await get('/api/v1/entities/proposed?status=pending', { 'x-api-key': API_KEY });
  assert.equal((await r.json()).proposals.some((p) => p.suggested_name === 'PlainCo'), false, 'no proposal without suggested_kind');
});
