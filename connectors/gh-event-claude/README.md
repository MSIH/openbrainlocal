# gh-event-claude

A Claude Code `PostToolUse` hook that records **GitHub issue/PR creation and PR merges** as
searchable `x-dev-event` artifacts in [LifeContext](https://github.com/msih/life-context). It
complements [`devsession-claude`](../devsession-claude/README.md): that connector captures the
*conversation* (`SessionEnd`/`PreCompact` → `dev_session`), this one captures the discrete *event*
— "when did I open issue #89?", "what PRs did I merge last week?".

## What it does

1. Claude Code invokes `index.js` on `PostToolUse` for a GitHub create **or merge** tool (matchers
   below), passing the hook JSON (`tool_name`, `tool_input`, `tool_response`, `cwd`) on stdin.
2. It extracts the issue/PR URL (the anchor), number, repo, and — best-effort — title and current
   branch, from either the Bash `gh` stdout or the GitHub-MCP structured response.
3. It POSTs one artifact to `POST {LIFECONTEXT_URL}/api/v1/ingest`. Core embeds and stores it.

If no issue/PR URL can be found (the create failed, or there's nothing to record) it ingests
nothing and exits 0.

**Merges** (`gh pr merge` / `mcp__github__merge_pull_request`) are a distinct action. `gh pr merge`
prints no full URL — only the `owner/repo#N` shorthand — so the hook reconstructs
`https://github.com/<repo>/pull/<n>` from that shorthand (or the MCP tool's `{owner, repo,
pullNumber}`). A merge is stored under a **separate** `source_id` (`<url>#merged`) so it never
upserts over the "Opened" artifact for the same PR — both events coexist. A merge whose PR ref
can't be derived (e.g. a bare current-branch `gh pr merge` after the branch is gone) ingests
nothing and exits 0.

`mcp__github__issue_write` handles both **create** and **update**; an update still returns the
issue's `html_url`, so the hook records *only* `method: "create"` — an explicit non-create method
is skipped, so ordinary edits never appear as phantom "Opened…" events. This mirrors the
`draft-issue-gate`'s method detection exactly (a missing/unparseable method falls through as a
create). The other matchers are creates by definition, so no check applies to them.

## Contract

| Field | Value |
|-------|-------|
| `source` | `gh-event-claude` |
| `source_id` | the issue/PR URL (e.g. `https://github.com/MSIH/life-context/issues/89`); a merge uses `<url>#merged` — reproducible + unique, so a re-fire **upserts**, never duplicates |
| `type` | `x-dev-event` (an `x-` extension type — issue/PR events aren't a registered artifact type; no registry change needed) |
| `text_repr` | `Opened GitHub issue #89 "capture gh events" in MSIH/life-context. <url>` — or `Merged GitHub pull request #164 …` for a merge |
| `extra` | `{ kind: 'issue'\|'pr', action: 'opened'\|'merged', number, url, repo, branch, tool_name, title }` |

## Setup

1. `cp .env.example .env` and set `LIFECONTEXT_URL` + `LIFECONTEXT_API_KEY` to match the core
   server. Without a valid `LIFECONTEXT_API_KEY` the hook is a no-op (exits 0) — so the committed
   wiring is inert for contributors who don't run LifeContext.
2. No `npm install` — the script is dependency-free (Node 18+ built-ins only).
3. Register the hook under `PostToolUse` in a `.claude/settings.json`, one entry per create/merge
   tool matcher (this repo already ships this in its own `.claude/settings.json`):

    ```jsonc
    "PostToolUse": [
      { "matcher": "Bash(gh issue create*)",            "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR:-$(pwd)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "mcp__github__create_issue",          "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR:-$(pwd)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "mcp__github__issue_write",           "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR:-$(pwd)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "Bash(gh pr create*)",                "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR:-$(pwd)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "mcp__github__create_pull_request",   "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR:-$(pwd)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "Bash(gh pr merge*)",                 "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR:-$(pwd)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] },
      { "matcher": "mcp__github__merge_pull_request",    "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR:-$(pwd)}/connectors/gh-event-claude/index.js\"", "shell": "bash", "timeout": 30 }] }
    ]
    ```

   The create/merge matchers overlap the `draft-issue-gate` / `pre-pr-review-gate` `PreToolUse`
   hooks — the gates *enforce* the workflow, this *records* the result. The command uses
   `${CLAUDE_PROJECT_DIR:-$(pwd)}` (not a bare `$CLAUDE_PROJECT_DIR`) so an unset var falls back to
   the working directory instead of resolving to `/connectors/…` → `ENOENT` → a silent no-op — the
   same fallback the gate `.sh` scripts use.

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
`html_url` preference, the `issue_write` update → no-ingest and create → ingest paths, the
no-URL no-ingest path, the merge paths (`gh pr merge` shorthand + MCP `merge_pull_request`, keyed
`#merged`; underivable-ref → no-ingest), and the missing-API-key skip.
