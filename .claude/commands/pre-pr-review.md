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

**Isolate the smoke server, then reap it (Windows).** Boot it on a **throwaway `PORT`** (e.g. `4123`) and a **temp `DB_PATH`** (under the scratchpad) so it never touches the real `:3000` LifeContext service or the real `.db`. When done, **kill it by its port's PID, not by the `$!` job**: Git Bash `kill $PID` does **not** reliably reap a detached `node src/server.js` on Windows, so a survivor lingers — holding the worktree dir (breaks Step 7's `git worktree remove`) and, on a reused port, answering later requests with a stale key (a confusing 401). Tear down and verify the port is free:
```bash
# Reap by the LISTENING port's PID — Git Bash `kill`/`$!` can't reliably reap a detached node on
# Windows. `:$PORT\b` anchors the port digits so :4123 doesn't also match :41230 or a foreign address.
netstat -ano | grep LISTENING | grep -E ":$PORT\b" | awk '{print $5}' | sort -u | while read -r pid; do [ -n "$pid" ] && taskkill //PID "$pid" //F >/dev/null 2>&1; done
netstat -ano | grep LISTENING | grep -qE ":$PORT\b" && echo "WARN: $PORT still up" || echo "$PORT down"
```
NEVER target port `3000` here — that's the real LifeContext service (see the Step 7 guard).

## Step 4 — Auto-fix (apply broadly)
Apply all Nits and all deterministic Should-fix items (single correct edit; naming, missing guard/`ArgumentNull`-equivalent, empty-catch→log, interpolated-log→structured, missing `EnsureSuccessStatusCode`-equivalent, test stubs) without per-item prompting. **Hold for a single go/no-go**: structural refactors, public-API/signature changes, behavior changes. Apply in batches; after each batch run the smoke test (and any `npm` build/lint/test); on red, revert that batch (`git restore .` + `git clean -fd` for scaffolded files) and re-classify. Commit batches separately. Re-run and re-verdict before proceeding.

## Clear the gate
On `APPROVE` / `APPROVE-WITH-NITS` **only**:
```bash
git rev-parse HEAD > "$CLAUDE_PROJECT_DIR/.claude/.pre-pr-review-done"
```
Do NOT write it on `CHANGES-REQUESTED` / `BLOCK` — fix the Blockers, re-run, and it clears. If the user explicitly says "open it anyway", confirm once, then write the marker.

Then check for a governing issue number on record for the branch: `.claude/.draft-issue-done` (local) or `.claude/.cloud-issue-done` (cloud) holds a value, or the branch's commits already carry a `Closes #<n>` / `Refs #<n>` trailer. If found, proceed straight to `gh pr create` (or the `mcp__github__create_pull_request` MCP tool in cloud sessions) using the Step 3 title/body skeleton — no separate ask. If no issue number is on record (ad hoc work), stop here: report the verdict and skeleton, and wait to be asked before opening the PR.

## Step 5 — Request bot review
After the PR is created, request a Copilot review. The mechanism differs by environment (mirrors how Step 3 branches `gh pr create` vs `mcp__github__create_pull_request`):
- **Local / desktop (has the `gh` CLI):** do NOT use `--reviewer @copilot` / `--add-reviewer @copilot` — `gh` lowercases the login and GitHub GraphQL rejects it (`Could not resolve user with login 'copilot'`); the `@copilot` form even exits 0 while attaching nothing. Use the REST bot login instead:
  ```bash
  gh api "repos/MSIH/life-context/pulls/<n>/requested_reviewers" -X POST -f "reviewers[]=copilot-pull-request-reviewer[bot]"
  ```
- **Cloud / remote (no `gh`; GitHub via MCP):** use the GitHub MCP tool `mcp__github__request_copilot_review` (`owner`, `repo`, `pullNumber`) — the `github/github-mcp-server` tool `request_copilot_review`, surfaced with the `mcp__github__` prefix (like `mcp__github__create_pull_request` in Step 3), that POSTs `/repos/{owner}/{repo}/pulls/{pullNumber}/copilot/review`. Confirm the exact tool name against the GitHub MCP server wired into the session.

Other bots (Greptile/CodeRabbit) auto-trigger if installed. Bot reviews are comment-only — they never block merge. Surface errors verbatim; don't retry on org/license errors.

## Step 6 — Monitor & resolve reviews (second-level)
Poll up to ~10 min for reviews (use the Monitor tool, not a sleep loop). Note: Copilot usually reviews within ~1 min and then **drops off `requested_reviewers`** — its output lands in the PR's reviews + inline comments (fetched below), so don't gauge success by an empty `requested_reviewers`. When they arrive, fetch all three endpoints — formal reviews, inline thread comments, PR conversation comments — and triage each: **Accept** (fix; ≥7 before merge), **Defer** (valid, out of scope → follow-up issue, link it), **Dismiss** (invalid / violates a repo convention → cite the rule). Persona findings outrank bot findings on repo conventions (e.g., a bot suggesting a committed `.env`, hardcoded key, or non-`BigInt` vec PK is wrong here). Apply mechanical Accepts, rebuild/smoke, push, resolve every thread. Hard cap: one Copilot re-request per invocation.

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

# 2. Move to the primary checkout (OUT of the worktree — else Windows locks the dir you stand in)
#    and sync the default branch (CLAUDE.md post-merge step).
cd "$MAIN" && git checkout 2.0 && git pull origin 2.0

# 3. Remove the merged worktree, then prune the branch. On Windows the dir is often locked — by a
#    transient Defender/indexer handle (clears on a short retry) or, rarely, a smoke-test server the
#    gate failed to reap (its cwd is the worktree). So `git worktree remove --force` can fail
#    "Permission denied": retry once, then fall back to Recycle-Bin'ing the leftover dir (registration
#    is pruned first, so recycle is safe and matches the Recycle-over-delete preference). --force also
#    clears disposable UNTRACKED artifacts (temp files, markers). If recycle ALSO reports the dir in
#    use, a live smoke server is holding it — kill it by ITS throwaway port (the one the smoke gate
#    used, e.g. 4123), never by a blind port-range sweep and NEVER :3000, then re-run the recycle.
git worktree remove "$WORKTREE" --force || { sleep 2; git worktree remove "$WORKTREE" --force || {
  echo "worktree remove still locked — pruning registration and recycling the leftover dir"
  git worktree prune
  powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('$WORKTREE','OnlyErrorDialogs','SendToRecycleBin')" 2>&1 || echo "MANUAL: a live process holds $WORKTREE — kill the stray smoke server by its throwaway port, then recycle"; }; }
git worktree prune
# Branch is safe to force-delete: gh confirmed MERGED, and a squash-merge leaves the branch tip
# unreachable from 2.0 (so plain `git branch -d` would wrongly refuse).
git branch -D "$BRANCH" 2>/dev/null || true
git fetch origin --prune      # drop the remote-tracking ref if GitHub auto-deleted the head branch

# 4. Restart the live LifeContext service ONLY when the merge changed server code/schema — i.e. the
#    merged PR touched a `src/**` path. A doc/tooling-only merge (docs/**, .claude/**, README) runs
#    byte-identical server behavior, so a restart would just bounce the live memory server (+ any
#    active connector, e.g. scan.js) for zero benefit — and every needless restart risks a boot
#    failure. When it DOES fire it's a DELIBERATE reload via WinSW ("LifeContext Memory Server") that
#    loads the merged code + runs the boot-time schema migration (e.g. proposed_entities.attrs_json) —
#    distinct from, and NOT in conflict with, the never-KILL-:3000 smoke guard. May need elevation.
# Fetch the merged PR's file list FIRST, distinguishing a gh failure from a genuine no-src result:
# a failed fetch (auth/rate-limit/network) must NOT be read as "no src/** changes" and silently
# skip a needed restart (that would leave the live server on stale code). On fetch failure, fail
# SAFE — restart anyway (a needless bounce on a rare gh hiccup beats a silently-stale memory server).
if changed=$(gh pr view "$PR_NUMBER" --json files --jq '.files[].path' 2>/dev/null); then
  printf '%s\n' "$changed" | grep -q '^src/' && need_restart=1 || need_restart=0
else
  echo "WARN: couldn't fetch the merged PR's file list (gh error) — can't tell if server code changed; restarting to be safe"
  need_restart=1
fi
if [ "$need_restart" = 1 ]; then
  powershell -NoProfile -Command "Restart-Service LifeContext" 2>&1 || echo "WARN: restart failed — run 'Restart-Service LifeContext' manually (may need elevation)"
  # Verify :3000 is back — ANY HTTP response (401/404 included) proves it booted; 000/empty = down.
  # Use `|| true` (NOT `|| echo 000`): curl's -w already prints 000 on failure, so `|| echo 000` would
  # concatenate a SECOND 000 → "000000", which passes the `!= 000` test and falsely reports "up".
  # `|| true` also keeps the failed curl from tripping `set -e` on the assignment.
  code=000
  for i in $(seq 1 15); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/ || true)
    [ "$code" != "000" ] && [ -n "$code" ] && break
    sleep 1
  done
  if [ "$code" != "000" ] && [ -n "$code" ]; then
    echo "LifeContext :3000 → HTTP $code (back up on merged code)"
  else
    # Exit non-zero (like the other Step 7 guards) so a downed memory server after restart is a hard
    # failure the operator/agent must act on — not a silent exit-0 that reads as success.
    echo "ERROR: LifeContext :3000 did not respond after restart — investigate NOW (server may be down)"; exit 1
  fi
else
  echo "doc/tooling-only merge (no src/** changes) — LifeContext restart not needed"
fi
```

Rules:
- **No confirmation prompt.** This is the default, not a gate. Asking "should I remove the worktree?" after a merge is exactly what this step exists to eliminate.
- Guard on `state == MERGED` first (via `gh`, the source of truth). NEVER remove a worktree whose PR is still open or was closed unmerged.
- Refuse on uncommitted **tracked** changes (`git status --porcelain --untracked-files=no` non-empty) — STOP and report; do not `--force` over real work. Disposable untracked artifacts (temp PR-body files, markers) are fine to clear.
- Always `cd "$MAIN"` before `git worktree remove` — you cannot remove the worktree you are standing in (Windows locks it).
- `git branch -D` is correct here only because `gh` confirmed the merge; outside that guard, never force-delete a branch.
- **Windows lock is expected, not exceptional.** A locked `git worktree remove` retries once, then recycles the leftover dir — never leave a half-removed worktree registered; `git worktree prune` + the recycle is the fallback.
- **Restart the LifeContext service after a merge that changed server code/schema** (step 4 — gated on the merged PR touching a `src/**` path) so the running :3000 instance loads the merged code and applies any boot-time schema migration. A doc/tooling-only merge (docs/**, .claude/**, README) skips the restart — bouncing the live server for byte-identical behavior is needless risk. Restart the *service* (`Restart-Service LifeContext`); never `taskkill` the :3000 node PID (that's the smoke-guard's forbidden action). Only smoke servers on throwaway ports are killed by PID.

## Rules
- Open the PR yourself only when a governing issue number is on record for the branch (see Clear the gate). Otherwise, output + gate-clear only — do not open the PR without being asked.
- Persona findings outrank both the bug-hunt and bot reviews on MSIH/repo conventions.
- Don't invent findings. "No findings." when a persona is clean.
- Severity tag required on every Should-fix.
