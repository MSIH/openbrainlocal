# Open Brain Local

A local-first, self-owned memory layer that any AI tool can plug into — one database, one gateway, running entirely on your own machine.

## Relationship & license

Open Brain Local is an **independent, local-first implementation of the "Open Brain" concept introduced by Nate B. Jones**. Nate's reference implementation, **OB1**, lives at <https://github.com/NateBJones-Projects/OB1>.

This project is **not affiliated with, endorsed by, or officially connected to** Nate B. Jones or OB1. It is a clean-room reimplementation of the *concept* — a single, user-owned knowledge/memory store that multiple AI tools share (for example, over the Model Context Protocol) — and it does **not** fork or redistribute OB1's source code. Where OB1 targets free-tier cloud services, Open Brain Local targets a fully local stack: a local database, a local AI gateway, and no SaaS dependency.

"Open Brain" and "OB1" remain the work of their author. The code in this repository is licensed under the [MIT License](LICENSE); refer to the OB1 repository for its own license terms.

## Concept

Every AI tool keeps its own siloed memory, so each new chat or tool starts from zero. Open Brain flips that around: **you** own one memory store, and every AI plugs into it. Open Brain Local pursues the same goal without any cloud service — your data and the gateway stay on your machine.

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

Upgrading from an earlier version? Migrate your existing memories into the OB2 artifact
store once (back up `unlimited_shared_brain.db` first — it's idempotent and safe to re-run).
It reuses the stored vectors as-is, so it's only valid when the embedding model and
`VECTOR_DIMENSION` are unchanged — a model swap requires re-embedding, not this migration:

```bash
npm run migrate                   # copies memories -> artifacts (type='note'), reusing vectors
```

Seed the entity graph from your contacts (people become searchable and future emails/photos
link to them):

```bash
npm run import:contacts contacts.vcf
```

Smoke test (`$KEY` = your `BRAIN_SECRET_KEY`):

```bash
curl -s -X POST localhost:3000/api/remember -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"content":"My sister Sarah lives in Austin."}'
curl -s -X POST localhost:3000/api/recall   -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"query":"where does my sister live"}'
```

Recall returns the stored memory with a similarity score. For AI clients, point an MCP-capable tool (Claude Desktop, Cursor, …) at `http://<host>:3000/mcp` with an `x-api-key` header to get the memory tools.

### Interfaces

Every endpoint/tool requires the `x-api-key` header. REST and MCP share one store.

- **REST** — `POST /api/remember`, `POST /api/recall`, `POST /api/search`, `POST /api/timeline`, `POST /api/about_entity`, `GET /api/artifact/:id`
- **MCP** (Streamable HTTP) — `/mcp`, tools:
  - `store_memory` / `search_memories` — the original note store + recall (unchanged on the wire)
  - `search` — hybrid semantic + keyword search with optional `types` / `time_range` / `entities` filters
  - `timeline` — chronological recall over a date range
  - `about_entity` — resolve a person/place/org and return their profile + recent linked artifacts
  - `get_artifact` — one artifact's full text, metadata, and entity links by id

## Status

**Phase 2.0 (foundation) — working.** Every memory is now an **artifact** (an event with time,
place, and a text representation) in a unified store, backed by an **entity graph** (contacts as
the spine) and **hybrid retrieval** (vector KNN + FTS5 keyword search fused with reciprocal rank
fusion, planned by a small LLM). Local store → embed (Ollama) → recall works over both REST and MCP;
`npm run migrate` brings OB1 memories forward, `npm run import:contacts` seeds people.

See [`docs/03-ob2-design.md`](docs/03-ob2-design.md) for the full Open Brain 2 roadmap — the next
phases add email, documents, photos, location, and consolidation against this stable core schema.
