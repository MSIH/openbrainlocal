# Open Brain 2 — Design Document

**A local, unified memory system for your entire digital footprint**

Evolves the OB1 text-memory server (Node.js + SQLite + sqlite-vec) into a system that ingests emails, documents, contacts, photos, videos, social posts, and location/time data — and can recall across all of them the way human memory does: by meaning, by person, by place, and by time.

---

## 1. Core Philosophy

### 1.1 The senses are multimodal; the mind is not

The human brain doesn't store photons or air pressure. Eyes and ears **transduce** raw sensory input into a common neural representation, and memory operates on that. Open Brain 2 copies this architecture:

| Human | Open Brain 2 |
|---|---|
| Eyes | Vision-language model (captioning, OCR, subject detection) |
| Ears | Whisper (speech → transcript) |
| Sense of time/place | EXIF, email headers, GPS logs → structured columns |
| Recognizing people | Contact entities + (optional) face clustering |
| Associative recall | Vector embeddings over the text representation |
| "Where was I when...?" | SQL filters on time + location, fused with vector rank |

**Design rule: every artifact gets normalized into exactly three things:**

1. **`text_repr`** — a natural-language description of the artifact (embedded for semantic search)
2. **Structured metadata** — timestamp, lat/lon, type, source (filtered with plain SQL)
3. **Entity links** — edges to people, places, and events (traversed as a graph)

This is the "describe, then embed" pattern. It's the pragmatic current-tech answer: instead of chasing a single embedding space that natively understands images, audio, and text (possible, but immature and lossy for retrieval-by-meaning), you convert everything to text — the representation LLMs are best at — and keep the raw artifact on disk as ground truth.

### 1.2 Three memory layers (mirrors human memory)

| Layer | Human analog | Implementation |
|---|---|---|
| **Episodic** | "That dinner in New Orleans" | `artifacts` table — every email, photo, doc as an event in time/space |
| **Semantic** | "Sarah is my sister; she lives in Austin" | `entities` + `entity_links` — durable facts and relationships |
| **Associative** | Fuzzy recall by vibe/meaning | `vec_artifacts` + FTS5 — hybrid retrieval |

Retrieval fuses all three: *"photos of Sarah from the New Orleans trip"* = entity filter (Sarah) ∩ location filter (New Orleans bbox) ∩ time filter ∩ vector rank on "dinner, celebration, trip."

---

## 2. Data Model

### 2.1 Unified artifact schema

```sql
CREATE TABLE artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,        -- email | document | photo | video |
                                      -- contact | post | location_ping | note
  source        TEXT NOT NULL,        -- gmail | icloud | filesystem | takeout | manual
  source_id     TEXT,                 -- provider's ID (dedup key)
  content_hash  TEXT,                 -- sha256 of raw bytes (dedup + integrity)
  occurred_at   DATETIME,             -- when it HAPPENED (photo taken, email sent)
  ingested_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  latitude      REAL,                 -- nullable
  longitude     REAL,                 -- nullable
  place_label   TEXT,                 -- reverse-geocoded: "Montrose, Houston, TX"
  raw_path      TEXT,                 -- pointer to original file on disk
  text_repr     TEXT NOT NULL,        -- normalized text — this gets embedded
  extra_json    TEXT,                 -- type-specific fields (EXIF, headers, etc.)
  UNIQUE(source, source_id)
);

CREATE INDEX idx_artifacts_time  ON artifacts(occurred_at);
CREATE INDEX idx_artifacts_type  ON artifacts(type, occurred_at);
CREATE INDEX idx_artifacts_hash  ON artifacts(content_hash);
```

Key decisions:

- **`occurred_at` ≠ `ingested_at`.** The photo from 2019 you import today must sort into 2019. This is what makes timeline queries work.
- **`raw_path`, not raw blobs.** SQLite holds pointers + text; originals stay on the filesystem (or NAS). DB stays small and fast; nothing is ever lossy.
- **`extra_json`** absorbs type-specific structure (email headers, EXIF camera model, video duration) without schema churn. Promote a field to a real column only when you need to index/filter on it.

### 2.2 Entity graph (the relationship layer)

```sql
CREATE TABLE entities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,       -- person | place | org | event | topic
  canonical_name TEXT NOT NULL,
  attrs_json     TEXT,                -- person: emails[], phones[], birthday,
                                      -- address, relationship ("sister")
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Aliases solve identity resolution: "Mom", "sarah.j@gmail.com",
-- "+1-555-0142", and "Sarah Jones" are all the same entity.
CREATE TABLE entity_aliases (
  entity_id INTEGER REFERENCES entities(id),
  alias     TEXT NOT NULL,            -- normalized (lowercase, digits-only phones)
  alias_type TEXT,                    -- email | phone | name | handle
  UNIQUE(alias, alias_type)
);

CREATE TABLE entity_links (
  artifact_id INTEGER REFERENCES artifacts(id),
  entity_id   INTEGER REFERENCES entities(id),
  role        TEXT,                   -- sender | recipient | pictured |
                                      -- mentioned | author | location_of
  confidence  REAL DEFAULT 1.0,       -- 1.0 = deterministic (email header),
                                      -- <1.0 = inferred (NER, face match)
  PRIMARY KEY (artifact_id, entity_id, role)
);
```

**Contacts are the spine.** Your contacts import seeds the `entities` table with high-quality person records (name, emails, phones, birthday, relationship). Every subsequent artifact links to them deterministically: email `From:` header matches an alias → hard link, confidence 1.0. A name mentioned in a document body → NER-inferred link, confidence 0.7. Confidence lets retrieval prefer certain links without discarding fuzzy ones.

### 2.3 Search indexes

```sql
-- Semantic (existing OB1 pattern, now keyed to artifacts)
CREATE VIRTUAL TABLE vec_artifacts USING vec0(
  artifact_id INTEGER PRIMARY KEY,
  embedding float[1536]
);

-- Keyword/exact match — vectors are bad at names, IDs, exact phrases
CREATE VIRTUAL TABLE artifacts_fts USING fts5(
  text_repr, content='artifacts', content_rowid='id'
);
```

Hybrid (vector + FTS5, fused with reciprocal rank fusion) is the current best practice — semantic search alone whiffs on proper nouns and exact strings, which your footprint is full of.

---

## 3. Ingestion Pipeline

```
Source connector → Normalizer → Enricher(s) → Store (transaction)
```

Each stage is idempotent; `(source, source_id)` and `content_hash` make re-runs safe. Same discipline as OB1's `storeTxn`: **enrich first (API calls), then commit atomically** — a failed caption never orphans a row.

### 3.1 Per-type normalization and enrichment

| Type | Source connector | `occurred_at` | `text_repr` construction | Entity links |
|---|---|---|---|---|
| **Email** | IMAP, or Gmail/Google Takeout mbox | `Date:` header | Subject + cleaned body (strip quotes/signatures) + "From X to Y" | Sender/recipients via alias match (1.0) |
| **Document** | Filesystem watcher / manual | file mtime or doc metadata | Extracted text (pdf-parse, mammoth for docx); LLM summary if huge | NER on body (inferred) |
| **Contact** | vCard / CardDAV / Google Contacts | — | "Sarah Jones, sister, lives in Austin, birthday March 4, email …" | IS an entity; artifact row makes it semantically searchable |
| **Photo** | Filesystem / iCloud or Google Photos export | EXIF `DateTimeOriginal` | VLM caption: subjects, scene, activity, visible text (OCR) | EXIF GPS → place entity; face clustering → person (optional, local) |
| **Video** | Filesystem export | file/container metadata | Whisper transcript + VLM captions of N keyframes | Speakers/subjects (inferred) |
| **Social post** | Platform data exports (Takeout, Twitter/X archive, Facebook DYI) | post timestamp | Post text + caption of attached media + engagement context | Mentions, tagged people |
| **Location** | Google Timeline export / Owntracks / iOS Significant Locations | ping timestamp | Segmented into *visits*: "At Common Bond Montrose, 9:14–10:02 AM" | Place entity |

Notes:

- **Location pings get segmented, not stored raw.** A million GPS points are noise; ~10 "visits" per day are memories. Cluster pings into visit windows, reverse-geocode once per visit, store the visit as the artifact. Keep raw pings in `extra_json` or a side table if the hoarder instinct demands it.
- **Photos are the highest-value phase-2 target.** EXIF alone (time + GPS) makes them queryable before any AI runs; VLM captioning then unlocks "photos of us cooking."
- **Videos are photos + audio.** Keyframe extraction (ffmpeg, 1 frame per scene change) + Whisper covers 90% of recall value at low cost.

### 3.2 Enrichment tech choices (current, practical)

| Job | Cloud (via your OpenRouter gateway) | Local (privacy-max) |
|---|---|---|
| Embeddings | `text-embedding-3-small` (keep — it works) | `nomic-embed-text` via Ollama (768-dim; change vec table dim) |
| Image captioning/OCR | `claude-haiku` / `gpt-4o-mini` (cents per thousand images) | LLaVA / Qwen2.5-VL via Ollama |
| Speech → text | — | `whisper.cpp` (local is genuinely best here) |
| NER / entity extraction | Small LLM with JSON-output prompt | Same model via Ollama |
| Face clustering | ❌ never cloud | `insightface` — embeddings + DBSCAN, cluster IDs you name once |
| Reverse geocoding | — | Offline dataset (e.g., `local-reverse-geocoder`) — keeps location data local |
| EXIF | — | `exifr` (npm) |

**Recommendation:** cloud VLM for the initial photo backlog (fast, cheap, quality), local-only for faces and location. Make the enricher an interface so each job's backend is a config flag.

### 3.3 One optional second index: true image embeddings

"Describe then embed" covers semantic recall. If you later want *visual similarity* ("find photos that look like this one"), add a second vec table with CLIP-family embeddings (`jina-clip-v2` or SigLIP, both runnable locally). It's additive — don't build it in v2.0.

---

## 4. Retrieval: The Query Planner

The single biggest upgrade over OB1. `search_memories(query)` becomes a two-stage planner:

**Stage 1 — Parse the query into filters + semantic core** (one cheap LLM call):

```
"photos of Sarah from our New Orleans trip last spring"
→ {
    types: ["photo"],
    entities: ["Sarah"],           → resolve via entity_aliases
    place: "New Orleans"           → bbox or place_label LIKE
    time: 2025-03-01 .. 2025-06-01,
    semantic: "trip, vacation, together"
  }
```

**Stage 2 — Filter, then rank:**

```sql
-- SQL prefilter shrinks the candidate set
SELECT a.id FROM artifacts a
JOIN entity_links el ON el.artifact_id = a.id
WHERE a.type = 'photo'
  AND el.entity_id = :sarah_id
  AND a.occurred_at BETWEEN :t0 AND :t1
  AND a.place_label LIKE '%New Orleans%';
```

Then vector-rank only within those candidates (sqlite-vec supports `partition key` columns and metadata filtering as of v0.1.6 — or do the filter-then-KNN join in SQL). Fuse with FTS5 results via reciprocal rank fusion.

**Graph expansion for relationship queries:** "what's going on with my sister" → resolve relationship attr → Sarah entity → walk `entity_links` → recent artifacts of any type, sorted by `occurred_at`. No embedding needed at all.

### 4.1 MCP tool surface (v2)

Keep the per-session server factory and Streamable HTTP transport from v2.2 unchanged. New/updated tools:

- `store_memory(content)` — unchanged (manual notes are just `type='note'` artifacts)
- `search(query, types?, time_range?, entities?, limit?)` — hybrid planner above
- `timeline(start, end, types?)` — pure chronological recall
- `about_entity(name)` — resolve → profile + linked artifact digest ("everything about Sarah")
- `get_artifact(id)` — full `text_repr` + metadata + `raw_path`

---

## 5. Memory Consolidation (the sleep cycle)

Humans don't keep raw sensory streams; they consolidate. A nightly batch job:

1. **Daily digest** — LLM summarizes yesterday's artifacts into one `type='note'` artifact ("Emailed 3 donors for MSIH; brunch at Common Bond; shipped OB2 ingestion PR"). Digests are what make *"what was I doing last October"* answerable in one hit instead of 400.
2. **Entity refresh** — new facts fold into `entities.attrs_json` ("Sarah changed jobs").
3. **Rollups** — weekly/monthly digests built from daily ones, hierarchical.

Cheap (one small-model call per day), and it's the feature that makes the system feel like memory instead of search.

---

## 6. Build Phases

| Phase | Scope | Why this order |
|---|---|---|
| **2.0** | Artifact schema + entity graph + FTS5; migrate OB1 memories to `type='note'`; contacts import; query planner v1 | Foundation; contacts seed the entity spine; everything is text-native (no new AI deps) |
| **2.1** | Email (Takeout mbox first, IMAP later) | Highest-density relationship data; deterministic entity links prove the graph |
| **2.2** | Documents + filesystem watcher | Easy win on existing pipeline |
| **2.3** | Photos: EXIF pass first (instantly queryable), VLM caption backlog second | Biggest emotional/recall payoff |
| **2.4** | Location visits + daily digests | Timeline becomes continuous; consolidation begins |
| **2.5** | Video/audio (Whisper + keyframes); social media exports | Heavier compute, lower marginal value — last |
| **Future** | Face clustering, CLIP visual similarity, cross-device sync, temporal knowledge graph (facts with validity ranges) | Additive, each independently optional |

Each phase is a new connector + enricher against a **stable core schema** — the schema is the contract; senses get added over time, exactly like the framing in §1.

---

## 7. Practical Constraints & Risks

- **Scale:** SQLite + sqlite-vec is comfortable to ~1M artifacts. A decade of personal data ≈ 100k–500k artifacts after location segmentation. You're fine; WAL mode already handles concurrent readers. Revisit only if you cross ~5M vectors.
- **Backlog cost:** 20k photos × VLM caption ≈ $10–30 via cheap cloud VLMs, or free-but-slow locally. Budget the embedding calls too (trivial: ~$0.02/1M tokens).
- **Ingestion is where the work is.** Retrieval is a solved pattern; parsing Google Takeout, mbox quirks, HEIC conversion, and export-format drift is 70% of the engineering. Build connectors as isolated, restartable scripts with their own state.
- **Privacy tiering:** faces and raw location never leave the machine. Everything else is your call per-enricher. Since it's all local SQLite + files, backup = copy a folder — matches the metadata-hoarder doctrine: cheap storage, one place, permanent.
- **Identity resolution is the hard unsolved-in-general problem.** Aliases + confidence scores get you 90%; accept occasional manual merges via an `merge_entities` admin endpoint rather than chasing full auto-resolution.

---

## 8. Summary

Open Brain 2 = OB1's engine + three additions:

1. **A unified artifact schema** where every digital object is an event with time, place, and a text representation
2. **An entity graph** with contacts as the spine, turning artifacts into relationships
3. **A query planner** that fuses SQL filters (time/place/person/type) with hybrid vector+keyword ranking

The senses (VLM, Whisper, EXIF) are pluggable and improve over time. The mind — text + metadata + graph — stays stable. That's the same trick evolution used.

---

## 9. Prior Art (researched July 2026)

- **Timelinize** (timelinize.com, AGPL, Go) — closest existing project: open-source, local-only personal archive unifying photos, messages, emails, location, social posts, and contacts into a SQLite-backed timeline. Entity-aware with automatic cross-source contact merging, and can infer locations for non-geolocated items. Caveats: still unstable (v0.0.x, schema changes force timeline rebuilds), and built for *browsing* (timeline/map/gallery UI) rather than *AI recall* — no MCP server, early semantic search. Its importers are a useful reference for Takeout/export parsing; its entity-attribute model independently validates the contacts-as-spine design in §2.2.
- **Perkeep** — unified personal data storage; weak on relationships/recall
- **Rewind/Limitless, Microsoft Recall** — lifelogging via screen/audio capture; continuous but shallow, no historical footprint
- **mem0, Letta** — LLM memory layers (text-only, like OB1)
- **Upstream OB1 itself** — community importers for Takeout/Twitter/Instagram/Gmail exist, and entity extraction + knowledge-graph work is emerging (see doc 01 §4); worth monitoring for reusable pieces

No existing project combines local-first multimodal ingestion, an entity graph, and an MCP retrieval brain — that combination is OB2's niche.
