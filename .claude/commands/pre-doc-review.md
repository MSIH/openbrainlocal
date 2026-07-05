---
description: Pre-PR review of documentation on the current branch — accuracy-vs-code, command correctness, clarity, cross-references, secrets, and staleness. Use before any PR touching docs/** or README.md.
---
# Pre-PR Doc Review

Pre-PR review of **documentation** on the current branch. Catch inaccuracy, stale claims, broken commands/links, and leaked secrets before the PR opens. A doc that contradicts the code is worse than no doc — it makes the next agent diverge.

## Scope
`docs/**/*.md` and `README.md`. Source-code review belongs to `/pre-pr-review`. If the diff has no doc changes, say so and stop.

## Inputs
1. `git status --short`; `git rev-parse --abbrev-ref HEAD`
2. `git diff main...HEAD --stat -- '*.md' 'docs/**'`
3. `git diff main...HEAD -- '*.md' 'docs/**'` — and Read each changed doc **in full**.
4. Read the code/config the doc describes — `src/brainserver.js`, `package.json`, `.env.example`, `.claude/**`. **Accuracy is judged against the code, not the prose.**

If the scoped diff is empty or whitespace-only, say so and stop.

## Step 1 — Triage (required)
```
Doc PR Triage
-------------
Branch / Base                 : <cur> / main
Docs changed                  : <list>
Size                          : XS|S|M|L|XL (lines changed)
Change type                   : new-doc | substantive | copyedit | typo-only
Describes commands / API      : yes|no
References code symbols/paths : yes|no
Cross-references other docs   : yes|no
Personas engaged              : [...]
```
Routing: `typo-only` → Editorial + Accuracy only. `copyedit`/`substantive`/`new-doc` → all applicable personas.

## Step 2 — Persona reviews
Run each engaged persona as a separate, labeled section. Each finding: **file:line**, the offending excerpt (≤25 words), the issue, and a concrete fix. Bucket into **Blockers / Should-fix `[sev N/10]` / Nits**.

- **Accuracy vs. code** (always) — every claim matches current code/config. Flag drift: wrong endpoint / flag / env var / model name / vector dimension; behavior the code doesn't actually do; numbers that disagree with `src/brainserver.js`, `.env.example`, or `package.json`.
- **Command correctness** (if commands present) — every command is copy-pasteable and correct for this repo + Windows: right paths, flags, and order; `npm` / `ollama` / `curl` invocations actually work; `$KEY` / placeholders explained; no invented flags.
- **Clarity / plain-language** (prose changes) — jargon defined on first use; steps concrete and ordered; a new contributor with zero context could follow it (same test as `/draft-issue`).
- **Structure / editorial** (always) — heading hierarchy sane; no leftover scaffolding / TODOs / stale `Status` lines; lists over prose for enumerations; density matches sibling docs.
- **Cross-reference / link integrity** (if refs present) — every internal link/path (`docs/…`, `src/…`, `[text](target)`) resolves to something that exists; no reference to a renamed/removed file; `#<n> "<title>"` refs valid.
- **Secrets / safety** (always — public repo) — no real keys/tokens/secrets in prose or code blocks (placeholders only); no internal-only URLs/paths that shouldn't be public.
- **Staleness** (always) — no claim contradicting current code or another doc; version / model / dimension numbers current; `Status` reflects reality.

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
