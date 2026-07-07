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
import { DB_PATH, VECTOR_DIMENSION } from './config.js';

export const db = new Database(DB_PATH);
sqliteVec.load(db);
db.pragma('journal_mode = WAL'); // concurrent readers (data-model.md rule 5)

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
    entity_id  INTEGER REFERENCES entities(id),
    alias      TEXT NOT NULL,           -- normalized (lowercase names/emails, digits-only phones)
    alias_type TEXT,                    -- email|phone|name|handle
    UNIQUE(alias, alias_type)
  );
  CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);
  CREATE TABLE IF NOT EXISTS entity_links (
    artifact_id INTEGER REFERENCES artifacts(id),
    entity_id   INTEGER REFERENCES entities(id),
    role        TEXT,                   -- sender|recipient|pictured|mentioned|author|self|location_of
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
    alias_type      TEXT,                -- email|phone|name|handle
    role            TEXT,
    hint_confidence REAL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(artifact_id, alias, alias_type, role)
  );
  CREATE INDEX IF NOT EXISTS idx_unresolved_alias ON unresolved_aliases(alias, alias_type);

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
    event_type  TEXT NOT NULL,          -- migrate|import_contacts|store_note|dedup_skip|ingest_create|ingest_update
    actor       TEXT,
    details     TEXT                    -- JSON
  );
`);

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
// text_repr is always present (required), so its assignment always fires the artifacts_au
// FTS trigger. source / source_id (the upsert key) and ingested_at (first-ingest time) are
// never in the SET clause.
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
const getEntityStmt = db.prepare('SELECT * FROM entities WHERE id = ?');
const logStmt = db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)');

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
    insertLinkStmt.run(id, l.entity_id, l.role ?? null, l.confidence ?? 1.0);
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
  const existing = artifact.source_id != null
    ? getArtifactBySourceStmt.get(artifact.source, artifact.source_id)
    : null;

  if (!existing) {
    const row = normalizeArtifact(artifact);
    const info = insertArtifactStmt.run(row);
    if (info.changes === 0) {
      // No (source, source_id) row existed a statement ago, so an ignored insert here is a
      // constraint violation, not a dedup — never swallow it as success (append-only + no-swallow).
      throw new Error(
        `upsertArtifactTxn: insert ignored with no dedup match — likely a constraint violation ` +
        `(source=${row.source}, source_id=${row.source_id}, type=${row.type})`
      );
    }
    const id = info.lastInsertRowid; // Number — safe for JSON responses
    insertVecArtifactStmt.run(BigInt(id), float32Vector); // vec0 PK must bind as BigInt (rule 1)
    const { resolved, unresolved } = resolveEntityHints(id, hints);
    logEvent('ingest_create', row.source, { artifact_id: id, type: row.type });
    return { id, created: true, resolved, unresolved };
  }

  // Guard the enrich-then-commit window: the caller decided whether to re-embed from a read
  // taken BEFORE this transaction. If text_repr differs from what we're about to write but no
  // new vector was supplied, a concurrent upsert of the same key changed the text underneath us
  // — committing would leave text_repr and its embedding out of sync. Fail loudly so the
  // connector retries (idempotent) rather than silently persisting a mismatch.
  if (!float32Vector && artifact.text_repr != null && artifact.text_repr !== existing.text_repr) {
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
  updateArtifactStmt.run(bind);
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
export const normalizePhone = (s) => s.replace(/\D/g, '');

// Resolve a free-text name/email/phone into entity ids via the alias table. Name/email
// aliases are stored lowercased; phone aliases digits-only — so try both normalizations.
export function resolveEntityIds(term) {
  const ids = new Set(resolveAliasStmt.all(normalizeName(term)).map((r) => r.entity_id));
  const digits = normalizePhone(term);
  if (digits.length >= 7) for (const r of resolveAliasStmt.all(digits)) ids.add(r.entity_id);
  return [...ids];
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
    }
  }
  return { resolved, unresolved };
}

export function getEntity(id) {
  const e = getEntityStmt.get(id);
  if (e && e.attrs_json) e.attrs = safeJson(e.attrs_json);
  return e;
}

export function getArtifactById(id) {
  const a = getArtifactStmt.get(id);
  if (!a) return null;
  a.extra = a.extra_json ? safeJson(a.extra_json) : null;
  a.links = getLinksStmt.all(id);
  return a;
}

// Raw artifact row by its upsert key, or undefined. Used by the ingest orchestrator to decide
// whether text_repr changed (and thus whether to re-embed) before opening upsertArtifactTxn.
export const getArtifactBySource = (source, sourceId) => getArtifactBySourceStmt.get(source, sourceId);

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Entity write statements exposed for the contacts connector (composes its own txn).
export { insertEntityStmt, insertAliasStmt, selectIdByHashStmt };
