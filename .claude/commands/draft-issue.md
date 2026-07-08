# Draft Issue

Issues are implementation briefs for a fresh agent with zero conversation context. Test: *could a new Claude Code session implement this correctly using only the issue body and the codebase, with no memory of prior discussion?* If no, the issue is incomplete.

Author a GitHub issue for `MSIH/life-context`, get explicit approval on the Implementation Plan, then file it. A `PreToolUse` hook (`.claude/hooks/draft-issue-gate.sh`) blocks `gh issue create` until this skill writes a fresh marker (600s) — no marker, no issue.

## When
Before ANY branch-creating work — issue first, always. No exceptions (not for "trivial", doc-only, or config changes).

## Step 1 — Investigate
Read the relevant code before drafting: `src/server.js`, `docs/**`, `.claude/rules/*`. For a bug, locate the root-cause file **and line** and confirm the reproduction — do not file on a symptom. Open at most a few files; don't read the world.

## Tier selection (choose before drafting)
| Tier | Use when | Sections |
|------|----------|----------|
| **New Feature** | new route, MCP tool, DB table/column, or service seam; design choices exist | All 8 |
| **Bug Fix** | wrong behavior in existing code; no new interface/table/route | 4 only |
| **Compound** | 2–8 related changes in the same area | All 8, adapted (one bullet/checkbox per item) |
In doubt → New Feature.

## Step 2 — Draft the body (dense: bullets / tables / code only; no prose walls)

**New Feature — all 8 sections** (use `N/A`, never drop a header):
| Section | Required content |
|---------|------------------|
| Problem | 2–3 sentences: what's missing/broken and why it matters. |
| Design Decisions | Bulleted WHY behind each choice — the primary source of implementation fidelity. Never omit. |
| Data / Schema Changes | Per table/column: name, type, `vec0` dimension, dedup key `(source, source_id)`/`content_hash`, WAL, and the **sqlite-vec BigInt PK** + `VECTOR_DIMENSION`-match constraints. Migration note (back up the `.db`; `IF NOT EXISTS` won't resize a vec table). `N/A` if none. |
| Interface Contracts | Exact signatures — REST: method + path + request/response JSON + auth header; MCP: tool name, input schema (zod fields), annotations. `N/A` if none. |
| Behavior / Output | Concrete responses, error shapes, status codes, log lines, edge-case outputs. `N/A` if none. |
| Implementation Plan | Numbered, **one step per file**, exact paths, what changes + the constraint. No vague steps. |
| Acceptance Criteria | Checkbox list, binary/observable. MUST include the store→recall smoke test (or a regression line) and any repro from Problem. |
| Out of Scope | Deferred items (write "None" if empty). |

**Bug Fix — 4 sections only** (drop the others entirely): **Problem** (what's broken + repro + impact) · **Root Cause** (exact `file:line`) · **Implementation Plan** (numbered, one step per file) · **Acceptance Criteria** (the repro MUST appear as a criterion).

## Step 3 — Confirmation gate (MANDATORY)
Paste the **Implementation Plan** section back to the user verbatim and wait for **explicit written approval** ("approved" / "ship it"). A non-response, emoji, topic change, or vague "looks good" does NOT count. On change requests, edit and re-paste; loop until explicit approval. (This is what the `git worktree add` gate re-checks.)

## Step 3.5 — Labels
Type (exactly 1, from the commit prefix): `fix`→bug · `feat`→enhancement · `refactor`→refactor · `chore`→chore · `docs`→documentation. Priority (optional): `P1`/`P2`/`P3`. Fresh repos may lack labels — create the label or drop `--label` rather than fail.

## Step 4 — Write the marker, then file (back-to-back; marker is fresh 600s)
```bash
date -u +%Y-%m-%dT%H:%M:%SZ > "$CLAUDE_PROJECT_DIR/.claude/.draft-issue-done"
gh issue create --repo MSIH/life-context --title "<conventional-commit title, ≤70 chars>" --body-file <file> [--label <type>]
```
Confirm the active `gh` account is **MSIH** first (`gh auth status`).

## quick=true (follow-ups only)
Trivial follow-ups (≤2 files, no design): skip the section walk AND the confirmation gate; still write the marker. Body = Problem (1–2 sentences) + one observable Acceptance line + Out of Scope. Not for new work.

## Emergency bypass (single-use)
If the skill can't run and the user explicitly authorizes skipping:
```bash
date -u +%Y-%m-%dT%H:%M:%SZ > "$CLAUDE_PROJECT_DIR/.claude/.draft-issue-skip"
```
Accepted within 60s, deleted on read. Document the bypass reason in the issue body — audit trail.

## Rules
- Do NOT write the marker before the Step 3 confirmation completes — the gate enforces the 8 sections, not just a timestamp.
- The marker is per-worktree — write it in the checkout you'll run `gh issue create` from.
- PR body (later) MUST begin with `Closes #<n>`. Reference issues/PRs as `#<n> "<title>"`, never bare `#n`.
