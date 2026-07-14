// The store's hard-won invariants (.claude/rules/data-model.md): BigInt vec0 PK, dedup,
// append-only preservation, the COALESCE upsert, the FTS delete-with-OLD-text trigger, vector
// dimension enforcement, and hint-confidence rules. No network — db.js doesn't import the
// embedder, so we bind Float32Array vectors directly. DB_PATH is pointed at a temp file BEFORE
// db.js is imported (it opens the DB at module load), so db.js is loaded dynamically here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { useTempDb, f32 } from './helpers.mjs';

const { cleanup } = useTempDb();
const {
  db, storeArtifactTxn, upsertArtifactTxn, resolveEntityHints, getArtifactById, annotateArtifactRows,
  insertEntityStmt, insertAliasStmt, mergeEntities, listProbableDuplicates, listContactPhotos,
  resolveEntityIds, getEntity, upsertEntityRelation, listEntities,
  addAlias, removeAlias, insertAliasUnlessTombstoned, normalizePhone,
  listProposedEntities, approveProposedEntity, rejectProposedEntity,
} = await import('../src/db.js');
const { backfillPhoneAliases } = await import('../scripts/backfill-phone-aliases.js');

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

// --- display_text handle annotation (#147) ---
test('display_text (#147): a linked handle in text_repr renders the contact name; text_repr stays raw; unlinked/absent left verbatim', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Amy Margaret Schneider', null).lastInsertRowid);
  // Alias stored under the canonical key (no +1, #129) — proves the lookup normalizes the +1 handle.
  insertAliasStmt.run(entityId, normalizePhone('+12406725399'), 'phone');
  const raw = 'Message from +12406725399: "call 5551234567 later"'; // second number is NOT a linked entity
  const { id } = storeArtifactTxn(
    { type: 'message', source: uniqueSource(), source_id: 'msg-147', text_repr: raw },
    f32(0.5),
    [{ entity_id: entityId, role: 'sender', confidence: 1.0 }],
  );
  const a = getArtifactById(id);
  assert.equal(a.text_repr, raw, 'stored text_repr is byte-for-byte unchanged (append-only)');
  assert.equal(
    a.display_text,
    'Message from Amy Margaret Schneider (+12406725399): "call 5551234567 later"',
    'the linked handle is renamed; the unlinked number in the body is left verbatim',
  );

  // No links -> display_text is just text_repr (no annotation, no crash).
  const { id: bare } = storeArtifactTxn(
    { type: 'note', source: uniqueSource(), source_id: 'note-147', text_repr: 'Message from +12406725399: "hi"' },
    f32(0.5),
  );
  assert.equal(getArtifactById(bare).display_text, 'Message from +12406725399: "hi"');
});

test('display_text (#147): email tokens resolve by email alias only — a digit-heavy email never matches a phone alias', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Dana Ortega', null).lastInsertRowid);
  insertAliasStmt.run(entityId, normalizePhone('+12565550111'), 'phone'); // canonical -> 2565550111
  insertAliasStmt.run(entityId, 'dana@example.com', 'email');
  // First email's digits (2565550111) equal Dana's phone; routing an email through the phone path
  // would mis-annotate it (Copilot, PR #148). Second email is Dana's real address and must annotate.
  const raw = 'Email from h2565550111@example.com; reply to dana@example.com';
  const { id } = storeArtifactTxn(
    { type: 'email', source: uniqueSource(), source_id: 'em-147', text_repr: raw },
    f32(0.5),
    [{ entity_id: entityId, role: 'sender', confidence: 1.0 }],
  );
  const d = getArtifactById(id).display_text;
  assert.ok(!d.includes('(h2565550111@example.com)'), 'a digit-heavy email must not match a phone alias');
  assert.equal(
    d,
    'Email from h2565550111@example.com; reply to Dana Ortega (dana@example.com)',
    'only the real email resolves, via its email alias',
  );
});

test('annotateArtifactRows (#149): batch-attaches display_text; linked row annotated, unlinked left raw; empty is safe', () => {
  const entityId = Number(insertEntityStmt.run('person', 'Bianca Lopez', null).lastInsertRowid);
  insertAliasStmt.run(entityId, normalizePhone('+12025550143'), 'phone');
  const { id: linked } = storeArtifactTxn(
    { type: 'message', source: uniqueSource(), source_id: 'ar-linked', text_repr: 'Message from +12025550143: "hi"' },
    f32(0.5),
    [{ entity_id: entityId, role: 'sender', confidence: 1.0 }],
  );
  const { id: unlinked } = storeArtifactTxn(
    { type: 'message', source: uniqueSource(), source_id: 'ar-unlinked', text_repr: 'Message from +19998887777: "yo"' },
    f32(0.5),
  );
  // Raw rows as timeline/about_entity fetch them — no links, no display_text until annotated.
  const rows = [
    { id: linked, text_repr: 'Message from +12025550143: "hi"' },
    { id: unlinked, text_repr: 'Message from +19998887777: "yo"' },
  ];
  const out = annotateArtifactRows(rows);
  assert.equal(out, rows, 'mutates and returns the same array');
  assert.equal(rows[0].display_text, 'Message from Bianca Lopez (+12025550143): "hi"');
  assert.equal(rows[1].display_text, 'Message from +19998887777: "yo"', 'unlinked handle left verbatim');
  assert.equal(annotateArtifactRows([]).length, 0, 'empty input is safe');
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
  assert.ok(photos.some((p) => p.entity_id === photographed.entityId && p.raw_path === path.resolve('/raw/contacts/aaa.jpg')));
  assert.ok(!photos.some((p) => p.entity_id === noPhoto.entityId), 'a contact with no preserved photo is excluded');
  assert.ok(!photos.some((p) => p.entity_id === company), 'a company entity is excluded even with a raw_path');

  // A merged-away (tombstoned) entity's photo must not be offered as a reference face either.
  const absorbTarget = makePerson('Merge Absorb Target', { rawPath: '/raw/contacts/bbb.jpg' });
  mergeEntities(photographed.entityId, absorbTarget.entityId);
  const afterMerge = listContactPhotos(100);
  assert.ok(!afterMerge.some((p) => p.entity_id === absorbTarget.entityId), 'a tombstoned entity is excluded from contact-photo listings');
});

test('listEntities: hasPhoto true for an imported raw_path OR an uploaded photoFile, false otherwise (#113)', () => {
  const imported = makePerson('Photo Imported Person', { rawPath: '/raw/contacts/imp.jpg' });
  // Uploaded-only: an entity with attrs.photoFile but a self-linked artifact WITHOUT a raw_path
  // (the #97 UI-upload shape) — has_photo (SQL, raw_path) is false, so hasPhoto must come from photoFile.
  const uploadedId = Number(insertEntityStmt.run('person', 'Photo Uploaded Person', JSON.stringify({ photoFile: 'abc123.jpg' })).lastInsertRowid);
  insertAliasStmt.run(uploadedId, 'photo uploaded person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: uniqueSource(), source_id: `contact-${uploadedId}`, text_repr: 'Photo Uploaded Person contact card' },
    f32(0.5), [{ entity_id: uploadedId, role: 'self', confidence: 1.0 }],
  );
  const none = makePerson('Photo None Person', {});

  const byId = new Map(listEntities({ limit: 500 }).map((e) => [e.id, e]));
  assert.equal(byId.get(imported.entityId)?.hasPhoto, true, 'imported raw_path -> hasPhoto true');
  assert.equal(byId.get(uploadedId)?.hasPhoto, true, 'uploaded attrs.photoFile -> hasPhoto true');
  assert.equal(byId.get(none.entityId)?.hasPhoto, false, 'no photo -> hasPhoto false');
});

test('listContactPhotos: dedups an entity with two self-linked photographed artifacts to one row, and resolves a relative raw_path to absolute (#84)', () => {
  // The ordinary multi-source-consolidation case: the same person imported from a second vCard
  // source under a different UID resolves to the same entity (contacts.js's resolveExistingEntity)
  // but creates a NEW self-linked contact artifact — this entity now has two role='self' links.
  const entityId = Number(insertEntityStmt.run('person', 'Multi Source Person', JSON.stringify({})).lastInsertRowid);
  insertAliasStmt.run(entityId, 'multi source person', 'name');
  storeArtifactTxn(
    { type: 'contact', source: uniqueSource(), source_id: 'first-import', text_repr: 'Multi Source Person (first)', raw_path: 'raw/contacts/first.jpg' },
    f32(0.5), [{ entity_id: entityId, role: 'self', confidence: 1.0 }],
  );
  storeArtifactTxn(
    { type: 'contact', source: uniqueSource(), source_id: 'second-import', text_repr: 'Multi Source Person (second)', raw_path: 'raw/contacts/second.jpg' },
    f32(0.5), [{ entity_id: entityId, role: 'self', confidence: 1.0 }],
  );

  const rows = listContactPhotos(100).filter((p) => p.entity_id === entityId);
  assert.equal(rows.length, 1, 'exactly one row per entity, even with two self-linked photographed artifacts');
  assert.ok(rows[0].raw_path.split(path.sep).join('/').endsWith('raw/contacts/second.jpg'), 'the most recently created contact artifact\'s photo wins');
  assert.ok(path.isAbsolute(rows[0].raw_path), 'a relative raw_path (CONTACTS_RAW_DIR default) is resolved to an absolute path');
});

test('schema (#110): foreign_keys pragma is ON', () => {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('schema (#110): the tightened columns are NOT NULL in table_info', () => {
  const notnull = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().find((x) => x.name === c)?.notnull;
  assert.equal(notnull('entity_aliases', 'entity_id'), 1);
  assert.equal(notnull('entity_aliases', 'alias_type'), 1);
  assert.equal(notnull('entity_links', 'role'), 1);
  assert.equal(notnull('unresolved_aliases', 'alias_type'), 1);
  assert.equal(notnull('unresolved_aliases', 'role'), 1);
});

test('schema (#110): FK enforced — an alias/link/relation referencing a nonexistent entity throws', () => {
  const person = makePerson('FK Guard Person');
  assert.throws(() => db.prepare('INSERT INTO entity_aliases (entity_id, alias, alias_type) VALUES (?, ?, ?)').run(9_999_999, 'ghost alias', 'name'), /FOREIGN KEY|foreign key/i);
  assert.throws(() => db.prepare('INSERT INTO entity_links (artifact_id, entity_id, role) VALUES (?, ?, ?)').run(person.artifactId, 9_999_999, 'mentioned'), /FOREIGN KEY|foreign key/i);
  assert.throws(() => db.prepare('INSERT INTO entity_relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)').run(person.entityId, 9_999_999, 'spouse'), /FOREIGN KEY|foreign key/i);
});

test('schema (#110): NOT NULL enforced — a NULL-role entity_links insert throws (was silently allowed)', () => {
  const person = makePerson('Null Role Person');
  assert.throws(() => db.prepare('INSERT INTO entity_links (artifact_id, entity_id, role) VALUES (?, ?, ?)').run(person.artifactId, person.entityId, null), /NOT NULL/i);
});

test('schema (#110): a born-tight, clean DB logs no not_null rebuild and no integrity violations', () => {
  const rows = db.prepare("SELECT details FROM ingest_log WHERE event_type IN ('schema_migration','integrity_check')").all();
  assert.ok(!rows.some((r) => /not_null/.test(r.details || '')), 'no NOT NULL rebuild on a DB born tight from CREATE TABLE');
  assert.ok(!rows.some((r) => { try { return (JSON.parse(r.details).foreign_key_violations || []).length > 0; } catch { return false; } }), 'no FK violations logged on a clean DB');
});

test('schema (#110): storeArtifactTxn throws (not silently drops) a link missing role', () => {
  const e = Number(insertEntityStmt.run('person', 'Roleless Link Person', null).lastInsertRowid);
  assert.throws(
    () => storeArtifactTxn({ type: 'note', source: uniqueSource(), text_repr: 'roleless link' }, f32(0.4), [{ entity_id: e }]),
    /link requires entity_id and role/,
  );
});

test('alias tombstone (#111): removeAlias tombstones; additive re-add suppressed; explicit addAlias clears', () => {
  const e = Number(insertEntityStmt.run('person', 'Tombstone Person', null).lastInsertRowid);
  addAlias(e, 'betsy', 'name');
  assert.ok(resolveEntityIds('betsy').includes(e), 'alias resolves after add');
  removeAlias(e, 'betsy', 'name');
  assert.ok(!resolveEntityIds('betsy').includes(e), 'removed alias no longer resolves');
  // simulate an import/re-import/edit/hint trying to re-add it → suppressed by the tombstone
  assert.equal(insertAliasUnlessTombstoned(e, 'betsy', 'name'), 0, 'additive re-add is a no-op');
  assert.ok(!resolveEntityIds('betsy').includes(e), 'still not resolvable after an additive attempt');
  // explicit user re-add overrides: clears the tombstone and inserts
  addAlias(e, 'betsy', 'name');
  assert.ok(resolveEntityIds('betsy').includes(e), 'explicit addAlias overrides the tombstone');
  // tombstone cleared → a later additive insert is allowed again (dup here, but not suppressed)
  removeAlias(e, 'betsy', 'name');
  addAlias(e, 'betsy', 'name');
  assert.ok(resolveEntityIds('betsy').includes(e), 're-removal then re-add works (tombstone lifecycle)');
});

test('alias tombstone (#111): scoped per entity — a tombstone on one entity does not suppress another', () => {
  const a = Number(insertEntityStmt.run('person', 'Chris One', null).lastInsertRowid);
  const b = Number(insertEntityStmt.run('person', 'Chris Two', null).lastInsertRowid);
  addAlias(a, 'chrisx', 'handle');
  removeAlias(a, 'chrisx', 'handle'); // tombstone on a only
  assert.equal(insertAliasUnlessTombstoned(a, 'chrisx', 'handle'), 0, 'suppressed on the tombstoned entity');
  assert.equal(insertAliasUnlessTombstoned(b, 'chrisx', 'handle'), 1, 'allowed on a different entity');
  assert.ok(resolveEntityIds('chrisx').includes(b));
});

test('alias tombstone (#111): tombstone insert is idempotent (re-removal adds 0 rows)', () => {
  const e = Number(insertEntityStmt.run('person', 'Idem Tombstone', null).lastInsertRowid);
  addAlias(e, 'idemtomb', 'handle');
  removeAlias(e, 'idemtomb', 'handle');
  removeAlias(e, 'idemtomb', 'handle'); // second removal — OR IGNORE, no duplicate
  const n = db.prepare('SELECT COUNT(*) AS n FROM alias_tombstones WHERE entity_id = ? AND alias = ? AND alias_type = ?').get(e, 'idemtomb', 'handle').n;
  assert.equal(n, 1, 'exactly one tombstone row despite two removals');
});

// --- Proposed entities (#119): the human-approval gate for entities auto-proposed from artifacts ---
const orgHint = (name) => [{ alias: name, alias_type: 'name', role: 'mentioned', suggested_kind: 'org' }];

test('proposed entities (#119): an unmatched hint with suggested_kind stages a proposal and mints nothing', () => {
  const source = uniqueSource();
  const { id } = upsertArtifactTxn(
    { type: 'document', source, source_id: 'receipt-1', text_repr: 'ACME Hardware receipt' },
    f32(0.5), orgHint('ACME Hardware'),
  );
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'ACME Hardware');
  assert.ok(p, 'a pending proposal was staged');
  assert.equal(p.suggested_kind, 'org');
  assert.equal(resolveEntityIds('ACME Hardware').length, 0, 'no entity was minted');
  assert.equal(getArtifactById(id).links.length, 0, 'no link formed yet');
});

test('proposed entities (#119): a hint WITHOUT suggested_kind stages no proposal', () => {
  const source = uniqueSource();
  upsertArtifactTxn(
    { type: 'document', source, source_id: 'nokind', text_repr: 'no-kind hint' },
    f32(0.5), [{ alias: 'NoKind Inc', alias_type: 'name', role: 'mentioned' }],
  );
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.suggested_name === 'NoKind Inc'), false);
});

test('proposed entities (#119): a matching hint links and ignores suggested_kind (no proposal)', () => {
  const eid = Number(insertEntityStmt.run('org', 'Existing Org', '{}').lastInsertRowid);
  insertAliasStmt.run(eid, 'existing org', 'name'); // normalized name alias
  const source = uniqueSource();
  const { id } = upsertArtifactTxn(
    { type: 'document', source, source_id: 'match', text_repr: 'doc mentioning existing org' },
    f32(0.5), orgHint('Existing Org'),
  );
  assert.ok(getArtifactById(id).links.some((l) => l.entity_id === eid), 'linked to the existing entity');
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.suggested_name === 'Existing Org'), false);
});

test('proposed entities (#119): approve creates the entity and retroactively links the staged artifact', () => {
  const source = uniqueSource();
  const { id } = upsertArtifactTxn(
    { type: 'document', source, source_id: 'receipt-2', text_repr: 'BetaCorp invoice' },
    f32(0.5), orgHint('BetaCorp'),
  );
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'BetaCorp');
  const { entity_id } = approveProposedEntity(p.id);
  assert.ok(entity_id > 0);
  assert.equal(getEntity(entity_id).kind, 'org', 'created as an org');
  assert.ok(getArtifactById(id).links.some((l) => l.entity_id === entity_id), 'staged artifact linked on approve');
  const approved = listProposedEntities('approved', 1000).find((x) => x.id === p.id);
  assert.ok(approved && approved.resolved_entity_id === entity_id, 'proposal marked approved + resolved');
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.id === p.id), false, 'no longer pending');
});

test('proposed entities (#119): re-ingesting the same artifact stages no duplicate proposal', () => {
  const source = uniqueSource();
  upsertArtifactTxn({ type: 'document', source, source_id: 'gamma', text_repr: 'GammaLLC one' }, f32(0.50), orgHint('GammaLLC'));
  const after1 = listProposedEntities('pending', 1000).filter((x) => x.suggested_name === 'GammaLLC').length;
  upsertArtifactTxn({ type: 'document', source, source_id: 'gamma', text_repr: 'GammaLLC two' }, f32(0.51), orgHint('GammaLLC'));
  const after2 = listProposedEntities('pending', 1000).filter((x) => x.suggested_name === 'GammaLLC').length;
  assert.equal(after1, 1);
  assert.equal(after2, 1, 're-ingest is idempotent — no duplicate proposal');
});

test('proposed entities (#119): reject retains the proposal (rejected) and mints nothing', () => {
  const source = uniqueSource();
  upsertArtifactTxn({ type: 'document', source, source_id: 'spam', text_repr: 'SpamCo ad' }, f32(0.5), orgHint('SpamCo'));
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'SpamCo');
  rejectProposedEntity(p.id);
  assert.equal(resolveEntityIds('SpamCo').length, 0, 'no entity minted on reject');
  assert.ok(listProposedEntities('rejected', 1000).some((x) => x.id === p.id), 'proposal retained as rejected');
  assert.equal(listProposedEntities('pending', 1000).some((x) => x.id === p.id), false, 'not in the pending queue');
});

test('proposed entities (#119): approve is not repeatable (already-resolved throws)', () => {
  const source = uniqueSource();
  const { id } = upsertArtifactTxn({ type: 'document', source, source_id: 'dupapprove', text_repr: 'DeltaCo bill' }, f32(0.5), orgHint('DeltaCo'));
  const p = listProposedEntities('pending', 1000).find((x) => x.suggested_name === 'DeltaCo');
  approveProposedEntity(p.id);
  assert.throws(() => approveProposedEntity(p.id), /already approved/);
  assert.throws(() => rejectProposedEntity(p.id), /already approved/, 'cannot reject an approved proposal');
  assert.ok(id > 0);
});

test('normalizePhone (#129): US +1 and bare 10-digit collapse to one key; non-NANP untouched', () => {
  assert.equal(normalizePhone('+1 (256) 468-0130'), '2564680130', 'US +1 with punctuation → 10-digit key');
  assert.equal(normalizePhone('1-256-468-0130'), '2564680130', 'leading 1, no + → 10-digit key');
  assert.equal(normalizePhone('(256) 468-0130'), '2564680130', 'bare 10-digit unchanged');
  assert.equal(normalizePhone('+44 20 7946 0958'), '442079460958', 'non-NANP international is NOT stripped');
  assert.equal(normalizePhone('468-0130'), '4680130', '7-digit local is unchanged (leading 1-strip does not apply)');
});

test('normalizePhone (#129): a contact aliased +1 resolves from the bare-10-digit form and vice versa', () => {
  const a = Number(insertEntityStmt.run('person', 'Plus One', null).lastInsertRowid);
  insertAliasUnlessTombstoned(a, normalizePhone('+12564680130'), 'phone'); // aliased in +1 form
  assert.ok(resolveEntityIds('(256) 468-0130').includes(a), '+1-aliased contact resolves from bare 10-digit lookup');

  const b = Number(insertEntityStmt.run('person', 'Bare Ten', null).lastInsertRowid);
  insertAliasUnlessTombstoned(b, normalizePhone('(415) 555-0130'), 'phone'); // aliased in bare form
  assert.ok(resolveEntityIds('+1 415 555 0130').includes(b), 'bare-aliased contact resolves from +1 lookup');
});

test('backfill:phones (#129): re-aliases an old +1 key under the canonical key, and flags a cross-entity collision', () => {
  // Simulate pre-change data by inserting the raw 11-digit key directly (bypassing normalizePhone).
  const solo = Number(insertEntityStmt.run('person', 'Solo Backfill', null).lastInsertRowid);
  insertAliasStmt.run(solo, '17776665555', 'phone'); // old digit-strip-only form, no competitor
  const owner = Number(insertEntityStmt.run('person', 'Canon Owner', null).lastInsertRowid);
  insertAliasStmt.run(owner, '8887776666', 'phone'); // already-canonical form
  const loser = Number(insertEntityStmt.run('person', 'Old Form Loser', null).lastInsertRowid);
  insertAliasStmt.run(loser, '18887776666', 'phone'); // same number as owner, but +1 form

  const s = backfillPhoneAliases();

  // Solo: canonical key added, now resolvable from either form.
  assert.ok(resolveEntityIds('(777) 666-5555').includes(solo), 'solo old-form number resolves under the canonical key after backfill');
  // Loser: its canonical key is owned by `owner`, so the add is suppressed and reported as a collision.
  assert.ok(
    s.collisionDetails.some((c) => c.canonical === '8887776666' && c.loser === loser && c.owner === owner),
    'the cross-entity canonical collision is surfaced in collisionDetails',
  );

  const s2 = backfillPhoneAliases(); // idempotent
  assert.equal(s2.aliasesAdded, 0, 'second run adds no new canonical aliases (every alias is now canonical)');
  assert.ok(
    s2.collisionDetails.some((c) => c.canonical === '8887776666' && c.loser === loser && c.owner === owner),
    'the collision is still reported on rerun — the loser still cannot claim the owner-held key',
  );
});

test('backfill:phones (#129): a canonical key tombstoned for this entity is NOT a false-positive collision (Copilot #131)', () => {
  // Entity T deliberately removed the canonical key (#111 tombstone) but still holds the old +1 form;
  // entity O owns the canonical key. The backfill must treat T's suppressed add as a removal, not a
  // cross-entity collision — else it would wrongly report "unreachable until merged".
  const t = Number(insertEntityStmt.run('person', 'Tomb Loser', null).lastInsertRowid);
  insertAliasStmt.run(t, '15554443333', 'phone');    // old +1 form, still on T
  addAlias(t, '5554443333', 'phone');                // T had the canonical key...
  removeAlias(t, '5554443333', 'phone');             // ...then removed it → tombstone on T, row deleted
  const owner = Number(insertEntityStmt.run('person', 'Tomb Owner', null).lastInsertRowid);
  insertAliasStmt.run(owner, '5554443333', 'phone'); // NOW O claims the canonical key (T freed it)

  const s = backfillPhoneAliases();
  assert.ok(
    !s.collisionDetails.some((c) => c.loser === t && c.canonical === '5554443333'),
    'a tombstoned canonical key is not reported as a cross-entity collision',
  );
});
