#!/usr/bin/env bash
# Worktree confirmation gate.
# PreToolUse on Bash. Reads stdin JSON; when the command is `git worktree add`,
# injects an advisory reminder (additionalContext) — advisory only, does not block.
set -euo pipefail

input=$(cat)
if echo "$input" | grep -q "git worktree add"; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"WORKTREE GATE (mandatory workflow): every branch is a git worktree, never a plain checkout -b — this repo is worked by multiple AI agents concurrently, so each branch needs its own working directory. Before creating it, confirm: (1) a GitHub issue exists for this work (filed via /draft-issue), and (2) you pasted the Implementation Plan to the user and they explicitly approved it. If either is missing, STOP and get approval first."}}'
fi
