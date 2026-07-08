# LifeContext — Roadmap: Next Steps & Deliverables

**Sequence-ordered. No dates.** Each milestone has deliverables and an exit test — the milestone isn't done until the test passes against the real server. Ordering follows value-per-inference and the prove-then-formalize rule: three real connectors before the contract is declared v1-stable.

> **This roadmap supersedes the phase table in [`03-ob2-design.md`](03-ob2-design.md) §6.**
> Doc 03 remains the architecture reference (schema, retrieval, consolidation design);
> [`04-connector-contract.md`](04-connector-contract.md) defines the ingest API these milestones
> build against. Phases from doc 03 not scheduled below live in the Backlog at the end.

---

## Milestone 0 — Contract Foundations (core-side prerequisites)

The minimum server work required before any connector can exist. Deliberately small; no framework, no plugin loader.

**Deliverables**

1. `POST /api/v1/ingest` — single-artifact upsert on `(source, source_id)`, Zod-validated against the payload in doc 04 §3
2. `POST /api/v1/ingest/batch` — up to 100 artifacts, one transaction per artifact (a bad item skips with a per-item error, never poisons the batch)
3. Entity-hint resolution per doc 04 §4 — alias match → link (confidence caps by alias type); miss → `unresolved_aliases` staging table (new migration)
4. Type registry as a static config + `GET /api/v1/ingest/types`; unregistered types accepted with `x-` prefix + warning
5. `schemas/ingest.v1.json` — the JSON Schema, committed to the repo
6. Warnings-in-response plumbing (accept-with-warning posture from doc 04 §2)

**Explicitly deferred:** event lane, sessionization, per-connector keys, state blob endpoints. None are needed by the first three connectors.

**Exit test:** a `curl` with the doc 04 §3 example payload creates an artifact, links the phone alias to a real contact at confidence 1.0, queues the name hint as unresolved, and re-running the identical `curl` updates rather than duplicates.

---

## Milestone 1 — Connector #1: `devsession` (push)

The ~40-line Claude Code `SessionEnd` hook. First live consumer of the contract; also the demo asset.

**Deliverables**

1. Hook script (Node): reads hook JSON from stdin → reads transcript → calls local LM Studio/Ollama chat model for a structured summary (what/decisions/why/next-steps) → `POST /api/v1/ingest` with `type='dev_session'`, `source='devsession'`, `source_id` = session UUID, `extra` = {project, cwd}
2. `settings.json` hook registration snippet, documented
3. Fallback behavior: server unreachable → write payload to a local spool file; next hook run flushes the spool (doc 04 §7 failure posture)
4. Path: `life-context-connectors/devsession/` (monorepo — see doc 04 §10)

**Exit test:** end a real coding session; next morning, `search("where did I leave off")` over MCP returns yesterday's session artifact with correct project context.

---

## Milestone 2 — First Recall Dogfood + Planner Hardening

Short deliberate pause to validate retrieval against real ingested data before adding volume.

**Deliverables**

1. Planner rule: unresolved/unmatched entity terms demote to keyword search, never dropped (the known-gap fix)
2. Planner rule: prefilter-then-rank verified against `dev_session` type filters (IN-constraint KNN, FTS5 filter — the known prefilter bug pattern)
3. A scratch eval file: ~15 real queries you actually ask ("what was the blocker on X", "when did I decide Y") with pass/fail notes — the seed of a regression set, not a framework

**Exit test:** all ~15 queries return the right artifact in top-3, including at least two that mix a type filter with semantic rank.

---

## Milestone 3 — Connector #2: `imessage` (watch)

The relationship-data connector; proves deterministic entity links at volume and the hub-and-spoke topology.

**Deliverables**

1. Mac Mini sync script (Node, better-sqlite3): read-only attach to `~/Library/Messages/chat.db`, WAL-safe; cursor = last ROWID in a local state file
2. `attributedBody` binary-plist decoder path for NULL `text` rows
3. Alias hints from the handle table (phone/email → `sender`/`recipient` roles)
4. Attachment handling: photos emitted as `type='photo'` artifacts with `raw_path` pointers (the many-types-per-connector case)
5. Backfill mode (full history, batched) + tail mode (watch for new rows); same script, one flag
6. Runs against the Windows server LAN IP; documented as the reference for remote connectors
7. Path: `life-context-connectors/imessage/`

**Exit test:** "what did Sarah text me about the trip" returns real messages; `about_entity("Sarah")` shows message artifacts interleaved with notes; full backfill re-run produces zero duplicates.

---

## Milestone 4 — Connector #3: `photo-exif` (batch) + Enrichment Waves

Makes the photo library time/place-queryable with zero inference; proves upsert-as-enrichment.

**Deliverables**

1. Batch scan script: `exifr` over the archive → `DateTimeOriginal`, GPS → `POST /ingest/batch`; `content_hash` for cross-import dedup; minimal `text_repr`
2. Offline reverse-geocode pass for `place_label` (local dataset, per doc 03 privacy tiering)
3. VLM caption worker (separate process, NSSM service, low priority): queue = `type='photo'` artifacts with minimal `text_repr`; captions one, upserts same `(source, source_id)` with enriched `text_repr`, repeats; kill-safe at any point
4. Nightly window scheduling for the worker (config, not code)
5. Path: `life-context-connectors/photo-exif/` (worker lives with core or alongside — decide here, it's core enrichment per doc 04's transducer split)

**Exit test:** "photos from Austin in 2019" works from EXIF alone before any caption exists; a captioned photo answers a content query ("photos of us cooking") without creating a duplicate artifact.

---

## Milestone 5 — Contract v1 Freeze + Framework Extraction

Three real connectors exist across all three trigger patterns. Now — and only now — formalize.

**Deliverables**

1. Revise doc 04 against what the three connectors actually needed; delete anything none of them used
2. Declare `/api/v1` frozen under the compatibility promise (doc 04 §8)
3. Publish `schemas/ingest.v1.json` as its own standalone repo/package — the schema-as-standard play
4. "Write a connector" guide: the drop-folder notes connector (~60 lines) built step-by-step as the hello-world template
5. `awesome-life-context-connectors` list seeded with the three reference connectors + the template

**Exit test:** someone who isn't you (or you, cold, following only the guide) builds a working connector in under an hour without reading core source.

---

## Milestone 6 — Consolidation v1 (the memory feature)

Pulled forward from the original phase order: dev sessions + texts + photos is already enough signal for digests to feel like memory.

**Deliverables**

1. Nightly job (NSSM-scheduled): `qwen3:8b` over yesterday's artifacts → one `type='digest'` artifact per day
2. Digest prompt treats dev sessions, messages, and photos as categories ("worked on…", "talked with…", "was at…")
3. `timeline` and `search` planner awareness of digests (a month-scale question answers from digests, not 400 artifacts)
4. Event lane + first sessionization rule ships here **only if** an events-producing connector exists by now; otherwise stays deferred (lazy-branching)

**Exit test:** "what was I doing last week" answers in one digest-backed response that mentions code, people, and places.

---

## Milestone 7 — Distribution & the Name

The reputation sequence, gated on working software — everything above is the prerequisite.

**Deliverables**

1. The demo: 30-second recording — close terminal Friday, open Monday, "where did we leave off?", Claude answers from LifeContext
2. README refresh: demo GIF up top, quickstart validated cold on both Windows 11 and macOS (the single-computer story, not just your server topology)
3. npm publication of the MCP server package; domain registration (.dev or .app)
4. The Nate conversation: the relationship framing + offer to upstream the entity schema / query planner design to OB1
5. Show HN / X launch post anchored on the demo + the connector contract as the novel claim
6. One external adoption target for the ingest schema (any other memory project using it = the standard exists)

**Exit test:** one connector in the awesome-list written by someone you've never spoken to.

---

## Backlog — Beyond Milestone 7 (carried forward from doc 03 §6)

Unscheduled, roughly in doc 03's original value order. Each is "just another connector" (or an
additive core index) against the frozen contract — sequence them by the same value-per-inference
rule when their turn comes:

- **Email** (Takeout mbox first, IMAP later) — highest-density relationship data; deterministic entity links at volume (doc 03 §3.1)
- **Documents + filesystem watcher** — pdf-parse/mammoth extraction, NER-inferred links
- **Location visits** — Google Timeline / Owntracks pings segmented into visits via the event lane (doc 04 §5)
- **Video/audio** — Whisper transcripts + keyframe captions; **social-media exports** (Takeout, X archive)
- **Face clustering** (local-only, `insightface`), **CLIP visual-similarity second index** (doc 03 §3.3), **`merge_entities` admin endpoint** (doc 03 §7), cross-device sync, temporal knowledge graph

---

## Standing Rules (apply to every milestone)

- No milestone starts until the previous exit test passes against the real server — no "done pending testing"
- Connectors share one monorepo, `life-context-connectors`, for now — one folder per connector; core repo (`life-context`) stays contract + core only. Split a connector into its own repo the moment it needs an independent release cadence or an external owner (lazy-branching, doc 04 §10)
- Any design decision invalidated by real retrieval behavior gets changed and doc 04 updated in the same commit — the doc tracks reality, not intent
- Backup `life-context.db` before every migration; migrations stay idempotent
