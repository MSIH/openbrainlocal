# Open Brain Local — Agent Guide

<context>

## Prime Directive
Local-first, code-first. Every artifact optimized for machine consumption first, humans second.
When goals conflict: **correctness > simplicity > speed**.

## What This Is
A local, self-owned AI memory server. Store text, embed it locally, recall it semantically — exposed over both a REST API and an MCP server so any AI tool or script can plug into one memory.

Independent, local-first implementation of the "Open Brain" concept by Nate B. Jones (reference impl **OB1**: <https://github.com/NateBJones-Projects/OB1>). Not affiliated with or endorsed by OB1; built from the concept, not forked from its code. Full relationship note in `README.md`.

## Stack
- **Runtime:** Node.js 18+ , ESM (`"type": "module"`) — no TypeScript.
- **Web:** Express 5 + `express-rate-limit`.
- **Store:** `better-sqlite3` + `sqlite-vec` (vec0 virtual table), WAL mode. Local file `unlimited_shared_brain.db`.
- **Embeddings/LLM:** OpenAI SDK pointed at **local Ollama** (`http://localhost:11434/v1`), model `qwen3-embedding:0.6b` (1024-dim).
- **AI interface:** `@modelcontextprotocol/sdk` — Streamable HTTP MCP server.
- **Validation:** `zod`. **Config:** `dotenv`.

## Layout
```
src/brainserver.js   — the server: REST + MCP, DB setup, embedding gateway, auth
docs/                — design + setup docs (03-ob2-design.md is the roadmap)
.env.example         — required env template (copy to .env; never commit .env)
.claude/rules/       — coding standards, data-model, design-philosophy (read before editing)
```

## Two Interfaces (same DB behind both)
| Interface | Endpoints / tools | Auth |
|-----------|-------------------|------|
| REST | `POST /api/remember`, `POST /api/recall` | `x-api-key` header |
| MCP (Streamable HTTP) | `/mcp` — tools `store_memory`, `search_memories` | `x-api-key` header |

## Run & Test
```bash
npm install                      # + `npm rebuild better-sqlite3` if native build was skipped
ollama pull qwen3-embedding:0.6b # engine must be running on :11434
cp .env.example .env             # set BRAIN_SECRET_KEY to a random value (placeholder is rejected)
npm start                        # serves on :3000
```
Smoke test (`$KEY` = `BRAIN_SECRET_KEY`): `POST /api/remember` then `/api/recall` — recall returns the memory + a distance score. Full steps in `README.md` Quickstart and `docs/local-llm-setup-guide.md`.

</context>

<rules>

## Absolute Rules
1. **All config via env (`ISettings`-style through `dotenv`) — never hardcode** secrets, keys, URLs, or model names in a way that can't be overridden. `.env` is gitignored; only `.env.example` (placeholders) is committed.
2. **`VECTOR_DIMENSION` must match the embedding model's output.** `qwen3-embedding:0.6b` → 1024. Changing the model means changing the dim AND re-embedding (a fresh vec table); old vectors are incompatible.
3. **`sqlite-vec` vec0 primary keys must be bound as `BigInt`**, not a JS Number — `better-sqlite3` returns `lastInsertRowid` as a Number, so cast (`BigInt(id)`) on insert. A Number throws `SqliteError: Only integers are allowed for primary key values`.
4. **Enrich first, then commit atomically.** Fetch embeddings (network) *before* the DB transaction so a failed API call never orphans a row. See `storeTxn`.
5. **Memory is append-only — never hard-delete or overwrite** stored memories/artifacts. Preserve originals (`raw_path`, `content_hash`). See `.claude/rules/design-philosophy.md`.
6. **Providers pluggable, config-driven.** Embedding/LLM backends are swappable via env (local Ollama by default); don't couple logic to a specific provider.

## Every Change
- A GitHub issue, then a branch, then a PR whose body starts with `Closes #<n>`, then merge to `main`. Sync `main` after merge.
- Run the store→recall smoke test (server must boot, 0 errors) before committing server changes.
- Update the relevant `docs/**` when behavior changes; keep the README Quickstart accurate.
- Commit messages: imperative, ≤2 sentences. Reference issues/PRs as `#<n> "<title>"`.

## Style & Data
- Match `src/brainserver.js`'s existing density and idiom. Details in `.claude/rules/coding-standards.md`.
- SQLite/schema conventions (occurred_at vs ingested_at, raw_path not blobs, dedup keys, WAL): `.claude/rules/data-model.md`.
- Design ethos (data preservation, logging, docs-close-to-code, baseline method, AI-artifact capture): `.claude/rules/design-philosophy.md`.

## Env / Config keys (`.env`)
- `BRAIN_SECRET_KEY` (required — server hard-exits if unset or left at the placeholder)
- `PORT` (default 3000)
- Optional/for later cloud enrichment: provider keys — keep out of git.

## Local settings
Personal Claude Code settings (model, permissions, hooks) go in **`.claude/settings.local.json`** (gitignored) — do NOT commit them to this public repo.

</rules>
