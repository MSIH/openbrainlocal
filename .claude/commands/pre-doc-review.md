---
description: Pre-PR review of documentation on the current branch — accuracy-vs-code, command correctness, clarity, cross-references, secrets, and staleness. Use before any PR touching docs/** or README.md.
---
# Pre-PR Doc Review

Pre-PR review of **documentation** on the current branch. Catch inaccuracy, stale claims, broken commands/links, and leaked secrets before the PR opens. A doc that contradicts the code is worse than no doc — it makes the next agent diverge.

## Scope
`docs/**/*.md`, `README.md`, and each connector's own `README.md`. Source-code review belongs to `/pre-pr-review`. If the diff has no doc changes, say so and stop.

## Inputs
1. `git status --short`; `git rev-parse --abbrev-ref HEAD`
2. `git diff main...HEAD --stat -- '*.md' 'docs/**'`
3. `git diff main...HEAD -- '*.md' 'docs/**'` — and Read each changed doc **in full**.
4. Read the code/config the doc describes — the relevant connector's `index.js`/`package.json`/`.env.example`, `.claude/**`. **Accuracy is judged against the code, not the prose.**

If the scoped diff is empty or whitespace-only, say so and stop.

## Step 1 — Triage (required)
```
Doc PR Triage
-------------
Branch / Base                 : <cur> / main
Docs changed                  : <list>
Size                          : XS|S|M|L|XL (lines changed)
Change type                   : new-doc | substantive | copyedit | typo-only
Describes commands / env vars : yes|no
References code symbols/paths : yes|no
Cross-references other docs   : yes|no
Personas engaged              : [...]
```
Routing: `typo-only` → Editorial + Accuracy only. `copyedit`/`substantive`/`new-doc` → all applicable personas.

## Step 2 — Persona reviews
Run each engaged persona as a separate, labeled section. Each finding: **file:line**, the offending excerpt (≤25 words), the issue, and a concrete fix. Bucket into **Blockers / Should-fix `[sev N/10]` / Nits**.

- **Accuracy vs. code** (always) — every claim matches current code/config. Flag drift: wrong env var name/default, wrong endpoint path, behavior the code doesn't actually do, a settings.json snippet that isn't valid JSON or doesn't match what the hook actually reads.
- **Command correctness** (if commands present) — every command is copy-pasteable and correct: right paths, flags, and order; `node`/`npm`/`curl` invocations actually work; placeholders explained; no invented flags.
- **Clarity / plain-language** (prose changes) — jargon defined on first use; steps concrete and ordered; a new contributor with zero context could follow it (same test as `/draft-issue`).
- **Structure / editorial** (always) — heading hierarchy sane; no leftover scaffolding / TODOs / stale `Status` lines; lists over prose for enumerations; density matches sibling docs.
- **Cross-reference / link integrity** (if refs present) — every internal link/path (`docs/…`, a connector folder, `[text](target)`) resolves to something that exists; a link to `msih/life-context` resolves to the actual file/branch named; `#<n> "<title>"` refs valid.
- **Secrets / safety** (always — public repo) — no real keys/tokens/secrets in prose or code blocks (placeholders only); no internal-only URLs/paths that shouldn't be public.
- **Staleness** (always) — no claim contradicting current code or another doc; if `docs/04-connector-contract.md` was touched, confirm it still matches the source-of-truth copy in `msih/life-context` (or that the provenance banner's commit reference was updated).

## Step 3 — Reconciliation & verdict
```
Overall Verdict              : APPROVE | APPROVE-WITH-NITS | CHANGES-REQUESTED | BLOCK
Blockers / Should-fix / Nits : N / N / N
Top 3 fixes before PR        : 1… 2… 3…
PR title suggestion          : <conventional commit, ≤70 chars>
PR body skeleton             : first line `Closes #<n>`, then Summary / Docs changed / Reviewer notes
```
Rubric: any Blocker → BLOCK; ≥1 Should-fix ≥8 → CHANGES-REQUESTED; else APPROVE-WITH-NITS / APPROVE.

## Clear the gate
On `APPROVE` / `APPROVE-WITH-NITS` only:
```bash
git rev-parse HEAD > "$CLAUDE_PROJECT_DIR/.claude/.pre-doc-review-done"
```
Doc-only PRs use this marker in place of the code review's. Do NOT write it on `CHANGES-REQUESTED` / `BLOCK` — fix, re-run, and it clears. (If the user explicitly says "open it anyway", confirm once, then write the marker.)

## Step 4 — Auto-fix
Mechanical Blockers/Should-fix (broken links, wrong command flags, stale numbers, missing placeholder, leftover scaffolding) → list as a checklist, apply on confirmation, then re-verdict.

## Rules
- Do not open the PR yourself. Output only.
- Judge accuracy against the **code**, not the prose.
- Cite `file:line` + the excerpt with every finding. No invented issues — say "No findings" when clean.
