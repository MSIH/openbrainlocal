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
# 1. Install dependencies
npm install
npm rebuild better-sqlite3        # only if npm skipped its native build

# 2. Pull the models: embedding (1024-dim — matches VECTOR_DIMENSION) + the query-planner chat model
ollama pull qwen3-embedding:0.6b
ollama pull qwen2.5:3b            # query-planner chat model (QUERY_MODEL); search degrades gracefully if absent

# 3. Configure the secret
cp .env.example .env              # then set BRAIN_SECRET_KEY to a random value

# 4. Run
npm start                         # REST + MCP on http://localhost:3000
```

Upgrading from an earlier version? Migrate your existing memories into the artifact store once (back up `unlimited_shared_brain.db` first — it's idempotent and safe to re-run). It reuses the stored vectors as-is, so it's only valid while the embedding model and `VECTOR_DIMENSION` are unchanged:

```bash
npm run migrate                   # copies memories -> artifacts (type='note'), reusing vectors
```

Seed the entity graph from your contacts (people become searchable and future emails/photos link to them):

```bash
npm run import:contacts contacts.vcf
```

Smoke test (`$KEY` = your `BRAIN_SECRET_KEY`):

```bash
curl -s -X POST localhost:3000/api/remember -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"content":"My sister Sarah lives in Austin."}'
curl -s -X POST localhost:3000/api/recall   -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"query":"where does my sister live"}'
```

Recall returns the stored memory with a similarity score. For AI clients, point an MCP-capable tool (Claude Desktop, Cursor, …) at `http://<host>:3000/mcp` with an `x-api-key` header to get the memory tools.

## Interfaces

Every endpoint/tool requires the `x-api-key` header. REST and MCP share one store.

- **REST** — `POST /api/remember`, `POST /api/recall`, `POST /api/search`, `POST /api/timeline`, `POST /api/about_entity`, `GET /api/artifact/:id`
- **Connector ingest** (`/api/v1`, see [`docs/04-connector-contract.md`](docs/04-connector-contract.md)) — `POST /api/v1/ingest` (submit one artifact; upsert on `(source, source_id)` — 201 create / 200 update, non-destructive issues accepted with a `warnings` array, 256 KB body cap), `POST /api/v1/ingest/batch` (submit 1–100 artifacts in one call; 200 with index-aligned per-item results + a `summary`, per-item isolation — one bad item is reported at its index, never poisons the rest), `GET /api/v1/ingest/types` (the machine-readable type registry, §6):

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
  - `search` — hybrid semantic + keyword search with optional `types` / `time_range` / `entities` filters
  - `timeline` — chronological recall over a date range
  - `about_entity` — resolve a person/place/org and return their profile + recent linked artifacts
  - `get_artifact` — one artifact's full text, metadata, and entity links by id

## Status

**Phase 2.0 (foundation) — working.** Every memory is now an **artifact** (an event with time, place, and a text representation) in a unified store, backed by an **entity graph** (contacts as the spine) and **hybrid retrieval** (vector KNN + FTS5 keyword search fused with reciprocal rank fusion, planned by a small LLM). Local store → embed (Ollama) → recall works over both REST and MCP; `npm run migrate` brings earlier memories forward, `npm run import:contacts` seeds people.

What's next is connector-driven: an HTTP ingest contract so anything — a Claude Code hook, an iMessage watcher, a photo-EXIF scan — can feed the same brain. See the [connector contract](docs/04-connector-contract.md) and the [roadmap](docs/05-roadmap.md).

## Design documents

| Doc | What it covers |
|-----|----------------|
| [`docs/03-ob2-design.md`](docs/03-ob2-design.md) | The core design: unified artifact schema, entity graph, hybrid retrieval, query planner, consolidation. Its build-phase table (§6) is superseded by the roadmap below. |
| [`docs/04-connector-contract.md`](docs/04-connector-contract.md) | The connector contract — the versioned HTTP + JSON ingest API (`/api/v1/ingest`) that lets any external process, in any language, feed the brain: artifact payloads, entity hints, the event lane, the type registry, and the compatibility promise. |
| [`docs/05-roadmap.md`](docs/05-roadmap.md) | The current roadmap: sequence-ordered milestones with exit tests — ingest API foundations, the first three reference connectors (`devsession`, `imessage`, `photo-exif`), planner hardening, contract v1 freeze, consolidation, and distribution. |
| [`docs/local-llm-setup-guide.md`](docs/local-llm-setup-guide.md) | Setting up Ollama and the local models (Windows-focused; Linux notes included). Later steps predate the 2.0 layout — see the notes inside. |
| [`docs/windows-service-winsw.md`](docs/windows-service-winsw.md) | Running the Node server as a Windows service with WinSW. |
