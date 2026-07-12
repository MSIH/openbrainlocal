// Contacts import (#74): vCard PHOTO preservation. Covers the pure parser (parsePhoto), the
// I/O layer (persistContactPhoto — decode/write, idempotency, malformed-input handling), and
// the end-to-end importContacts path (raw_path/extra_json on the stored artifact, no
// regression for photo-less cards). DB_PATH, OLLAMA_BASE_URL, and CONTACTS_RAW_DIR are all set
// BEFORE contacts.js (which imports db.js/config.js/embeddings.js) is loaded.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useTempDb, startFakeOllama } from './helpers.mjs';

const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;
const rawDir = mkdtempSync(path.join(tmpdir(), 'lc-test-contacts-raw-'));
process.env.CONTACTS_RAW_DIR = rawDir;

const { parsePhoto, persistContactPhoto, importContacts, parseVCards, contactTextRepr } = await import('../src/contacts.js');
const { db, getArtifactById, nameVariants } = await import('../src/db.js');

after(async () => { db.close(); await fake.close(); cleanup(); rmSync(rawDir, { recursive: true, force: true }); });

const PHOTO_BYTES = Buffer.from('hello-world-photo-bytes');
const PHOTO_B64 = PHOTO_BYTES.toString('base64');

const vcard = (body) => `BEGIN:VCARD\nVERSION:3.0\n${body}\nEND:VCARD\n`;

test('parsePhoto: vCard 3.0 inline base64 (ENCODING=b + TYPE)', () => {
  const p = parsePhoto(PHOTO_B64, [{ key: 'ENCODING', value: 'b' }, { key: 'TYPE', value: 'JPEG' }]);
  assert.deepEqual(p, { kind: 'base64', data: PHOTO_B64, mediaType: 'image/jpeg', ext: 'jpg' });
});

test('parsePhoto: vCard 4.0 data: URI', () => {
  const p = parsePhoto(`data:image/png;base64,${PHOTO_B64}`, []);
  assert.equal(p.kind, 'base64');
  assert.equal(p.data, PHOTO_B64);
  assert.equal(p.ext, 'png');
});

test('parsePhoto: external http(s) URI', () => {
  const p = parsePhoto('https://example.com/photo.jpg', [{ key: 'TYPE', value: 'JPEG' }]);
  assert.deepEqual(p, { kind: 'uri', url: 'https://example.com/photo.jpg', mediaType: 'image/jpeg' });
});

test('parsePhoto: unrecognized shape returns null (photo silently absent)', () => {
  assert.equal(parsePhoto('some-unrecognized-value', []), null);
});

test('parsePhoto: vCard 4.0 data: URI tolerates an extra ;param=value segment (e.g. ;charset=) before ;base64,', () => {
  const p = parsePhoto(`data:image/png;charset=binary;base64,${PHOTO_B64}`, []);
  assert.equal(p.kind, 'base64');
  assert.equal(p.data, PHOTO_B64);
  assert.equal(p.mediaType, 'image/png');
  assert.equal(p.ext, 'png');
});

test('parsePhoto: unrecognized image subtype (e.g. HEIC) falls back to its own subtype as the file extension', () => {
  const p = parsePhoto(PHOTO_B64, [{ key: 'ENCODING', value: 'b' }, { key: 'MEDIATYPE', value: 'image/heic' }]);
  assert.equal(p.mediaType, 'image/heic');
  assert.equal(p.ext, 'heic');
});

test('persistContactPhoto: base64 -> content-addressed file under CONTACTS_RAW_DIR', () => {
  const result = persistContactPhoto({ kind: 'base64', data: PHOTO_B64, mediaType: 'image/jpeg', ext: 'jpg' });
  assert.ok(result.raw_path.startsWith(rawDir));
  assert.ok(existsSync(result.raw_path));
  assert.deepEqual(readFileSync(result.raw_path), PHOTO_BYTES);
});

test('persistContactPhoto: idempotent — same bytes write the same path, second call is a no-op write', () => {
  const a = persistContactPhoto({ kind: 'base64', data: PHOTO_B64, mediaType: 'image/jpeg', ext: 'jpg' });
  const b = persistContactPhoto({ kind: 'base64', data: PHOTO_B64, mediaType: 'image/jpeg', ext: 'jpg' });
  assert.equal(a.raw_path, b.raw_path);
});

test('persistContactPhoto: external URI is recorded but never fetched (no raw_path)', () => {
  const result = persistContactPhoto({ kind: 'uri', url: 'https://example.com/p.jpg', mediaType: 'image/jpeg' });
  assert.deepEqual(result, { photo_url: 'https://example.com/p.jpg', media_type: 'image/jpeg' });
});

test('persistContactPhoto: a malicious ext (path traversal) is rejected, falls back to a safe extension', () => {
  // This function is exported and takes a raw descriptor — parsePhoto always hands it a
  // sanitized ext, but persistContactPhoto must not trust that on its own (a future/direct
  // caller could pass anything). "../../x" must never escape CONTACTS_RAW_DIR.
  const result = persistContactPhoto({ kind: 'base64', data: PHOTO_B64, mediaType: 'image/jpeg', ext: '../../../../etc/passwd' });
  assert.ok(result.raw_path.startsWith(rawDir), 'the written path must stay inside CONTACTS_RAW_DIR');
  assert.ok(result.raw_path.endsWith('.jpg'), 'an invalid ext falls back to the safe default');
  assert.ok(existsSync(result.raw_path));
});

test('persistContactPhoto: malformed base64 logs and returns null, never throws', () => {
  const originalError = console.error;
  let logged = false;
  console.error = () => { logged = true; };
  try {
    const result = persistContactPhoto({ kind: 'base64', data: '!!!not-valid-base64!!!', ext: 'jpg' });
    assert.equal(result, null);
  } finally {
    console.error = originalError;
  }
  assert.equal(logged, true, 'a decode failure is logged, never swallowed');
});

test('persistContactPhoto: truncated base64 (length not a multiple of 4) is rejected, not silently decoded into corrupt bytes', () => {
  const truncated = PHOTO_B64.slice(0, PHOTO_B64.length - 1); // chop one char off a valid, padded b64 string
  const originalError = console.error;
  let logged = false;
  console.error = () => { logged = true; };
  let result;
  try {
    result = persistContactPhoto({ kind: 'base64', data: truncated, ext: 'jpg' });
  } finally {
    console.error = originalError;
  }
  assert.equal(result, null, 'truncated base64 must not decode into a corrupt file');
  assert.equal(logged, true);
});

test('persistContactPhoto: null descriptor (no PHOTO) is a no-op', () => {
  assert.equal(persistContactPhoto(null), null);
});

test('importContacts: inline base64 PHOTO ends up as the contact artifact raw_path + extra_json.photo', async () => {
  const text = vcard(`FN:Photo Person\nEMAIL:photo.person@example.com\nPHOTO;ENCODING=b;TYPE=JPEG:${PHOTO_B64}`);
  const summary = await importContacts(text);
  assert.equal(summary.artifacts, 1);
  assert.equal(summary.photos, 1);

  const row = db.prepare("SELECT id FROM artifacts WHERE source = 'vcard' AND text_repr LIKE 'Photo Person%'").get();
  const artifact = getArtifactById(row.id);
  assert.ok(artifact.raw_path && existsSync(artifact.raw_path));
  assert.deepEqual(readFileSync(artifact.raw_path), PHOTO_BYTES);
  assert.equal(artifact.extra.photo.media_type, 'image/jpeg');
  assert.equal(artifact.extra.photo.raw_path, artifact.raw_path);
});

test('importContacts: card with no PHOTO imports unchanged (no regression)', async () => {
  const text = vcard('FN:No Photo Person\nEMAIL:no.photo@example.com');
  const summary = await importContacts(text);
  assert.equal(summary.artifacts, 1);
  assert.equal(summary.photos, 0);

  const row = db.prepare("SELECT id FROM artifacts WHERE source = 'vcard' AND text_repr LIKE 'No Photo Person%'").get();
  const artifact = getArtifactById(row.id);
  assert.equal(artifact.raw_path, null);
  assert.equal(artifact.extra.photo, undefined);
});

test('importContacts: malformed PHOTO does not abort the contact import', async () => {
  const text = vcard(`FN:Bad Photo Person\nEMAIL:bad.photo@example.com\nPHOTO;ENCODING=b;TYPE=JPEG:!!!not-valid-base64!!!`);
  const originalError = console.error;
  console.error = () => {};
  let summary;
  try { summary = await importContacts(text); } finally { console.error = originalError; }
  assert.equal(summary.artifacts, 1, 'contact still imports despite the bad photo');
  assert.equal(summary.photos, 0);

  const row = db.prepare("SELECT id FROM artifacts WHERE source = 'vcard' AND text_repr LIKE 'Bad Photo Person%'").get();
  assert.equal(getArtifactById(row.id).raw_path, null);
});

test('importContacts: re-import is idempotent — no duplicate artifact, no duplicate photo write', async () => {
  const text = vcard(`FN:Repeat Person\nEMAIL:repeat.person@example.com\nPHOTO;ENCODING=b;TYPE=JPEG:${PHOTO_B64}`);
  const first = await importContacts(text);
  const second = await importContacts(text);
  assert.equal(first.artifacts, 1);
  assert.equal(second.artifacts, 0);
  assert.equal(second.skipped, 1);

  const rows = db.prepare("SELECT id FROM artifacts WHERE source = 'vcard' AND text_repr LIKE 'Repeat Person%'").all();
  assert.equal(rows.length, 1, 'no duplicate artifact on re-import');
});

// --- Entity resolution: name-variant aliases + X-* relationship parsing (#93) ---

test('parseVCards: Google/Android X-SPOUSE / X-CHILD parse into relatedNames with a canonical-able type', () => {
  const [c] = parseVCards(vcard('FN:Rel Parser\nX-SPOUSE:Some Spouse\nX-CHILD:Some Kid\nX-MANAGER:The Boss'));
  assert.deepEqual(c.relatedNames, [
    { type: 'spouse', name: 'Some Spouse' },
    { type: 'child', name: 'Some Kid' },
    { type: 'manager', name: 'The Boss' },
  ]);
});

test('contactTextRepr: embeds ALL addresses (not just the last), de-duped, empties dropped (#92)', () => {
  const [c] = parseVCards(vcard(
    'FN:Multi Addr\n' +
    'ADR;TYPE=HOME:;;12 Barkwood Court;Rockville;MD;20850;US\n' +
    'ADR;TYPE=WORK:;;9 Nicholson Lane;Rockville;MD;20852;US\n' +
    'ADR;TYPE=HOME:;;12 Barkwood Court;Rockville;MD;20850;US\n' +   // exact dup of the first
    'ADR;TYPE=OTHER:;;;;;;'                                          // empty ADR -> flattens to ''
  ));
  const text = contactTextRepr(c);
  assert.match(text, /Barkwood Court/);                              // non-last address present
  assert.match(text, /Nicholson Lane/);                              // last address present
  assert.equal((text.match(/Barkwood Court/g) || []).length, 1);     // de-duped
  assert.doesNotMatch(text, /Address: ;|; ;|; \./);                  // no bare/empty entry from the empty ADR
});

test('contactTextRepr: single address is unchanged (regression) and no address emits no Address line', () => {
  const [one] = parseVCards(vcard('FN:One Addr\nADR;TYPE=HOME:;;5013 Russett Rd;Rockville;MD;20853;US'));
  assert.match(contactTextRepr(one), /Address: 5013 Russett Rd, Rockville, MD, 20853, US\./);
  const [none] = parseVCards(vcard('FN:No Addr\nEMAIL:noaddr@example.com'));
  assert.doesNotMatch(contactTextRepr(none), /Address:/);
});

test('nameVariants: middle name yields a given+family alias; two-token name adds no redundant duplicate', () => {
  assert.deepEqual(
    nameVariants({ fn: 'Amy Margaret Schneider', given: 'Amy', family: 'Schneider', additional: 'Margaret' }).sort(),
    ['amy margaret schneider', 'amy schneider'].sort(),
  );
  assert.deepEqual(nameVariants({ fn: 'Jon Ardell', given: 'Jon', family: 'Ardell' }), ['jon ardell']);
});

test('nameVariants: nickname yields both the bare nickname and a nickname+family alias', () => {
  assert.deepEqual(
    nameVariants({ fn: 'Elisabeth Allister', given: 'Elisabeth', family: 'Allister', nicknames: ['Betsy'] }).sort(),
    ['betsy', 'betsy allister', 'elisabeth allister'].sort(),
  );
});

test('nameVariants: falls back to tokenizing FN when the N split is absent (backfill path)', () => {
  assert.deepEqual(
    nameVariants({ fn: 'Amy Margaret Schneider' }).sort(),
    ['amy margaret schneider', 'amy schneider'].sort(),
  );
});

test('nameVariants: a 4+ token name is NOT reduced to first+last (would mint a wrong alias)', () => {
  // "Ana Maria Garcia Lopez" -> first+last "ana lopez" would be wrong (compound given + 2-part
  // surname). Without a structured N split we only keep the full name.
  assert.deepEqual(nameVariants({ fn: 'Ana Maria Garcia Lopez' }), ['ana maria garcia lopez']);
});

test('nameVariants: derive=false (org) yields only the full name + nicknames, no given+family reduction', () => {
  assert.deepEqual(nameVariants({ fn: 'Bank of America', derive: false }), ['bank of america']);
});

test('nameVariants: non-array nicknames are ignored, not iterated (robust backfill input)', () => {
  assert.deepEqual(nameVariants({ fn: 'Solo Name', nicknames: 'betsy' }), ['solo name']);
});

test('importContacts: an org contact does not get a bogus given+family name alias', async () => {
  await importContacts(vcard('FN:Global Widgets Incorporated\nKIND:org\nEMAIL:info@globalwidgets.example'));
  const org = db.prepare("SELECT id FROM entities WHERE canonical_name='Global Widgets Incorporated'").get();
  const aliases = db.prepare("SELECT alias FROM entity_aliases WHERE entity_id=? AND alias_type='name'").all(org.id).map((r) => r.alias);
  assert.deepEqual(aliases, ['global widgets incorporated'], 'org keeps only its full-name alias');
});

test('importContacts: X-SPOUSE relation forms across a middle-name variant, regardless of import order', async () => {
  // Card names the spouse by given+family ("Zoe Quill"); the spouse's own card carries the middle
  // name ("Zoe Beatrix Quill"). Import the referencing card FIRST so the hint must stage and only
  // resolve when the middle-name entity lands — exercising X-SPOUSE parse + staging + the derived
  // given+family alias + reverse resolution together (the seed-bug regression).
  await importContacts(vcard('FN:Quinn Referrer\nEMAIL:quinn.ref@example.com\nX-SPOUSE:Zoe Quill'));
  await importContacts(vcard('FN:Zoe Beatrix Quill\nN:Quill;Zoe;Beatrix;;\nEMAIL:zoe.quill@example.com'));

  const from = db.prepare("SELECT entity_id FROM entity_links WHERE role='self' AND artifact_id=(SELECT id FROM artifacts WHERE text_repr LIKE 'Quinn Referrer%')").get();
  const to = db.prepare("SELECT id FROM entities WHERE canonical_name='Zoe Beatrix Quill'").get();
  const edge = db.prepare('SELECT relation_type FROM entity_relations WHERE from_entity_id=? AND to_entity_id=?').get(from.entity_id, to.id);
  assert.equal(edge?.relation_type, 'spouse', 'spouse edge formed from referrer to the middle-name entity');
});
