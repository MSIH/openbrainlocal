#!/usr/bin/env bash
# Cloud issue gate.
# Fires on Edit and Write PreToolUse. In Claude Code cloud/web sessions
# (CLAUDE_CODE_REMOTE=true) there is no `gh` CLI, so the gh-based gates never fire —
# this gate enforces the issue-first rule at edit time instead: it denies ANY edit
# under the project dir (including .claude/ tooling and CLAUDE.md) until a GitHub
# issue exists and its number is recorded in .claude/.cloud-issue-done.
# Cloud containers start from a fresh clone, so the marker is naturally session-scoped.
# Local sessions exit immediately — their flow is covered by the worktree gates.
set -euo pipefail

if [[ "${CLAUDE_CODE_REMOTE:-}" != "true" ]]; then
  exit 0
fi

input=$(cat)

# Extract file_path WITHOUT requiring jq (file paths carry no escaped quotes) — same
# fail-closed discipline as worktree-edit-gate.
file_path=$(printf '%s' "$input" | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/^[^:]*:[[:space:]]*"//; s/"$//' || true)
if [[ -z "$file_path" ]]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MARKER="$PROJECT_DIR/.claude/.cloud-issue-done"

# Normalize backslashes for consistent matching (Windows paths).
normalized="${file_path//\\//}"
project_normalized="${PROJECT_DIR//\\//}"

# Absolute paths outside the project dir (scratchpad, temp files) are never gated.
if [[ "$normalized" == /* || "$normalized" == [A-Za-z]:/* ]]; then
  case "$normalized" in
    "$project_normalized"/*) ;; # inside the repo — gate below
    *) exit 0 ;;
  esac
fi

# Allow the gitignored .claude marker/state dotfiles and personal settings — the agent
# must be able to write .cloud-issue-done itself, and skills write their own markers.
# Committed .claude tooling (hooks, commands, agents, settings.json, rules) IS gated.
if echo "$normalized" | grep -qiE '(^|/)\.claude/(\.[^/]+|settings\.local\.json)$'; then
  exit 0
fi

# Marker must exist and its first line must be a positive integer (the issue number).
if [[ -f "$MARKER" ]]; then
  ISSUE=$(head -n1 "$MARKER" 2>/dev/null | tr -d '[:space:]')
  if [[ "$ISSUE" =~ ^[1-9][0-9]*$ ]]; then
    exit 0
  fi
fi

REASON="Cloud issue gate: edit blocked — ${file_path}. MANDATORY WORKFLOW: cloud/web sessions have no gh CLI, so this gate enforces issue-first at edit time. Steps: (1) draft the plan with the user following /draft-issue (Problem / Design Decisions / Implementation Plan / Acceptance / Out-of-scope) and get explicit approval; (2) file it with the GitHub MCP tool issue_write (method=create); (3) record the number: echo <issue-number> > ${MARKER} ; then retry the edit. The marker is gitignored and dies with the session's container."

if command -v jq >/dev/null 2>&1; then
  jq -n --arg reason "$REASON" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
else
  ESCAPED=${REASON//\\/\\\\}
  ESCAPED=${ESCAPED//\"/\\\"}
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$ESCAPED"
fi
