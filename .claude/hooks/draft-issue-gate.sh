#!/usr/bin/env bash
# Draft-issue gate.
# PreToolUse on `mcp__github__create_issue` and `Bash(gh issue create*)`.
# Denies issue creation unless /draft-issue ran within 600s (marker .claude/.draft-issue-done)
# OR a single-use bypass token .claude/.draft-issue-skip exists (within 60s, deleted on read).
# Requires GNU `date -d` (git-bash / Linux / cloud); BSD/macOS `date` is not supported.
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MARKER="$PROJECT_DIR/.claude/.draft-issue-done"
SKIP="$PROJECT_DIR/.claude/.draft-issue-skip"
FRESH_SECONDS=600
SKIP_SECONDS=60
NOW=$(date -u +%s)

iso_to_epoch() {
  local ts="$1"
  if [[ -z "$ts" ]]; then echo 0; return; fi
  date -u -d "$ts" +%s 2>/dev/null || echo 0
}

# Path 1: fresh marker passes.
if [[ -f "$MARKER" ]]; then
  MARKER_TS=$(cat "$MARKER" 2>/dev/null | head -n1 | tr -d '[:space:]')
  MARKER_EPOCH=$(iso_to_epoch "$MARKER_TS")
  AGE=$(( NOW - MARKER_EPOCH ))
  if (( MARKER_EPOCH > 0 && AGE >= 0 && AGE <= FRESH_SECONDS )); then exit 0; fi
fi

# Path 2: fresh single-use bypass token passes (always deleted on read).
if [[ -f "$SKIP" ]]; then
  SKIP_TS=$(cat "$SKIP" 2>/dev/null | head -n1 | tr -d '[:space:]')
  SKIP_EPOCH=$(iso_to_epoch "$SKIP_TS")
  AGE=$(( NOW - SKIP_EPOCH ))
  rm -f "$SKIP"
  if (( SKIP_EPOCH > 0 && AGE >= 0 && AGE <= SKIP_SECONDS )); then exit 0; fi
fi

REASON="Draft-issue gate: run the /draft-issue skill before creating a GitHub issue (mandatory workflow for this repo). It captures Problem / Approach / Implementation Plan / Acceptance / Out-of-scope, gets your explicit approval on the plan, then writes an ISO-8601 UTC timestamp to ${MARKER} (accepted for 600s). Trivial follow-up: /draft-issue quick=true. Emergency single-use bypass (explicit user authorization only): write the current ISO-8601 UTC timestamp to ${SKIP} (accepted within 60s; deleted on read)."

if command -v jq >/dev/null 2>&1; then
  jq -n --arg reason "$REASON" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
else
  ESCAPED=${REASON//\\/\\\\}
  ESCAPED=${ESCAPED//\"/\\\"}
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$ESCAPED"
fi
