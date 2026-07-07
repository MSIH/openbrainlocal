# LifeContext — The Connector Contract

**How anything — yours or the community's — feeds the brain**

Defines the stable boundary between the LifeContext core (artifact store, entity graph, hybrid retrieval, consolidation) and *connectors*: external processes that gather data from some corner of a digital life and submit it for ingestion. The contract is HTTP + JSON, not a plugin API. Publishing this document *is* shipping the framework.

> **Status: partially implemented.** `POST /api/v1/ingest` (single-artifact upsert on
> `(source, source_id)`, §2–§4) and `GET /api/v1/ingest/types` (§6) are **live** in
> `src/ingest.js` / `src/brainserver.js`. The batch (`/ingest/batch`), event (`/events`), and
> per-connector state endpoints below remain design-only ([`05-roadmap.md`](05-roadmap.md)
> Milestone 0+). The contract is declared v1-stable only after three real connectors have used
> it (Milestone 5). This doc supersedes the ingestion-pipeline framing in
> [`03-ob2-design.md`](03-ob2-design.md) §3 — see the naming note below for how the terms map.

**Naming note.** Doc 03 §1.1 uses "senses" for the *transducers* — the core-side enrichers (VLM, Whisper, EXIF) that convert a modality into text. That usage stands. The external gatherers defined here are **connectors**, because one connector can emit many types (iMessage emits messages *and* photo attachments; a Takeout importer emits email, location, and browsing history). The decomposition is: **connector** (gathers) → **type** (classifies) → **transducer/sense** (enriches non-text into `text_repr`, core-side). The `artifacts` table already encodes the first two as its `source` and `type` columns.

---

## 1. Design Principles

### 1.1 The contract is the wire, not the runtime

A connector is **any process that can make an authenticated HTTP POST**. Not a TypeScript interface, not a folder the core dynamically loads, not code that runs inside the server process.

| In-process plugin model | HTTP contract model (this doc) |
|---|---|
| Plugins run arbitrary code inside the brain with access to everything | Connectors are isolated processes; a crash or a bug is contained |
| One language (Node) | Any language — PowerShell, Python, bash, an iOS Shortcut |
| Core must review, load, sandbox, and version plugin code | Core reviews nothing; it validates payloads |
| Distribution requires an in-repo plugin directory | Distribution is a list of links to independent repos |

This is the same discipline already stated in doc 03 §7: *"build connectors as isolated, restartable scripts with their own state."* This contract just formalizes it and opens it to strangers.

### 1.2 Core owns the graph; connectors submit hints

**Connectors never see or assert entity IDs.** They submit raw *alias hints* — an email address, a phone number, a name — and the core resolves them against `entity_aliases`. A hit becomes a deterministic link; a miss queues for later resolution. One buggy community connector can therefore never corrupt the contacts spine. (Full rules in §4.)

### 1.3 Idempotency is structural, not conventional

`source` + `source_id` are **required** fields and ingestion is **upsert-by-default**. A connector that crashes mid-run and restarts from the top is harmless by construction. We cannot code-review every community connector's retry logic, so the API makes retries safe regardless.

### 1.4 High-frequency streams are events, not artifacts

A song every 3 minutes, a page view every 30 seconds, a GPS ping every 10 — raw streams would outnumber deliberate memories 1000:1 and poison retrieval. The contract provides two lanes:

- **Artifact lane** — discrete, memory-worthy items (an email, a photo, a dev session). One POST = one memory.
- **Event lane** — raw high-frequency observations. Core *sessionizes* them into artifacts (a listening session, a browsing session, a visit) on its own schedule. This generalizes the location-pings→visits rule from doc 03 §3.1. (Details in §5.)

Connector authors do not implement aggregation. If they did, search quality would be hostage to the worst connector.

### 1.5 Core governs vocabulary and versions the contract

Types come from a registered list (§6) so the planner can reason about them; the endpoint is versioned (`/api/v1/…`) with an explicit compatibility promise (§8) so a shortcut on someone's phone keeps working across LifeContext upgrades.

---

## 2. The Ingest API

All endpoints require the standard `x-api-key` header. All bodies are JSON. Size cap 256 KB per request (raw media never travels through this API — see `raw_path` note in §3).

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/ingest` | Submit one artifact (upsert on `(source, source_id)`) |
| `POST /api/v1/ingest/batch` | Submit up to 100 artifacts in one call (EXIF backlogs, export imports) |
| `POST /api/v1/events` | Submit raw high-frequency events for sessionization |
| `GET  /api/v1/ingest/types` | The current type registry (machine-readable) |
| `GET  /api/v1/sources/:source/state` | Optional per-connector cursor/state blob (see §7) |
| `PUT  /api/v1/sources/:source/state` | Store the cursor/state blob |

**Responses:**

```json
// 201 created / 200 updated (upsert)
{ "id": 4821, "created": true, "resolved_entities": 2, "unresolved_aliases": 1 }

// 422 — schema violation (missing source_id, unknown required field, oversize)
{ "error": "validation", "issues": [ ... ] }

// 200 with warnings — accepted, but flagged (unregistered x- type, no occurred_at)
{ "id": 4822, "created": true, "warnings": ["occurred_at missing; ingested_at used for timeline"] }
```

Design note: prefer **accept-with-warning** over rejection wherever data isn't destructive. A community connector that mostly works should mostly work.

---

## 3. The Artifact Payload

```jsonc
{
  // ---- REQUIRED ----
  "source": "imessage",                // stable connector identifier; becomes artifacts.source
  "source_id": "chat.db:msg:88213",    // provider-unique ID; upsert key with source
  "type": "message",                   // from the registry (§6), or "x-…"
  "text_repr": "Text from Sarah Jones: 'Landed! See you at the gate.'",

  // ---- STRONGLY RECOMMENDED ----
  "occurred_at": "2026-07-04T18:22:09Z",  // when it HAPPENED; omit → warning, ingested_at used
  "content_hash": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",  // bare sha256 hex of the raw bytes

  // ---- OPTIONAL ----
  "latitude": 30.2672,
  "longitude": -97.7431,
  "place_label": "Austin-Bergstrom Intl",
  "raw_path": "/archive/imessage/2026/07/msg-88213.json",  // pointer; media never travels in-band
  "extra": { "service": "iMessage", "is_from_me": false }, // → artifacts.extra_json, schema-free

  // ---- ENTITY HINTS (never IDs — see §4) ----
  "entity_hints": [
    { "alias": "+15550142",   "alias_type": "phone", "role": "sender" },
    { "alias": "sarah jones", "alias_type": "name",  "role": "mentioned", "confidence": 0.7 }
  ]
}
```

Field-by-field rules:

- **`source`** — lowercase, stable for the lifetime of the connector. Changing it orphans your history. Prefer the plain product/source name (`imessage`, `gmail`, `photo-exif`) — no prefix convention needed; the column itself says what it is.
- **`source_id`** — must be reproducible from the source data itself (a provider ID, a file path + mtime, a hash), *never* a random UUID minted at runtime — random IDs defeat upsert.
- **`text_repr`** — the normalized natural-language representation, per doc 03 §1.1. This is what gets embedded and FTS-indexed. Connectors do the describing; core does the embedding. Connectors **never** call Ollama or compute vectors — embedding model and dimensions are core's private business (this is what lets the embedding model change without touching a single connector).
- **`occurred_at` vs `ingested_at`** — the 2019 photo imported today sorts into 2019. Connectors that can't determine occurrence time omit the field and accept the warning.
- **`content_hash`** — lowercase hex SHA-256 digest of the raw bytes, no algorithm prefix (matches core's `sha256()` helper). Compared by exact string equality for cross-import dedup — a mismatched format silently breaks dedup instead of erroring.
- **`raw_path`** — the API carries text + metadata only. Connectors that own binary artifacts (photos, audio) write them to disk themselves and submit the pointer. Keeps the DB small and the API fast, per doc 03 §2.1.

**Upsert merge semantics (implemented).** A second POST with the same `(source, source_id)` **updates** the existing artifact (200; a first POST is 201). Fields **present** in the payload overwrite; fields **absent** are left unchanged — so the photo-exif → VLM caption wave can upsert only `text_repr` without wiping the GPS/`place_label` the EXIF pass stored (enrichment waves compose). This reconciles with append-only: only the *derived* representation is rewritten (`text_repr`, its embedding, its FTS row, and metadata) — the original bytes are never touched (`raw_path` files untouched, `content_hash` still tracks them), `ingested_at` stays at first ingestion, entity links are only ever added, and every update appends an `ingest_log` row carrying the prior value of each changed field, so the full evolution is reconstructable. Nothing can be **cleared** through this API: an explicit `null` on an optional field is a 422 (optional, not nullable). The embedding is recomputed only when `text_repr` actually changes — a metadata-only upsert (or an identical retry) never calls the embedder.

---

## 4. Entity Hints & Resolution Rules

The single most important boundary in the contract.

**What connectors submit:** `{alias, alias_type, role, confidence?}` where `alias_type ∈ {email, phone, name, handle}` and `role` uses the `entity_links` vocabulary (`sender`, `recipient`, `pictured`, `mentioned`, `author`, `self`, `location_of`). `self` is connector-submittable, not core-inferred-only — a connector that already knows an artifact is the account owner's own (iMessage's `is_from_me`, a device's own GPS track) should hint `self` directly rather than relying on later resolution.

**What core does with each hint:**

| Case | Action | Resulting confidence |
|---|---|---|
| Alias matches `entity_aliases` exactly (normalized) | Create `entity_links` row | 1.0 for deterministic alias types (email, phone); connector-supplied confidence (capped 0.9) for `name`/`handle` |
| No match | Insert into `unresolved_aliases` staging table with artifact reference | — (surfaced in an admin/merge UI later; resolving retroactively links all queued artifacts) |
| Connector supplies `confidence` > its type's cap | Clamp | Deterministic trust is earned by alias type, not asserted by the connector |

Normalization (lowercase, digits-only phones) happens core-side; connectors submit what they see.

**Never in the payload:** entity IDs, entity creation requests, relationship assertions ("this is my sister"). Durable facts enter the graph through contacts import and consolidation, not through connectors.

```sql
-- New staging table (core migration, not a payload concern). UNIQUE(artifact_id, alias,
-- alias_type, role) is an additive deviation from an earlier sketch of this table: it makes
-- resolveEntityHints idempotent by construction (paired with INSERT OR IGNORE), the same
-- discipline entity_links already gets from its own PK — re-submitting identical hints for
-- the same artifact stages zero new rows instead of piling up duplicates.
CREATE TABLE unresolved_aliases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER REFERENCES artifacts(id),
  alias       TEXT NOT NULL,
  alias_type  TEXT,
  role        TEXT,
  hint_confidence REAL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(artifact_id, alias, alias_type, role)
);
CREATE INDEX idx_unresolved_alias ON unresolved_aliases(alias, alias_type);
```

---

## 5. The Event Lane & Sessionization

`POST /api/v1/events` accepts raw observations:

```jsonc
{
  "source": "nowplaying",
  "stream": "music",                    // registered stream name (§6)
  "observed_at": "2026-07-06T21:14:00Z",
  "payload": { "track": "Starboy", "artist": "The Weeknd", "app": "Spotify" },
  "dedup_key": "spotify:starboy:2114"   // optional; same-key events within window collapse
}
```

Events land in an `events` side table — **never** in `artifacts`, never embedded, never searchable directly.

**Sessionization** runs as part of the nightly consolidation job (doc 03 §5) — or opportunistically on stream-idle — and rolls events into one artifact per session using per-stream rules:

| Stream | Session boundary | Resulting artifact `text_repr` (example) |
|---|---|---|
| `music` | gap > 30 min or app change | "Listening session, 9:00–11:30 PM: synthwave — 14 tracks incl. The Weeknd, Kavinsky" |
| `browsing` | gap > 20 min or domain-cluster change | "Reading session: sqlite-vec docs, 3 GitHub issues on FTS5 ranking (25 min)" |
| `location` | existing visit segmentation | "At Common Bond Montrose, 9:14–10:02 AM" |
| `terminal` | shell session lifetime | "Shell session in ~/lifecontext: npm test ×6, git commit ×2, nssm restart" |

Session artifacts get `type` from the registry (`listening_session`, `browsing_session`, `visit`, …), `source` = the originating connector, `source_id` = deterministic session key (stream + start timestamp) so re-running sessionization upserts instead of duplicating. Raw events older than a retention window (default 90 days, configurable) are pruned; the session artifact and its `extra` digest are the permanent record.

**Retrieval policy:** ambient session types are **excluded from default search** and included only when the planner detects intent ("what was I listening to", "that article I read") or when explicitly filtered. Deliberate memories stay in front.

---

## 6. Type & Stream Registry

> **Live.** The registry is implemented as static config in `src/ingest-types.js`
> (`TYPE_REGISTRY`) and served machine-readably at `GET /api/v1/ingest/types` — connectors can
> self-check at startup instead of trusting a copy of this table. `src/search.js`'s planner
> prompt and the `types` filter zod enum both derive from the same module, so they cannot
> diverge from what the endpoint advertises. `location_ping` (mentioned in earlier drafts of
> this doc) never shipped as a registered type — location is an event-lane stream (§5), not an
> artifact type. Streams (below) remain design-only; the event lane and `POST /api/v1/events`
> are still deferred (§1.4, roadmap Milestone 0).

Registered artifact types (v1), each with planner policy `{default_searchable, digest_eligible}`:

| type | default_searchable | digest_eligible |
|---|---|---|
| `note` | true | true |
| `message` | true | true |
| `email` | true | true |
| `document` | true | true |
| `photo` | true | true |
| `video` | true | true |
| `contact` | true | false |
| `post` | true | true |
| `dev_session` | true | true |
| `visit` | false | true |
| `listening_session` | false | true |
| `browsing_session` | false | true |
| `digest` | true | false |

Ambient session types (`visit`, `listening_session`, `browsing_session`) default out of search per
the §5 retrieval policy but are digest-eligible — they're exactly what a daily digest
summarizes. `contact` is reference data, not a daily event, so it's not digest-eligible;
`digest` itself is excluded from digest-eligibility to avoid recursive summarization. Planner
*enforcement* of these flags (actually excluding non-searchable types from default search)
lands with a later milestone — today the flags are data only.

Registered event streams (v1): `music`, `browsing`, `location`, `terminal`.

Rules:

- Unregistered types must be prefixed `x-` (e.g., `x-dream-journal`). Accepted with a warning; the planner treats `x-` types as searchable-but-generic. If an `x-` type proves broadly useful, it gets promoted into the registry in a minor version — the `x-` name remains accepted as an alias forever. `src/ingest-types.js` exports `isRegisteredType()` / `isExtensionType()` for this check; accept-with-warning handling at ingest is a later issue.
- The registry is machine-readable at `GET /api/v1/ingest/types` so connectors can self-check at startup.
- Types carry planner policy (default-searchable: yes/no; digest-eligible: yes/no) — one more reason the vocabulary is governed rather than free-form.

---

## 7. Connector Lifecycle Conventions (guidance, not enforcement)

The core doesn't run connectors, but reference connectors follow these patterns and community connectors should too:

- **Trigger patterns** — three shapes cover everything: **watch** (react to a file/db changing: `chat.db`, a Documents folder), **poll** (ask on an interval: now-playing, an IMAP inbox), **push** (something else initiates: a Claude Code hook, an iOS Shortcut, a browser extension). These are implementation styles, not API concepts — the wire looks identical.
- **Cursor state** — incremental connectors need a high-water mark ("last ROWID synced"). Keep it in a local file next to the connector, *or* use the optional `GET/PUT /api/v1/sources/:source/state` blob store so the cursor lives with the brain and survives connector-machine reinstalls. Either is contract-conformant.
- **Backoff & batching** — batch endpoint for backlogs (100/call), single ingest for live trickle. Respect 429s with exponential backoff. Rate limit is per key.
- **Per-connector API keys** *(core roadmap item)* — v1 ships with the single `BRAIN_SECRET_KEY`; a follow-up adds named keys with per-key `source` binding and revocation, so a leaked phone Shortcut key can be killed without rotating the brain. The contract is written assuming this arrives; connectors shouldn't share keys across devices.
- **Failure posture** — a connector that dies must lose at most its uncommitted cursor window. Never buffer unbounded in memory; never require the brain to be up to *observe* (queue locally, flush on reconnect) if the source data is ephemeral (now-playing is ephemeral; `chat.db` is not, so the iMessage connector can simply do nothing while the server is down).

---

## 8. Versioning & Compatibility Promise

- The path is versioned: `/api/v1/…`. Within v1: **fields are only ever added, never removed or repurposed**; new registered types/streams may appear; warnings may appear on previously-silent payloads. Nothing that validates today will 422 tomorrow.
- Breaking changes get `/api/v2/…` and v1 keeps working for a deprecation window of **no less than 12 months**.
- The payload schema is published as JSON Schema in the repo (`schemas/ingest.v1.json`) — connectors can validate in CI without a live server.

This promise is the whole reason a stranger can put a LifeContext URL in an iPhone Shortcut and trust it across upgrades.

---

## 9. Reference Connectors (the contract's first three consumers)

Each reference connector doubles as the canonical example of one trigger pattern:

| Connector | Pattern | Sketch |
|---|---|---|
| **`devsession`** | push | Claude Code `SessionEnd` hook → reads transcript path from hook stdin → local LLM (LM Studio) synthesizes a summary → `POST /ingest` as `type='dev_session'`, `source_id` = CC session UUID, `extra` = {project, cwd} |
| **`imessage`** | watch | Mac Mini script watches `~/Library/Messages/chat.db` (WAL-safe read-only attach) → decodes `attributedBody` where `text` is NULL → alias hints from handle table (phone/email) → forwards to the Windows server's LAN IP. The hub-and-spoke topology is *just configuration* — same connector, different base URL. Note this one connector emits two types: `message` for texts, `photo` for attachments — the many-types-per-connector case that motivated the naming |
| **`photo-exif`** | batch | One-shot/cron scan over the photo archive → `exifr` for `DateTimeOriginal` + GPS → `POST /ingest/batch`, `text_repr` = minimal ("Photo taken 2019-03-04 near Austin, TX"), `content_hash` for dedup across re-imports. The VLM caption worker later *upserts the same `(source, source_id)`* with an enriched `text_repr` — the contract's upsert semantics are what let enrichment arrive in waves |

Near-term community-obvious connectors that need **zero core changes** once this ships: iOS Shortcut brain-dump (push), now-playing (poll→events), browser reading history (push→events), shell history (watch→events), platform data-dump importers (batch).

---

## 10. Distribution

- Connectors live in **their own repos**, any language, any license. The LifeContext repo contains only the contract (this doc + JSON Schema) and the reference connectors.
- Discovery via a curated **`awesome-lifecontext-connectors`** list: name, platform, pattern, data it reads, where the data goes (should always be "your LifeContext server, nothing else" — connectors that phone home don't get listed).
- No certification, no review pipeline, no plugin store. The contract's structural guarantees (hints not IDs, upsert, event lane, payload validation) are the safety model; curation is just a README.

---

## 11. Open Questions (deliberately unresolved in v1)

- **Deletion/tombstones** — when a source deletes an item (a recalled message, a deleted photo), should connectors be able to propagate that? Leaning yes-eventually via `DELETE /api/v1/ingest/:source/:source_id`, but the memory-system philosophy ("memories don't un-happen") argues for a `superseded` flag over hard deletes. Deferred.
- **Connector-supplied embeddings** — explicitly rejected for v1 (breaks the model-swap freedom in §3); revisit only if a connector emerges with a genuinely better representation (e.g., CLIP for visual similarity — which doc 03 §3.3 already scopes as a *core* second index, not a connector concern).
- **Backpressure on the event lane** — is a per-stream events/day cap needed, or is rate limiting enough? Wait for real abuse before adding knobs (lazy-branching doctrine).
- **Per-connector keys** — committed direction (§7), unscheduled.
