/**
 * The store. Single authority for the SQLite/sqlite-vec schema, the write transaction,
 * and the append-only ingest log. Opened once and shared by the server and every
 * headless script (migrate, connectors) so the enrich-then-commit discipline and the
 * BigInt vec0-PK rule live in exactly one place.
 *
 * OB2 Phase 2.0 schema (docs/03-ob2-design.md §2): a unified `artifacts` table, an
 * entity graph, and hybrid search indexes (vec0 + FTS5). Created idempotently at import.
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DB_PATH, VECTOR_DIMENSION, DB_BUSY_TIMEOUT_MS } from './config.js';
import { haversineKm } from './geocode.js';

export const db = new Database(DB_PATH);
sqliteVec.load(db);
db.pragma('journal_mode = WAL'); // concurrent readers (data-model.md rule 5)
db.pragma('foreign_keys = ON');  // enforce REFERENCES clauses — per-connection, defaults OFF (#110)
db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`); // wait out a brief competing writer instead of throwing SQLITE_BUSY instantly (#224)

// --- SCHEMA (idempotent; VECTOR_DIMENSION must match the embedding model — rule 2) ---
db.exec(`
  -- Unified artifact: every email/photo/doc/note is an event with time, place, text.
  CREATE TABLE IF NOT EXISTS artifacts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT NOT NULL,        -- registered type (src/ingest-types.js) or an x- extension
    source        TEXT NOT NULL,        -- gmail|icloud|filesystem|vcard|ob1-migration|manual
    source_id     TEXT,                 -- provider's id (dedup key)
    content_hash  TEXT,                 -- sha256 of raw bytes (dedup + integrity)
    occurred_at   DATETIME,             -- when it HAPPENED (nullable)
    ingested_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    latitude      REAL,
    longitude     REAL,
    place_label   TEXT,
    raw_path      TEXT,                 -- pointer to original on disk (never the blob)
    text_repr     TEXT NOT NULL,        -- normalized text — this gets embedded
    extra_json    TEXT,                 -- type-specific fields (headers, EXIF, …)
    UNIQUE(source, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_time ON artifacts(occurred_at);
  CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(content_hash);

  -- Entity graph: contacts are the spine; artifacts link to people/places/orgs.
  CREATE TABLE IF NOT EXISTS entities (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL,       -- person|place|org|event|topic
    canonical_name TEXT NOT NULL,
    attrs_json     TEXT,                -- emails[], phones[], birthday, relationship, …
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  -- Identity resolution: "Mom", an email, a phone, and a full name are one entity.
  CREATE TABLE IF NOT EXISTS entity_aliases (
    entity_id  INTEGER NOT NULL REFERENCES entities(id),
    alias      TEXT NOT NULL,           -- normalized (lowercase names/emails, digits-only phones)
    alias_type TEXT NOT NULL,           -- email|phone|name|handle
    UNIQUE(alias, alias_type)
  );
  CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);

  -- Deliberately-removed aliases (#111). A removal records a tombstone here so a later ADDITIVE
  -- write (contact import/re-import #94, a profile edit, hint resolution) can't silently resurrect
  -- it; an explicit user addAlias clears (DELETEs) the tombstone (user intent overrides). Scoped
  -- per entity — removing "chris" from one person doesn't suppress it on another. Inserts are
  -- idempotent (OR IGNORE on the UNIQUE key); rows are cleared only by an explicit re-add, so this
  -- is not strictly append-only. The UNIQUE(entity_id, alias, alias_type) index also serves the
  -- hasTombstone lookup — no separate index needed.
  CREATE TABLE IF NOT EXISTS alias_tombstones (
    entity_id  INTEGER NOT NULL REFERENCES entities(id),
    alias      TEXT NOT NULL,           -- normalized identically to entity_aliases
    alias_type TEXT NOT NULL,           -- email|phone|name|handle
    removed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_id, alias, alias_type)
  );
  CREATE TABLE IF NOT EXISTS entity_links (
    artifact_id INTEGER REFERENCES artifacts(id),
    entity_id   INTEGER REFERENCES entities(id),
    role        TEXT NOT NULL,          -- sender|recipient|pictured|mentioned|author|self|location_of
    confidence  REAL DEFAULT 1.0,       -- 1.0 deterministic; <1.0 inferred
    PRIMARY KEY (artifact_id, entity_id, role)
  );
  CREATE INDEX IF NOT EXISTS idx_links_entity ON entity_links(entity_id);

  -- Staging for connector hints that miss entity_aliases (connector contract doc 04 §4).
  -- UNIQUE is an additive deviation from the doc's DDL sketch: makes resolveEntityHints
  -- idempotent by construction, matching entity_links' own PK + OR IGNORE discipline.
  CREATE TABLE IF NOT EXISTS unresolved_aliases (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id     INTEGER REFERENCES artifacts(id),
    alias           TEXT NOT NULL,       -- normalized (lowercase; digits-only phones)
    alias_type      TEXT NOT NULL,       -- email|phone|name|handle
    role            TEXT NOT NULL,
    hint_confidence REAL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(artifact_id, alias, alias_type, role)
  );
  CREATE INDEX IF NOT EXISTS idx_unresolved_alias ON unresolved_aliases(alias, alias_type);

  -- Proposed entities (#119): the human-approval gate for entities auto-proposed from ARTIFACT
  -- signals (a document vendor, an email sender) via an entity hint's suggested_kind flag. An
  -- unmatched such hint stages a proposal here INSTEAD of minting the entity, so low-signal
  -- senders (noreply@, marketing, one-off vendors) can't silently pollute the graph. Approve →
  -- create + retroactively link; reject → kept (append-only) so re-ingest never re-raises it.
  -- Gates ONLY the connector-ingest lane; contact import (trusted) creates entities directly.
  -- UNIQUE makes proposeEntity idempotent, mirroring unresolved_aliases' discipline.
  CREATE TABLE IF NOT EXISTS proposed_entities (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    suggested_kind     TEXT NOT NULL,                   -- person|org|place (free-text; #137)
    suggested_name     TEXT NOT NULL,
    alias              TEXT NOT NULL,                   -- normalized resolution key
    alias_type         TEXT NOT NULL,                   -- email|phone|name|handle
    artifact_id        INTEGER REFERENCES artifacts(id),
    source             TEXT,
    confidence         REAL,
    status             TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
    resolved_entity_id INTEGER REFERENCES entities(id),
    attrs_json         TEXT,                            -- staged geo/span for a place/event proposal (#137); NULL for person/org
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(suggested_name, alias, alias_type)
  );
  CREATE INDEX IF NOT EXISTS idx_proposed_status ON proposed_entities(status);

  -- Side contact directory (#154): a handle -> name LOOKUP loaded from the user's full contacts
  -- export. Deliberately NOT entities/entity_aliases — the curated entity graph only grows by
  -- explicit approval. A directory hit on an unresolved handle (a) auto-labels it for display and
  -- (b) stages a proposed_entities row (name pre-filled) for review. Nothing here is an entity, has
  -- an embedding, or references entities. Handle is normalized (normalizePhone / lowercased email);
  -- UNIQUE(handle, handle_type) makes the loader idempotent (first-writer-wins on a shared number,
  -- mirroring entity_aliases discipline). name may repeat (a contact has several handles).
  CREATE TABLE IF NOT EXISTS contact_directory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    handle      TEXT NOT NULL,
    handle_type TEXT NOT NULL CHECK(handle_type IN ('phone','email')),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(handle, handle_type)
  );

  -- Entity<->entity edges (issue #37; person->org added #88). entity_links joins
  -- artifacts->entities; this joins entities to each other (spouse/child/parent/…, and a
  -- person's worksAt->org). Append-only + idempotent via the UNIQUE key + OR IGNORE, mirroring
  -- entity_links. Kind-agnostic columns. Directional: from_entity_id = the contact owner (or the
  -- employee), to_entity_id = the related person (or the employer org); asymmetric; confidence
  -- 1.0 for an explicit contact field.
  CREATE TABLE IF NOT EXISTS entity_relations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    from_entity_id INTEGER NOT NULL REFERENCES entities(id),
    to_entity_id   INTEGER NOT NULL REFERENCES entities(id),
    relation_type  TEXT NOT NULL,       -- canonical vocab (RELATION_TYPE_MAP) or 'custom'
    raw_label      TEXT,                -- original source label, preserved (esp. for 'custom')
    confidence     REAL DEFAULT 1.0,
    source         TEXT,                -- vcard|…
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_entity_id, to_entity_id, relation_type)
  );
  CREATE INDEX IF NOT EXISTS idx_relations_from ON entity_relations(from_entity_id);
  CREATE INDEX IF NOT EXISTS idx_relations_to ON entity_relations(to_entity_id);

  -- Semantic index (dim MUST equal the embedding model's output).
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_artifacts USING vec0(
    artifact_id INTEGER PRIMARY KEY,
    embedding float[${VECTOR_DIMENSION}]
  );
  -- Keyword/exact index — vectors miss proper nouns and exact strings.
  CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
    text_repr, content='artifacts', content_rowid='id'
  );
  -- Keep FTS in sync with this external-content table. INSERT feeds the new row in. The
  -- ingest upsert path (src/ingest.js) rewrites text_repr in place when an enrichment wave
  -- arrives, so an AFTER UPDATE OF text_repr trigger does the external-content delete+reinsert
  -- dance: 'delete' MUST carry the OLD text_repr so FTS removes the right terms, then the new
  -- text is indexed. Artifacts are otherwise append-only — no row is ever DELETEd — so no
  -- delete shadow trigger is needed. (Never run ('rebuild') — a double run or an empty-table
  -- rebuild corrupts/duplicates the index.)
  CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
    INSERT INTO artifacts_fts(rowid, text_repr) VALUES (new.id, new.text_repr);
  END;
  CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE OF text_repr ON artifacts BEGIN
    INSERT INTO artifacts_fts(artifacts_fts, rowid, text_repr) VALUES('delete', old.id, old.text_repr);
    INSERT INTO artifacts_fts(rowid, text_repr) VALUES (new.id, new.text_repr);
  END;

  -- Append-only log of significant transitions (design-philosophy.md §3).
  CREATE TABLE IF NOT EXISTS ingest_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    event_type  TEXT NOT NULL,          -- migrate|import_contacts|store_note|dedup_skip|ingest_create|ingest_update|relation_added|relation_resolved|relation_removed|entity_created|entity_edited|entity_merged|alias_added|alias_removed|alias_tombstone_cleared|schema_migration|integrity_check
    actor       TEXT,
    details     TEXT                    -- JSON
  );
`);

// Guarded migration (#75): CREATE TABLE IF NOT EXISTS above won't add a column to an
// entities table that already existed pre-upgrade — check PRAGMA table_info and ALTER once.
// merged_into NULL = a live entity; non-NULL = a tombstone redirecting to its merge survivor
// (mergeEntities never deletes the absorbed row — design-philosophy.md §1). Back up
// life-context.db before upgrading, same as any schema change (data-model.md "Migrations").
if (!db.prepare("PRAGMA table_info(entities)").all().some((c) => c.name === 'merged_into')) {
  db.exec('ALTER TABLE entities ADD COLUMN merged_into INTEGER REFERENCES entities(id)');
  // Schema changes get a log row same as any other significant transition (design-philosophy.md
  // §3) — a raw statement, not the logEvent()/logStmt helper below, since those aren't defined
  // yet at this point in module evaluation (this runs at schema-setup time, top-to-bottom).
  db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)')
    .run('schema_migration', 'db.js', JSON.stringify({ migration: 'entities.merged_into' }));
}
db.exec('CREATE INDEX IF NOT EXISTS idx_entities_merged_into ON entities(merged_into)');

// Guarded migration (#137): carry a place/event proposal's staged geo/span so approveProposedEntity
// can copy it into the minted entity. Nullable — a person/org proposal leaves it NULL. Same
// table_info-guarded ALTER as merged_into above (ADD COLUMN doesn't rewrite existing rows).
if (!db.prepare('PRAGMA table_info(proposed_entities)').all().some((c) => c.name === 'attrs_json')) {
  db.exec('ALTER TABLE proposed_entities ADD COLUMN attrs_json TEXT');
  db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)')
    .run('schema_migration', 'db.js', JSON.stringify({ migration: 'proposed_entities.attrs_json' }));
}

// Data migration (#88): business contacts flagged isCompany were historically inserted as
// kind='person' (the 'org' schema slot went unused). Fill the derived classification from the
// raw source signal — idempotent (only still-mis-kinded live rows change), run unconditionally,
// logged only when it actually promotes rows. Same raw-statement approach as the migration above
// (logEvent/logStmt aren't defined yet at schema-setup time). json_extract ships with better-sqlite3.
// json_valid guards first: attrs_json is an unconstrained TEXT column the code already treats as
// possibly-non-JSON (safeJson), and json_extract THROWS on malformed JSON — since this runs at
// module load, one bad row would otherwise crash every startup. SQLite short-circuits AND, so a
// malformed/NULL row is skipped before json_extract sees it.
{
  const info = db.prepare(`
    UPDATE entities SET kind = 'org'
    WHERE kind = 'person' AND merged_into IS NULL
      AND json_valid(attrs_json)
      AND json_extract(attrs_json, '$.isCompany') = 1
  `).run();
  if (info.changes > 0) {
    db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)')
      .run('schema_migration', 'db.js', JSON.stringify({ migration: 'entities.kind=org', rows: info.changes }));
  }
}

// --- Integrity enforcement (#110) ---
// FKs are enforced for NEW writes (pragma at open). Check EXISTING data once at startup —
// detect-only: design-philosophy §1 forbids deleting stored rows, so a pre-existing orphan is
// logged (console + an `integrity_check` ingest_log row) and boot continues; repair is a separate,
// deliberate act. Raw statement, not logEvent/logStmt (not defined until later in this module).
const logSchemaStmt = db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)');
{
  const fkViolations = db.pragma('foreign_key_check');            // [] when clean
  const integrity = db.pragma('integrity_check');                 // [{integrity_check:'ok'}] when clean
  const integrityOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
  if (fkViolations.length > 0 || !integrityOk) {
    console.error('db.js: startup integrity issues (NOT repaired — design-philosophy §1):',
      { foreign_key_violations: fkViolations, integrity_check: integrity });
    logSchemaStmt.run('integrity_check', 'db.js',
      JSON.stringify({ foreign_key_violations: fkViolations, integrity_check: integrityOk ? 'ok' : integrity }));
  }
}

// Guarded NOT NULL tightening (#110): SQLite can't ALTER a column to NOT NULL, so rebuild the table
// (sqlite.org new-table→INSERT SELECT→drop→rename recipe). Idempotent — skipped once the target
// column is already NOT NULL (so a fresh DB, born tight from the CREATE TABLE above, never rebuilds).
// Never coerces/drops data: if the target columns still hold NULLs, or the rebuilt table trips a
// pre-existing FK orphan, SKIP and log loudly (surfacing corruption beats hiding it, design-philosophy
// §1). FKs toggle OFF around the rebuild (the pragma is a no-op inside a transaction) and are always
// restored in `finally`; foreign_key_check re-verifies before commit and rolls back on an orphan.
function tightenNotNull(table, columns, createNewSql, copyCols, indexSqls) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.every((c) => info.find((x) => x.name === c)?.notnull === 1)) return; // already migrated
  const nullRows = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${columns.map((c) => `"${c}" IS NULL`).join(' OR ')}`).get().n;
  if (nullRows > 0) {
    console.error(`db.js: NOT NULL migration for ${table} SKIPPED — ${nullRows} row(s) with NULL ${columns.join('/')} (not coerced; design-philosophy §1). Clean these and restart.`);
    logSchemaStmt.run('integrity_check', 'db.js', JSON.stringify({ migration: `${table}.not_null`, skipped: 'null_rows', null_rows: nullRows, columns }));
    return;
  }
  db.pragma('foreign_keys = OFF'); // must be outside any transaction; restored in finally
  try {
    let orphans = [];
    const rebuild = db.transaction(() => {
      db.exec(createNewSql);
      db.exec(`INSERT INTO ${table}_new (${copyCols}) SELECT ${copyCols} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      for (const ix of indexSqls) db.exec(ix);
      orphans = db.pragma(`foreign_key_check(${table})`);
      if (orphans.length > 0) throw new Error('__ROLLBACK_ORPHAN__'); // preserve data; leave table untightened
    });
    try {
      rebuild();
      logSchemaStmt.run('schema_migration', 'db.js', JSON.stringify({ migration: `${table}.not_null`, columns }));
    } catch (err) {
      if (err.message !== '__ROLLBACK_ORPHAN__') throw err;
      console.error(`db.js: NOT NULL migration for ${table} SKIPPED — ${orphans.length} pre-existing FK orphan(s); table left unchanged (not repaired, design-philosophy §1).`);
      logSchemaStmt.run('integrity_check', 'db.js', JSON.stringify({ migration: `${table}.not_null`, skipped: 'fk_orphans', orphans: orphans.length, columns }));
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

tightenNotNull('entity_aliases', ['entity_id', 'alias_type'], `
  CREATE TABLE entity_aliases_new (
    entity_id  INTEGER NOT NULL REFERENCES entities(id),
    alias      TEXT NOT NULL,
    alias_type TEXT NOT NULL,
    UNIQUE(alias, alias_type)
  )`, 'entity_id, alias, alias_type', [
  'CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id)',
]);

tightenNotNull('entity_links', ['role'], `
  CREATE TABLE entity_links_new (
    artifact_id INTEGER REFERENCES artifacts(id),
    entity_id   INTEGER REFERENCES entities(id),
    role        TEXT NOT NULL,
    confidence  REAL DEFAULT 1.0,
    PRIMARY KEY (artifact_id, entity_id, role)
  )`, 'artifact_id, entity_id, role, confidence', [
  'CREATE INDEX IF NOT EXISTS idx_links_entity ON entity_links(entity_id)',
]);

tightenNotNull('unresolved_aliases', ['alias_type', 'role'], `
  CREATE TABLE unresolved_aliases_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id     INTEGER REFERENCES artifacts(id),
    alias           TEXT NOT NULL,
    alias_type      TEXT NOT NULL,
    role            TEXT NOT NULL,
    hint_confidence REAL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(artifact_id, alias, alias_type, role)
  )`, 'id, artifact_id, alias, alias_type, role, hint_confidence, created_at', [
  'CREATE INDEX IF NOT EXISTS idx_unresolved_alias ON unresolved_aliases(alias, alias_type)',
]);

// --- PREPARED STATEMENTS (compiled once) ---
const insertArtifactStmt = db.prepare(`
  INSERT OR IGNORE INTO artifacts
    (type, source, source_id, content_hash, occurred_at, latitude, longitude, place_label, raw_path, text_repr, extra_json)
  VALUES
    (@type, @source, @source_id, @content_hash, @occurred_at, @latitude, @longitude, @place_label, @raw_path, @text_repr, @extra_json)
`);
const insertVecArtifactStmt = db.prepare('INSERT INTO vec_artifacts (artifact_id, embedding) VALUES (?, ?)');
const insertLinkStmt = db.prepare('INSERT OR IGNORE INTO entity_links (artifact_id, entity_id, role, confidence) VALUES (?, ?, ?, ?)');
const insertUnresolvedStmt = db.prepare(`
  INSERT OR IGNORE INTO unresolved_aliases (artifact_id, alias, alias_type, role, hint_confidence)
  VALUES (?, ?, ?, ?, ?)
`);
const selectIdBySourceStmt = db.prepare('SELECT id FROM artifacts WHERE source = ? AND source_id = ?');
const getArtifactBySourceStmt = db.prepare('SELECT * FROM artifacts WHERE source = ? AND source_id = ?');
const selectIdByHashStmt = db.prepare('SELECT id FROM artifacts WHERE content_hash = ? LIMIT 1');
const getArtifactStmt = db.prepare('SELECT * FROM artifacts WHERE id = ?');
// Upsert update path. COALESCE(@field, field): a present field overwrites; an absent one
// (bound null) keeps the current value — so a metadata-only wave never wipes what an earlier
// wave stored, and nothing can be cleared through this path (schema rejects explicit null).
// source / source_id (the upsert key) and ingested_at (first-ingest time) are never in the
// SET clause. Two variants so the caller only touches text_repr when it actually changed:
// naming text_repr in SET fires `artifacts_au` (AFTER UPDATE OF text_repr) even when the value
// is identical, so a metadata-only wave would otherwise churn the FTS index for nothing.
const updateArtifactStmt = db.prepare(`
  UPDATE artifacts SET
    type        = COALESCE(@type, type),
    occurred_at = COALESCE(@occurred_at, occurred_at),
    latitude    = COALESCE(@latitude, latitude),
    longitude   = COALESCE(@longitude, longitude),
    place_label = COALESCE(@place_label, place_label),
    text_repr   = COALESCE(@text_repr, text_repr),
    extra_json  = COALESCE(@extra_json, extra_json)
  WHERE id = @id
`);
// Metadata-only variant: identical but omits text_repr, so the FTS update trigger does NOT
// fire. Used when text_repr is unchanged (an enrichment wave that only touches place/geo/etc.).
const updateArtifactMetaStmt = db.prepare(`
  UPDATE artifacts SET
    type        = COALESCE(@type, type),
    occurred_at = COALESCE(@occurred_at, occurred_at),
    latitude    = COALESCE(@latitude, latitude),
    longitude   = COALESCE(@longitude, longitude),
    place_label = COALESCE(@place_label, place_label),
    extra_json  = COALESCE(@extra_json, extra_json)
  WHERE id = @id
`);
// One vector per artifact, dimension unchanged — update in place; vec0 PK binds as BigInt.
const updateVecArtifactStmt = db.prepare('UPDATE vec_artifacts SET embedding = ? WHERE artifact_id = ?');
const getLinksStmt = db.prepare(`
  SELECT el.entity_id, el.role, el.confidence, e.canonical_name, e.kind
  FROM entity_links el JOIN entities e ON e.id = el.entity_id
  WHERE el.artifact_id = ?
`);
const insertEntityStmt = db.prepare('INSERT INTO entities (kind, canonical_name, attrs_json) VALUES (?, ?, ?)');
const insertAliasStmt = db.prepare('INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_type) VALUES (?, ?, ?)');
const resolveAliasStmt = db.prepare('SELECT DISTINCT entity_id FROM entity_aliases WHERE alias = ?');
// entity_aliases is UNIQUE(alias, alias_type) — a hint's declared type must be part of the
// match, or a name/handle alias could collide with an unrelated entity's differently-typed
// alias (and a phone/email hint could earn undeserved 1.0 confidence off that collision).
const resolveAliasByTypeStmt = db.prepare('SELECT DISTINCT entity_id FROM entity_aliases WHERE alias = ? AND alias_type = ?');
// Query-time given-name fallback (#184): a name alias whose value is exactly the term OR starts
// with the term at a token boundary ("sam" -> "sam rivera"/"sam maria rivera", never "jetsam" or a
// mid-token "sa"). `name` aliases ONLY — a prefix on a phone/email is meaningless. Used solely by
// hybridSearch's entity loop, never on the exact-match ingest/annotate path (see resolveNameByPrefix).
// LIMIT 2: we only ever decide "exactly one match" vs "ambiguous", so two distinct rows is enough —
// no need to materialize every entity whose name starts with a common/short prefix.
const resolveNameByPrefixStmt = db.prepare(`SELECT DISTINCT entity_id FROM entity_aliases WHERE alias_type = 'name' AND (alias = @t OR alias LIKE @t || ' %' ESCAPE '\\') LIMIT 2`);
const getEntityStmt = db.prepare('SELECT * FROM entities WHERE id = ?');
const logStmt = db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)');
// entity_relations (issue #37): append-only edges, OR IGNORE for idempotency.
const insertRelationStmt = db.prepare(`
  INSERT OR IGNORE INTO entity_relations (from_entity_id, to_entity_id, relation_type, raw_label, confidence, source)
  VALUES (@from_entity_id, @to_entity_id, @relation_type, @raw_label, @confidence, @source)
`);
// r.id AS relation_id lets the contacts UI (#96) target a specific edge for removal; harmless to
// about_entity, which ignores it.
const getRelationsStmt = db.prepare(`
  SELECT r.id AS relation_id, r.to_entity_id AS entity_id, r.relation_type, r.raw_label, r.confidence, e.canonical_name AS name
  FROM entity_relations r JOIN entities e ON e.id = r.to_entity_id
  WHERE r.from_entity_id = ? ORDER BY r.relation_type, e.canonical_name
`);
// Incoming edges (#88): the reverse of getRelationsStmt — who points AT this entity. Lets
// about_entity(org) list its employees (worksAt from=person, to=org); harmlessly gives every
// entity its reverse edges too. Joins the FROM side for the name.
const getRelationsToStmt = db.prepare(`
  SELECT r.id AS relation_id, r.from_entity_id AS entity_id, r.relation_type, r.raw_label, r.confidence, e.canonical_name AS name
  FROM entity_relations r JOIN entities e ON e.id = r.from_entity_id
  WHERE r.to_entity_id = ? ORDER BY r.relation_type, e.canonical_name
`);
// Name aliases of an entity — used to match staged relation hints that point at this person.
const selectNameAliasesStmt = db.prepare(`SELECT alias FROM entity_aliases WHERE entity_id = ? AND alias_type = 'name'`);
// Staged relation hints keyed by the related person's normalized name (alias_type='relation'
// marks them so they never collide with ordinary artifact->entity alias hints).
const selectRelationHintsStmt = db.prepare(`SELECT artifact_id, role FROM unresolved_aliases WHERE alias = ? AND alias_type = 'relation'`);
// The self-entity of a contact artifact — the "from" side of a staged relation.
const selectSelfEntityStmt = db.prepare(`SELECT entity_id FROM entity_links WHERE artifact_id = ? AND role = 'self' LIMIT 1`);
// Proposed entities (#119): stage / list / read / transition rows in proposed_entities.
const insertProposalStmt = db.prepare(`
  INSERT OR IGNORE INTO proposed_entities (suggested_kind, suggested_name, alias, alias_type, artifact_id, source, confidence, attrs_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const listProposalsStmt = db.prepare(`
  SELECT id, suggested_kind, suggested_name, alias, alias_type, artifact_id, source, confidence, status, resolved_entity_id, attrs_json, created_at
  FROM proposed_entities WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?
`);
const getProposalStmt = db.prepare('SELECT * FROM proposed_entities WHERE id = ?');
const setProposalStatusStmt = db.prepare('UPDATE proposed_entities SET status = ? WHERE id = ?');
const setProposalResolvedStmt = db.prepare(`UPDATE proposed_entities SET status = 'approved', resolved_entity_id = ? WHERE id = ?`);

// Side contact directory (#154). Handles normalize the same way resolution does, so a directory
// number stored 10-digit matches a `+1…` message handle and vice versa (#129). insertDirectoryEntry
// is first-writer-wins per (handle, type) and logs a name collision; lookupDirectoryName returns the
// stored name or null. Defined here (used by resolveEntityHints, annotateHandles, the loader, and
// the backfill) — all callers run after module load, so referencing normalizePhone/normalizeName
// (declared below) is safe.
const directorySelectStmt = db.prepare('SELECT name FROM contact_directory WHERE handle = ? AND handle_type = ?');
const directoryInsertStmt = db.prepare('INSERT OR IGNORE INTO contact_directory (name, handle, handle_type) VALUES (?, ?, ?)');
const dirKey = (handle, handleType) => (handleType === 'phone' ? normalizePhone(handle) : normalizeName(handle));
export function insertDirectoryEntry(name, handle, handleType) {
  const cleanName = typeof name === 'string' ? name.trim() : '';
  // Guard the type up front (matches the table CHECK) so a bad value returns a no-op result rather
  // than throwing a SqliteError mid-load; empty name/handle can't label anything.
  const key = cleanName && handle && (handleType === 'phone' || handleType === 'email') ? dirKey(handle, handleType) : '';
  if (!key) return { inserted: false, collision: false };
  // INSERT OR IGNORE first, then trust .changes — a SELECT-then-INSERT could wrongly report an
  // insert when a concurrent writer took the (handle,type) between the two (Copilot, PR #155).
  if (directoryInsertStmt.run(cleanName, key, handleType).changes > 0) return { inserted: true, collision: false };
  // Ignored: the (handle,type) already exists — SELECT only now, to detect/log a name collision.
  const existing = directorySelectStmt.get(key, handleType);
  const collision = !!existing && existing.name !== cleanName;
  if (collision) console.error(`contact_directory: ${handleType} ${key} already maps to "${existing.name}", ignoring "${cleanName}"`);
  return { inserted: false, collision };
}
export const lookupDirectoryName = (handle, handleType) => {
  const key = handle ? dirKey(handle, handleType) : '';
  return key ? directorySelectStmt.get(key, handleType)?.name ?? null : null;
};
// Backfill: stage a directory-sourced person proposal for every historical unresolved phone/email
// hint the directory knows (#154). Frequency-ordered so the highest-traffic numbers surface first;
// skips a handle that has since become curated; idempotent (proposed_entities' UNIQUE absorbs re-runs).
const selectUnmatchedHandlesStmt = db.prepare(`
  SELECT alias, alias_type, MIN(artifact_id) AS artifact_id, COUNT(*) AS freq
  FROM unresolved_aliases WHERE alias_type IN ('phone','email')
  GROUP BY alias, alias_type ORDER BY COUNT(*) DESC
`);
export function backfillDirectoryProposals() {
  let scanned = 0, proposed = 0;
  const run = db.transaction(() => {
    for (const row of selectUnmatchedHandlesStmt.all()) {
      scanned++;
      const name = lookupDirectoryName(row.alias, row.alias_type);
      if (!name) continue;
      if (resolveAliasByTypeStmt.all(row.alias, row.alias_type).length) continue; // became curated since
      if (proposeEntity({ suggested_kind: 'person', name, alias: row.alias, alias_type: row.alias_type, artifact_id: row.artifact_id, source: 'directory-backfill' })) proposed++;
    }
  });
  run();
  logEvent('directory_backfill', 'backfill-directory-proposals.js', { scanned, proposed });
  return { scanned, proposed };
}

// The 11 artifact columns storeArtifactTxn writes; callers pass a partial and we fill nulls.
const ARTIFACT_FIELDS = ['type', 'source', 'source_id', 'content_hash', 'occurred_at',
  'latitude', 'longitude', 'place_label', 'raw_path', 'text_repr', 'extra_json'];

// The derived/metadata columns the upsert update path may rewrite. Deliberately EXCLUDES:
// source/source_id (the upsert key); ingested_at (records FIRST ingestion — the update event
// lives in ingest_log); and content_hash + raw_path, which are the append-only ORIGINALS
// (CLAUDE.md rule 5: "Preserve originals (raw_path, content_hash)") — write-once at create,
// never overwritten by a later enrichment wave, so the artifact row keeps pointing at the raw
// bytes it was born from. Absent fields keep their prior value (COALESCE in updateArtifactStmt).
const MUTABLE_FIELDS = ['type', 'occurred_at', 'latitude', 'longitude',
  'place_label', 'text_repr', 'extra_json'];

function normalizeArtifact(a) {
  const row = {};
  for (const f of ARTIFACT_FIELDS) row[f] = a[f] ?? null;
  return row;
}

/**
 * Atomic write of one artifact + its vector + entity links. Enrich-then-commit:
 * the caller MUST fetch `float32Vector` (network) BEFORE calling, so a failed API call
 * never opens this transaction (CLAUDE.md rule 4). Returns { id, deduped }.
 * The FTS row is produced by the AFTER INSERT trigger — do not insert it here.
 */
export const storeArtifactTxn = db.transaction((artifact, float32Vector, links = []) => {
  const row = normalizeArtifact(artifact);
  const info = insertArtifactStmt.run(row);
  if (info.changes === 0) {
    // INSERT OR IGNORE skipped the row. The ONLY expected reason is a (source, source_id)
    // dedup hit — anything else (a NOT NULL / CHECK violation) must not be silently swallowed
    // as a dedup, or we'd lose a write and report success (violates append-only + no-swallow).
    const existing = row.source_id != null ? selectIdBySourceStmt.get(row.source, row.source_id) : null;
    if (!existing) {
      throw new Error(
        `storeArtifactTxn: insert ignored with no (source, source_id) match — likely a constraint ` +
        `violation (source=${row.source}, source_id=${row.source_id}, type=${row.type})`
      );
    }
    return { id: existing.id, deduped: true }; // genuine dedup — don't duplicate vector/links
  }
  const id = info.lastInsertRowid; // Number — safe for JSON responses
  // sqlite-vec vec0 PKs MUST bind as BigInt; a plain Number throws (data-model.md rule 1).
  insertVecArtifactStmt.run(BigInt(id), float32Vector);
  for (const l of links) {
    // entity_id + role are the entity_links PK and role is NOT NULL (#110); a missing one would be
    // silently dropped by INSERT OR IGNORE (it swallows constraint violations, incl. NOT NULL), so
    // fail fast and surface the caller's bug rather than lose the link (design-philosophy §1).
    if (l.entity_id == null || l.role == null) throw new Error(`storeArtifactTxn: link requires entity_id and role — got ${JSON.stringify(l)}`);
    insertLinkStmt.run(id, l.entity_id, l.role, l.confidence ?? 1.0);
  }
  return { id, deduped: false };
});

/**
 * Upsert one artifact on (source, source_id), reconciling the connector contract's
 * upsert-by-default (doc 04 §1.3/§3) with the store's append-only rule. Enrich-then-commit:
 * the caller MUST fetch `float32Vector` BEFORE calling (CLAUDE.md rule 4); pass null when
 * text_repr is unchanged so no re-embed happens (embedding is the expensive step).
 *
 *  - CREATE (no existing row): mirrors storeArtifactTxn — insert row + vector, resolve hints,
 *    log ingest_create. Requires a non-null vector.
 *  - UPDATE (row exists): rewrite ONLY the present derived/metadata fields (MUTABLE_FIELDS);
 *    originals are never destroyed (raw_path files untouched, content_hash still tracks the
 *    raw bytes, ingested_at frozen). The vec row is updated in place only when a new vector
 *    is passed. Hints are re-resolved (idempotent). The ingest_update log row carries the
 *    prior value of every changed field, so the full evolution of the derived record is
 *    reconstructable from the log (design-philosophy §1/§3) — the log IS the history.
 *
 * Entity links are additive on update (resolveEntityHints is INSERT OR IGNORE). Returns
 * { id, created, resolved, unresolved }.
 */
export const upsertArtifactTxn = db.transaction((artifact, float32Vector, hints = []) => {
  let existing = artifact.source_id != null
    ? getArtifactBySourceStmt.get(artifact.source, artifact.source_id)
    : null;

  if (!existing) {
    // Create path requires a vector — a null here would insert a broken vec row or throw an
    // opaque sqlite-vec error. Guard with a clear message (enrich-then-commit means the caller
    // fetches the embedding before opening this transaction — CLAUDE.md rule 4).
    if (!float32Vector) {
      throw new Error(
        `upsertArtifactTxn: create path requires an embedding vector ` +
        `(source=${artifact.source}, source_id=${artifact.source_id})`
      );
    }
    const row = normalizeArtifact(artifact);
    const info = insertArtifactStmt.run(row);
    if (info.changes === 0) {
      // INSERT OR IGNORE skipped the row. WAL lets a separate process (migrate, a connector
      // script) insert this (source, source_id) between our read above and this insert — a
      // normal concurrent-upsert outcome, not a failure. Re-read: if the row now exists, fall
      // through to the update path so the ingest stays idempotent (§1.3) instead of 500ing. If
      // it's STILL absent, the ignore was a real constraint violation — never swallow that.
      existing = getArtifactBySourceStmt.get(row.source, row.source_id);
      if (!existing) {
        throw new Error(
          `upsertArtifactTxn: insert ignored with no dedup match — likely a constraint violation ` +
          `(source=${row.source}, source_id=${row.source_id}, type=${row.type})`
        );
      }
      // fall through to the update path below
    } else {
      const id = info.lastInsertRowid; // Number — safe for JSON responses
      insertVecArtifactStmt.run(BigInt(id), float32Vector); // vec0 PK must bind as BigInt (rule 1)
      const { resolved, unresolved } = resolveEntityHints(id, hints);
      logEvent('ingest_create', row.source, { artifact_id: id, type: row.type });
      return { id, created: true, resolved, unresolved };
    }
  }

  const textChanged = artifact.text_repr != null && artifact.text_repr !== existing.text_repr;

  // Guard the enrich-then-commit window: the caller decided whether to re-embed from a read
  // taken BEFORE this transaction. If text_repr changed but no new vector was supplied, a
  // concurrent upsert of the same key changed the text underneath us — committing would leave
  // text_repr and its embedding out of sync. Fail loudly so the connector retries (idempotent)
  // rather than silently persisting a mismatch.
  if (textChanged && !float32Vector) {
    throw new Error(
      `upsertArtifactTxn: text_repr changed under a concurrent upsert (source=${artifact.source}, ` +
      `source_id=${artifact.source_id}) but no embedding was supplied — retry the ingest`
    );
  }

  // Update path: build the bind from present fields, tracking what actually changed.
  const changed = [];
  const prior = {};
  const bind = { id: existing.id };
  for (const f of MUTABLE_FIELDS) {
    const val = artifact[f] ?? null;
    bind[f] = val; // null → COALESCE keeps the existing value
    if (val !== null && val !== existing[f]) { changed.push(f); prior[f] = existing[f]; }
  }
  // Only touch text_repr (and thus fire the FTS trigger) when it actually changed; a
  // metadata-only wave uses the variant that omits it, so the FTS index isn't churned.
  if (textChanged) {
    updateArtifactStmt.run(bind);
  } else {
    const { text_repr, ...metaBind } = bind;
    updateArtifactMetaStmt.run(metaBind);
  }
  // Update the vector whenever a new one was supplied (in the normal flow that's exactly when
  // text_repr changed; a direct caller may also re-embed unchanged text).
  if (float32Vector) updateVecArtifactStmt.run(float32Vector, BigInt(existing.id));
  const { resolved, unresolved } = resolveEntityHints(existing.id, hints);
  logEvent('ingest_update', artifact.source, { artifact_id: existing.id, type: artifact.type, changed, prior });
  return { id: existing.id, created: false, resolved, unresolved };
});

// --- Shared helpers ---
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function logEvent(eventType, actor, details) {
  logStmt.run(eventType, actor, details == null ? null : JSON.stringify(details));
}

export const normalizeName = (s) => s.trim().toLowerCase();
// Digit-strip, then canonicalize the NANP country code: an 11-digit key beginning with `1`
// (US/Canada) drops the leading `1` so `+1 (256) 468-0130`, `1-256-468-0130`, and
// `(256) 468-0130` all collapse to `2564680130` and resolve to one contact (#129). Assumption:
// an 11-digit key starting with `1` is a US country code. Non-NANP international (e.g. `+44…`),
// bare 10-digit, and 7-digit local numbers are left untouched. Not full E.164 (would need a
// default region + libphonenumber) — out of scope; this covers US-with/without-`+1`.
export const normalizePhone = (s) => { const d = s.replace(/\D/g, ''); return /^1\d{10}$/.test(d) ? d.slice(1) : d; };

// The set of name aliases a person should answer to (#93). Always the full FN + each verbatim
// nickname; when `derive` is on (persons, not orgs) we also add:
//   - a given+family form when a middle name is present, so "Amy Schneider" resolves an entity
//     stored as "Amy Margaret Schneider" (exact-match lookup misses the middle name otherwise);
//   - a nickname+family form ("betsy allister"), so a related-name reference by nickname+surname
//     resolves alongside the bare nickname ("betsy").
// Prefers the structured N split (given/family/additional). When it's absent (e.g. the backfill,
// which only has canonical_name) we fall back to tokenizing FN, but ONLY for a clean 2- or
// 3-token name (first [middle] last) — a 4+ token name is too ambiguous (compound given names,
// multi-part surnames) to reduce to first+last without minting a wrong alias, so we skip it.
// `derive: false` (orgs) yields just the full name + nicknames — a company name has no given/
// family to reduce, and "Bank of America" must not become "bank america". Returns normalized,
// de-duped strings; callers INSERT OR IGNORE so re-runs are no-ops.
export function nameVariants({ fn, given, family, additional, nicknames = [], derive = true }) {
  const nicks = Array.isArray(nicknames) ? nicknames : [];
  const out = new Set();
  const add = (s) => { const n = typeof s === 'string' && normalizeName(s); if (n) out.add(n); };
  if (fn) add(fn);
  for (const nick of nicks) add(nick);
  if (derive) {
    const toks = typeof fn === 'string' ? fn.trim().split(/\s+/) : [];
    const g = given || toks[0];
    // Trust a structured family outright; from tokenization only accept the last of a 2/3-token name.
    const f = family || (toks.length === 2 || toks.length === 3 ? toks[toks.length - 1] : null);
    const hasMiddle = Boolean(additional) || toks.length === 3;
    if (hasMiddle && g && f) add(`${g} ${f}`);
    if (f) for (const nick of nicks) add(`${nick} ${f}`);
  }
  return [...out];
}

// Resolve a free-text name/email/phone into entity ids via the alias table. Name/email
// aliases are stored lowercased; phone aliases digits-only — so try both normalizations.
//
// No merge-tombstone redirect is needed here (#75): mergeEntities re-points EVERY
// entity_aliases row off the absorbed entity unconditionally (see repointAliasesStmt below —
// (alias, alias_type) is globally unique, so the repoint can never collide and is never
// partial), so an alias can never resolve to an id with entities.merged_into set. The same
// invariant is why resolveEntityHints' resolveAliasByTypeStmt lookup (used by the connector
// ingest lane) needs no redirect either — both read the same always-live table.
export function resolveEntityIds(term) {
  const ids = new Set(resolveAliasStmt.all(normalizeName(term)).map((r) => r.entity_id));
  const digits = normalizePhone(term);
  if (digits.length >= 7) for (const r of resolveAliasStmt.all(digits)) ids.add(r.entity_id);
  return [...ids];
}

// Query-time given-name prefix fallback (#184) — SEARCH PATH ONLY, deliberately separate from
// resolveEntityIds (which must stay exact-match/deterministic on the hot ingest/annotate/display
// path). Resolves a bare first name ("sam") to a person stored under a full name alias ("sam
// rivera"), but ONLY when exactly one distinct entity matches the token-boundary prefix — two
// people sharing a first name stay unresolved (a wrong filter is worse than none). Returns the
// single entity's id(s) or [] (no match, or ambiguous). LIKE metacharacters in the term are
// escaped (matching the stmt's ESCAPE '\') so a stray `%`/`_` can't widen the match.
export function resolveNameByPrefix(term) {
  const t = normalizeName(term).replace(/[\\%_]/g, '\\$&');
  if (!t) return [];
  const ids = resolveNameByPrefixStmt.all({ t }).map((r) => r.entity_id); // capped at 2 rows (see stmt)
  if (ids.length > 1) {
    console.error(`entity-resolve: "${term}" ambiguous (≥2 entities), left unresolved`);
    return [];
  }
  return ids; // 0 rows (no match) or the single matching entity
}

// Deterministic alias types earn confidence 1.0 outright (connector-supplied value ignored);
// name/handle earn only the connector-supplied confidence, capped (connector contract doc 04 §4).
const DETERMINISTIC_ALIAS_TYPES = new Set(['email', 'phone']);
const NAME_HANDLE_DEFAULT_CONFIDENCE = 0.7;
const NAME_HANDLE_CONFIDENCE_CAP = 0.9;

function hintConfidence(aliasType, supplied) {
  if (DETERMINISTIC_ALIAS_TYPES.has(aliasType)) return 1.0;
  // Garbage supplied values (NaN, Infinity, negative, non-number) are treated as absent
  // rather than persisted into entity_links.confidence, where they'd corrupt ranking.
  const isValidSupplied = typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0;
  return Math.min(isValidSupplied ? supplied : NAME_HANDLE_DEFAULT_CONFIDENCE, NAME_HANDLE_CONFIDENCE_CAP);
}

/**
 * Resolve connector-submitted alias hints against entity_aliases (connector contract doc 04
 * §4). Hints, never IDs — resolution is wholly core-side, so a buggy connector can never
 * corrupt the graph. An exact normalized match links every matching entity (ambiguity
 * preserved, not guessed away, per resolveEntityIds' own multi-match behavior); a miss
 * stages a row in unresolved_aliases for later retroactive resolution. Synchronous,
 * prepared-statements-only, no network — composable inside the caller's own open
 * transaction alongside the artifact write. Returns { resolved, unresolved } entity/alias
 * counts (future contract response fields resolved_entities / unresolved_aliases).
 */
export function resolveEntityHints(artifactId, hints) {
  let resolved = 0, unresolved = 0;
  // #119: the artifact's source is stamped on any proposal staged below — fetch it once here,
  // not per hint, since it's constant across the loop (only read when a suggested_kind miss occurs).
  let artifactSource = null, sourceFetched = false;
  const sourceOf = () => { if (!sourceFetched) { artifactSource = getArtifactStmt.get(artifactId)?.source ?? null; sourceFetched = true; } return artifactSource; };
  for (const hint of hints) {
    const aliasType = hint.alias_type ?? null;
    // '' rather than null: SQLite UNIQUE indexes don't treat NULL as equal to NULL, so a
    // role-less/type-less hint retried with the same input would otherwise insert a
    // duplicate row instead of hitting the UNIQUE constraint (breaks idempotency).
    const role = hint.role ?? '';
    const alias = aliasType === 'phone' ? normalizePhone(hint.alias) : normalizeName(hint.alias);
    const confidence = hintConfidence(aliasType, hint.confidence);
    const matches = resolveAliasByTypeStmt.all(alias, aliasType);
    if (matches.length) {
      for (const m of matches) insertLinkStmt.run(artifactId, m.entity_id, role, confidence);
      resolved += matches.length;
    } else {
      insertUnresolvedStmt.run(artifactId, alias, aliasType ?? '', role, hint.confidence ?? null);
      unresolved++;
      // #119: a hint carrying suggested_kind asks to CREATE (not just link) an entity — stage it
      // for human review instead of minting it, so low-signal senders never auto-pollute the graph.
      // The unresolved_aliases row above still stands, so approving later retroactively links this artifact.
      if (hint.suggested_kind) {
        proposeEntity({
          suggested_kind: hint.suggested_kind,
          name: hint.alias,
          alias,
          alias_type: aliasType ?? '',
          artifact_id: artifactId,
          source: sourceOf(),
          confidence: hint.confidence ?? null,
        });
      } else if (aliasType === 'phone' || aliasType === 'email') {
        // #154: the connector sent no suggested_kind, but the side directory may know this handle —
        // stage a person proposal with the directory's name (pre-filled) for review. Promotion into
        // the curated graph still requires approval; the unresolved_aliases row above stands, so an
        // approval retroactively links this artifact. Idempotent via proposed_entities' UNIQUE.
        const dirName = lookupDirectoryName(alias, aliasType);
        if (dirName) proposeEntity({ suggested_kind: 'person', name: dirName, alias, alias_type: aliasType, artifact_id: artifactId, source: sourceOf(), confidence: hint.confidence ?? null });
      }
    }
  }
  return { resolved, unresolved };
}

// The entity's own aliases, and the staged artifact hints matching one (alias, alias_type).
// alias_type != 'relation' keeps person<->person relation staging (resolveRelationHints) out —
// though entity_aliases never holds a 'relation' type anyway, so the guard is belt-and-suspenders.
// ORDER BY deterministic-first: when multiple hints share one (artifact, entity, role) they collide
// on entity_links' PK and INSERT OR IGNORE keeps the FIRST — so email/phone (1.0) must be tried
// before name/handle, or a capped-0.9 name link would wrongly shadow a deterministic match. Within
// a type, higher supplied confidence wins.
const selectEntityAliasesStmt = db.prepare(`SELECT alias, alias_type FROM entity_aliases WHERE entity_id = ? ORDER BY CASE alias_type WHEN 'email' THEN 0 WHEN 'phone' THEN 0 ELSE 1 END`);
const selectArtifactHintsStmt = db.prepare(`SELECT artifact_id, role, hint_confidence FROM unresolved_aliases WHERE alias = ? AND alias_type = ? AND alias_type != 'relation' ORDER BY hint_confidence DESC`);

/**
 * Retroactively link artifacts whose connector hints (doc 04 §4) were staged in
 * unresolved_aliases before this entity existed — "resolving retroactively links all queued
 * artifacts." For each of the entity's own aliases (name/email/phone/handle), form an
 * entity_links row for every staged hint matching (alias, alias_type). Confidence follows the
 * same hintConfidence() policy as resolveEntityHints, so ingest-time and retroactive linking
 * cannot diverge. Append-only + idempotent: staged rows are left in place (mirrors
 * resolveRelationHints) and the INSERT OR IGNORE + entity_links PK absorb re-runs. Called
 * automatically on contact import; NOT scheduled. Returns the count of links formed.
 */
export function resolveStagedArtifactHints(entityId) {
  let formed = 0;
  for (const { alias, alias_type } of selectEntityAliasesStmt.all(entityId)) {
    for (const hint of selectArtifactHintsStmt.all(alias, alias_type)) {
      const confidence = hintConfidence(alias_type, hint.hint_confidence);
      formed += insertLinkStmt.run(hint.artifact_id, entityId, hint.role, confidence).changes;
    }
  }
  return formed;
}

// Canonical person<->person relation vocabulary (issue #37). Maps an Apple X-ABLabel /
// Google `type` / Android relation label (lowercased) onto one enum; anything unrecognized is
// 'custom' with the original label preserved in entity_relations.raw_label.
const RELATION_TYPE_MAP = {
  spouse: 'spouse', husband: 'spouse', wife: 'spouse',
  partner: 'partner',
  'domestic partner': 'domesticPartner', domesticpartner: 'domesticPartner',
  child: 'child', son: 'child', daughter: 'child',
  parent: 'parent', mother: 'mother', mom: 'mother', father: 'father', dad: 'father',
  sibling: 'sibling', brother: 'brother', sister: 'sister',
  friend: 'friend', relative: 'relative',
  assistant: 'assistant', manager: 'manager',
  'referred by': 'referredBy', referredby: 'referredBy',
  worksat: 'worksAt', employer: 'worksAt',   // person->org employment edge (#88)
};
export const canonicalRelationType = (rawLabel) =>
  RELATION_TYPE_MAP[String(rawLabel ?? '').trim().toLowerCase()] || 'custom';

/**
 * Insert one append-only person<->person edge (OR IGNORE — re-inserting the same triple is a
 * no-op, so callers are idempotent). Logs `relation_added` only when a row is actually created.
 * Returns true if a new edge was written.
 */
export function upsertEntityRelation({ from_entity_id, to_entity_id, relation_type, raw_label = null, confidence = 1.0, source = null }, eventType = 'relation_added') {
  const info = insertRelationStmt.run({ from_entity_id, to_entity_id, relation_type, raw_label, confidence, source });
  if (info.changes > 0) logEvent(eventType, source ?? 'entity_relations', { from_entity_id, to_entity_id, relation_type, raw_label });
  return info.changes > 0;
}

/**
 * Resolve an org by name, or create it (kind='org') and seed its name aliases so pending relation
 * hints for that name resolve. For a person's employer field (#125) — trusted, deliberate contact
 * data, so NOT gated by the proposed-entities approval queue (which governs artifact-derived
 * entities). Idempotent: resolve-first means an existing org card (imported before or after) or a
 * re-import forms zero new entities. `derive:false` — a company name has no given/family to reduce
 * ("Bank of America" must not become "bank america"), mirroring the org-card alias seeding in
 * contacts.js. Returns the org entity id.
 */
export function ensureOrgEntity(name) {
  const existing = resolveEntityIds(name);
  if (existing.length) return existing[0];
  const id = insertEntityStmt.run('org', name, '{}').lastInsertRowid;
  for (const alias of nameVariants({ fn: name, derive: false })) insertAliasUnlessTombstoned(id, alias, 'name');
  return id;
}

// --- Place entities (#137): a geo-anchored, human-approved location node. ---
// A place's coordinates live in attrs_json {latitude, longitude, radius_km}; kind='place' is
// free-text (no DDL / vec / VECTOR_DIMENSION impact — a place has no embedding). Reuses the #68
// bbox+haversine prefilter pattern; haversineKm comes from geocode.js (no import cycle —
// geocode.js is I/O-pure and imports nothing from db.js).
const KM_PER_DEG_LAT = 111.32;   // matches search.js's geo-radius prefilter (#68)
const POLE_COS_EPSILON = 1e-6;   // below this |cos(lat)| the longitude span blows up — cover the whole band
const LON_ABS_MAX = 180;         // longitude range is [-180, 180]
const placeBboxStmt = db.prepare(`
  SELECT id, latitude, longitude FROM artifacts
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    AND latitude BETWEEN @latMin AND @latMax
    AND longitude BETWEEN @lonMin AND @lonMax
`);

/**
 * Resolve a place by name, or create it (kind='place') with its geo in attrs_json and seed name
 * aliases so `about_entity`/`search entities:[…]` resolve it. Mirrors ensureOrgEntity (#125):
 * resolve-first (idempotent — a 2nd call mints 0 entities/aliases), `derive:false` (a place name
 * has no given/family to reduce, like an org). Does NOT link artifacts — call
 * linkArtifactsToPlace(id) after. Returns the place entity id.
 */
export function ensurePlaceEntity(name, { latitude = null, longitude = null, radius_km = null } = {}) {
  const existing = resolveEntityIds(name);
  if (existing.length) return existing[0];
  const id = Number(insertEntityStmt.run('place', name, JSON.stringify({ latitude, longitude, radius_km })).lastInsertRowid);
  for (const alias of nameVariants({ fn: name, derive: false })) insertAliasUnlessTombstoned(id, alias, 'name');
  logEvent('entity_created', 'places', { entity_id: id, kind: 'place', canonical_name: name });
  return id;
}

/**
 * Link every GPS-bearing artifact within a place's radius to it via entity_links (role
 * 'location_of', OR IGNORE — idempotent, append-only). A degree bounding box narrows the SQL scan,
 * then an exact haversine pass trims it to a true circle (the #68 geoCandidateIds pattern). A place
 * with null/invalid coords or radius links nothing (logged), never throws. Runs in its own
 * transaction (nested via savepoint when called from createEntity/approveProposedEntity). Returns
 * the count of newly-created links.
 */
export const linkArtifactsToPlace = db.transaction((placeId) => {
  const { latitude, longitude, radius_km } = getEntity(placeId)?.attrs ?? {};
  const lat = Number(latitude);
  const lon = Number(longitude);
  const radiusKm = Number(radius_km);
  // Reject null/absent coords EXPLICITLY: Number(null) is 0, so relying on Number.isFinite alone
  // would center the search on (0,0) instead of no-op'ing. lat/lon of 0 (equator / prime meridian)
  // is a legitimate coordinate and still passes.
  if (latitude == null || longitude == null || ![lat, lon, radiusKm].every(Number.isFinite) || radiusKm <= 0) {
    logEvent('place_linked', 'places', { entity_id: placeId, linked: 0, reason: 'no-coords-or-radius' });
    return 0;
  }
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Near a pole longitude is meaningless (all meridians converge), so the box spans the ENTIRE
  // [-180, 180] band regardless of lon (matching geoCandidateIds #68 — NOT lon±180, which would
  // exclude valid longitudes when lon≠0); otherwise a degree-based half-width around lon.
  const nearPole = Math.abs(cosLat) < POLE_COS_EPSILON;
  const dLon = nearPole ? 0 : radiusKm / (KM_PER_DEG_LAT * Math.abs(cosLat));
  const rows = placeBboxStmt.all({
    latMin: lat - dLat, latMax: lat + dLat,
    lonMin: nearPole ? -LON_ABS_MAX : lon - dLon,
    lonMax: nearPole ? LON_ABS_MAX : lon + dLon,
  });
  let linked = 0;
  for (const r of rows) {
    if (haversineKm(lat, lon, r.latitude, r.longitude) > radiusKm) continue;
    if (insertLinkStmt.run(r.id, placeId, 'location_of', 1.0).changes > 0) linked++;
  }
  logEvent('place_linked', 'places', { entity_id: placeId, scanned: rows.length, linked });
  return linked;
});

// --- Event entities (#138): a time-bounded (optionally place-anchored) episode node. ---
// An event's span/place lives in attrs_json {start, end, place_entity_id?}; kind='event' is
// free-text (no DDL / vec impact — an event has no embedding). Reuses proposed_entities.attrs_json
// and the kind-generalized approveProposedEntity from #137. Linking is temporal (occurred_at in
// [start,end]) + an optional spatial intersect with the referenced place's radius.
const eventArtifactsStmt = db.prepare(`
  SELECT id, latitude, longitude FROM artifacts
  WHERE occurred_at IS NOT NULL
    AND datetime(occurred_at) >= datetime(@start)
    AND datetime(occurred_at) <= datetime(@end)
`);

/**
 * Resolve an event by name, or create it (kind='event') with its span/place in attrs_json and seed
 * name aliases so `about_entity`/`search entities:[…]` resolve it. Mirrors ensurePlaceEntity /
 * ensureOrgEntity: resolve-first (idempotent — a 2nd call mints 0), `derive:false` (an event name
 * has no given/family to reduce). Does NOT link artifacts — call linkArtifactsToEvent(id) after.
 * Returns the event entity id.
 */
export function ensureEventEntity(name, { start = null, end = null, place_entity_id = null } = {}) {
  const existing = resolveEntityIds(name);
  if (existing.length) return existing[0];
  const id = Number(insertEntityStmt.run('event', name, JSON.stringify({ start, end, place_entity_id })).lastInsertRowid);
  for (const alias of nameVariants({ fn: name, derive: false })) insertAliasUnlessTombstoned(id, alias, 'name');
  logEvent('entity_created', 'events', { entity_id: id, kind: 'event', canonical_name: name });
  return id;
}

/**
 * Link every artifact whose `occurred_at` falls in the event's [start, end] span to it via
 * entity_links (role 'part_of', OR IGNORE — idempotent, append-only). Dates are normalized to ISO
 * and compared with SQLite `datetime()` so a 'YYYY-MM-DD HH:MM:SS' occurred_at and an ISO span
 * compare correctly. If the event references a place (place_entity_id) with usable coords, linking
 * is ADDITIONALLY constrained to that place's radius (haversine) — coordless artifacts are excluded
 * since they can't be confirmed at the place; a referenced place with no usable coords degrades to
 * time-only (logged). An event with a null/invalid span links nothing (logged), never throws. Runs
 * in its own transaction (nested via savepoint from createEntity/approveProposedEntity). Returns the
 * count of newly-created links.
 */
export const linkArtifactsToEvent = db.transaction((eventId) => {
  const { start, end, place_entity_id } = getEntity(eventId)?.attrs ?? {};
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    logEvent('event_linked', 'events', { entity_id: eventId, linked: 0, reason: 'no-span' });
    return 0;
  }
  const rows = eventArtifactsStmt.all({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
  // Optional spatial constraint: only when the referenced place has usable coords + radius.
  let center = null, radiusKm = null;
  if (place_entity_id != null) {
    const { latitude, longitude, radius_km } = getEntity(place_entity_id)?.attrs ?? {};
    const plat = Number(latitude), plon = Number(longitude), prad = Number(radius_km);
    if (latitude != null && longitude != null && [plat, plon, prad].every(Number.isFinite) && prad > 0) {
      center = { lat: plat, lon: plon }; radiusKm = prad;
    } else {
      logEvent('event_linked', 'events', { entity_id: eventId, place_entity_id, reason: 'place-no-coords-time-only' });
    }
  }
  let linked = 0;
  for (const r of rows) {
    if (center) {
      if (r.latitude == null || r.longitude == null) continue;
      if (haversineKm(center.lat, center.lon, r.latitude, r.longitude) > radiusKm) continue;
    }
    if (insertLinkStmt.run(r.id, eventId, 'part_of', 1.0).changes > 0) linked++;
  }
  logEvent('event_linked', 'events', { entity_id: eventId, scanned: rows.length, linked, place_constrained: !!center });
  return linked;
});

/**
 * Stage a relation whose related name doesn't resolve yet: recorded on the owner's contact
 * artifact in unresolved_aliases (alias_type='relation', role=raw label). When the related
 * person is later imported, resolveRelationHints forms the edge. Idempotent via the table's
 * UNIQUE(artifact_id, alias, alias_type, role).
 */
export function stageRelationHint(artifactId, relatedName, rawLabel) {
  insertUnresolvedStmt.run(artifactId, normalizeName(relatedName), 'relation', rawLabel, 1.0);
  // Also stage a given+family reduction of a 3-token related name (#93), so a card that names
  // someone by their full middle-name form ("Amy Margaret Schneider") still matches an entity
  // aliased only as given+family ("amy schneider"). Gated to exactly 3 tokens for the same reason
  // nameVariants is: a 4+ token name can't be reduced to first+last without minting a wrong match.
  // Idempotent via the table's UNIQUE key.
  const toks = String(relatedName ?? '').trim().split(/\s+/);
  if (toks.length === 3) {
    const reduced = normalizeName(`${toks[0]} ${toks[toks.length - 1]}`);
    if (reduced && reduced !== normalizeName(relatedName)) {
      insertUnresolvedStmt.run(artifactId, reduced, 'relation', rawLabel, 1.0);
    }
  }
}

/**
 * Form edges for staged relations that now resolve to `entityId` — i.e. an earlier import
 * named this person as someone's relation before their own contact existed. Matches the
 * entity's name aliases against staged hints, derives the "from" side from the hint artifact's
 * self-link, and inserts the (canonicalized) edge. Append-only and idempotent (staged rows are
 * left in place; the OR IGNORE edge insert absorbs re-runs). Returns the count of edges formed.
 */
export function resolveRelationHints(entityId) {
  let formed = 0;
  for (const { alias } of selectNameAliasesStmt.all(entityId)) {
    for (const hint of selectRelationHintsStmt.all(alias)) {
      const from = selectSelfEntityStmt.get(hint.artifact_id);
      if (!from || from.entity_id === entityId) continue; // no self-loop
      const relation_type = canonicalRelationType(hint.role);
      if (upsertEntityRelation({ from_entity_id: from.entity_id, to_entity_id: entityId, relation_type, raw_label: hint.role, confidence: 1.0, source: 'vcard' }, 'relation_resolved')) {
        formed++;
      }
    }
  }
  return formed;
}

export function getRelations(entityId) {
  return getRelationsStmt.all(entityId);
}

export function getRelationsTo(entityId) {
  return getRelationsToStmt.all(entityId);
}

export function getEntity(id) {
  const e = getEntityStmt.get(id);
  if (e && e.attrs_json) e.attrs = safeJson(e.attrs_json);
  return e;
}

// --- Entity merge & duplicate detection (#75) ---
// Identity resolution is the hard unsolved-in-general problem (doc 03 §7) — this is the
// "accept occasional manual merges" admin surface, not auto-resolution.
const getLiveEntityStmt = db.prepare('SELECT * FROM entities WHERE id = ? AND merged_into IS NULL');
const tombstoneEntityStmt = db.prepare('UPDATE entities SET merged_into = ? WHERE id = ?');
// entity_aliases has no unique key on entity_id, and (alias, alias_type) is globally unique
// across the WHOLE table (not per-entity) — so re-pointing entity_id can never collide with
// an existing row; a plain UPDATE (no OR IGNORE) is correct and complete.
const repointAliasesStmt = db.prepare('UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ?');
const countAliasesStmt = db.prepare('SELECT COUNT(*) AS n FROM entity_aliases WHERE entity_id = ?');
const countLinksStmt = db.prepare('SELECT COUNT(*) AS n FROM entity_links WHERE entity_id = ?');
// entity_links' PK is (artifact_id, entity_id, role) — repointing CAN collide when the
// survivor already has a link for the same artifact+role (e.g. both entities were separately
// hinted as "mentioned" on the same artifact before being recognized as one person). Delete
// the absorbed side's row FIRST when that's the case — it's an exact duplicate of a row the
// survivor already has, so nothing is lost — THEN repoint the remainder unconditionally.
// (An earlier version used UPDATE OR IGNORE alone, which left the duplicate permanently
// orphaned pointing at the tombstoned id — visible forever via getLinksStmt/get_artifact.)
const deleteDuplicateLinksStmt = db.prepare(`
  DELETE FROM entity_links
  WHERE entity_id = @absorb
    AND EXISTS (
      SELECT 1 FROM entity_links k
      WHERE k.entity_id = @keep AND k.artifact_id = entity_links.artifact_id AND k.role = entity_links.role
    )
`);
const repointLinksStmt = db.prepare('UPDATE entity_links SET entity_id = ? WHERE entity_id = ?');
const countRelationsStmt = db.prepare('SELECT COUNT(*) AS n FROM entity_relations WHERE from_entity_id = ? OR to_entity_id = ?');
// A direct keep<->absorb relation edge is meaningless once they're recognized as one person —
// drop it before repointing so the repoint below can never produce a from=to self-loop. This
// one is genuinely DELETED, not moved (see the moved-count comment in mergeEntities).
const deleteSelfRelationsStmt = db.prepare(`
  DELETE FROM entity_relations
  WHERE (from_entity_id = @keep AND to_entity_id = @absorb) OR (from_entity_id = @absorb AND to_entity_id = @keep)
`);
// entity_relations is UNIQUE(from_entity_id, to_entity_id, relation_type) on both edge columns —
// dedupe-then-repoint each side separately, same reasoning and same fix as entity_links above.
const deleteDuplicateRelationsFromStmt = db.prepare(`
  DELETE FROM entity_relations
  WHERE from_entity_id = @absorb
    AND EXISTS (
      SELECT 1 FROM entity_relations k
      WHERE k.from_entity_id = @keep AND k.to_entity_id = entity_relations.to_entity_id AND k.relation_type = entity_relations.relation_type
    )
`);
const repointRelationsFromStmt = db.prepare('UPDATE entity_relations SET from_entity_id = ? WHERE from_entity_id = ?');
const deleteDuplicateRelationsToStmt = db.prepare(`
  DELETE FROM entity_relations
  WHERE to_entity_id = @absorb
    AND EXISTS (
      SELECT 1 FROM entity_relations k
      WHERE k.to_entity_id = @keep AND k.from_entity_id = entity_relations.from_entity_id AND k.relation_type = entity_relations.relation_type
    )
`);
const repointRelationsToStmt = db.prepare('UPDATE entity_relations SET to_entity_id = ? WHERE to_entity_id = ?');

/**
 * Merge two entities: tombstone `absorbId` (merged_into = keepId, row never deleted —
 * design-philosophy.md §1) and re-point its aliases/links/relations to `keepId`. All-or-nothing
 * in one transaction. Throws (never silently no-ops) when either id is missing/already merged,
 * or when keepId === absorbId — callers map these to 404/422. Returns
 * { keep_id, absorb_id, moved: { aliases, links, relations } }. Every one of the absorbed
 * entity's original alias/link/relation rows ends up represented on the survivor — either
 * physically repointed, or deleted because it exactly duplicated a row the survivor already
 * had (never left dangling on the tombstoned id) — so `moved` is an exact count, counted right
 * after the one row category that's genuinely deleted rather than moved (a direct keep<->absorb
 * relation edge) is removed.
 */
export const mergeEntities = db.transaction((keepId, absorbId) => {
  if (keepId === absorbId) {
    const err = new Error('mergeEntities: keep_id and absorb_id must differ');
    err.code = 'SELF_MERGE';
    throw err;
  }
  const keep = getLiveEntityStmt.get(keepId);
  const absorb = getLiveEntityStmt.get(absorbId);
  if (!keep || !absorb) {
    const err = new Error('mergeEntities: keep_id or absorb_id not found (or already merged)');
    err.code = 'NOT_FOUND';
    throw err;
  }
  deleteSelfRelationsStmt.run({ keep: keepId, absorb: absorbId });
  const moved = {
    aliases: countAliasesStmt.get(absorbId).n,
    links: countLinksStmt.get(absorbId).n,
    relations: countRelationsStmt.get(absorbId, absorbId).n,
  };
  repointAliasesStmt.run(keepId, absorbId);
  deleteDuplicateLinksStmt.run({ keep: keepId, absorb: absorbId });
  repointLinksStmt.run(keepId, absorbId);
  deleteDuplicateRelationsFromStmt.run({ keep: keepId, absorb: absorbId });
  repointRelationsFromStmt.run(keepId, absorbId);
  deleteDuplicateRelationsToStmt.run({ keep: keepId, absorb: absorbId });
  repointRelationsToStmt.run(keepId, absorbId);
  tombstoneEntityStmt.run(keepId, absorbId);
  logEvent('entity_merged', 'entities', {
    keep_id: keepId, absorb_id: absorbId, moved,
    absorbed_attrs: absorb.attrs_json ? safeJson(absorb.attrs_json) : null,
  });
  return { keep_id: keepId, absorb_id: absorbId, moved };
});

// Cheap token-overlap-free string similarity for typo/spelling near-duplicates ("Jon Smith" vs
// "John Smith") — NOT nickname resolution ("Bob" vs "Robert" needs a name dictionary, out of
// scope; see #75 Out of Scope). 1 - (Levenshtein distance / longer string's length).
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}
function nameSimilarity(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen ? 1 - levenshtein(na, nb) / maxLen : 0;
}
const NAME_SIMILARITY_THRESHOLD = 0.6;
// Guard against an unbounded event-loop stall: the O(n²) Levenshtein pass below is only
// "acceptable at contact-book scale" (see listProbableDuplicates' doc comment) if that
// assumption holds. Past this many live person entities, skip that pass (phone/email
// matching — both O(n) — still runs) rather than silently let it grow quadratically forever.
const NAME_SIMILARITY_MAX_ENTITIES = 5000;

const listLivePersonEntitiesStmt = db.prepare(
  `SELECT id, canonical_name, attrs_json FROM entities WHERE kind = 'person' AND merged_into IS NULL`
);
// The contact's own artifact (role='self') — used as the embedding-distance tie-breaker signal.
const getSelfArtifactVecStmt = db.prepare(`
  SELECT v.embedding FROM entity_links el JOIN vec_artifacts v ON v.artifact_id = el.artifact_id
  WHERE el.entity_id = ? AND el.role = 'self' LIMIT 1
`);
// sqlite-vec (loaded above) ships vec_distance_cosine() as a callable SQL scalar function —
// reuse it instead of hand-parsing the raw BLOB into a Float32Array. It returns cosine
// DISTANCE (1 - similarity); a raw Buffer from a SELECT binds directly, no conversion needed.
const cosineDistanceStmt = db.prepare('SELECT vec_distance_cosine(?, ?) AS d');

/**
 * Rank candidate duplicate PERSON entities never merged into each other, by cheap signals:
 * a shared normalized phone/email in their contact attrs (strong — contacts.js only
 * auto-merges on shared email/exact name at import, NEVER on phone, so two records sharing a
 * phone number is a real, common residue) and name similarity (typo-level; NOT nicknames).
 * Embedding distance between each pair's own contact artifact enriches the reason as a
 * tie-breaker rather than a standalone O(n²) sweep over the whole corpus. Read-only — never
 * merges; a human (via merge_entities) decides. O(n²) over live person entities, acceptable at
 * contact-book scale (hundreds to low thousands) for this on-demand admin call, not the search
 * hot path. Returns pairs sorted by score desc, capped at `limit`.
 */
export function listProbableDuplicates(limit = 20) {
  const entities = listLivePersonEntitiesStmt.all();
  const nameById = new Map(entities.map((e) => [e.id, e.canonical_name]));
  const byPhone = new Map();
  const byEmail = new Map();
  for (const e of entities) {
    const attrs = e.attrs_json ? safeJson(e.attrs_json) ?? {} : {};
    for (const p of attrs.phones ?? []) {
      const norm = normalizePhone(p);
      if (norm.length < 7) continue;
      if (!byPhone.has(norm)) byPhone.set(norm, []);
      byPhone.get(norm).push(e.id);
    }
    for (const em of attrs.emails ?? []) {
      const norm = normalizeName(em);
      if (!norm) continue;
      if (!byEmail.has(norm)) byEmail.set(norm, []);
      byEmail.get(norm).push(e.id);
    }
  }

  const pairs = new Map(); // "minId:maxId" -> { a, b, score, reasons: [] }
  const addPair = (idA, idB, score, reason) => {
    if (idA === idB) return;
    const a = Math.min(idA, idB), b = Math.max(idA, idB);
    const key = `${a}:${b}`;
    const existing = pairs.get(key) ?? { a, b, score: 0, reasons: [] };
    existing.score = Math.max(existing.score, score);
    existing.reasons.push(reason);
    pairs.set(key, existing);
  };
  for (const [phone, ids] of byPhone) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addPair(ids[i], ids[j], 0.9, `shared phone ${phone}`);
  }
  for (const [email, ids] of byEmail) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addPair(ids[i], ids[j], 0.95, `shared email ${email}`);
  }
  if (entities.length > NAME_SIMILARITY_MAX_ENTITIES) {
    console.error(
      `listProbableDuplicates: skipping the O(n²) name-similarity pass — ${entities.length} live ` +
      `person entities exceeds NAME_SIMILARITY_MAX_ENTITIES (${NAME_SIMILARITY_MAX_ENTITIES}); ` +
      `phone/email matching still ran`
    );
  } else {
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const sim = nameSimilarity(entities[i].canonical_name, entities[j].canonical_name);
        if (sim >= NAME_SIMILARITY_THRESHOLD) {
          addPair(entities[i].id, entities[j].id, sim, `similar name ("${entities[i].canonical_name}" vs "${entities[j].canonical_name}")`);
        }
      }
    }
  }

  // Memoize each entity's own contact-artifact vector once — an entity can appear in several
  // candidate pairs (e.g. a shared-phone match AND a similar-name match), and without this a
  // popular id would re-trigger the same entity_links/vec_artifacts join for every pair it's in.
  const vecByEntity = new Map();
  const vecFor = (id) => {
    if (!vecByEntity.has(id)) vecByEntity.set(id, getSelfArtifactVecStmt.get(id)?.embedding ?? null);
    return vecByEntity.get(id);
  };

  return [...pairs.values()]
    .map((p) => {
      const vecA = vecFor(p.a);
      const vecB = vecFor(p.b);
      let reason = p.reasons.join('; ');
      if (vecA && vecB) reason += `; contact text ${Math.round((1 - cosineDistanceStmt.get(vecA, vecB).d) * 100)}% similar`;
      return {
        a: { id: p.a, name: nameById.get(p.a) },
        b: { id: p.b, name: nameById.get(p.b) },
        score: Math.round(p.score * 100) / 100,
        reason,
      };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

// The reference-face input for photo-exif's face-worker `suggest-labels` command (#84): live
// person entities whose own contact artifact has a preserved photo (raw_path, from #74's vCard
// PHOTO persistence). Company entities and photo-less contacts are excluded at the query level.
// One row per entity, never per artifact: an entity can end up with more than one role='self'
// contact artifact (re-importing the same person from a second vCard source under a different
// UID resolves to the same entity but creates a NEW self-linked artifact, per contacts.js's
// resolveExistingEntity — this is the ordinary multi-source-consolidation case, not an edge
// case) — the correlated subquery picks the most-recently-created photo deterministically,
// mirroring the LIMIT-1-per-entity discipline getSelfArtifactVecStmt already applies to this
// exact join shape. `merged_into IS NULL` is provably redundant here (mergeEntities re-points
// every entity_links row off an absorbed entity unconditionally, so no such row can ever join
// back to a tombstoned e.id) — kept anyway as defense-in-depth, matching this file's dominant
// style of explicit liveness checks (getLiveEntityStmt, listLivePersonEntitiesStmt).
const listContactPhotosStmt = db.prepare(`
  SELECT entity_id, name, photo_file, raw_path FROM (
    SELECT e.id AS entity_id, e.canonical_name AS name,
      -- Uploaded UI override (#97), a bare basename; json_valid guards a malformed attrs_json
      -- (unconstrained TEXT) so json_extract can't throw at query time (mirrors the #88 migration).
      CASE WHEN json_valid(e.attrs_json) THEN json_extract(e.attrs_json, '$.photoFile') END AS photo_file,
      (SELECT a.raw_path FROM entity_links el JOIN artifacts a ON a.id = el.artifact_id
       WHERE el.entity_id = e.id AND el.role = 'self' AND a.raw_path IS NOT NULL
       ORDER BY a.id DESC LIMIT 1) AS raw_path
    FROM entities e
    WHERE e.kind = 'person' AND e.merged_into IS NULL
  )
  WHERE photo_file IS NOT NULL OR raw_path IS NOT NULL
  ORDER BY entity_id
  LIMIT ?
`);

/**
 * List photographed contacts for reference-face matching. Read-only; core never computes or
 * compares face descriptors itself — that stays connector-local (doc 04 §11 rejects
 * connector-supplied embeddings, and the inverse holds too: core doesn't do connector-side ML).
 * Returns BOTH photo candidates per contact — the uploaded UI override (`photo_file`, bare
 * basename) and the imported vCard photo (`raw_path`) — so the server can apply the same
 * uploaded-wins precedence as GET /api/v1/entities/:id/photo (#112). db.js stays fs-free: it does
 * not resolve/confine `photo_file` (no CONTACTS_RAW_DIR here) — the server's resolver does that.
 * `raw_path` is passed through path.resolve() before returning. contacts.js now stores an
 * already-absolute raw_path (resolved at import time, against that import's own cwd — the only
 * moment the correct base directory is unambiguous), so this is a no-op for new rows; it's a
 * backward-compat shim for any row imported before that fix, when CONTACTS_RAW_DIR's relative
 * default meant raw_path was stored relative to whatever cwd `import:contacts` happened to run
 * from. Resolving here against the SERVER's cwd is only correct for those old rows if the server
 * happens to share import's cwd — best-effort for pre-existing data, not a general guarantee.
 */
export function listContactPhotos(limit = 100) {
  return listContactPhotosStmt.all(limit).map((r) => ({
    entity_id: r.entity_id, name: r.name,
    photo_file: r.photo_file ?? null,
    raw_path: r.raw_path ? path.resolve(r.raw_path) : null, // only resolve a present imported path
  }));
}

// --- Contacts curation surface (#96) ---
// The core-owned admin API the contacts web UI drives: correct a contact's aliases/attrs, edit
// relationships, set a photo. Same posture as mergeEntities above — the entity graph is mutable
// curation state (raw `contact` artifacts stay append-only; nothing here touches them), and every
// mutation logs to ingest_log with before/after so the derived record's history is reconstructable.
const listEntitiesStmt = db.prepare(`
  SELECT id, kind, canonical_name, attrs_json,
    EXISTS (
      SELECT 1 FROM entity_links el JOIN artifacts a ON a.id = el.artifact_id
      WHERE el.entity_id = entities.id AND el.role = 'self' AND a.raw_path IS NOT NULL
    ) AS has_photo
  FROM entities
  WHERE merged_into IS NULL
    AND (@kind IS NULL OR kind = @kind)
    AND (@like IS NULL
         OR LOWER(canonical_name) LIKE @like
         OR id IN (SELECT entity_id FROM entity_aliases WHERE alias LIKE @like))
  ORDER BY canonical_name COLLATE NOCASE
  LIMIT @limit OFFSET @offset
`);
const getAliasesStmt = db.prepare('SELECT alias, alias_type FROM entity_aliases WHERE entity_id = ? ORDER BY alias_type, alias');
const profileArtifactsStmt = db.prepare(`
  SELECT a.id, a.type, a.occurred_at, a.text_repr, el.role
  FROM entity_links el JOIN artifacts a ON a.id = el.artifact_id
  WHERE el.entity_id = ? ORDER BY a.id DESC LIMIT ?
`);
const updateEntityRowStmt = db.prepare('UPDATE entities SET canonical_name = COALESCE(?, canonical_name), attrs_json = ? WHERE id = ?');
const deleteAliasStmt = db.prepare('DELETE FROM entity_aliases WHERE entity_id = ? AND alias = ? AND alias_type = ?');
// Alias tombstones (#111): a removal records one here; additive inserts consult it, an explicit
// add clears it. All callers pass an ALREADY-normalized alias (same normalization as entity_aliases).
const insertTombstoneStmt = db.prepare('INSERT OR IGNORE INTO alias_tombstones (entity_id, alias, alias_type) VALUES (?, ?, ?)');
const deleteTombstoneStmt = db.prepare('DELETE FROM alias_tombstones WHERE entity_id = ? AND alias = ? AND alias_type = ?');
const hasTombstoneStmt = db.prepare('SELECT 1 FROM alias_tombstones WHERE entity_id = ? AND alias = ? AND alias_type = ?');
// The additive-insert guard: import/re-import (#94), profile edits, and hint resolution route alias
// creation through this so a tombstoned (deliberately-removed) alias is NOT resurrected. Returns the
// number of rows inserted (0 when suppressed by a tombstone or an OR IGNORE duplicate). The alias
// must already be normalized. Explicit user re-adds (addAlias) bypass this and clear the tombstone.
export function insertAliasUnlessTombstoned(entityId, alias, aliasType) {
  if (hasTombstoneStmt.get(entityId, alias, aliasType)) return 0;
  return insertAliasStmt.run(entityId, alias, aliasType).changes;
}
const getRelationByIdStmt = db.prepare('SELECT * FROM entity_relations WHERE id = ?');
const deleteRelationStmt = db.prepare('DELETE FROM entity_relations WHERE id = ?');
// The self-linked contact artifact's photo (most-recent, mirroring listContactPhotos' subquery).
const getSelfPhotoStmt = db.prepare(`
  SELECT a.raw_path FROM entity_links el JOIN artifacts a ON a.id = el.artifact_id
  WHERE el.entity_id = ? AND el.role = 'self' AND a.raw_path IS NOT NULL
  ORDER BY a.id DESC LIMIT 1
`);

const notFound = (id) => { const err = new Error(`entity ${id} not found (or merged)`); err.code = 'NOT_FOUND'; throw err; };
// email/phone aliases are globally UNIQUE(alias, alias_type). Adding one already owned by a
// DIFFERENT live entity would silently no-op (insertAliasStmt is OR IGNORE) and quietly fail to
// take effect — surface it as a conflict instead so the UI can offer a merge (mergeEntities).
// name/handle aliases are exempt from this friendly pre-check only: the UNIQUE(alias, alias_type)
// constraint still applies to them (an alias value is single-owner per type — two people named
// "chris" can't both hold ('chris','name')), so a same-type name/handle collision falls through to
// OR IGNORE and silently no-ops (first-writer-wins) rather than raising ALIAS_CONFLICT. They are not
// truly shareable; the exemption just means such a collision fails silently instead of loudly.
function assertNoAliasConflict(entityId, normAlias, aliasType) {
  if (aliasType !== 'email' && aliasType !== 'phone') return;
  const other = resolveAliasByTypeStmt.all(normAlias, aliasType).map((r) => r.entity_id).find((eid) => eid !== entityId);
  if (other != null) {
    const err = new Error(`${aliasType} "${normAlias}" already belongs to entity ${other}`);
    err.code = 'ALIAS_CONFLICT';
    err.conflict = { alias: normAlias, alias_type: aliasType, entity_id: other };
    throw err;
  }
}
const normalizeAlias = (alias, aliasType) => (aliasType === 'phone' ? normalizePhone(alias) : normalizeName(alias));
// Recent linked artifacts shown on a contact's profile (GET /:id) — a preview, not the full set.
const PROFILE_ARTIFACT_LIMIT = 10;

export function listEntities({ kind = null, query = null, limit = 50, offset = 0 } = {}) {
  const like = query && query.trim() ? `%${normalizeName(query)}%` : null;
  return listEntitiesStmt.all({ kind, like, limit, offset }).map((e) => {
    const attrs = e.attrs_json ? safeJson(e.attrs_json) : null;
    // hasPhoto: same "effective photo" precedence as the /photo route + #112 — an uploaded
    // override (attrs.photoFile) OR an imported vCard photo (self-linked artifact raw_path,
    // computed as has_photo in SQL). Lets the list badge which contacts have a picture without
    // fetching any image.
    return { id: e.id, kind: e.kind, canonical_name: e.canonical_name, attrs, hasPhoto: Boolean(e.has_photo) || Boolean(attrs?.photoFile) };
  });
}

export function getEntityProfile(id) {
  const entity = getLiveEntityStmt.get(id);
  if (!entity) return null;
  return {
    entity: { id: entity.id, kind: entity.kind, canonical_name: entity.canonical_name, attrs: entity.attrs_json ? safeJson(entity.attrs_json) : null },
    aliases: getAliasesStmt.all(id),
    relations: getRelations(id),
    relations_in: getRelationsTo(id),
    artifacts: profileArtifactsStmt.all(id, PROFILE_ARTIFACT_LIMIT),
  };
}

// Create a person/org from the UI (e.g. a related contact that doesn't exist yet). Seeds name/
// email/phone aliases exactly like the vCard import path so the new entity is resolvable. Any
// supplied email/phone that already belongs to another entity is a conflict (throws) — a new
// contact must not silently inherit someone else's alias.
export const createEntity = db.transaction(({ kind, canonical_name, attrs = {} }) => {
  const emails = [...new Set((attrs.emails ?? []).map((e) => normalizeName(e)).filter(Boolean))];
  const phones = [...new Set((attrs.phones ?? []).map((p) => normalizePhone(p)).filter(Boolean))];
  for (const e of emails) assertNoAliasConflict(-1, e, 'email');
  for (const p of phones) assertNoAliasConflict(-1, p, 'phone');
  const id = Number(insertEntityStmt.run(kind, canonical_name, JSON.stringify(attrs)).lastInsertRowid);
  for (const alias of nameVariants({ fn: canonical_name, nicknames: attrs.nicknames, derive: kind === 'person' })) insertAliasUnlessTombstoned(id, alias, 'name');
  for (const e of emails) insertAliasUnlessTombstoned(id, e, 'email');
  for (const p of phones) insertAliasUnlessTombstoned(id, p, 'phone');
  logEvent('entity_created', 'contacts-ui', { entity_id: id, kind, canonical_name });
  // Trusted manual place/event creation (#137/#138): link matching artifacts immediately so the
  // entity is recallable without a separate call. No-ops (never throws) on absent coords/span.
  if (kind === 'place') linkArtifactsToPlace(id);
  else if (kind === 'event') linkArtifactsToEvent(id);
  return id;
});

// --- PROPOSED ENTITIES (#119): human-approval gate for entities auto-proposed from artifacts ---
// Stage a proposal (no entity is minted). Plain function (no transaction of its own): it runs
// INSIDE resolveEntityHints, which runs inside the caller's ingest transaction. Hoisted so
// resolveEntityHints (defined earlier) can call it. Idempotent via the table's UNIQUE key.
// Returns true when a NEW proposal row was written (false when the UNIQUE key already existed —
// INSERT OR IGNORE). Callers that count staged proposals (the #154 backfill) rely on this to stay
// idempotent; resolveEntityHints ignores the return.
export function proposeEntity({ suggested_kind, name, alias, alias_type, artifact_id = null, source = null, confidence = null, attrs_json = null }) {
  const attrs = attrs_json == null ? null : (typeof attrs_json === 'string' ? attrs_json : JSON.stringify(attrs_json));
  return insertProposalStmt.run(suggested_kind, name, alias, alias_type, artifact_id, source, confidence, attrs).changes > 0;
}

// List proposals by status (default the review queue: pending), newest first.
export function listProposedEntities(status = 'pending', limit = 20) {
  return listProposalsStmt.all(status, limit);
}

// Approve a pending proposal: create the entity, seed its aliases (name variants + the exact staged
// key so email/phone/handle hints resolve too), mark the proposal approved, then
// resolveStagedArtifactHints so the originating artifact(s) link. One transaction — a mid-way
// failure rolls back to no entity, proposal still pending.
export const approveProposedEntity = db.transaction((id) => {
  const p = getProposalStmt.get(id);
  if (!p) { const err = new Error(`proposal ${id} not found`); err.code = 'NOT_FOUND'; throw err; }
  if (p.status !== 'pending') { const err = new Error(`proposal ${id} already ${p.status}`); err.code = 'ALREADY_RESOLVED'; throw err; }
  // If an entity already carries this exact (alias, alias_type) — e.g. a contact was imported
  // after the proposal was staged — link to it instead of minting a duplicate (review note #119).
  const existing = resolveAliasByTypeStmt.all(p.alias, p.alias_type);
  let entityId, created = false;
  if (existing.length) {
    entityId = existing[0].entity_id;
  } else {
    // A place/event proposal carries its staged geo/span in attrs_json (#137); person/org have NULL.
    entityId = Number(insertEntityStmt.run(p.suggested_kind, p.suggested_name, p.attrs_json ?? '{}').lastInsertRowid);
    for (const v of nameVariants({ fn: p.suggested_name, derive: p.suggested_kind === 'person' })) insertAliasUnlessTombstoned(entityId, v, 'name');
    insertAliasUnlessTombstoned(entityId, p.alias, p.alias_type);
    created = true;
  }
  setProposalResolvedStmt.run(entityId, id);
  const linked = resolveStagedArtifactHints(entityId);
  // A place mints with staged coords then links in-radius artifacts (#137); an event mints with its
  // staged span then links artifacts in that time window (+ place radius if referenced, #138) — the
  // location_of / part_of edges that make about_entity('<place|event>') return its artifacts.
  const placeLinked = p.suggested_kind === 'place' ? linkArtifactsToPlace(entityId) : 0;
  const eventLinked = p.suggested_kind === 'event' ? linkArtifactsToEvent(entityId) : 0;
  logEvent('proposed_entity_approved', 'proposed-entities', { proposal_id: id, entity_id: entityId, created, suggested_kind: p.suggested_kind, suggested_name: p.suggested_name, linked, place_linked: placeLinked, event_linked: eventLinked });
  return { entity_id: entityId };
});

// Reject a proposal — status='rejected', retained (append-only) so re-ingest never re-raises it.
export const rejectProposedEntity = db.transaction((id) => {
  const p = getProposalStmt.get(id);
  if (!p) { const err = new Error(`proposal ${id} not found`); err.code = 'NOT_FOUND'; throw err; }
  // Can't reject an already-approved proposal — that would flip status approved→rejected while the
  // created entity lives on, mislabeling the audit trail. Re-rejecting a rejected one is a no-op.
  if (p.status === 'approved') { const err = new Error(`proposal ${id} already approved`); err.code = 'ALREADY_RESOLVED'; throw err; }
  setProposalStatusStmt.run('rejected', id);
  logEvent('proposed_entity_rejected', 'proposed-entities', { proposal_id: id, suggested_name: p.suggested_name });
  return { rejected: true };
});

// Overwrite a contact's editable attrs (+ optional rename), reconciling email/phone aliases to
// match the new attrs. Additive for names (a rename adds new name variants; old ones stay, as a
// person may still be referenced by them). photoFile/raw_path are server-owned — a PATCH can
// neither set nor wipe them (the upload route + import own them). Conflicts are checked before
// any write; a throw rolls the whole transaction back.
export const updateEntityAttrs = db.transaction((id, { canonical_name = null, attrs = null } = {}) => {
  const cur = getLiveEntityStmt.get(id) || notFound(id);
  const before = cur.attrs_json ? safeJson(cur.attrs_json) : {};
  const next = attrs ? { ...attrs } : { ...before };
  delete next.photoFile; delete next.raw_path;
  if (before.photoFile) next.photoFile = before.photoFile; // preserve server-owned photo
  const set = (arr, fn) => [...new Set((arr ?? []).map(fn).filter(Boolean))];
  const oldEmails = set(before.emails, normalizeName), newEmails = set(next.emails, normalizeName);
  const oldPhones = set(before.phones, normalizePhone), newPhones = set(next.phones, normalizePhone);
  for (const e of newEmails) if (!oldEmails.includes(e)) assertNoAliasConflict(id, e, 'email');
  for (const p of newPhones) if (!oldPhones.includes(p)) assertNoAliasConflict(id, p, 'phone');
  if (canonical_name && canonical_name !== cur.canonical_name)
    for (const alias of nameVariants({ fn: canonical_name, nicknames: next.nicknames, derive: cur.kind === 'person' })) insertAliasUnlessTombstoned(id, alias, 'name');
  for (const e of newEmails) if (!oldEmails.includes(e)) insertAliasUnlessTombstoned(id, e, 'email');
  for (const e of oldEmails) if (!newEmails.includes(e)) { deleteAliasStmt.run(id, e, 'email'); insertTombstoneStmt.run(id, e, 'email'); } // tombstone so a re-import can't re-add it (#111)
  for (const p of newPhones) if (!oldPhones.includes(p)) insertAliasUnlessTombstoned(id, p, 'phone');
  for (const p of oldPhones) if (!newPhones.includes(p)) { deleteAliasStmt.run(id, p, 'phone'); insertTombstoneStmt.run(id, p, 'phone'); }
  updateEntityRowStmt.run(canonical_name, JSON.stringify(next), id);
  logEvent('entity_edited', 'contacts-ui', { entity_id: id, before, after: next, renamed_to: canonical_name && canonical_name !== cur.canonical_name ? canonical_name : null });
  return { updated: true };
});

// Reduce a person entity's display name to first+last when it's a clean 3-token first-middle-last
// (#156), keeping the full name (and the reduced form) as resolvable name aliases. The import path
// now defaults new contacts to first+last; this fixes the ones imported before that. Idempotent:
// a 2-token canonical is left alone, so a re-run reduces 0. Only touches person entities that
// aren't merged away; a UI-shortened name is already 2-token and skipped.
const setCanonicalNameStmt = db.prepare('UPDATE entities SET canonical_name = ? WHERE id = ?');
export const reduceEntityDisplayName = db.transaction((id) => {
  const e = getEntityStmt.get(id);
  if (!e || e.kind !== 'person' || e.merged_into != null || !e.canonical_name) return { changed: false };
  const toks = e.canonical_name.trim().split(/\s+/);
  if (toks.length !== 3) return { changed: false }; // only first-middle-last reduces (2/4+ untouched)
  const reduced = `${toks[0]} ${toks[2]}`;
  if (reduced === e.canonical_name) return { changed: false };
  insertAliasUnlessTombstoned(id, normalizeName(e.canonical_name), 'name'); // keep the full name resolvable
  insertAliasUnlessTombstoned(id, normalizeName(reduced), 'name');           // and the reduced form
  // Only rename if the reduced form actually resolves to THIS entity — a prior UI tombstone (#111)
  // would have refused the alias above, and a cross-entity collision (first-writer-wins) leaves it
  // owned elsewhere; renaming the display to a name that doesn't resolve back here would break the
  // guarantee, so skip the reduction in that case (Copilot, PR #157). The full name stays aliased.
  if (!resolveAliasByTypeStmt.all(normalizeName(reduced), 'name').some((r) => r.entity_id === id)) {
    return { changed: false, skipped: 'reduced-name-unresolvable' };
  }
  setCanonicalNameStmt.run(reduced, id);
  logEvent('display_name_reduced', 'backfill-display-names', { entity_id: id, from: e.canonical_name, to: reduced });
  return { changed: true, from: e.canonical_name, to: reduced };
});

export const addAlias = db.transaction((id, alias, alias_type) => {
  if (!getLiveEntityStmt.get(id)) notFound(id);
  const a = normalizeAlias(alias, alias_type);
  if (!a) { const err = new Error('empty alias'); err.code = 'BAD_ALIAS'; throw err; }
  assertNoAliasConflict(id, a, alias_type);
  // Explicit user re-add overrides a prior removal (#111): clear the tombstone, then insert directly.
  if (deleteTombstoneStmt.run(id, a, alias_type).changes > 0) logEvent('alias_tombstone_cleared', 'contacts-ui', { entity_id: id, alias: a, alias_type });
  const added = insertAliasStmt.run(id, a, alias_type).changes > 0;
  if (added) logEvent('alias_added', 'contacts-ui', { entity_id: id, alias: a, alias_type });
  return { added };
});

export const removeAlias = db.transaction((id, alias, alias_type) => {
  const a = normalizeAlias(alias, alias_type);
  const removed = deleteAliasStmt.run(id, a, alias_type).changes > 0;
  if (removed) {
    // Record the removal (#111) so an additive re-add (import/re-import/edit/hint) can't silently
    // resurrect it — but only if the entity row exists: #110's integrity pass leaves pre-existing
    // FK orphans in place, and a tombstone for a missing entity would throw
    // SQLITE_CONSTRAINT_FOREIGNKEY. For an orphaned alias, resurrection is moot (nothing resolves to
    // a missing entity), so skip the tombstone and just log the removal.
    if (getEntityStmt.get(id)) insertTombstoneStmt.run(id, a, alias_type);
    logEvent('alias_removed', 'contacts-ui', { entity_id: id, alias: a, alias_type });
  }
  return { removed };
});

export const removeRelation = db.transaction((relationId) => {
  const row = getRelationByIdStmt.get(relationId);
  if (!row) return { removed: false };
  deleteRelationStmt.run(relationId);
  logEvent('relation_removed', 'contacts-ui', { relation_id: relationId, from_entity_id: row.from_entity_id, to_entity_id: row.to_entity_id, relation_type: row.relation_type, raw_label: row.raw_label });
  return { removed: true };
});

// Record an uploaded photo's basename in attrs.photoFile (server-owned key — see updateEntityAttrs).
export const setEntityPhotoFile = db.transaction((id, basename) => {
  const cur = getLiveEntityStmt.get(id) || notFound(id);
  const before = cur.attrs_json ? safeJson(cur.attrs_json) : {};
  updateEntityRowStmt.run(null, JSON.stringify({ ...before, photoFile: basename }), id);
  logEvent('entity_edited', 'contacts-ui', { entity_id: id, photoFile: basename, prev_photoFile: before.photoFile ?? null });
  return { photoFile: basename };
});

// The effective photo path for a contact: the self-linked contact artifact's raw_path (imported
// vCard photo), absolute. The uploaded-photo override (attrs.photoFile) is resolved by the route,
// which confines it to CONTACTS_RAW_DIR. Returns null when the contact has no imported photo.
export function getContactPhotoRawPath(id) {
  const row = getSelfPhotoStmt.get(id);
  return row?.raw_path ? path.resolve(row.raw_path) : null;
}

// Handle-annotation for display (#147, #154). A connector bakes raw contact handles into text_repr
// ("Message from +12406725399: …"); recall reads far better with the resolved name folded in.
// Non-mutating: derives a display string; the stored text_repr (embedded, append-only) is never
// touched, the displayed handle stays raw (only the match key is normalized, #129).
//
// Precedence per handle token:
//   1. A curated entity LINKED to this artifact — exactly one match → its canonical name wins;
//      an ambiguous match (>1 linked entity) is left raw, never mis-attributed.
//   2. Otherwise the side contact_directory (#154) — display-only auto-label; creates no entity,
//      needs no approval. So a handle with no curated link (a number quoted in a message body, an
//      unlinked sender) is now labeled IF the directory knows it; still-unknown tokens stay verbatim.
// Curated resolution is skipped entirely when the artifact has no links (the query couldn't match)
// and a per-call cache resolves a repeated handle once — both avoid wasted queries on the hot
// hydration path (Copilot, PR #155). Curated resolution is scoped to the token's OWN alias_type
// (email→email, phone→phone) rather than routed through resolveEntityIds, which also tries the phone
// path on any 7+-digit string — an email like "h1471234567@example.com" would otherwise digit-strip
// to a phone alias and mis-attribute (Copilot, PR #148).
// Email domain is label-based (`label(.label)*.tld`) rather than `[A-Za-z0-9.-]+\.[A-Za-z]{2,}`:
// the old form let `.` sit in both the greedy class and the following literal, so an adversarial
// `x@` + `a.`×N backtracked super-linearly. Labels can't contain `.`, so there's no overlap to
// backtrack across (#150). Phone alternative unchanged.
const HANDLE_TOKEN_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}|\+?\d[\d().-]{5,}\d/g;
const resolveHandleToken = (tok) => {
  if (tok.includes('@')) return resolveAliasByTypeStmt.all(normalizeName(tok), 'email').map((r) => r.entity_id);
  const digits = normalizePhone(tok);
  return digits.length >= 7 ? resolveAliasByTypeStmt.all(digits, 'phone').map((r) => r.entity_id) : [];
};
export function annotateHandles(text, links) {
  if (!text) return text;
  const nameById = new Map((links ?? []).map((l) => [l.entity_id, l.canonical_name]));
  const cache = new Map(); // per-call memo: a handle repeated in one text resolves once (Copilot, PR #155 / #150)
  return text.replace(HANDLE_TOKEN_RE, (tok) => {
    if (cache.has(tok)) return cache.get(tok);
    let name = null, ambiguous = false;
    if (nameById.size) { // curated resolution only when the artifact has links
      const matched = resolveHandleToken(tok).filter((id) => nameById.has(id));
      if (matched.length === 1) name = nameById.get(matched[0]);
      else if (matched.length > 1) ambiguous = true;
    }
    if (!name && !ambiguous) name = lookupDirectoryName(tok, tok.includes('@') ? 'email' : 'phone'); // #154 directory fallback
    const out = name ? `${name} (${tok})` : tok;
    cache.set(tok, out);
    return out;
  });
}

export function getArtifactById(id) {
  const a = getArtifactStmt.get(id);
  if (!a) return null;
  a.extra = a.extra_json ? safeJson(a.extra_json) : null;
  a.links = getLinksStmt.all(id);
  a.display_text = annotateHandles(a.text_repr, a.links);
  return a;
}

// Batch links loader for the read paths that DON'T go through getArtifactById (timeline,
// about_entity — #149). One query over all row ids (json_each), grouped in JS by artifact_id, so
// annotating N rows costs a single round-trip, not N. getLinksStmt is single-id and stays private.
const getLinksForIdsStmt = db.prepare(`
  SELECT el.artifact_id, el.entity_id, el.role, el.confidence, e.canonical_name, e.kind
  FROM entity_links el JOIN entities e ON e.id = el.entity_id
  WHERE el.artifact_id IN (SELECT value FROM json_each(?))
`);
// Attach display_text (#147) to a batch of raw artifact rows in place, returning the same array.
// Same read-time, non-mutating annotation as getArtifactById; a row with no links keeps text_repr.
export function annotateArtifactRows(rows) {
  if (!rows?.length) return rows;
  const linksById = new Map();
  for (const l of getLinksForIdsStmt.all(JSON.stringify(rows.map((r) => r.id)))) {
    if (!linksById.has(l.artifact_id)) linksById.set(l.artifact_id, []);
    linksById.get(l.artifact_id).push(l);
  }
  for (const r of rows) r.display_text = annotateHandles(r.text_repr, linksById.get(r.id) ?? []);
  return rows;
}

// Raw artifact row by its upsert key, or undefined. Used by the ingest orchestrator to decide
// whether text_repr changed (and thus whether to re-embed) before opening upsertArtifactTxn.
export const getArtifactBySource = (source, sourceId) => getArtifactBySourceStmt.get(source, sourceId);
// Read-only existence check for the connector /exists endpoint (#198): the subset of `sourceIds`
// already stored under `source`. Point lookups reuse the prepared selectIdBySourceStmt (indexed by
// UNIQUE(source, source_id)), so there's no dynamically-built IN() SQL; the batch is capped ≤100 by
// the route schema, and this is a pure read — no write, no ingest_log row.
export function existingSourceIds(source, sourceIds) {
  const present = [];
  const checked = new Set(); // dedup input: a duplicate source_id → one lookup, one output at most
  for (const sourceId of sourceIds) {
    if (checked.has(sourceId)) continue;
    checked.add(sourceId);
    if (selectIdBySourceStmt.get(source, sourceId)) present.push(sourceId);
  }
  return present;
}
// The entity a contact artifact self-links to (role='self') — the authoritative owner for the
// contacts re-import update path (#94), resilient to a post-import merge (links repoint to survivor).
export const getSelfEntityId = (artifactId) => selectSelfEntityStmt.get(artifactId)?.entity_id ?? null;

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Entity write statements exposed for the contacts connector (composes its own txn).
export { insertEntityStmt, insertAliasStmt, selectIdByHashStmt };
// insertAliasUnlessTombstoned is exported at its definition (used by the contacts importer, #111).
