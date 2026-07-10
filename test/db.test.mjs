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
  insertEntityStmt, insertAliasStmt, mergeEntities, listProbableDuplicates, listContactPhotos,
  resolveEntityIds, getEntity, upsertEntityRelation,
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

// --- Entity merge & duplicate detection (#75) ---
const getRawEntityStmt = db.prepare('SELECT * FROM entities WHERE id = ?');
const lastMergeLogStmt = db.prepare("SELECT * FROM ingest_log WHERE event_type = 'entity_merged' ORDER BY id DESC LIMIT 1");

// A minimal person entity + its own self-linked contact artifact, mirroring what contacts.js
// produces (attrs carry emails[]/phones[] the same way structuredFields() does). `rawPath`
// mirrors #74's vCard PHOTO persistence (artifacts.raw_path) for #84's listContactPhotos tests.
function makePerson(name, { emails = [], phones = [], rawPath = null } = {}) {
  const entityId = Number(insertEntityStmt.run('person', name, JSON.stringify({ emails, phones })).lastInsertRowid);
  insertAliasStmt.run(entityId, name.toLowerCase(), 'name');
  for (const e of emails) insertAliasStmt.run(entityId, e.toLowerCase(), 'email');
  for (const p of phones) insertAliasStmt.run(entityId, p.replace(/\D/g, ''), 'phone');
  const { id: artifactId } = storeArtifactTxn(
    { type: 'contact', source: uniqueSource(), source_id: `contact-${entityId}`, text_repr: `${name} contact card`, raw_path: rawPath },
    f32(0.5),
    [{ entity_id: entityId, role: 'self', confidence: 1.0 }],
  );
  return { entityId, artifactId };
}

test('mergeEntities: tombstones the absorbed entity (never deletes) and re-points aliases/links to the survivor', () => {
  const keep = makePerson('Robert Smith', { emails: ['robert@example.com'] });
  const absorb = makePerson('Bob Smith', { emails: ['bob@old.example.com'] });

  const result = mergeEntities(keep.entityId, absorb.entityId);
  assert.deepEqual(result.moved, { aliases: 2, links: 1, relations: 0 }); // name + email alias, 1 self link

  const absorbedRow = getRawEntityStmt.get(absorb.entityId);
  assert.equal(absorbedRow.merged_into, keep.entityId, 'absorbed entity tombstoned, row still present (never deleted)');

  // An alias that lived only on the absorbed entity now resolves straight to the survivor.
  assert.deepEqual(resolveEntityIds('bob@old.example.com'), [keep.entityId]);
  assert.deepEqual(resolveEntityIds('bob smith'), [keep.entityId]);

  // The absorbed contact's own artifact link is re-pointed to the survivor entity.
  const artifact = getArtifactById(absorb.artifactId);
  assert.ok(artifact.links.some((l) => l.entity_id === keep.entityId && l.role === 'self'));
});

test('mergeEntities: logs an entity_merged ingest_log row with moved counts + absorbed attrs', () => {
  const keep = makePerson('Jane Doe', {});
  const absorb = makePerson('J. Doe', { emails: ['jane@old.example.com'] });
  mergeEntities(keep.entityId, absorb.entityId);

  const details = JSON.parse(lastMergeLogStmt.get().details);
  assert.equal(details.keep_id, keep.entityId);
  assert.equal(details.absorb_id, absorb.entityId);
  assert.equal(details.moved.aliases, 2);
  assert.deepEqual(details.absorbed_attrs.emails, ['jane@old.example.com']);
});

test('mergeEntities: self-merge throws SELF_MERGE and changes nothing', () => {
  const p = makePerson('Solo Person', {});
  assert.throws(() => mergeEntities(p.entityId, p.entityId), (err) => err.code === 'SELF_MERGE');
  assert.equal(getRawEntityStmt.get(p.entityId).merged_into, null);
});

test('mergeEntities: re-merging an already-tombstoned entity throws NOT_FOUND (idempotent-safe)', () => {
  const keep = makePerson('Keep Person', {});
  const absorb = makePerson('Absorb Person', {});
  mergeEntities(keep.entityId, absorb.entityId);

  const third = makePerson('Third Person', {});
  assert.throws(() => mergeEntities(third.entityId, absorb.entityId), (err) => err.code === 'NOT_FOUND');
});

test('mergeEntities: drops a direct keep<->absorb relation (no self-loop), excludes it from moved.relations, and repoints third-party relations', () => {
  const keep = makePerson('Keep Rel', {});
  const absorb = makePerson('Absorb Rel', {});
  const third = makePerson('Third Rel', {});
  upsertEntityRelation({ from_entity_id: keep.entityId, to_entity_id: absorb.entityId, relation_type: 'sibling', source: 'test' });
  upsertEntityRelation({ from_entity_id: third.entityId, to_entity_id: absorb.entityId, relation_type: 'friend', source: 'test' });

  const result = mergeEntities(keep.entityId, absorb.entityId);
  // The direct keep<->absorb edge is deleted, not moved — only the third-party relation
  // should be counted (moved.relations must not overstate what actually carried over).
  assert.equal(result.moved.relations, 1);

  const relations = db.prepare('SELECT * FROM entity_relations WHERE from_entity_id = ? OR to_entity_id = ?').all(keep.entityId, keep.entityId);
  assert.ok(!relations.some((r) => r.from_entity_id === r.to_entity_id), 'no self-loop relation survives the merge');
  assert.ok(
    relations.some((r) => r.from_entity_id === third.entityId && r.to_entity_id === keep.entityId && r.relation_type === 'friend'),
    'a third party\'s relation to the absorbed entity is re-pointed to the survivor'
  );
});

test('mergeEntities: an entity_links collision is deleted as a duplicate, never left orphaned pointing at the tombstoned id', () => {
  const keep = makePerson('Collision Keep', {});
  const absorb = makePerson('Collision Absorb', {});
  // Both entities separately linked as 'mentioned' to the same artifact — the exact collision
  // shape repointLinksStmt (a plain UPDATE, post-fix) cannot move without first deduping.
  const { id: sharedArtifactId } = storeArtifactTxn(
    { type: 'note', source: uniqueSource(), source_id: 'shared', text_repr: 'mentions both' },
    f32(0.5),
    [
      { entity_id: keep.entityId, role: 'mentioned', confidence: 0.7 },
      { entity_id: absorb.entityId, role: 'mentioned', confidence: 0.7 },
    ],
  );

  mergeEntities(keep.entityId, absorb.entityId);

  const rows = db.prepare('SELECT entity_id, role FROM entity_links WHERE artifact_id = ?').all(sharedArtifactId);
  assert.deepEqual(
    rows, [{ entity_id: keep.entityId, role: 'mentioned' }],
    'the colliding duplicate is deleted outright, not left dangling on the tombstoned absorb id'
  );
  // get_artifact/getArtifactById must never surface a stale link to the tombstoned entity.
  assert.ok(!getArtifactById(sharedArtifactId).links.some((l) => l.entity_id === absorb.entityId));
});

test('mergeEntities: an entity_relations collision (to-side) is deleted as a duplicate, never left orphaned', () => {
  const keep = makePerson('Rel Collision Keep', {});
  const absorb = makePerson('Rel Collision Absorb', {});
  const third = makePerson('Rel Collision Third', {});
  upsertEntityRelation({ from_entity_id: third.entityId, to_entity_id: keep.entityId, relation_type: 'friend', source: 'test' });
  upsertEntityRelation({ from_entity_id: third.entityId, to_entity_id: absorb.entityId, relation_type: 'friend', source: 'test' });

  mergeEntities(keep.entityId, absorb.entityId);

  const rows = db.prepare('SELECT from_entity_id, to_entity_id, relation_type FROM entity_relations WHERE from_entity_id = ?').all(third.entityId);
  assert.deepEqual(
    rows, [{ from_entity_id: third.entityId, to_entity_id: keep.entityId, relation_type: 'friend' }],
    'the colliding duplicate relation is deleted, not left pointing at the tombstoned absorb id'
  );
});

test('listProbableDuplicates: surfaces a shared-phone pair (contacts.js never auto-merges on phone) and excludes merged entities', () => {
  const a = makePerson('Duplicate One', { phones: ['(240) 997-4940'] });
  const b = makePerson('Duplicate Two', { phones: ['2409974940'] }); // same number, different formatting
  const unrelated = makePerson('Unrelated Person', { phones: ['5551234567'] });

  const pairs = listProbableDuplicates(50);
  const found = pairs.find((p) => [p.a.id, p.b.id].includes(a.entityId) && [p.a.id, p.b.id].includes(b.entityId));
  assert.ok(found, 'shared-phone pair surfaced');
  assert.match(found.reason, /shared phone/);
  assert.equal(pairs.filter((p) => [p.a.id, p.b.id].includes(unrelated.entityId)).length, 0, 'an unrelated phone number is not paired');

  mergeEntities(a.entityId, b.entityId);
  const after = listProbableDuplicates(50);
  assert.ok(!after.some((p) => p.a.id === b.entityId || p.b.id === b.entityId), 'the tombstoned entity is excluded from future duplicate listings');
});

test('listContactPhotos: only live person entities with a preserved contact photo (#84)', () => {
  const photographed = makePerson('Photographed Person', { rawPath: '/raw/contacts/aaa.jpg' });
  const noPhoto = makePerson('No Photo Person', {});
  const company = Number(insertEntityStmt.run('org', 'Acme Corp', JSON.stringify({})).lastInsertRowid);
  storeArtifactTxn(
    { type: 'contact', source: uniqueSource(), source_id: `contact-${company}`, text_repr: 'Acme Corp contact card', raw_path: '/raw/contacts/company.jpg' },
    f32(0.5),
    [{ entity_id: company, role: 'self', confidence: 1.0 }],
  );

  const photos = listContactPhotos(100);
  assert.ok(photos.some((p) => p.entity_id === photographed.entityId && p.raw_path === '/raw/contacts/aaa.jpg'));
  assert.ok(!photos.some((p) => p.entity_id === noPhoto.entityId), 'a contact with no preserved photo is excluded');
  assert.ok(!photos.some((p) => p.entity_id === company), 'a company entity is excluded even with a raw_path');

  // A merged-away (tombstoned) entity's photo must not be offered as a reference face either.
  const absorbTarget = makePerson('Merge Absorb Target', { rawPath: '/raw/contacts/bbb.jpg' });
  mergeEntities(photographed.entityId, absorbTarget.entityId);
  const afterMerge = listContactPhotos(100);
  assert.ok(!afterMerge.some((p) => p.entity_id === absorbTarget.entityId), 'a tombstoned entity is excluded from contact-photo listings');
});
