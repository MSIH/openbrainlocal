# LifeContext (formerly Open Brain Local) — Agent Guide

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
- **Store:** `better-sqlite3` + `sqlite-vec` (vec0 virtual table), WAL mode. Local file `life-context.db`.
- **Embeddings/LLM:** OpenAI SDK pointed at **local Ollama** (`http://localhost:11434/v1`), model `qwen3-embedding:0.6b` (1024-dim).
- **AI interface:** `@modelcontextprotocol/sdk` — Streamable HTTP MCP server.
- **Validation:** `zod`. **Config:** `dotenv`.

## Layout
```
src/config.js            — single config source (dotenv loads here, before any env read)
src/db.js                — the store: schema (artifacts + entity graph + vec/FTS), prepared stmts, storeArtifactTxn, ingest_log
src/embeddings.js        — shared Ollama client + getEmbedding (used by server + scripts)
src/geocode.js           — offline reverse-geocoding (place_label from lat/lon); src/geodata/places.json is the bundled GeoNames-derived dataset (CC BY 4.0), regenerate via `npm run geocode:build -- <path-to-cities1000.txt>`
src/search.js            — query planner: LLM parse, SQL prefilter, KNN + FTS, RRF fusion, timeline/about_entity
src/server.js            — the server: REST + MCP tools, auth, transport (imports the modules above)
src/migrate.js           — `npm run migrate`: OB1 memories -> artifacts (idempotent, reuses vectors)
src/contacts.js          — `npm run import:contacts <file>`: vCard -> entities + contact artifacts
connectors/              — external HTTP connectors, one self-contained folder each (doc 04; NEVER import src/ — `npm run check:boundary`)
docs/                    — design + setup docs (03 core design, 04 connector contract, 05 roadmap, 06 consolidation, 07 Cloudflare Tunnel remote access, 08 Claude Code web session capture)
.env.example             — required env template (copy to .env; never commit .env)
.claude/rules/           — coding standards, data-model, connector-conventions, design-philosophy (read before editing)
```

## Two Interfaces (same DB behind both)
| Interface | Endpoints / tools | Auth |
|-----------|-------------------|------|
| REST | `POST /api/{remember,recall,search,timeline,about_entity}`, `GET /api/artifact/:id` | `x-api-key` header |
| MCP (Streamable HTTP) | `/mcp` — tools `store_memory`, `search_memories`, `search`, `timeline`, `about_entity`, `get_artifact` | `x-api-key` header |

## Run & Test
```bash
npm install                      # + `npm rebuild better-sqlite3` if native build was skipped
ollama pull qwen3-embedding:0.6b # engine must be running on :11434
cp .env.example .env             # set LIFECONTEXT_API_KEY to a random value (placeholder is rejected)
npm start                        # serves on :3000
```
Smoke test (`$KEY` = `LIFECONTEXT_API_KEY`): `POST /api/remember` then `/api/recall` — recall returns the memory + a distance score. Full steps in `README.md` Quickstart and `docs/local-llm-setup-guide.md`.

</context>

<rules>

## Absolute Rules
1. **All config via env (`ISettings`-style through `dotenv`) — never hardcode** secrets, keys, URLs, or model names in a way that can't be overridden. `.env` is gitignored; only `.env.example` (placeholders) is committed.
2. **`VECTOR_DIMENSION` must match the embedding model's output.** `qwen3-embedding:0.6b` → 1024. Changing the model means changing the dim AND re-embedding (a fresh vec table); old vectors are incompatible.
3. **`sqlite-vec` vec0 primary keys must be bound as `BigInt`**, not a JS Number — `better-sqlite3` returns `lastInsertRowid` as a Number, so cast (`BigInt(id)`) on insert. A Number throws `SqliteError: Only integers are allowed for primary key values`.
4. **Enrich first, then commit atomically.** Fetch embeddings (network) *before* the DB transaction so a failed API call never orphans a row. See `storeTxn`.
5. **Memory is append-only — never hard-delete or overwrite** stored memories/artifacts. Preserve originals (`raw_path`, `content_hash`). See `.claude/rules/design-philosophy.md`.
6. **Providers pluggable, config-driven.** Embedding/LLM backends are swappable via env (local Ollama by default); don't couple logic to a specific provider.

## Every Change (mandatory workflow — no exceptions)
Enforced by gate hooks in `.claude/hooks/`. This repo is worked by multiple AI agents concurrently, so branches must be isolated in their own working dirs:
1. **`/draft-issue`** — file a GitHub issue and get explicit approval on the Implementation Plan first. (Gate denies `gh issue create` without a fresh marker.)
2. **worktree** — create the branch with `git worktree add`, NEVER a plain `git checkout -b` / `git switch -c`.
3. **`/pre-pr-review`** — run the multi-persona review (or **`/pre-doc-review`** for doc-only PRs). On APPROVE/APPROVE-WITH-NITS, if a governing issue number is on record for the branch (`.claude/.draft-issue-done` / `.claude/.cloud-issue-done` holds a value, or a commit already carries `Closes #<n>`/`Refs #<n>`), open the PR immediately with the generated title/body skeleton (body starts with `Closes #<n>`) — no separate ask. Otherwise report the verdict and wait to be asked. (Gate denies `gh pr create` without an APPROVE marker.) The repo ruleset requires a PR to the default branch (`2.0` today); merge, then sync it.

`/planning` (Opus) can perform steps 1–2 (issue + plan + worktree) in one shot. The `worktree-edit-gate` hook **denies editing `.js` source outside a `.worktrees/` dir** — step 2 is not optional.

**Cloud/remote sessions (claude.ai/code, GitHub tasks): the workflow is enforced by the `cloud-issue-gate` hook.** These sessions have no `gh` CLI (the `gh`-based gate hooks never trigger) and GitHub access goes through MCP tools instead — so the gate blocks **every Edit/Write under the repo (including `.claude/` tooling and `CLAUDE.md`)** until an issue exists: draft the plan per `/draft-issue`, get explicit approval, file it via the GitHub MCP tool `issue_write` (creation itself is gated by `draft-issue-gate`), then `echo <issue-number> > .claude/.cloud-issue-done` (gitignored; dies with the container, so each session re-earns it). See #13. The harness-assigned `claude/*` branch substitutes for the worktree (each cloud session is already an isolated clone, and `worktree-edit-gate` stands down when `CLAUDE_CODE_REMOTE=true`); still run `/pre-pr-review` / `/pre-doc-review` before any PR, and the PR body still starts with `Closes #<n>`.
- Run the store→recall smoke test (server boots, 0 errors) before committing server changes.
- Update the relevant `docs/**` when behavior changes; keep the README Quickstart accurate.
- Commit messages: imperative, ≤2 sentences. Reference issues/PRs as `#<n> "<title>"`.

## Style & Data
- Match `src/server.js`'s existing density and idiom. Details in `.claude/rules/coding-standards.md`.
- SQLite/schema conventions (occurred_at vs ingested_at, raw_path not blobs, dedup keys, WAL): `.claude/rules/data-model.md`.
- Design ethos (data preservation, logging, docs-close-to-code, baseline method, AI-artifact capture): `.claude/rules/design-philosophy.md`.

## Env / Config keys (`.env`)
- `LIFECONTEXT_API_KEY` (required — server hard-exits if unset or left at the placeholder)
- `PORT` (default 3000)
- `GEO_RADIUS_DEFAULT_KM` (default 25) / `GEO_RADIUS_MAX_KM` (default 500) — `near` geo-radius search (#68)
- Optional/for later cloud enrichment: provider keys — keep out of git.

## Workflow tooling & local settings
The mandatory-workflow tooling is committed in `.claude/` so it travels with the repo — cloud/remote agents get only the git checkout, never `~/.claude`:
- **Skills** (`.claude/commands/`): `/draft-issue`, `/pre-pr-review`, `/pre-doc-review`. **Agent** (`.claude/agents/`): `/planning` (Opus — issue + plan + worktree).
- **Hooks** (`.claude/hooks/`): `draft-issue-gate` + `pre-pr-review-gate` (deny), `worktree-gate` (advisory), `worktree-edit-gate` (deny `.js` edits outside a worktree; stands down in cloud sessions), `cloud-issue-gate` (deny ALL repo edits in cloud sessions until an issue number is in `.claude/.cloud-issue-done`), `session-start` (bootstrap Node deps on cloud/remote). Wired + an `rm` deny in `.claude/settings.json`; direct-invocation tests in `hooks/test-gates.sh`. `settings.json` also registers the cloud-gated `devsession-claude` `SessionEnd`/`PreCompact` session-capture hook — it runs only when `CLAUDE_CODE_REMOTE=true` (no-op locally, where a user-level hook handles capture) and no-ops without `LIFECONTEXT_API_KEY`; see `connectors/devsession-claude/README.md`. It also registers the `gh-event-claude` `PostToolUse` hook on the issue/PR create matchers (same matchers as the `draft-issue-gate`/`pre-pr-review-gate` `PreToolUse` gates), which records each created issue/PR as an `x-dev-event` memory — registered **unguarded** (fires locally and in cloud; harmless double-fire since ingest upserts by URL and there's no LLM step) and likewise no-ops without `LIFECONTEXT_API_KEY`; see `connectors/gh-event-claude/README.md` (#89).
Personal Claude Code settings (model, permission mode, extra hooks) go in **`.claude/settings.local.json`** (gitignored) — never commit those to this public repo.

</rules>
