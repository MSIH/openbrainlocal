#!/usr/bin/env bash
# Pre-PR review gate.
# PreToolUse on `mcp__github__create_pull_request` and `Bash(gh pr create*)`.
# Denies PR creation unless /pre-pr-review ran for the current HEAD
# (marker .claude/.pre-pr-review-done contains the current HEAD SHA).
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MARKER="$PROJECT_DIR/.claude/.pre-pr-review-done"
HEAD="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo '')"

if [[ -n "$HEAD" && -f "$MARKER" && "$(cat "$MARKER" 2>/dev/null | tr -d '[:space:]')" == "$HEAD" ]]; then
  exit 0
fi

REASON="Pre-PR review gate: run the /pre-pr-review skill before opening a PR (mandatory workflow — do not bypass). Address any Blockers it reports, then retry. It writes the current HEAD SHA (${HEAD}) to ${MARKER} on an APPROVE / APPROVE-WITH-NITS verdict, which clears this gate."

if command -v jq >/dev/null 2>&1; then
  jq -n --arg reason "$REASON" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
else
  ESCAPED=${REASON//\\/\\\\}
  ESCAPED=${ESCAPED//\"/\\\"}
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$ESCAPED"
fi
