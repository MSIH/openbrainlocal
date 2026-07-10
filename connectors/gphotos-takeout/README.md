# gphotos-takeout

Ingests a **Google Takeout** "Google Photos" export into [LifeContext](https://github.com/msih/life-context) as `type='photo'` (and `type='video'`) artifacts, and — for the people you've named in the Google Photos UI — reuses Google's face matching as `pictured` entity hints. Batch connector; zero runtime dependencies.

## Why Takeout, not the API

Google's face/people matching lives inside the Photos UI and is **not** exposed by any public API:

- **Photos Library API** — no face/person data at all. `PEOPLE` is a "contains people" scene category, not *which* people. (Post-2025 it also restricts third-party apps to media they uploaded.)
- **Photos Picker API** — only basic metadata on the items a user explicitly picks.

But a **named face-group album becomes a folder in a Takeout export**. So the one supported way to reuse Google's matching is: name your key people as albums, export via Takeout, and read album membership. That's what this connector does — best suited to a small set of important people (family), which is a modest one-time setup for high recall value.

For whole-library, no-Google recognition, see the companion local-face-clustering work (issue #78) instead.

## One-time setup in Google Photos (the manual step)

For each person you care about:

1. Open **Google Photos → the person's face group** (Search → People).
2. Select their photos and **Save as an album**, titled with the person's real name (e.g. `Mom`, `Sarah Jones`).
3. Then **[Google Takeout](https://takeout.google.com/)** → deselect all → select **Google Photos** → export → download and unzip.

A Takeout export lays out as `Takeout/Google Photos/Photos from <year>/…` (year buckets) plus one folder per album, each with a `metadata.json` holding the album title. Each photo carries a JSON sidecar with its taken-time and GPS.

## Configure which albums are people

```bash
cp config.example.json config.json   # config.json is gitignored (may hold family names)
```

Edit `config.json` — keys are album titles, values map the album to a contact:

```jsonc
{
  "person_albums": {
    "Mom": { "alias": "Jane Doe" },   // album 'Mom' pictures contact 'Jane Doe'
    "Sarah Jones": {}                    // album title IS the person's name
  }
}
```

This is an explicit allow-list on purpose: an album **not** listed here (a trip, an event) still ingests as photos, just with no `pictured` hint. A wrong person tag is worse than a missing one, so album names are never auto-guessed to be people.

Each listed album emits `{alias, alias_type:"name", role:"pictured", confidence:0.7}` on every photo in it. The connector only ever sends a *name hint* — core resolves it against the entity graph (`entity_aliases` → `entity_links`, or stages in `unresolved_aliases` so it auto-links once that contact is imported). Names cap at 0.9 confidence core-side; a face match is never deterministic (doc 04 §4).

## Run

```bash
cp .env.example .env    # set LIFECONTEXT_URL / LIFECONTEXT_API_KEY / TAKEOUT_ROOT
node index.js
```

`TAKEOUT_ROOT` can point at either the `Takeout` folder or the `Google Photos` folder inside it — the connector auto-descends into `Google Photos` if present. Re-running is safe and incremental (see below).

## What it does

1. Walks the export; pairs each media file (images **and** videos — `.mp4`/`.mov`/`.m4v`/`.3gp` are ingested as `type='video'`, everything else as `type='photo'`) with its JSON sidecar (handles the classic `<name>.json`, the newer `<name>.supplemental-metadata.json`, and the `name(1).jpg → name.jpg(1).json` duplicate-counter shift).
2. Reads `photoTakenTime` → `occurred_at` and `geoData` → raw `latitude`/`longitude` (submitted raw; **core** reverse-geocodes `place_label`, issue #67). Takeout's `(0,0)` "unknown location" is treated as absent.
3. **Collapses Takeout's duplication**: the same photo appears in its year bucket and in every album it belongs to. All byte-identical copies are merged into **one** artifact (keyed by `content_hash`), carrying the union of its albums' person hints.
4. `source_id` is `gphotos:<sha256>` — reproducible from the bytes, so it dedups across folders and survives album/folder renames and re-exports.
5. Sends `type='photo'` artifacts via `POST /api/v1/ingest/batch` (≤100/call).
6. Skips photos unchanged since the last run (state in `GPHOTOS_MANIFEST_PATH`); content hashes are cached by path+mtime+size so re-runs don't re-hash unchanged files.
7. On an unreachable server, spools payloads to `GPHOTOS_SPOOL_PATH` and flushes them on the next run (doc 04 §7).

## Exit test

After a run, "photos of Mom" (`about_entity` for the mapped contact, once that contact exists in the entity graph) returns her photos, and "photos from 2019" works from `occurred_at` alone — the store→recall path over the ingested artifacts. Adding a person to a new album and re-running **adds** that person's link to the existing artifacts without duplicating them (upsert on `(source, source_id)`, additive entity links — data-model.md).

## Known limitations

- **Only reuses Google's matching for people you turned into named albums.** People Google clustered but you never saved as an album aren't in the export — there's no API for those.
- **Year-bucket detection is English-only** (`Photos from <year>`). A non-English Takeout names year folders differently; those folders would be read as albums (harmless unless one happens to match a `person_albums` key).
- **Reverse geocoding happens in core, not here** — this connector submits raw `latitude`/`longitude` only (`src/geocode.js` owns `place_label`).
- **`occurred_at` is never guessed.** A photo whose sidecar lacks `photoTakenTime` gets no `occurred_at` (and core's warning) rather than an upload-time approximation that would mis-sort the timeline.
- **Byte-identical photos dedup to one artifact.** An edited copy (`IMG-edited.jpg`) has different bytes and is a separate artifact — intended.

## Testing without a real Takeout export

`test.mjs` (`npm test`) synthesizes a Takeout tree (year bucket + albums, duplicated photos, a video, sidecar-name variants, `(0,0)` geo) and runs `index.js` against a mock ingest server. Covers: content-hash dedup across folders, person-hint attachment (and non-person albums getting none), video vs. photo typing, sidecar date/geo parsing, unchanged-file skipping on re-run, manifest pruning of removed files, and server-down spool → next-run flush without duplicate sends.

## Files

- `index.js` — the batch scanner/ingester (walk → hash-group → describe → ingest)
- `lib/takeout.js` — Takeout tree walk, sidecar matching/parsing, album classification
- `people.js` — the album→person allow-list and `pictured` hint construction
- `lib/shared.js` — env loading, hashing, batching, the ingest client, the spool
- `config.example.json` — copy to `config.json` (gitignored)
- `.env.example` — copy to `.env`
- `test.mjs` — `node --test` suite
