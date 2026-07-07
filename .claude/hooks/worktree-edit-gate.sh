#!/usr/bin/env bash
# Worktree edit gate.
# Fires on Edit and Write PreToolUse. Blocks editing SOURCE files (.js/.mjs/.cjs)
# when the target path is NOT inside a .worktrees/ branch directory — mechanically
# enforcing the mandatory rule that all source changes go through issue + worktree.
# Docs, JSON/config, SQL, and .claude/ files are NOT gated.
set -euo pipefail

# Cloud/web sessions have no worktrees — the whole checkout is an isolated clone on a
# harness-assigned claude/* branch, and cloud-issue-gate enforces the workflow there.
if [[ "${CLAUDE_CODE_REMOTE:-}" == "true" ]]; then
  exit 0
fi

input=$(cat)

# Extract file_path WITHOUT requiring jq (file paths carry no escaped quotes), so the gate
# ENFORCES even where jq is not on PATH (e.g. Windows git-bash). Fail-closed on source, not open.
file_path=$(printf '%s' "$input" | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/^[^:]*:[[:space:]]*"//; s/"$//')
if [[ -z "$file_path" ]]; then
  exit 0
fi

# Normalize backslashes to forward slashes for consistent matching (Windows paths).
normalized="${file_path//\\//}"

# Allow any edit inside a worktree. (^|/) anchors to a segment boundary.
if echo "$normalized" | grep -qiE '(^|/)\.worktrees/'; then
  exit 0
fi

# Allow .claude/ config/hooks/skills — legitimately edited in the main dir.
if echo "$normalized" | grep -qiE '(^|/)\.claude/'; then
  exit 0
fi

# Gate JS source only — docs, JSON, config, SQL are not gated.
if echo "$normalized" | grep -qiE '\.(js|mjs|cjs)$'; then
  REASON="Worktree edit gate: source edit blocked outside a worktree — ${file_path}. MANDATORY WORKFLOW: all source (.js/.mjs/.cjs) changes require a GitHub issue + worktree branch. Steps: (1) /draft-issue — file the issue and get plan approval; (2) git worktree add .worktrees/<type>-<issue>-<slug> -b <type>/<issue>-<slug>; (3) open the worktree path and edit there. Do NOT edit source directly in the main working directory."
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg reason "$REASON" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  else
    ESCAPED=${REASON//\\/\\\\}
    ESCAPED=${ESCAPED//\"/\\\"}
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$ESCAPED"
  fi
  exit 0
fi
