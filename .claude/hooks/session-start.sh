#!/bin/bash
set -euo pipefail

# SessionStart hook: bootstrap the Node toolchain for Claude Code on the web / remote agents,
# so a fresh cloud checkout can build and run without manual setup.
# Local sessions exit immediately — the developer already has deps installed.

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"
echo "[session-start] remote environment detected — bootstrapping Node deps"

git fetch origin --prune || true

if [ -f package-lock.json ]; then
  npm ci || npm install
else
  npm install
fi

# better-sqlite3 is a native module; ensure its binary is built even if an
# allow-scripts policy skipped the install script.
npm rebuild better-sqlite3 || true

echo "[session-start] Node deps ready ($(node --version 2>/dev/null || echo 'node?'))."
echo "[session-start] NOTE: embeddings require a local Ollama (qwen3-embedding:0.6b) on :11434."
echo "[session-start]       Cloud sandboxes have no Ollama — store/recall will fail until an"
echo "[session-start]       Ollama endpoint is reachable (point the gateway baseURL at a remote engine via env if needed)."
