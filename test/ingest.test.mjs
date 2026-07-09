// The ingest contract (src/ingest.js, connector contract doc 04): payload validation strictness,
// warning computation, and the enrich-then-commit orchestration — in particular re-embed ONLY
// when text_repr changed (a metadata-only wave must never call the embedder). A fake local
// Ollama stands in for the engine and counts embedding calls. DB_PATH + OLLAMA_BASE_URL are set
// before src/ingest.js (which imports db.js + embeddings.js) is loaded.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, startFakeOllama } from './helpers.mjs';

const { cleanup } = useTempDb();
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.baseUrl;

const { executeIngest, computeWarnings, IngestPayloadSchema } = await import('../src/ingest.js');
const { db, getArtifactById } = await import('../src/db.js');

after(async () => { db.close(); await fake.close(); cleanup(); });

test('computeWarnings: flags missing occurred_at and an x- extension type', () => {
  const w = computeWarnings({ type: 'x-custom', text_repr: 't' });
  assert.ok(w.some((m) => /occurred_at missing/.test(m)));
  assert.ok(w.some((m) => /x- extension/.test(m)));
  // A registered type with occurred_at present yields no warnings.
  assert.deepEqual(computeWarnings({ type: 'note', occurred_at: '2026-01-01', text_repr: 't' }), []);
});

test('IngestPayloadSchema: strict — unknown key, explicit null, and bad content_hash all fail', () => {
  const base = { source: 's', source_id: '1', type: 'note', text_repr: 't' };
  assert.equal(IngestPayloadSchema.safeParse(base).success, true);
  assert.equal(IngestPayloadSchema.safeParse({ ...base, bogus: 1 }).success, false, 'unknown top-level key rejected');
  assert.equal(IngestPayloadSchema.safeParse({ ...base, place_label: null }).success, false, 'explicit null on optional rejected (nothing is clearable)');
  assert.equal(IngestPayloadSchema.safeParse({ ...base, content_hash: 'not-a-hash' }).success, false, 'malformed content_hash rejected');
  assert.equal(IngestPayloadSchema.safeParse({ ...base, content_hash: 'a'.repeat(64) }).success, true, 'bare sha256 hex accepted');
});

test('executeIngest: create embeds once; metadata-only re-ingest does not re-embed; text change does', async () => {
  const source = 'ingest-embed';
  const start = fake.counts.embed;

  const created = await executeIngest({ source, source_id: '1', type: 'note', text_repr: 'hello world' });
  assert.equal(created.result.created, true);
  assert.equal(fake.counts.embed, start + 1, 'create embeds exactly once');

  // Same text_repr, only a metadata field added → must NOT call the embedder.
  const meta = await executeIngest({ source, source_id: '1', type: 'note', text_repr: 'hello world', place_label: 'Paris' });
  assert.equal(meta.result.created, false);
  assert.equal(fake.counts.embed, start + 1, 'metadata-only upsert skips the embedder');

  // Changed text_repr → re-embed.
  await executeIngest({ source, source_id: '1', type: 'note', text_repr: 'goodbye world' });
  assert.equal(fake.counts.embed, start + 2, 'a text_repr change re-embeds');
});

test('executeIngest: core resolves place_label from raw lat/lon when none is supplied (#67)', async () => {
  // San Francisco coordinates, no place_label — core reverse-geocodes offline from the bundled
  // GeoNames dataset (landed in #69). Assert a label was resolved without pinning the exact city
  // string (dataset-dependent), and that it did not require the embedder path to be special.
  const r = await executeIngest({
    source: 'geo', source_id: '1', type: 'photo', text_repr: 'a photo by the bay',
    latitude: 37.7749, longitude: -122.4194,
  });
  const a = getArtifactById(r.result.id);
  assert.ok(a.place_label && a.place_label.length > 0, 'a place_label was resolved from coordinates');
});
