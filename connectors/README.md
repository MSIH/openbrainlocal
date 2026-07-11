# Connectors

Official connectors for **LifeContext** — each is an isolated process that gathers data from one corner of a digital life and submits it to a running LifeContext server over the versioned `POST /api/v1/ingest` contract ([`docs/04-connector-contract.md`](../docs/04-connector-contract.md)). **Nothing here imports LifeContext source or another connector's code** — the HTTP contract is the only coupling point, enforced by `npm run check:boundary` from the repo root.

> Formerly the standalone `life-context-connectors` repo, folded into this repo (with full history) once the two-repo split proved to be overhead without payoff — see doc 04 §10. A connector still splits out into its own repo the moment it needs an independent release cadence or an external owner (`git subtree split --prefix=connectors/<name>`).

## Structure

```
devsession-claude/  Claude Code SessionEnd/PreCompact hook → dev_session artifacts (Milestone 1)
gh-event-claude/    Claude Code PostToolUse hook → x-dev-event artifacts on gh issue/PR create (#89)
documents/          PDF/DOCX/XLSX/PPTX tree scan + tesseract OCR worker → document artifacts (#56)
imessage/           iMessage chat.db sync → message/photo artifacts (Milestone 3)
photo-exif/         Photo library EXIF scan + VLM captioning → photo artifacts (Milestone 4)
gphotos-takeout/    Google Takeout scan → photo/video artifacts + named-album `pictured` hints (#77)
```

Each connector is self-contained: its own `package.json` (dependencies never shared), its own `README.md` (setup, env vars, trigger registration), its own `.env` (gitignored). There is no repo-wide build — these are client processes deployed wherever the source data lives (e.g. `imessage/` runs on a Mac), cloned from this repo.

## Adding a connector

1. New folder under `connectors/`, named after the connector's `source` value (e.g. `imessage/`).
2. Own `package.json` (or equivalent for another language) — no shared dependencies assumed between connectors.
3. Own `README.md` with setup steps and, for push-style connectors, the trigger registration snippet.
4. Talk to LifeContext only via `POST {LIFECONTEXT_URL}/api/v1/ingest` (or `/ingest/batch`) per [`docs/04-connector-contract.md`](../docs/04-connector-contract.md). Validate payloads against [`schemas/ingest.v1.json`](../schemas/ingest.v1.json) for CI-time checking without a live server. Never import from `src/`.

Conventions (payload shape, `source_id` discipline, spool/failure posture, entity hints): [`.claude/rules/connector-conventions.md`](../.claude/rules/connector-conventions.md).

## License

MIT (see `LICENSE`) — each connector folder is free to declare its own.
