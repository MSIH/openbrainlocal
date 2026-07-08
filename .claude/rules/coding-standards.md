# Coding Standards
globs: **/*.js, **/*.mjs

## Code-First Principle
Generated code is optimized for machine consumption: concise, dense, pattern-matched to the existing codebase (`src/server.js`).

## Before Creating/Editing Any File
1. Read `src/server.js` (and any sibling of the same kind) first.
2. Match its structure, density, and style exactly.
3. Do not introduce new patterns, frameworks, or formatting conventions unasked.

## Module & Language
- **ESM only** — `import`/`export`, `"type": "module"`. No `require`, no CommonJS.
- Node 18+ built-ins are fine (`node:crypto`, `fetch`). Prefer built-ins over new deps.
- `async`/`await` for all async work. No floating promises — `await` them or explicitly `void`/handle.
- No TypeScript; but keep shapes obvious. Validate external input with `zod` (shared schemas).

## Naming
| Element | Convention | Example |
|---------|------------|---------|
| Variables / functions | `camelCase` | `executeStore`, `memoryId` |
| Classes / constructors | `PascalCase` | `McpServer` |
| Constants (module-level config) | `UPPER_SNAKE` | `VECTOR_DIMENSION`, `EMBEDDING_MODEL` |
| Prepared statements | `xxxStmt` | `insertVecStmt` |
| Async functions | verb-first | `getEmbedding`, `executeRecall` |

## Required
- Prepared statements for all SQL (compile once, reuse) — never build SQL by string concatenation.
- All config through `process.env` (via `dotenv`); never hardcode secrets, keys, URLs, or model names.
- Structured errors: on catch, log the error object (`console.error("context", err)`), never swallow. The Express error middleware is the single funnel — keep it.
- Constant-time comparison for the auth token (`timingSafeEqual` over hashes) — do not weaken.

## Prohibited
- Hardcoded secrets / API keys / tokens — why: this repo is public; secrets live in `.env` (gitignored).
- Committing `.env`, `*.db*`, or `node_modules/` — why: secrets, machine-specific, and huge.
- Empty `catch {}` — why: hides failures; always log or rethrow.
- Magic numbers (embedding dims, limits, ports) — name them as constants — why: self-documenting and single-source.
- `var`; `require()`; blocking sync I/O on the request path — why: legacy / blocks the event loop.
- Commented-out code — why: noise; git history is the archive.

## No copyright header
Unlike some MSIH repos, source files here carry **no** mandatory copyright header — MIT + public. Don't add one.
