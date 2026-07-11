# gh-event-claude

A Claude Code `PostToolUse` hook that records **GitHub issue/PR creation** as a searchable
`x-dev-event` artifact in [LifeContext](https://github.com/msih/life-context). It complements
[`devsession-claude`](../devsession-claude/README.md): that connector captures the *conversation*
(`SessionEnd`/`PreCompact` → `dev_session`), this one captures the discrete *event* — "when did I
open issue #89?", "what PRs did I cut last week?".

## What it does

1. Claude Code invokes `index.js` on `PostToolUse` for a GitHub create tool (matchers below),
   passing the hook JSON (`tool_name`, `tool_input`, `tool_response`, `cwd`) on stdin.
2. It extracts the issue/PR URL (the anchor), number, repo, and — best-effort — title and current
   branch, from either the Bash `gh` stdout or the GitHub-MCP structured response.
3. It POSTs one artifact to `POST {LIFECONTEXT_URL}/api/v1/ingest`. Core embeds and stores it.

If no issue/PR URL can be found (the create failed, or there's nothing to record) it ingests
nothing and exits 0.

## Contract

| Field | Value |
|-------|-------|
| `source` | `gh-event-claude` |
| `source_id` | the issue/PR URL (e.g. `https://github.com/MSIH/life-context/issues/89`) — reproducible + unique, so a re-fire **upserts**, never duplicates |
| `type` | `x-dev-event` (an `x-` extension type — issue/PR creation isn't a registered artifact type; no registry change needed) |
| `text_repr` | e.g. `Opened GitHub issue #89 "capture gh events" in MSIH/life-context. <url>` |
| `extra` | `{ kind: 'issue'\|'pr', number, url, repo, branch, tool_name, title }` |

## Setup

1. `cp .env.example .env` and set `LIFECONTEXT_URL` + `LIFECONTEXT_API_KEY` to match the core
   server. Without a valid `LIFECONTEXT_API_KEY` the hook is a no-op (exits 0) — so the committed
   wiring is inert for contributors who don't run LifeContext.
2. No `npm install` — the script is dependency-free (Node 18+ built-ins only).
3. Register the hook under `PostToolUse` in a `.claude/settings.json`, one entry per create-tool
   matcher (this repo already ships this in its own `.claude/settings.json`):

    ```jsonc
    "PostToolUse": [
      { "matcher": "Bash(gh issue create*)",            "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "mcp__github__create_issue",          "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "mcp__github__issue_write",           "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "Bash(gh pr create*)",                "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "mcp__github__create_pull_request",   "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] }
    ]
    ```

   These are the same matchers the `draft-issue-gate` / `pre-pr-review-gate` `PreToolUse` hooks
   use — the gates *enforce* the workflow, this *records* the result.

### Why unguarded (unlike devsession-claude)

`devsession-claude` is registered in this repo's committed `.claude/settings.json` behind a
`CLAUDE_CODE_REMOTE=true` guard, because a user-level + project hook would otherwise run its
*expensive LLM summarizer* twice on every local session. This connector does **no** LLM call, and
ingest is upsert-by-`(source, source_id)` keyed on the URL — a double-fire just re-writes the same
artifact. So it's registered **unguarded**: it fires locally *and* in cloud, capturing your local
issue/PR events with no separate user-level wiring. `PostToolUse` only fires after the tool
actually ran, so a create denied by a `PreToolUse` gate never reaches this hook.

## Failure posture

Best-effort, per [`docs/04-connector-contract.md`](../../docs/04-connector-contract.md) §7: never
throws past `main()`, always exits 0 (a capture hook must never hang or fail the terminal). If the
ingest server is unreachable the payload is spooled to `GH_EVENT_SPOOL_PATH`
(default `~/.life-context/gh-event-spool.jsonl`) and flushed on the next event.

## Testing

`npm test` (`node --test test.mjs`) spawns `index.js` against a mock `node:http` ingest server —
no `npm install`, no real network. Covers the Bash-stdout parse, the MCP-response parse, the
no-URL no-ingest path, and the missing-API-key skip.
