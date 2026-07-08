# Pre-PR Review

Multi-persona review of the current branch before the PR opens — catch issues now so the PR opens clean. A `PreToolUse` hook (`.claude/hooks/pre-pr-review-gate.sh`) blocks `gh pr create` until this skill writes the current HEAD SHA to `.claude/.pre-pr-review-done` on an APPROVE / APPROVE-WITH-NITS verdict. For doc-only PRs use `/pre-doc-review` instead.

## Inputs
1. `git status --short`; `git rev-parse --abbrev-ref HEAD`
2. `git log --oneline main..HEAD`; `git diff main...HEAD --stat`
3. `git diff main...HEAD` — the full diff
4. Read every changed `.js` / `.json` / hook / doc **in full** — diff context alone is not enough for architecture or security judgments.

If the diff is empty or whitespace-only, say so and stop.

## Step 1 — Triage (required; output first)
```
PR Triage
---------
Branch / Base                 : <cur> / main
Commits / Files / Size        : N / N / XS|S|M|L|XL
Touches SQLite / sqlite-vec   : yes|no
Touches embeddings / model    : yes|no
Touches auth / rate-limit     : yes|no
Touches MCP tools / REST routes : yes|no
Touches .claude/ hooks/skills : yes|no
New/modified public functions : yes|no
Touches try/catch or async    : yes|no
Personas engaged              : [Senior, Security, Performance, Data, Silent-Failure, TestCoverage]
```

## Step 1.5 — Automated bug hunt (required)
Invoke the built-in `code-review` skill over the branch diff at **high** effort (`max` when Size is L/XL or auth/schema/embeddings are touched). Review-only — no `--fix`, no `--comment`. Capture findings under "Automated Bug Hunt", map each to the 1–10 rubric, and feed them into Step 3. "No findings." if clean.

## Step 2 — Persona reviews
Run each engaged persona as a separate, labeled section — independent, no deferring. Each finding: **file:line**, the issue, and a concrete fix (snippet or one-sentence direction). Bucket:
- **Blockers** — must fix before PR opens (sev 9–10).
- **Should-fix `[sev N/10]`** — open the PR, fix before merge. Rubric: 8–9 behavior bug / security hole; 5–7 correctness / maintainability; 3–4 style; 1–2 preference. Sort high→low.
- **Nits** — optional (sev 0–2).

- **Senior Node / ESM** — `async`/`await` correctness; no floating promises (`await` or explicit discard); guard clauses on inputs; prepared-statement reuse (compile once); resource cleanup (`db`, streams); ESM-only (`import`, no `require`); no blocking sync I/O on the request path; matches `src/server.js` density/idiom; no `var`, magic numbers, dead/commented code.
- **Security / secrets** — no hardcoded secrets/keys/tokens (env only); no committed `.env` / `*.db` / `node_modules`; auth intact (constant-time `timingSafeEqual` over hashed token, `x-api-key`); rate limiting preserved; server binds only where intended (it listens on all interfaces — the key is the real access control); raw HTML / `MarkupString`-equivalent only on trusted input with a justification.
- **Performance** — no N+1 SQL; `IQueryable`-equivalent not materialized early; no `await` in a tight loop where a batch would do; embeddings fetched once, not per row; no unbounded in-memory growth on the request path.
- **Data model (SQLite / sqlite-vec)** — vec0 PK bound as `BigInt` (Number throws); `VECTOR_DIMENSION` matches the embedding model; enrich-then-commit atomic (embed before the transaction); **append-only** — no hard-delete/overwrite; dedup keys + WAL respected. See `.claude/rules/data-model.md`.
- **Silent-Failure / Error-Handling** — no empty `catch {}`; no catch-and-swallow where the caller can't recover; generic `catch (err)` carries a one-line justification or a specific type; errors funnel through the Express error middleware; no fire-and-forget promise that can reject unobserved; `SaveChanges`-equivalent surfaces failures.
- **Test Coverage** — for each new/changed public function or MCP tool/route, is there coverage, and does the **store→recall path still work**? Rate the gap 1–10 (10 = must add before merge). List the test names you'd add.

## Step 3 — Reconciliation & verdict
Merge Automated-Bug-Hunt findings with persona findings (dedupe same file/line). Then:
```
Overall Verdict  : APPROVE | APPROVE-WITH-NITS | CHANGES-REQUESTED | BLOCK
Blocker count    : N
Should-fix count : N (9-10:N 7-8:N 5-6:N 3-4:N 1-2:N)
Nit count        : N
Top 3 to fix before PR (by severity): 1… 2… 3…
PR title         : <conventional commit, ≤70 chars>
PR body skeleton : first line `Closes #<n>`; then Summary / Changes / Verification / Test plan
```
Rubric: any Blocker → BLOCK; no Blockers but ≥1 Should-fix ≥8 → CHANGES-REQUESTED; findings but none ≥8 → APPROVE-WITH-NITS; nothing above Nit → APPROVE.

## Smoke-test gate (required before any APPROVE)
Boot the server against local Ollama and confirm the loop end-to-end: `POST /api/remember` then `/api/recall` returns the stored memory with a distance score and **0 server errors** (tail the server log). Needs Ollama + `qwen3-embedding:0.6b` on :11434. If unavailable, say so and do NOT APPROVE on assumption. For hook/doc-only changes with no server code touched, verify the hooks (`bash -n`, behavior) instead and note the server was unchanged.

## Step 4 — Auto-fix (apply broadly)
Apply all Nits and all deterministic Should-fix items (single correct edit; naming, missing guard/`ArgumentNull`-equivalent, empty-catch→log, interpolated-log→structured, missing `EnsureSuccessStatusCode`-equivalent, test stubs) without per-item prompting. **Hold for a single go/no-go**: structural refactors, public-API/signature changes, behavior changes. Apply in batches; after each batch run the smoke test (and any `npm` build/lint/test); on red, revert that batch (`git restore .` + `git clean -fd` for scaffolded files) and re-classify. Commit batches separately. Re-run and re-verdict before proceeding.

## Clear the gate
On `APPROVE` / `APPROVE-WITH-NITS` **only**:
```bash
git rev-parse HEAD > "$CLAUDE_PROJECT_DIR/.claude/.pre-pr-review-done"
```
Do NOT write it on `CHANGES-REQUESTED` / `BLOCK` — fix the Blockers, re-run, and it clears. If the user explicitly says "open it anyway", confirm once, then write the marker.

## Step 5 — Request bot review
After the PR is created, request a Copilot review (`--reviewer @copilot` at create, or `gh pr edit <n> --add-reviewer @copilot`). Other bots (Greptile/CodeRabbit) auto-trigger if installed. Bot reviews are comment-only — they never block merge. Surface `gh` errors verbatim; don't retry on org/license errors.

## Step 6 — Monitor & resolve reviews (second-level)
Poll up to ~10 min for reviews (use the Monitor tool, not a sleep loop). When they arrive, fetch all three endpoints — formal reviews, inline thread comments, PR conversation comments — and triage each: **Accept** (fix; ≥7 before merge), **Defer** (valid, out of scope → follow-up issue, link it), **Dismiss** (invalid / violates a repo convention → cite the rule). Persona findings outrank bot findings on repo conventions (e.g., a bot suggesting a committed `.env`, hardcoded key, or non-`BigInt` vec PK is wrong here). Apply mechanical Accepts, rebuild/smoke, push, resolve every thread. Hard cap: one Copilot re-request per invocation.

## Step 7 — Post-merge cleanup (automatic — no prompt)

Once a PR opened via this flow is **merged**, clean up its worktree **immediately and without asking**. The user has standing approval for post-merge worktree cleanup — do NOT prompt, do NOT offer; just do it. Stale worktrees and merged branches otherwise pile up (see `git worktree list`).

Trigger this step when you observe the PR is merged: the user says it merged / "merge it", you just ran `gh pr merge`, or a poll returns `state: MERGED`.

```bash
set -euo pipefail   # any failed precondition (gh, cd, pull) aborts before we touch the worktree
PR_NUMBER=${PR_NUMBER:-$(gh pr view --json number --jq .number)}
STATE=$(gh pr view "$PR_NUMBER" --json state --jq .state)          # gh is the source of truth
BRANCH=$(git rev-parse --abbrev-ref HEAD)
WORKTREE=$(git rev-parse --show-toplevel)
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')  # primary checkout

# 1. Hard guards — never remove a worktree whose PR is not merged, or one with uncommitted TRACKED work.
[ "$STATE" = "MERGED" ] || { echo "PR #$PR_NUMBER state=$STATE (not MERGED) — skip cleanup"; exit 0; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Worktree has uncommitted tracked changes — STOP, report to user, do NOT remove"; exit 1
fi

# 2. Move to the primary checkout and sync the default branch (CLAUDE.md post-merge step).
cd "$MAIN" && git checkout 2.0 && git pull origin 2.0

# 3. Remove the merged worktree, then prune the branch.
#    --force clears disposable UNTRACKED artifacts (PR-body temp files, .pre-pr-review-done marker);
#    tracked changes were already rejected by the guard above.
git worktree remove "$WORKTREE" --force
git worktree prune
# Branch is safe to force-delete: gh confirmed MERGED, and a squash-merge leaves the branch tip
# unreachable from 2.0 (so plain `git branch -d` would wrongly refuse).
git branch -D "$BRANCH" 2>/dev/null || true
git fetch origin --prune      # drop the remote-tracking ref if GitHub auto-deleted the head branch
```

Rules:
- **No confirmation prompt.** This is the default, not a gate. Asking "should I remove the worktree?" after a merge is exactly what this step exists to eliminate.
- Guard on `state == MERGED` first (via `gh`, the source of truth). NEVER remove a worktree whose PR is still open or was closed unmerged.
- Refuse on uncommitted **tracked** changes (`git status --porcelain --untracked-files=no` non-empty) — STOP and report; do not `--force` over real work. Disposable untracked artifacts (temp PR-body files, markers) are fine to clear.
- Always `cd "$MAIN"` before `git worktree remove` — you cannot remove the worktree you are standing in.
- `git branch -D` is correct here only because `gh` confirmed the merge; outside that guard, never force-delete a branch.

## Rules
- Do not open the PR yourself in this skill — output + gate-clear only.
- Persona findings outrank both the bug-hunt and bot reviews on MSIH/repo conventions.
- Don't invent findings. "No findings." when a persona is clean.
- Severity tag required on every Should-fix.
