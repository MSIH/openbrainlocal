# photo-exif

Two scripts that make a photo library time/place-queryable in [LifeContext](https://github.com/msih/life-context) with zero inference, then optionally enrich it with real content understanding. Implements [Milestone 4](https://github.com/msih/life-context/blob/2.0/docs/05-roadmap.md) of the roadmap — the **batch** reference connector, and the proof that upsert-as-enrichment works.

## Architecture decision: where the caption worker lives

The roadmap flags this as an open question ("worker lives with core or alongside — decide here," since doc 04 frames VLM captioning as a core-side "transducer," conceptually parallel to how core owns embeddings). **Decision: it lives here, in `photo-exif/`, as a second script alongside the scanner** — not in `life-context` core. Rationale:

- Consistency: `devsession-claude` and `imessage` are both pure isolated HTTP clients with zero direct database coupling; splitting `photo-exif`'s enrichment step into core would make it the only connector that isn't.
- The worker never needs to query "which artifacts need captions" from the server — it re-walks the same `PHOTO_ROOT` it already knows and checks its own local state file (`PHOTO_EXIF_CAPTION_STATE_PATH`). No new server-side capability required.
- It still upserts the *same artifact* (`source_id` = the relative file path, computed identically in both scripts via `lib/shared.js`), so the contract's upsert semantics do all the real work — the worker is just a slow, patient HTTP client like any other.

## What it does

### `scan.js` (deliverables 1–2)
1. Recursively walks `PHOTO_ROOT` for image files (`.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`, `.tif`, `.tiff`).
2. Extracts `DateTimeOriginal` and GPS coordinates via `exifr`.
3. Submits GPS as raw `latitude`/`longitude` — this connector does no geocoding of its own. [LifeContext core](https://github.com/msih/life-context) resolves `place_label` from those coordinates server-side, fully offline (`src/geocode.js`), so every connector with GPS gets place resolution without bundling its own city dataset.
4. Computes a sha256 `content_hash` of the file bytes (streamed, not loaded fully into memory).
5. Sends `type='photo'` artifacts via `POST /api/v1/ingest/batch`.
6. Skips files unchanged since the last scan (mtime+size cache in `PHOTO_EXIF_MANIFEST_PATH`) — repeat scans over a large library only process what's new.

### `caption-worker.js` (deliverables 3–4)
1. Walks the same `PHOTO_ROOT`, skipping anything already captioned (local state file).
2. Sends each photo to a local vision-language model (Ollama, default `llava`) for a one-sentence caption.
3. Upserts the **same** `(source, source_id)` with the caption appended to the original EXIF-based description — the upsert's merge semantics (doc 04 §3) mean `occurred_at`/GPS/`place_label`/`raw_path`/`content_hash` are left untouched; only `text_repr` and `extra.captioned` change.
4. Saves its state after **every** photo, not batched — kill-safe at any point.
5. Stops the whole run (rather than failing through the entire library) if the VLM itself is unreachable; per-item ingest failures are logged and retried on the next run.
6. Does its own scheduling for **nothing** — one pass, then exits. Nightly-window scheduling is config, not code (see below).

### `face-worker.js` (issue #53)

A third, local-first enrichment pass that links photos to *who is in them* via the contract's `pictured` `entity_hints` role (doc 04 §4). Detection runs entirely on-device — no cloud face API (Prime Directive: local-first).

1. Detects faces in each photo (local `@vladmandic/face-api` + `@tensorflow/tfjs-node`, models loaded from `FACE_MODELS_PATH`).
2. Clusters the 128-d face descriptors into anonymous groups by nearest-centroid (`FACE_MATCH_THRESHOLD`). **Descriptors never leave the machine** — they live only in the local clusters file; doc 04 §11 forbids connectors sending embeddings.
3. Records `extra.faces_detected` on every scanned photo. A photo whose faces are all in *unlabeled* clusters gets **no** `pictured` hint (its `text_repr` is re-sent as base + caption, reconstructed from the caption cache, so captioning is preserved, not extended).
4. Once you name a cluster (`label`), every photo containing it upserts `entity_hints: [{alias, alias_type:"name", role:"pictured", confidence}]` and a `text_repr` with a "Pictured: …" sentence appended to the base + caption text.

Commands:
```bash
node face-worker.js                         # scan: detect + cluster + emit hints for any labeled faces
node face-worker.js export-thumbnails ./faces   # one sample image per cluster + index.json, to eyeball who's who
node face-worker.js label 7 "Sarah Jones"   # name cluster 7; re-emits its photos' hints immediately
```

Nothing is sent for a cluster until you name it — an unnamed cluster is just an anonymous bucket, so no fabricated aliases pollute the entity graph. Naming is a deliberate, local trust decision; alias→entity resolution stays core's job.

## Setup

1. `cp .env.example .env` and fill in `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY` / `PHOTO_ROOT`.
2. `npm install` (real dependency: `exifr`; the face worker additionally needs `@vladmandic/face-api`, `@tensorflow/tfjs-node`, and `canvas` — native modules, only required if you run `face-worker.js`).
3. Backfill: `node scan.js`.
4. Optionally, once you have a vision model pulled in Ollama (`ollama pull llava`): `node caption-worker.js`.
5. Optionally, for face → contact linking: download the face-api model weights into `FACE_MODELS_PATH` (the `ssdMobilenetv1`, `faceLandmark68Net`, and `faceRecognitionNet` weight files from the `@vladmandic/face-api` model repo — one-time, offline after), then `node face-worker.js`, browse clusters with `export-thumbnails`, and `label` the ones you recognize.

### Wave order matters

Run **scan → caption → face** for each photo. The ingest contract requires `text_repr` on every upsert and replaces it (and `extra`) wholesale — there is no deep-merge (doc 04 §3). The face worker therefore reconstructs `text_repr` as *base + caption + "Pictured: …"* by reading the caption cache, so it preserves a caption rather than dropping it. Two ordering caveats follow from the wholesale replace:

- If the face worker runs on a photo whose caption isn't in its local cache yet (e.g. the caption was written on a different machine), it will write base-only text and overwrite the server-side caption. Keep the caption cache co-located with the face worker.
- A caption run that lands *after* a face `label` on the same photo drops the "Pictured: …" sentence (the entity link itself is unaffected — that's the primary recall path). In practice each worker processes a photo once (file-state gated), so this only bites if a photo is labeled before it is ever captioned.

### Nightly-window scheduling (config, not code)

`caption-worker.js` does one pass and exits — schedule it to run during an off-hours window with cron (it naturally stops at the end of its pass; killing it mid-run is safe and just resumes next time):

```cron
# Run nightly between 1am and 5am; a `timeout` bounds the window in case the library is huge
0 1 * * * cd /path/to/life-context/connectors/photo-exif && timeout 4h node caption-worker.js >> ~/.life-context/photo-exif-captions.log 2>&1
```

On Windows, use Task Scheduler with a "Daily, 1:00 AM" trigger running `node caption-worker.js`, and a second trigger at 5:00 AM that kills the `node.exe` process if it's still running — see [`../../docs/windows-service-winsw.md`](../../docs/windows-service-winsw.md) for the general Windows-service pattern this project uses.

## Exit test (roadmap M4)

"Photos from Austin in 2019" works from EXIF alone before any caption exists; a captioned photo answers a content query ("photos of us cooking") without creating a duplicate artifact — guaranteed by the ingest contract's upsert-on-`(source, source_id)` semantics, since `scan.js` and `caption-worker.js` compute `source_id` identically (`lib/shared.js`'s `sourceIdFor`).

## Known limitations

- **Reverse geocoding happens in LifeContext core, not here** — this connector submits raw `latitude`/`longitude` only. `place_label` resolution (coarseness, the "near" prefix, the distance cutoff beyond which nothing is labeled) is core's behavior now (`src/geocode.js` in [`msih/life-context`](https://github.com/msih/life-context)), not this connector's.
- **`occurred_at` is never guessed from file mtime.** A photo with no `DateTimeOriginal` gets no `occurred_at` (and the core server's own warning), never an approximation — an import-time mtime would make a 2019 photo sort as "today," which is worse than an honest gap (doc 04 §3).
- **Source ID is the relative file path.** Reorganizing the photo library after the first scan orphans history for moved files (a fresh `source_id` looks like a new artifact) — the same tradeoff every connector's `source`/`source_id` stability rule implies (doc 04 §3).
- **The caption worker has no real vision model to test against in this repo's CI/dev environment** — `test.mjs` verifies the full flow (state tracking, upsert-only-what-changed, VLM-down handling) against a mock Ollama server, but the actual caption quality/latency of a real `llava` (or similar) model is unverified here.

## Testing without a real photo library or VLM

`test.mjs` (`npm test`) synthesizes JPEGs with injected EXIF via `piexifjs` (analogous to how the `imessage` connector's tests use `bplist-creator`) and runs both scripts against mock ingest/VLM HTTP servers. Covers: EXIF+GPS, GPS-only, and no-metadata photos; unchanged-file skipping on re-scan; caption enrichment preserving EXIF-sourced fields via upsert semantics; kill-safe per-photo state; and VLM-unreachable handling.

## Known limitations (face worker)

- **Clustering is approximate** — nearest-centroid with a fixed Euclidean threshold, not a trained recognizer. Expect occasional split clusters (same person, two buckets) or, rarely, a merged one; `export-thumbnails` + re-`label` is the correction path.
- **`export-thumbnails` writes the sample *image*, not a tight face crop** — a real crop would pull in the native image-processing stack at export time. Per-face bounding boxes aren't persisted today (the clusters file stores only centroid/count/label/sample), so a future cropped version would need to re-detect the sample image or start persisting boxes.
- **The ML stack is unverified in this repo's CI** — `test.mjs` covers the full clustering/label/ingest pipeline with an injected fixture detector (no models), so the wire behavior is tested, but real `face-api` detection quality/latency is a manual, on-device concern (same posture as the VLM caption worker).
- **Native dependencies** — `@tensorflow/tfjs-node` and `canvas` are native modules; they're only loaded (via dynamic import) when you actually run a scan, so the other two scripts and the test suite need none of them.

## Files

- `scan.js` — the EXIF batch scanner
- `caption-worker.js` — the VLM enrichment worker
- `face-worker.js` — the local face-detection/clustering worker (`scan` / `label` / `export-thumbnails`)
- `lib/shared.js` — env loading, directory walk, shared `source_id` computation, ingest client
- `lib/describe.js` — shared EXIF description logic (used by every script, so they can never drift)
- `lib/caption-cache.js` — caption state (relPath→text map) + `currentTextRepr`, shared by caption + face workers
- `lib/face-cluster.js` — pure, IO-free descriptor clustering (euclidean, nearest-centroid, (de)serialization)
- `lib/face-detect.js` — lazy ML-model detector + the test fixture detector
- `test.mjs` — `node --test` suite
- `.env.example` — copy to `.env`
