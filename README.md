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

# 2. Pull the embedding model (1024-dim — matches VECTOR_DIMENSION)
ollama pull qwen3-embedding:0.6b

# 3. Configure the secret
cp .env.example .env              # then set BRAIN_SECRET_KEY to a random value

# 4. Run
npm start                         # REST + MCP on http://localhost:3000
```

Smoke test (`$KEY` = your `BRAIN_SECRET_KEY`):

```bash
curl -s -X POST localhost:3000/api/remember -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"content":"My sister Sarah lives in Austin."}'
curl -s -X POST localhost:3000/api/recall   -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"query":"where does my sister live"}'
```

Recall returns the stored memory with a similarity score. For AI clients, point an MCP-capable tool (Claude Desktop, Cursor, …) at `http://<host>:3000/mcp` with an `x-api-key` header to get the `store_memory` / `search_memories` tools.

### Interfaces

- **REST** — `POST /api/remember`, `POST /api/recall` (header `x-api-key`)
- **MCP** (Streamable HTTP) — `/mcp`, tools `store_memory` and `search_memories`

## Status

Working: local store → embed (Ollama) → semantic recall, over both REST and MCP. See [`docs/03-ob2-design.md`](docs/03-ob2-design.md) for the Open Brain 2 roadmap (multimodal ingestion, entity graph, query planner).
