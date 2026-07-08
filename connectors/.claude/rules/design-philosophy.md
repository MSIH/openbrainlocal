# Design Philosophy
globs: **/*

The whole point of LifeContext is a durable, self-owned memory. Connectors are how data reaches it, so these tenets — mirrored from `msih/life-context` — apply to what a connector submits and how it behaves, even though the store itself lives elsewhere.

## 1. Data Preservation
- A connector never fabricates or discards data to make a payload cleaner — if a field is unknown, omit it (accept the warning) rather than guess.
- Keep raw inputs where they already live; a connector points to them (`raw_path`) rather than copying/transforming them lossily before core ever sees them.
- **Why:** lost or fabricated context is worse than an honest gap — recall quality depends on the full, accurate record.

## 2. Collect Data and Metadata
- Capture who/what/when/where at every submission: `occurred_at`, `source`, `source_id`, `content_hash`, location, when the source data actually has them.
- When building a new connector, ask "what would I need to reconstruct this event a year from now?" and put those fields in `extra` if there's no first-class field for them yet.

## 3. Create Log Tables Liberally
- This is core's concern (`ingest_log` lives in `life-context`), but a connector should still log its own significant transitions locally — a sync run started/finished, a spool flush, a cursor advance — so its own history is reconstructable independent of the server.

## 4. Log Every Step of the Flow
- Structured logging at each connector boundary: read source, transform to payload, POST, spool-on-failure. If you can't answer "what happened to this session/message/photo between capture and ingest?" from logs, add logging.
- Errors funnel to stderr with enough context to be useful hours later — never a bare `console.error(err)` with no label.

## 5. Keep Design Docs Up To Date
- Any change to a connector's behavior updates that connector's own `README.md` in the same change.
- A doc that contradicts the code is worse than none — it makes the next agent diverge. The copy of `docs/04-connector-contract.md` in this repo is a **copy**; if core's contract changes, refresh it from `msih/life-context` rather than letting it silently drift (see the provenance banner at the top of that file).

## 6. Docs Live Close to Code
- Each connector's setup/behavior docs live in that connector's own folder; repo-wide conventions live in `.claude/rules/`.
- Don't scatter guidance into a far-off wiki — proximity to code is the discovery mechanism.

## 7. Baseline Method (When Stuck)
- After two failed approaches, STOP adding changes. Strip to the last known-good state (a green commit, a minimal repro) and reintroduce one change at a time; the first that breaks reveals the cause.
- If still stuck after the baseline attempt, ask; don't guess a third time.

## 8. AI Artifact Capture
- Any CLI command, test harness, or debugging script generated in a session is a permanent artifact — capture it in the relevant connector's `README.md` before the session ends.
- **Why:** sessions have no memory; the repo is the only thing that survives a context reset. If a command or mock-server pattern helped verify a connector, write it down.
