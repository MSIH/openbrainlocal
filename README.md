# LifeContext

*(formerly Open Brain Local)*

A local-first, self-owned memory layer that any AI tool can plug into — one database, one gateway, running entirely on your own machine. LifeContext stores your notes, contacts, and (soon) emails, photos, and location history as a unified memory your AI assistants can actually recall from: by meaning, by person, by place, and by time.

## Origins & lineage

LifeContext began as an independent, local-first implementation of the "Open Brain" concept introduced by Nate B. Jones. Nate's reference implementation, **OB1**, lives at <https://github.com/NateBJones-Projects/OB1>.

The project has grown in two stages:

1. **The port** — a faithful local re-implementation of the Open Brain idea (one memory store, any AI plugs in via MCP), swapping OB1's cloud stack (Supabase + edge functions) for a fully local one: SQLite + sqlite-vec, a single Node.js server, and Ollama for embeddings. That version is preserved in this repository's history (pre-0.2.0) for anyone who wants the simple text-memory server.
2. **The evolution** — the living codebase on the default branch. Memories became **artifacts** (events with time, place, and a text representation), backed by an **entity graph** with contacts as the spine, and **hybrid retrieval** (vector + keyword, fused and planned by a small local LLM). The roadmap adds pluggable "senses" — email, documents, photos, location — feeding the same stable core.

The project was renamed from Open Brain Local to LifeContext to avoid confusion with OB1's identity as that divergence grew.

## Relationship & license

This project is **not affiliated with, endorsed by, or officially connected to** Nate B. Jones or OB1. It is a clean-room reimplementation of the *concept* — a single, user-owned knowledge/memory store that multiple AI tools share (for example, over the Model Context Protocol) — and it does **not** fork or redistribute OB1's source code. Where OB1 targets free-tier cloud services, LifeContext targets a fully local stack: a local database, a local AI gateway, and no SaaS dependency.

"Open Brain" and "OB1" remain the work of their author. The code in this repository is licensed under the [MIT License](LICENSE); refer to the OB1 repository for its own license terms.

## Concept

Every AI tool keeps its own siloed memory, so each new chat or tool starts from zero. LifeContext flips that around: **you** own one memory store, and every AI plugs into it — with your data and the gateway staying on your machine.

## Quickstart

Runs fully local — no cloud. Requires [Node.js](https://nodejs.org) 18+ and [Ollama](https://ollama.com/download).

```bash
# 1. Install dependencies (Ollama must be installed and running)
npm install
npm rebuild better-sqlite3        # only if npm skipped its native build

# 2. Bootstrap: pulls the embedding model (+ optional query model) and writes .env with a
#    random LIFECONTEXT_API_KEY. Idempotent — safe to re-run; never overwrites an existing .env.
npm run setup

# 3. Run
npm start                         # REST + MCP on http://localhost:3000
```

**Developing against your data?** Use `npm run dev` — it boots a second server on `:3001` against a **copy** of `life-context.db` (`.dev.db`, a consistent online snapshot), so tests never write your live memory. Add `-- --fresh` to re-copy. **Never** run a second `npm start` / `node src/server.js` against the live DB — concurrent SQLite writers cause `SQLITE_BUSY`/locks. Every instance logs its resolved DB file at boot, so a mis-pointed one is obvious.

`npm run setup` prints the generated `LIFECONTEXT_API_KEY` once — **save it**; it's the `x-api-key` header for every call. Prefer to do it by hand? The manual equivalent (pull `qwen3-embedding:0.6b` + `qwen2.5:3b`, `cp .env.example .env`, set a key) is in [`docs/local-llm-setup-guide.md`](docs/local-llm-setup-guide.md).

Upgrading from an earlier version? Migrate your existing memories into the artifact store once (back up your DB file first — `life-context.db` by default, or whatever `DB_PATH` points to — it's idempotent and safe to re-run). It reuses the stored vectors as-is, so it's only valid while the embedding model and `VECTOR_DIMENSION` are unchanged:

```bash
npm run migrate                   # copies memories -> artifacts (type='note'), reusing vectors
```

Seed the entity graph from your contacts (people become searchable and future emails/photos link to them). Clean them up first — see [`docs/08-preparing-contacts.md`](docs/08-preparing-contacts.md) for the pre-clean checklist and why it matters:

```bash
npm run import:contacts contacts.vcf
```

Any embedded contact photo is decoded and preserved to `CONTACTS_RAW_DIR` (default `raw/contacts`, override in `.env`) — the future seed for face-recognition-based photo↔contact linking.

Re-running `import:contacts` on an **edited** vCard updates that contact in place (#94): a UID-matched card whose content changed is re-embedded and its searchable text refreshed (new emails/phones/nicknames become additive aliases); an unchanged card is skipped with no work. The imported photo and the entity profile you edit in the contacts UI are left untouched — the UI owns the profile. Summary line, e.g. `Contacts import complete: 0 added, 2 updated (0 new entities, 0 photos preserved), 5 skipped, of 7 vCards.`

Phone numbers are matched by a canonical key (#129): US/Canada numbers written with a `+1` country code (`+1 (256) 468-0130`) resolve to the same contact as the bare 10-digit form (`(256) 468-0130`) — punctuation, spacing, and the `+1` all normalize away. Contacts imported before this change are re-aliased under the canonical key by `npm run backfill:phones` (additive and idempotent — back up `life-context.db` first).

A contact's **display name defaults to first + last** (#156): a card with a middle name (`Amy Margaret Schneider`) is stored and shown as `Amy Schneider`, while the full name is kept as a searchable alias — so search/timeline read cleanly without losing resolution by the full name. Contacts imported before this change are shortened by `npm run backfill:display-names` (idempotent; back up `life-context.db` first).

**Side contact directory (#154).** To keep the entity graph *curated* while still recognizing everyone, load your full contacts export as a lookup-only directory — it creates **no** entities:
```bash
npm run directory:load contacts.vcf        # handle -> name lookup; NO entities created
npm run backfill:directory-proposals       # stage the historical unknown handles for review
```
A handle that misses the curated graph but matches the directory is then (a) **auto-labeled** in search/timeline (`Message from Jane Doe (number)` — display only, no entity), and (b) **staged in the proposed-entities review queue** with the name pre-filled. Approving a proposal promotes it into the curated graph and links its history; rejecting silences it. Promotion is always your call — the directory never auto-creates a contact. vCard (`.vcf`) only for now.

The staging step (`backfill:directory-proposals`) also runs from the browser (#162): the **Stage from directory** button in the contacts UI's *Proposed* drawer re-runs the same idempotent pass against the loaded directory and refreshes the queue — so you never have to drop to a shell after loading a directory.

**Ingest order.** There are two tiers, not a five-step chain: **Tier 1 — contacts** (they seed the entity graph); **Tier 2 — everything else** (photos, emails, documents, texts), in *any* order. Tier-2 sources link to *entities*, never to each other, so nothing among them depends on the rest. Contacts-first is a recommendation, not a hard constraint: an artifact ingested before its contact exists is still stored and fully searchable (by meaning, keyword, time, place) — only the person link is deferred, and it forms automatically when that contact is later imported (see [`docs/08-preparing-contacts.md`](docs/08-preparing-contacts.md#ingest-order--what-happens-on-a-no-match)).

Real imports are messy. Curate contacts — fix emails/phones/addresses, set a photo, and wire up relationships (spouse/parent/child/`worksAt`) — in the browser. **The web UI is token-only (#169):** it is served **only** when `UI_URL_TOKEN` is set in `.env`, and **only** at a bookmarkable capability URL — `http://localhost:3000/<token>/ui/contacts.html` (and `/<token>/ui/chat.html`), token-first, matching the MCP `/<token>/mcp` URL. The page reads the token from its own path and authorizes with **no manual key entry** (there is no API-key bar). With `UI_URL_TOKEN` unset the UI is **disabled** — `/ui/*` and `/<anything>/ui/*` all 404 — so a Cloudflare Tunnel can never expose the page without an explicit token (localhost dev needs a token too — the fail-safe default). See [`docs/09-contacts-ui.md`](docs/09-contacts-ui.md), and [`docs/07`](docs/07-cloudflare-tunnel-setup.md#opening-the-browser-ui-remotely-capability-url) for the URL-leak tradeoff and the Cloudflare Access recommendation.

Consolidate each day's artifacts into one searchable daily digest (schedule it nightly — see [`docs/06-consolidation.md`](docs/06-consolidation.md)):

```bash
npm run consolidate               # yesterday; `-- --date=YYYY-MM-DD` or `-- --backfill=N` for history
```

Smoke test (`$KEY` = your `LIFECONTEXT_API_KEY`):

```bash
curl -s -X POST localhost:3000/api/remember -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"content":"My sister Sarah lives in Austin."}'
curl -s -X POST localhost:3000/api/recall   -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"query":"where does my sister live"}'
```

Recall returns the stored memory with a similarity score. For AI clients, point an MCP-capable tool (Claude Desktop, Cursor, …) at `http://<host>:3000/mcp` with an `x-api-key` header to get the memory tools. Clients that can only take a bare URL (some MCP setups, gemini/VS Code extensions) can pass the key as a `?api_key=<key>` query param instead (`http://<host>:3000/mcp?api_key=$KEY`) — the header is preferred; the query param leaks the key into logs and history (see [`docs/07`](docs/07-cloudflare-tunnel-setup.md#part-c--point-your-ai-tools-at-it)), and it does **not** work for the Claude.ai web connector (the MCP spec forbids query-string tokens — web needs header auth or OAuth).

## Interfaces

Every endpoint/tool requires the key, sent as the `x-api-key` header (or `Authorization: Bearer`, or — for clients that can't set headers — an `?api_key=` query param; header preferred, see the caveat above). REST and MCP share one store.

- **REST** — `POST /api/remember`, `POST /api/recall`, `POST /api/search`, `POST /api/timeline`, `POST /api/about_entity`, `GET /api/artifact/:id`
- **Entity curation** (`/api/v1/entities`, core-owned — never via a connector, see [`docs/03-ob2-design.md §7`](docs/03-ob2-design.md)) — `GET /api/v1/entities/duplicates` (rank likely-duplicate person entities by shared phone/email + name similarity; read-only), `POST /api/v1/entities/merge` (`{keep_id, absorb_id}` — tombstones the absorbed entity, never deletes it, and re-points its aliases/links/relations to the survivor), plus the contacts-UI CRUD surface — list/get, create, `PATCH` fields, add/remove aliases & relationships, and photo upload/download (all under `/api/v1/entities`, see [`docs/09-contacts-ui.md`](docs/09-contacts-ui.md)). A browser UI over these lives at `/<token>/ui/contacts.html` (token-only, #169 — see the curation note above).
- **Connector ingest** (`/api/v1`, see [`docs/04-connector-contract.md`](docs/04-connector-contract.md)) — `POST /api/v1/ingest` (submit one artifact; upsert on `(source, source_id)` — 201 create / 200 update, non-destructive issues accepted with a `warnings` array, 256 KB body cap), `POST /api/v1/ingest/batch` (submit 1–100 artifacts in one call; 200 with index-aligned per-item results + a `summary`, per-item isolation — one bad item is reported at its index, never poisons the rest), `GET /api/v1/ingest/types` (the machine-readable type registry, §6). The payload's JSON Schema is published at [`schemas/ingest.v1.json`](schemas/ingest.v1.json) (generated from the zod schema via `npm run schema:ingest`) so connector authors can validate offline, without a live server:

  ```bash
  curl -s -X POST localhost:3000/api/v1/ingest -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{
    "source":"imessage","source_id":"chat.db:msg:88213","type":"message",
    "text_repr":"Text from Sarah Jones: Landed! See you at the gate.",
    "occurred_at":"2026-07-04T18:22:09Z",
    "latitude":30.2672,"longitude":-97.7431,"place_label":"Austin-Bergstrom Intl",
    "entity_hints":[{"alias":"+15550142","alias_type":"phone","role":"sender"}]}'

  curl -s -X POST localhost:3000/api/v1/ingest/batch -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{
    "artifacts":[
      {"source":"photo-exif","source_id":"IMG_0001.jpg","type":"photo","text_repr":"Photo taken 2019-03-04 near Austin, TX"},
      {"source":"photo-exif","source_id":"IMG_0002.jpg","type":"photo","text_repr":"Photo taken 2019-03-04 near Austin, TX"}]}'
  ```
- **MCP** (Streamable HTTP) — `/mcp`, tools:
  - `store_memory` / `search_memories` — the original note store + recall (unchanged on the wire)
  - `search` — hybrid semantic + keyword search with optional `types` / `time_range` / `entities` filters, plus `near` (a place name or `{lat, lon}`) + `radius_km` for geo-radius search — surfaces artifacts within the radius by coordinate, catching nearby places the label text doesn't literally name (e.g. `near: "San Francisco"` finds a Sausalito photo)
  - `timeline` — chronological recall over a date range
  - `about_entity` — resolve a person/place/org and return their profile, recent linked artifacts, and person↔person relations (spouse, child, parent, …)
  - `get_artifact` — one artifact's full text, metadata, and entity links by id
  - `list_probable_duplicates` / `merge_entities` — surface and merge likely-duplicate contacts (30 years across Google/Yahoo/iPhone rarely dedup perfectly); merge tombstones the absorbed entity rather than deleting it

### Connectors write; recall is separate

A connector's only job is to **submit** data via `POST /api/v1/ingest` (or `POST /api/v1/ingest/batch`) — see [`docs/04-connector-contract.md §1.1`](docs/04-connector-contract.md). Installing a connector does not, by itself, make any AI tool *recall* from LifeContext. That's a separate integration you configure on the AI tool's side: point an MCP-capable client at `/mcp` (or use the REST `/api/recall`/`/api/search` endpoints directly) as described above under Interfaces. A connector neither provides nor configures that wiring for you.

## Status

**Phase 2.0 (foundation) — working.** Every memory is now an **artifact** (an event with time, place, and a text representation) in a unified store, backed by an **entity graph** (contacts as the spine) and **hybrid retrieval** (vector KNN + FTS5 keyword search fused with reciprocal rank fusion, planned by a small LLM). Local store → embed (Ollama) → recall works over both REST and MCP; `npm run migrate` brings earlier memories forward, `npm run import:contacts` seeds people.

Feeding the brain is connector-driven: an HTTP ingest contract so anything — a Claude Code hook, an iMessage watcher, a photo-EXIF scan, a document-tree scan — can submit artifacts. The reference connectors live in [`connectors/`](connectors/) (one self-contained folder each; the HTTP contract is their only coupling to core — `npm run check:boundary` enforces it). See the [connector contract](docs/04-connector-contract.md) and the [roadmap](docs/05-roadmap.md).

Location is resolved server-side: a connector submitting raw `latitude`/`longitude` gets a `place_label` filled in automatically, offline, against a bundled dataset (`src/geodata/places.json`, ~135k places) derived from [GeoNames](https://www.geonames.org/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Regenerate it with `npm run geocode:build -- <path-to-cities1000.txt>` (the `--` forwards the path to the script) after downloading GeoNames' `cities1000.txt` dump (population ≥ 1,000) from <https://download.geonames.org/export/dump/cities1000.zip> — the raw dump isn't committed, only the derived file and `scripts/build-places.js` are.

## Design documents

| Doc | What it covers |
|-----|----------------|
| [`docs/03-ob2-design.md`](docs/03-ob2-design.md) | The core design: unified artifact schema, entity graph, hybrid retrieval, query planner, consolidation. Its build-phase table (§6) is superseded by the roadmap below. |
| [`docs/04-connector-contract.md`](docs/04-connector-contract.md) | The connector contract — the versioned HTTP + JSON ingest API (`/api/v1/ingest`) that lets any external process, in any language, feed the brain: artifact payloads, entity hints, the event lane, the type registry, and the compatibility promise. |
| [`docs/05-roadmap.md`](docs/05-roadmap.md) | The current roadmap: sequence-ordered milestones with exit tests — ingest API foundations, the first three reference connectors (`devsession`, `imessage`, `photo-exif`), planner hardening, contract v1 freeze, consolidation, and distribution. |
| [`docs/06-consolidation.md`](docs/06-consolidation.md) | Consolidation v1 — `npm run consolidate`: nightly daily digests (`type='digest'`), regeneration semantics (input-hash skip, derived-only upsert), timeline/planner digest awareness, scheduling snippets. |
| [`docs/07-cloudflare-tunnel-setup.md`](docs/07-cloudflare-tunnel-setup.md) | Remote access on your own domain — beginner-friendly Cloudflare Tunnel setup so phones, other machines, and cloud agents can reach the server (`https://…/api/*`, `https://…/mcp`); no port forwarding. |
| [`docs/local-llm-setup-guide.md`](docs/local-llm-setup-guide.md) | Setting up Ollama and the local models (Windows-focused; Linux notes included). Later steps predate the 2.0 layout — see the notes inside. |
| [`docs/windows-service-winsw.md`](docs/windows-service-winsw.md) | Running the Node server as a Windows service with WinSW. |
