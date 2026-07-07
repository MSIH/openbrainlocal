# .claude/rules — Index

Project conventions for `life-context-connectors`. Read these before editing code. `CLAUDE.md` (repo root) links here and holds the absolute rules + run/test contract.

| File | Scope | Contents |
|------|-------|----------|
| `coding-standards.md` | `**/*.js` | ESM/Node style, naming, no hardcoded secrets, no committed `.env`/`node_modules` |
| `connector-conventions.md` | wire contract | Payload shape rules, `source`/`source_id` discipline, spool/fallback pattern, entity hints — the connector-side half of `docs/04-connector-contract.md` |
| `design-philosophy.md` | all work | 8 tenets: data preservation, metadata capture, log tables, log every step, docs-up-to-date, docs-close-to-code, baseline method, AI-artifact capture |

## Workflow tooling (present)
Mirrored from `msih/life-context` (full rationale documented there) and adapted for a connectors monorepo: no SQLite/sqlite-vec/embeddings concerns here, so `data-model.md` became `connector-conventions.md`, and the pre-PR review's smoke test became "verify the touched connector's own I/O" instead of the core server's store→recall loop. Carried over as-is: `commands/{draft-issue,pre-pr-review,pre-doc-review}.md`, `agents/planning.md` (Opus), the `hooks/` gates (`draft-issue-gate`, `pre-pr-review-gate`, `worktree-gate`, `worktree-edit-gate`, `cloud-issue-gate`, `session-start`; tests in `hooks/test-gates.sh`), and `settings.json` wiring them + an `rm` deny. Mandatory flow: **draft-issue → worktree → pre-pr-review** (doc-only: `pre-doc-review`). See `CLAUDE.md`.

## Not carried over
`data-model.md` (SQLite/sqlite-vec-specific — connectors never touch the store directly, see `docs/04-connector-contract.md` §1.1/§3) was replaced, not copied, by `connector-conventions.md`. Personal settings belong in `.claude/settings.local.json` (gitignored).
