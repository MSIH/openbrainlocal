# .claude/rules — Index

Project conventions for Open Brain Local. Read these before editing code or schema. `CLAUDE.md` (repo root) links here and holds the absolute rules + run/test contract.

| File | Scope | Contents |
|------|-------|----------|
| `coding-standards.md` | `**/*.js` | ESM/Node style, naming, prepared statements, prohibited patterns (no hardcoded secrets, no committed `.env`/`*.db`) |
| `data-model.md` | SQLite / sqlite-vec | Store shape (current + OB2 roadmap), the BigInt vec0-PK rule, `VECTOR_DIMENSION` matching, enrich-then-commit, append-only preservation, metadata + dedup keys |
| `design-philosophy.md` | all work | 8 tenets: data preservation, metadata capture, log tables, log every step, docs-up-to-date, docs-close-to-code, baseline method, AI-artifact capture |

## Not carried over from the source repo
Adapted from `msih.org.arbitration_web`. Deliberately **not** copied (arbitration/.NET-specific): the `commands/` skills (clause-*, deploy-iis, Blazor `new-*`, draft-issue), the `hooks/` gates (draft-issue / worktree / pre-pr-review / dotnet-output-filter), the PowerShell statusline, and the personal `settings.json` posture. Personal Claude Code settings belong in `.claude/settings.local.json` (gitignored).
