// The store's hard-won invariants (.claude/rules/data-model.md): BigInt vec0 PK, dedup,
// append-only preservation, the COALESCE upsert, the FTS delete-with-OLD-text trigger, vector
// dimension enforcement, and hint-confidence rules. No network — db.js doesn't import the
// embedder, so we bind Float32Array vectors directly. DB_PATH is pointed at a temp file BEFORE
// db.js is imported (it opens the DB at module load), so db.js is loaded dynamically here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, f32 } from './helpers.mjs';

const { cleanup } = useTempDb();
const {
  db, storeArtifactTxn, upsertArtifactTxn, resolveEntityHints, getArtifactById,
  insertEntityStmt, insertAliasStmt,
} = await import('../src/db.js');

after(() => { db.close(); cleanup(); });

const knnStmt = db.prepare('SELECT artifact_id, distance FROM vec_artifacts WHERE embedding MATCH ? AND k = ?');
const ftsStmt = db.prepare('SELECT rowid FROM artifacts_fts WHERE artifacts_fts MATCH ?');
const countVecStmt = db.prepare('SELECT COUNT(*) AS n FROM vec_artifacts WHERE artifact_id = ?');

let seq = 0;
const uniqueSource = () => `test-${++seq}`;

test('storeArtifactTxn: create stores a rank-ordered vector under the right id (BigInt vec0 PK)', () => {
  // If the internal BigInt(id) cast regressed to a plain Number, insertVecArtifactStmt would
  // throw "Only integers are allowed for primary key values" and this store would fail.
  const near = storeArtifactTxn(
    { type: 'note', source: uniqueSource(), source_id: 'near', text_repr: 'a near memory' },
    f32(0.2),
  );
  const far = storeArtifactTxn(
    { type: 'note', source: uniqueSource(), source_id: 'far', text_repr: 'a far memory' },
    f32(0.8),
  );
  assert.equal(near.deduped, false);
  assert.equal(typeof near.id, 'number');
  // Query near f32(0.2): the near artifact must rank ahead of the far one. Ranking (not mere
  // membership) proves the vector was stored under the correct artifact id, not just inserted.
  const ranked = knnStmt.all(f32(0.2), 10).map((r) => r.artifact_id);
  assert.ok(ranked.includes(near.id) && ranked.includes(far.id), 'both vectors are KNN-queryable');
  assert.ok(ranked.indexOf(near.id) < ranked.indexOf(far.id), 'the nearer vector ranks first');
});

test('storeArtifactTxn: duplicate (source, source_id) dedups without a second vector row', () => {
  const source = uniqueSource();
  const a = storeArtifactTxn({ type: 'note', source, source_id: 'dup', text_repr: 'first' }, f32(0.3));
  const b = storeArtifactTxn({ type: 'note', source, source_id: 'dup', text_repr: 'second' }, f32(0.4));
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  assert.equal(b.id, a.id, 'dedup returns the existing id');
  assert.equal(countVecStmt.get(a.id).n, 1, 'no second vector row inserted on dedup');
});

test('upsertArtifactTxn: create path requires an embedding vector', () => {
  assert.throws(
    () => upsertArtifactTxn({ type: 'note', source: uniqueSource(), source_id: 'x', text_repr: 't' }, null),
    /requires an embedding vector/,
  );
});

test('upsertArtifactTxn: update rewrites text_repr but preserves append-only originals', () => {
  const source = uniqueSource();
  const hash = 'a'.repeat(64);
  const created = upsertArtifactTxn(
    { type: 'note', source, source_id: '1', text_repr: 'original text', content_hash: hash, raw_path: '/raw/original' },
    f32(0.5),
  );
  assert.equal(created.created, true);
  const before = getArtifactById(created.id);

  // The update deliberately sends a DIFFERENT content_hash/raw_path: if either were ever added to
  // db.js's MUTABLE_FIELDS (regressing the append-only-originals rule), the stored value would
  // change and the assertions below would fail. Omitting them would make preservation trivially
  // true (absent → COALESCE keeps the old value) and catch no such regression.
  const updated = upsertArtifactTxn(
    { type: 'note', source, source_id: '1', text_repr: 'revised text', content_hash: 'b'.repeat(64), raw_path: '/raw/CHANGED' },
    f32(0.6),
  );
  assert.equal(updated.created, false);
  const after = getArtifactById(created.id);
  assert.equal(after.text_repr, 'revised text', 'derived text_repr is rewritten');
  assert.equal(after.content_hash, hash, 'content_hash (original) is never overwritten');
  assert.equal(after.raw_path, '/raw/original', 'raw_path (original) is never overwritten');
  assert.equal(after.ingested_at, before.ingested_at, 'ingested_at (first-ingest time) is frozen');
});

test('upsertArtifactTxn: metadata-only update keeps prior text_repr (COALESCE of absent field)', () => {
  const source = uniqueSource();
  const { id } = upsertArtifactTxn(
    { type: 'note', source, source_id: '1', text_repr: 'keep me' },
    f32(0.5),
  );
  // No text_repr, no vector — only a metadata field changes.
  upsertArtifactTxn({ type: 'note', source, source_id: '1', place_label: 'Berlin' }, null);
  const a = getArtifactById(id);
  assert.equal(a.text_repr, 'keep me', 'absent text_repr must not be wiped');
  assert.equal(a.place_label, 'Berlin', 'present metadata field is applied');
});

test('FTS stays in sync on update: OLD terms are removed, NEW terms are searchable', () => {
  const source = uniqueSource();
  const { id } = upsertArtifactTxn(
    { type: 'note', source, source_id: '1', text_repr: 'the zebrafish swims' },
    f32(0.5),
  );
  assert.ok(ftsStmt.all('zebrafish').some((r) => r.rowid === id), 'new row is indexed on insert');

  upsertArtifactTxn({ type: 'note', source, source_id: '1', text_repr: 'the quokka hops' }, f32(0.6));
  // If artifacts_au's 'delete' stopped carrying the OLD text_repr, 'zebrafish' would linger.
  assert.equal(ftsStmt.all('zebrafish').length, 0, 'old term is removed from the FTS index');
  assert.ok(ftsStmt.all('quokka').some((r) => r.rowid === id), 'new term is searchable');
});

test('vec_artifacts enforces VECTOR_DIMENSION (wrong-length vector is rejected)', () => {
  const insertVec = db.prepare('INSERT INTO vec_artifacts (artifact_id, embedding) VALUES (?, ?)');
  assert.throws(() => insertVec.run(BigInt(999_999), new Float32Array(512)));
});

test('resolveEntityHints: deterministic types earn 1.0, name/handle are capped, and re-submit is idempotent', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Ada Lovelace', null).lastInsertRowid);
  insertAliasStmt.run(entityId, 'ada@example.com', 'email');
  insertAliasStmt.run(entityId, 'ada lovelace', 'name');

  const { id } = storeArtifactTxn(
    { type: 'note', source: uniqueSource(), source_id: '1', text_repr: 'note about ada' },
    f32(0.5),
  );

  // Distinct roles so both links persist (entity_links PK is (artifact_id, entity_id, role) —
  // same role to the same entity would collide). email supplies 0.5 but a deterministic type is
  // forced to 1.0; name supplies 0.99, capped at 0.9.
  const hints = [
    { alias: 'ada@example.com', alias_type: 'email', role: 'sender', confidence: 0.5 },
    { alias: 'Ada Lovelace', alias_type: 'name', role: 'mentioned', confidence: 0.99 },
  ];
  const r = resolveEntityHints(id, hints);
  assert.equal(r.resolved, 2);

  const byRole = Object.fromEntries(getArtifactById(id).links.map((l) => [l.role, l.confidence]));
  assert.equal(byRole.sender, 1, 'deterministic (email) hint linked at confidence 1.0');
  assert.equal(byRole.mentioned, 0.9, 'name hint capped at confidence 0.9');

  // Re-submitting the identical hints stages zero new links (entity_links PK + OR IGNORE).
  const linksBefore = getArtifactById(id).links.length;
  resolveEntityHints(id, hints);
  assert.equal(getArtifactById(id).links.length, linksBefore, 'idempotent — no duplicate links');
});
