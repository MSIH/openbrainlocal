# Data Model Conventions
globs: **/*.js — anything touching the SQLite / sqlite-vec store

## Store shape (current — OB2 Phase 2.0, in `src/db.js`)
- `artifacts(id, type, source, source_id, content_hash, occurred_at, ingested_at, latitude, longitude, place_label, raw_path, text_repr, extra_json, UNIQUE(source, source_id))` — every email/photo/doc/note as an event; `text_repr` is what gets embedded. Source of truth.
- `vec_artifacts USING vec0(artifact_id INTEGER PK, embedding float[1024])` — the vectors (dim = `VECTOR_DIMENSION`).
- `artifacts_fts USING fts5(text_repr, content='artifacts', content_rowid='id')` — keyword/exact match, kept in sync by a single `AFTER INSERT` trigger (`artifacts_ai`). The store is append-only, so no delete/update shadow triggers and **never** run `('rebuild')`.
- Entity graph: `entities` + `entity_aliases(UNIQUE(alias, alias_type))` + `entity_links(PK(artifact_id, entity_id, role), confidence)`.
- `unresolved_aliases(id, artifact_id, alias, alias_type, role, hint_confidence, created_at, UNIQUE(artifact_id, alias, alias_type, role))` — staging for connector alias hints (doc 04 §4) that miss `entity_aliases`; the UNIQUE key makes `resolveEntityHints` idempotent the same way `entity_links`' PK + `OR IGNORE` does — re-submitting the same hints stages zero new rows.
- `ingest_log(id, occurred_at, event_type, actor, details)` — append-only log of migrate/import/store events.
- **Legacy:** the original `memories` / `vec_memories` tables are left untouched (append-only). `npm run migrate` copies them into `artifacts` as `type='note'`, reusing the raw 1024-dim vectors (no re-embed); it's idempotent, keyed by `(source='ob1-migration', source_id=<old id>)`.

Writes go through `storeArtifactTxn(artifact, float32Vector, links)` — enrich (embed) first, then one transaction inserts the artifact row + vector row (+ links); the FTS row comes from the trigger.

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
