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
    type          TEXT NOT NULL,        -- email|document|photo|video|contact|post|location_ping|note
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

  -- Semantic index (dim MUST equal the embedding model's output).
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_artifacts USING vec0(
    artifact_id INTEGER PRIMARY KEY,
    embedding float[${VECTOR_DIMENSION}]
  );
  -- Keyword/exact index — vectors miss proper nouns and exact strings.
  CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
    text_repr, content='artifacts', content_rowid='id'
  );
  -- Keep FTS in sync. The store is APPEND-ONLY (no UPDATE/DELETE of artifacts), so a
  -- single AFTER INSERT trigger is complete — the delete/update shadow triggers that
  -- external-content FTS normally needs don't apply. (Never run ('rebuild') — a double
  -- run or an empty-table rebuild corrupts/duplicates the index.)
  CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
    INSERT INTO artifacts_fts(rowid, text_repr) VALUES (new.id, new.text_repr);
  END;

  -- Append-only log of significant transitions (design-philosophy.md §3).
  CREATE TABLE IF NOT EXISTS ingest_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    event_type  TEXT NOT NULL,          -- migrate|import_contacts|store_note|dedup_skip
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
const selectIdBySourceStmt = db.prepare('SELECT id FROM artifacts WHERE source = ? AND source_id = ?');
const selectIdByHashStmt = db.prepare('SELECT id FROM artifacts WHERE content_hash = ? LIMIT 1');
const getArtifactStmt = db.prepare('SELECT * FROM artifacts WHERE id = ?');
const getLinksStmt = db.prepare(`
  SELECT el.entity_id, el.role, el.confidence, e.canonical_name, e.kind
  FROM entity_links el JOIN entities e ON e.id = el.entity_id
  WHERE el.artifact_id = ?
`);
const insertEntityStmt = db.prepare('INSERT INTO entities (kind, canonical_name, attrs_json) VALUES (?, ?, ?)');
const insertAliasStmt = db.prepare('INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_type) VALUES (?, ?, ?)');
const resolveAliasStmt = db.prepare('SELECT DISTINCT entity_id FROM entity_aliases WHERE alias = ?');
const getEntityStmt = db.prepare('SELECT * FROM entities WHERE id = ?');
const logStmt = db.prepare('INSERT INTO ingest_log (event_type, actor, details) VALUES (?, ?, ?)');

// The 11 artifact columns storeArtifactTxn writes; callers pass a partial and we fill nulls.
const ARTIFACT_FIELDS = ['type', 'source', 'source_id', 'content_hash', 'occurred_at',
  'latitude', 'longitude', 'place_label', 'raw_path', 'text_repr', 'extra_json'];

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

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Entity write statements exposed for the contacts connector (composes its own txn).
export { insertEntityStmt, insertAliasStmt, selectIdByHashStmt };
