# Draft Issue

Author a GitHub issue for `MSIH/openbrainlocal`, get explicit approval on the plan, then file it. A `PreToolUse` hook (`.claude/hooks/draft-issue-gate.sh`) blocks `gh issue create` until this skill writes a fresh marker.

## When
Before any branch-creating work — **issue first, always** (mandatory workflow for this repo).

## Steps
1. **Investigate** — read the relevant code (`src/brainserver.js`, `docs/`, `.claude/rules/`). Confirm the root cause / scope. Don't file on a symptom alone.
2. **Draft the body** (dense — bullets / tables / code blocks, no prose walls):
   - **Problem** — what's broken/missing and why it matters.
   - **Approach** — the design in a few bullets (the *why* behind each choice).
   - **Implementation Plan** — numbered, one step per file, exact paths.
   - **Acceptance Criteria** — checkboxes, observable and testable; include a smoke-test / regression line.
   - **Out of Scope** — deferrals (or "None").
3. **Confirmation gate (mandatory)** — paste the **Implementation Plan** to the user verbatim and wait for explicit written approval ("approved" / "ship it"). A non-response, emoji, or topic change does NOT count. If they request changes, edit and re-paste; loop until approved.
4. **Write the marker, then file** (do these back-to-back — the marker is fresh for 600s):
   ```bash
   date -u +%Y-%m-%dT%H:%M:%SZ > "$CLAUDE_PROJECT_DIR/.claude/.draft-issue-done"
   gh issue create --repo MSIH/openbrainlocal --title "<conventional-commit-style title>" --body-file <file> [--label enhancement]
   ```
   Confirm the active `gh` account is **MSIH** first (`gh auth status`).

## quick=true (trivial follow-ups)
Skip the section walk AND the confirmation gate; still write the marker. Short body: Problem (1-2 sentences) + one Acceptance line + Out of Scope. Use only when the change touches ≤2 files and needs no design discussion.

## Emergency bypass
If the skill itself can't run and the user explicitly authorizes skipping:
```bash
date -u +%Y-%m-%dT%H:%M:%SZ > "$CLAUDE_PROJECT_DIR/.claude/.draft-issue-skip"
```
Single-use, accepted within 60s, deleted on read. Document the reason in the issue body.

## Rules
- Do NOT write the marker before the confirmation gate completes.
- The marker is per-worktree — write it in the checkout you'll run `gh issue create` from.
- Reference issues/PRs as `#<n> "<title>"`, never bare `#n`.
