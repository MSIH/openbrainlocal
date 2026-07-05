# Pre-PR Review

Multi-persona review of the current branch before opening a PR. A `PreToolUse` hook (`.claude/hooks/pre-pr-review-gate.sh`) blocks `gh pr create` until this skill writes the current HEAD SHA to the marker on an APPROVE verdict.

## Inputs
- `git rev-parse --abbrev-ref HEAD`, `git status --short`
- `git diff main...HEAD --stat` and the full diff
- Read every changed `.js` / `.json` / hook / doc **in full** — diff context alone isn't enough.

## Personas (run those that apply; each → Blockers / Should-fix `[sev N/10]` / Nits)
- **Correctness (Node / ESM)** — `async`/`await` correctness, no floating promises, guard clauses on inputs, resource cleanup, prepared-statement reuse; matches `src/brainserver.js` density/idiom.
- **Security / secrets** — no hardcoded secrets/keys (env only), no committed `.env` / `*.db`, auth intact (constant-time compare, `x-api-key`), rate limiting intact, raw HTML/`MarkupString` only on trusted input.
- **Data model (SQLite / sqlite-vec)** — vec0 PK bound as `BigInt`; `VECTOR_DIMENSION` matches the embedding model; enrich-then-commit atomic; append-only (no destructive ops). See `.claude/rules/data-model.md`.
- **Error handling** — no empty `catch`; errors logged and funnelled; no swallowed rejections; `Try*`/false returns handled.
- **Test coverage** — new/changed behavior is exercised; the store→recall path still works.

## Automated bug hunt
Run the built-in `code-review` skill at `high` effort over the branch diff; fold its findings into the verdict (same severity rubric). Persona findings outrank it on repo conventions.

## Smoke-test gate (required before APPROVE)
Boot the server against local Ollama and confirm the loop end-to-end: `POST /api/remember` then `/api/recall` returns the memory with **0 server errors**. Needs Ollama + `qwen3-embedding:0.6b`; if unavailable, say so and do NOT APPROVE on assumption.

## Verdict + auto-fix
`APPROVE` | `APPROVE-WITH-NITS` | `CHANGES-REQUESTED` | `BLOCK`. Apply deterministic fixes (nits + single-correct-edit should-fixes), re-run the smoke test, then re-verdict. Hold structural/behavioral changes for a go/no-go.

## Clear the gate
On `APPROVE` / `APPROVE-WITH-NITS` **only**:
```bash
git rev-parse HEAD > "$CLAUDE_PROJECT_DIR/.claude/.pre-pr-review-done"
```
Do NOT write the marker on `CHANGES-REQUESTED` / `BLOCK` — fix, re-run, and it clears naturally.

## After the PR opens
Request a Copilot review (`--reviewer @copilot` at create, or `gh pr edit <n> --add-reviewer @copilot`). Triage all review comments; dismiss ones that violate repo conventions (cite the rule). One re-request cap.
