# Design Philosophy
globs: **/*

The whole point of this project is a durable, self-owned memory. These tenets flow directly from that — a memory system that loses or mutates data has failed at its one job.

## 1. Data Preservation
- **Never hard-delete or overwrite** a stored memory/artifact. Correct forward by appending; treat every row as permanent.
- Keep raw inputs alongside derived values — store originals by `raw_path`, never discard them.
- **Why:** lost memory is unrecoverable, and recall quality depends on the full record. Backup = copy the `.db` file + the raw files.

## 2. Collect Data and Metadata
- Capture who/what/when/where at every write: `occurred_at`, `ingested_at`, `source`, `source_id`, `content_hash`, location.
- When designing a new artifact type, ask "what would I need to reconstruct this event a year from now?" and store those fields (in real columns if filtered on, else `extra_json`).

## 3. Create Log Tables Liberally
- Add a dedicated `*_log` / `*_event` table for significant transitions (import run, embedding recomputed, entity merged). Append-only: no updates, no deletes.
- Minimum row: `entity_id`, `event_type`, `occurred_at` (UTC), `actor`, `details`.
- **Why:** `created_at` tells you when a row appeared; a log tells you the whole history of how the memory evolved.

## 4. Log Every Step of the Flow
- Structured logging at each service boundary and every branch that changes an outcome (store, embed, recall, dedup hit, cache).
- The Express error middleware is the single funnel for failures — keep errors flowing through it; never swallow.
- **Why:** if you can't answer "what happened to memory X between store and recall?" from logs, add logging.

## 5. Keep Design Docs Up To Date
- Any change that alters documented behavior updates the relevant `docs/**` and the README Quickstart in the same change.
- A doc that contradicts the code is worse than none — it makes agents diverge. `docs/03-ob2-design.md` is the roadmap; keep it honest.

## 6. Docs Live Close to Code
- Runtime/setup docs in `docs/`; the run contract in `README.md`; agent conventions in `.claude/rules/`.
- Don't scatter guidance into a far-off wiki — proximity to code is the discovery mechanism.

## 7. Baseline Method (When Stuck)
- After two failed approaches, STOP adding changes. Strip to the last known-good state (a green commit, a minimal repro) and reintroduce one change at a time; the first that breaks reveals the cause.
- The `sqlite-vec` PK bug was found this way — an isolated 4-line repro testing `Number` vs `BigInt`, not more guessing. If still stuck after the baseline attempt, ask; don't guess a third time.

## 8. AI Artifact Capture
- Any CLI command, migration snippet, or debugging script generated in a session is a permanent artifact — capture it in `docs/**` or the README before the session ends.
- **Why:** sessions have no memory; the repo is the only thing that survives a context reset. If a command fixed something, write it down.
