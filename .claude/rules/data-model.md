# Data Model Conventions
globs: **/*.js — anything touching the SQLite / sqlite-vec store

## Store shape (current — v2.x)
- `memories(id INTEGER PK, content TEXT, created_at DATETIME)` — the raw text, source of truth.
- `vec_memories USING vec0(memory_id INTEGER PK, embedding float[N])` — the vectors.
- (Planned) `artifacts_fts USING fts5(...)` — keyword/exact match to complement vectors.

## Store shape (roadmap — OB2, see docs/03-ob2-design.md)
One `artifacts` table (every email/photo/doc/note as an event with `text_repr` + metadata), an `entities`/`entity_aliases`/`entity_links` graph, `vec_artifacts`, and FTS. Same core rules below apply.

## Hard rules (learned the hard way)
1. **`sqlite-vec` vec0 primary keys bind as `BigInt`.** `better-sqlite3` returns `lastInsertRowid` as a JS Number; passing a Number to a vec0 PK throws `SqliteError: Only integers are allowed for primary key values`. Cast: `insertVecStmt.run(BigInt(memoryId), vec)`. Keep the non-BigInt `id` for JSON responses (BigInt breaks `JSON.stringify`).
2. **`VECTOR_DIMENSION` must equal the embedding model's output length** (`qwen3-embedding:0.6b` → 1024). `CREATE VIRTUAL TABLE IF NOT EXISTS` will NOT resize an existing vec table — changing models requires dropping `vec_memories` and re-embedding; vectors from different models are not comparable.
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
