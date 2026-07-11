# Data Model Conventions
globs: **/*.js — anything touching the SQLite / sqlite-vec store

## Store shape (current — OB2 Phase 2.0, in `src/db.js`)
- `artifacts(id, type, source, source_id, content_hash, occurred_at, ingested_at, latitude, longitude, place_label, raw_path, text_repr, extra_json, UNIQUE(source, source_id))` — every email/photo/doc/note as an event; `text_repr` is what gets embedded. Source of truth.
- `vec_artifacts USING vec0(artifact_id INTEGER PK, embedding float[1024])` — the vectors (dim = `VECTOR_DIMENSION`).
- `artifacts_fts USING fts5(text_repr, content='artifacts', content_rowid='id')` — keyword/exact match, kept in sync by **two** triggers: `artifacts_ai` (`AFTER INSERT`) indexes the new row, and `artifacts_au` (`AFTER UPDATE OF text_repr`) does the external-content delete+reinsert dance — `INSERT INTO artifacts_fts(artifacts_fts, rowid, text_repr) VALUES('delete', old.id, old.text_repr)` (the 'delete' MUST carry the OLD text so the right terms are removed) then indexes the new text. The update trigger exists because the ingest upsert path rewrites `text_repr` in place (see below); artifacts are otherwise append-only (no row is ever DELETEd, so no delete shadow trigger), and you **never** run `('rebuild')`.
- Entity graph: `entities` + `entity_aliases(UNIQUE(alias, alias_type))` + `entity_links(PK(artifact_id, entity_id, role), confidence)`.
- `unresolved_aliases(id, artifact_id, alias, alias_type, role, hint_confidence, created_at, UNIQUE(artifact_id, alias, alias_type, role))` — staging for connector alias hints (doc 04 §4) that miss `entity_aliases`; the UNIQUE key makes `resolveEntityHints` idempotent the same way `entity_links`' PK + `OR IGNORE` does — re-submitting the same hints stages zero new rows. Relation hints (`alias_type='relation'`, from `stageRelationHint`) live here too: a person named as someone's relation before their own contact exists; `resolveRelationHints` forms the edge when that person is later imported.

**Contact name aliases + relationships (#93, `src/contacts.js` + `nameVariants` in `src/db.js`).** Entity resolution is exact-match against `entity_aliases`, so a contact import generates every name a person is likely to be referenced by — beyond the full FN and each verbatim nickname: a **given+family** variant when a middle name is present (`"Amy Margaret Schneider"` → also `amy schneider`) and a **nickname+family** variant (`NICKNAME:Betsy` + family `Allister` → also `betsy allister`). Relationship links are parsed from Apple `X-ABRELATEDNAMES`/vCard-4 `RELATED` **and** the Google/Android `X-*` family (`X-SPOUSE`, `X-CHILD`, `X-MANAGER`, …), canonicalized via `RELATION_TYPE_MAP`. `stageRelationHint` also stages a given+family reduction of a 3-token related name (exactly 3 — a 4+ token name is too ambiguous to reduce to first+last safely) so the reverse direction matches too. Fixing resolution by generating more aliases (all `INSERT OR IGNORE`, append-only) — not by fuzzy-matching at lookup time — keeps the lookup path exact and deterministic. **Backfill:** existing contacts predate these aliases and `import:contacts` skips a matched UID before reading content, so `npm run backfill:relations` regenerates the variants for every person entity and re-runs `resolveRelationHints` (idempotent — a second run adds 0 aliases, forms 0 edges).
- `ingest_log(id, occurred_at, event_type, actor, details)` — append-only log of migrate/import/store events.
- **Legacy:** the original `memories` / `vec_memories` tables are left untouched (append-only). `npm run migrate` copies them into `artifacts` as `type='note'`, reusing the raw 1024-dim vectors (no re-embed); it's idempotent, keyed by `(source='ob1-migration', source_id=<old id>)`.

Writes go through `storeArtifactTxn(artifact, float32Vector, links)` — enrich (embed) first, then one transaction inserts the artifact row + vector row (+ links); the FTS row comes from the trigger.

**Upsert path (connector ingest — `upsertArtifactTxn(artifact, float32VectorOrNull, hints)`).** `POST /api/v1/ingest` (src/ingest.js) upserts on `(source, source_id)`: a new key inserts (mirrors `storeArtifactTxn`); an existing key **updates only the derived representation** — `text_repr`, its embedding, FTS row, and metadata. This is the one place `artifacts` rows are UPDATEd, and it's reconciled with append-only: only derived values change, never originals (`raw_path`/`content_hash` untouched, `ingested_at` frozen — the update event lives in `ingest_log`, whose `ingest_update` row records the prior value of every changed field, so the derived record's full history is reconstructable). Rules the update path follows: **present fields overwrite, absent fields are left unchanged** (built via `COALESCE(@field, field)` so a metadata-only wave never wipes an earlier wave's data; explicit `null` is rejected at the schema, so nothing is ever cleared); **re-embed only when `text_repr` changed** (pass a null vector otherwise — the embedder is the expensive step, and a metadata-only upsert must not call it); the vec0 row is `UPDATE`d in place (PK bound `BigInt`); entity links are **additive** (`resolveEntityHints` is idempotent). Enrich-then-commit still holds — the embedding is fetched before the transaction opens.

## Hard rules (learned the hard way)
1. **`sqlite-vec` vec0 primary keys bind as `BigInt`.** `better-sqlite3` returns `lastInsertRowid` as a JS Number; passing a Number to a vec0 PK throws `SqliteError: Only integers are allowed for primary key values`. Cast: `insertVecStmt.run(BigInt(memoryId), vec)`. Keep the non-BigInt `id` for JSON responses (BigInt breaks `JSON.stringify`).
2. **`VECTOR_DIMENSION` must equal the embedding model's output length** (`qwen3-embedding:0.6b` → 1024). `CREATE VIRTUAL TABLE IF NOT EXISTS` will NOT resize an existing vec table — changing models requires dropping `vec_artifacts` and re-embedding; vectors from different models are not comparable.
3. **Embeddings are `Float32Array`** bound directly to the `embedding` column.
4. **Enrich-then-commit atomically.** Fetch the embedding (network) before opening the transaction; the write of raw row + vector row is one `db.transaction` (`storeTxn`) so a failed API call never leaves an orphan.
5. **WAL mode** (`journal_mode = WAL`) — set at startup; enables concurrent readers.

## Preservation (append-only)
- **Never hard-delete or overwrite** stored rows. Memory is permanent; correct forward by appending, not mutating. (No `IsActive`/soft-delete concept here — nothing is deleted at all in the base design.)
- Keep originals: for non-text artifacts store a **`raw_path`** pointer to the file on disk, not the blob in SQLite — the DB stays small and lossless.
- **`content_hash`** (sha256) + a `(source, source_id)` unique key are the dedup/idempotency keys; re-running an importer must be safe.

## Metadata (capture who/what/when/where)
- Separate **`occurred_at`** (when it happened) from **`ingested_at`** (when imported) — a 2019 photo imported today must sort into 2019.
- Absorb type-specific fields in an `extra_json` column; promote to a real column only when you need to filter/index on it.
- Store structured `latitude`/`longitude`/`place_label` for anything geo, so time+place filtering works without the vector index.

## Search
- Hybrid is the target: vector KNN (`sqlite-vec` MATCH + `k`) fused with FTS5 keyword search — vectors miss proper nouns/exact strings; keyword search catches them.

## Migrations
There is no ORM/migration framework. Schema is created idempotently at startup via `db.exec(CREATE ... IF NOT EXISTS)`. Any change that alters an existing table (esp. the vec dimension) needs an explicit, documented migration path (back up the `.db` file first — the whole point of local SQLite).
