# photo-exif

The single photo/video connector for [LifeContext](https://github.com/msih/life-context). Three scripts make a media library time/place/person-queryable with zero inference, then optionally enrich it with real content understanding. Implements [Milestone 4](https://github.com/msih/life-context/blob/2.0/docs/05-roadmap.md) of the roadmap — the **batch** reference connector, and the proof that upsert-as-enrichment works.

**Handles both a plain photo library and a Google Takeout export** (#171 folded the former `gphotos-takeout` connector in here). Media from a **Google Takeout export** keys under `source='google-photos'`, `source_id='gphotos:<sha256>'`; everything else keys under `source='photo-exif'`, `source_id='<sha256>'`. Takeout-origin is decided **at the scan root, not per file** (#176): the root is a Takeout export when it *is* a `Google Photos` directory, contains one, or holds a Takeout marker (a `Photos from <YYYY>` bucket or an album `metadata.json`) — set `PHOTO_TAKEOUT=true|false` to force it. (Per-file sidecar presence is the wrong signal: Takeout omits a sidecar for some items — e.g. motion-photo `.MP4`s — and keying those generic would duplicate the `google-photos` row.) Person hints come from two sources: the sidecar's `people[]` (Google's face tags) and the immediate containing folder name (a person-named album/folder). Videos (`.mp4`/`.mov`/`.m4v`/`.3gp`) ingest as `type='video'`; images as `type='photo'`.

## Architecture decision: where the caption worker lives

The roadmap flags this as an open question ("worker lives with core or alongside — decide here," since doc 04 frames VLM captioning as a core-side "transducer," conceptually parallel to how core owns embeddings). **Decision: it lives here, in `photo-exif/`, as a second script alongside the scanner** — not in `life-context` core. Rationale:

- Consistency: `devsession-claude` and `imessage` are both pure isolated HTTP clients with zero direct database coupling; splitting `photo-exif`'s enrichment step into core would make it the only connector that isn't.
- The worker never needs to query "which artifacts need captions" from the server — it re-walks the same `PHOTO_ROOT` it already knows and checks its own local state file (`PHOTO_EXIF_CAPTION_STATE_PATH`). No new server-side capability required.
- It still upserts the *same artifact* (the `(source, source_id)` key is the file's content hash, computed identically in all three scripts via `lib/shared.js`'s `keyForMedia`), so the contract's upsert semantics do all the real work — the worker is just a slow, patient HTTP client like any other.

## What it does

### `scan.js` (deliverables 1–2)
1. Recursively walks `PHOTO_ROOT` for image files (`.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`, `.tif`, `.tiff`) **and** videos (`.mp4`, `.mov`, `.m4v`, `.3gp`, ingested as `type='video'`).
2. Extracts `DateTimeOriginal` and GPS coordinates via `exifr`.
3. Submits GPS as raw `latitude`/`longitude` — this connector does no geocoding of its own. [LifeContext core](https://github.com/msih/life-context) resolves `place_label` from those coordinates server-side, fully offline (`src/geocode.js`), so every connector with GPS gets place resolution without bundling its own city dataset.
4. Computes a sha256 `content_hash` of the file bytes (streamed, not loaded fully into memory) — this content hash **is** the `source_id` (see keying above), so a re-organized library, a re-export, or a copy in another folder all key to the same artifact.
5. **Collapses byte-identical copies within a scan.** A Google Takeout export puts the same photo in its year bucket *and* every album it belongs to; scan.js merges copies that share a content hash into one payload before sending, unioning their `pictured` hints. (The server's upsert is additive too, so cross-batch copies still converge.)
6. Sends `type='photo'`/`type='video'` artifacts via `POST /api/v1/ingest/batch`.
7. Skips files unchanged since the last scan (mtime+size cache in `PHOTO_EXIF_MANIFEST_PATH`, keyed by relPath) — repeat scans over a large library only process what's new. On a long run scan.js prints a throttled `photo-exif: progress — …` line and **persists the manifest to disk on the same tick** (`PHOTO_EXIF_PROGRESS_INTERVAL_MS`, default 30000ms; `0` disables both), so a killed/crashed scan resumes to within one interval instead of re-hashing everything.
   - **Skips files core already has, even on a cold manifest (#198).** For files that miss the local manifest, scan.js hashes them (cheap), asks the server `POST /api/v1/exists` which `(source, source_id)`s are already stored, and runs the expensive EXIF read + ingest only for genuinely new files (logged per batch: `skip-check — N hashed, M already stored, K new`). This is what makes a **Takeout re-extract cheap** — unzipping resets every file's mtime, so the mtime-keyed manifest misses on everything, but the server check recognizes the already-imported library and skips it. Already-stored files are still recorded in the manifest so subsequent *local* runs skip them via a bare `stat`. Against a core that predates `/exists` (a `404`), scan.js logs one line and falls back to processing everything — never a hard failure.
8. **Person hints — two sources**, both `alias_type:'name'`, `role:'pictured'`, `confidence:0.9`; core resolves each against the entity graph (linking the photo, or staging an unresolved alias), never asserted as an entity here:
   - **Google Takeout sidecar `people[]` (#152)** — Google's user-verified face tags. If a per-photo `*.supplemental-metadata.json` (or an older/variant name) sits next to the file, scan.js reads it best-effort. It also uses the sidecar's **`photoTakenTime` / `geoData` as an EXIF fallback** — only when the file's own EXIF lacks a date/GPS (Takeout frequently strips EXIF on export); EXIF always wins when present, and `geoData {0,0}` (Google's "no location" sentinel) is not submitted as a coordinate. The sidecar resolver handles `<file>.supplemental-metadata.json`, `.supplemental-meta.json`, older `<file>.json`, the duplicate-media `(N)` variants, and a length-truncated prefix fallback (a per-directory scan, amortized to one readdir per folder — plain non-Takeout folders pay a negligible once-per-folder cost).
   - **Immediate containing folder name** — a JSON-less photo in `.../Aunt Mary/` maps to that person via a folder-name hint (a non-person folder simply won't resolve core-side, which is harmless). A file directly in `PHOTO_ROOT` (no subfolder) emits no folder hint, and a Takeout year bucket (`Photos from <year>`) is never treated as a person. The folder hint is deduped against sidecar names (case-insensitive).
   - Names are **not** written into `text_repr` (the caption/face workers rebuild `text_repr`, so people live in the durable `entity_hints`, not the prose).

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
node face-worker.js suggest-labels          # print (never apply) name suggestions for unlabeled clusters
```

Nothing is sent for a cluster until you name it — an unnamed cluster is just an anonymous bucket, so no fabricated aliases pollute the entity graph. Naming is a deliberate, local trust decision; alias→entity resolution stays core's job.

#### `suggest-labels` — pre-name clusters from contact photos (#84)

Speeds up labeling by using each contact's **current** photo as a reference face — the UI-uploaded override (`attrs.photoFile`, #97) if present, else the imported vCard photo (core's `PHOTO` import, #74) — the same photo the contacts UI shows (`GET /api/v1/entities/photos` applies that precedence, #112). It only ever **prints** candidate matches to stderr — it never writes `cluster.label` and never emits an ingest hint. You still confirm with the existing `label <id> "<name>"` command; a wrong auto-label would be worse than an anonymous cluster.

```bash
node face-worker.js suggest-labels
# photo-exif: suggest — cluster 7 (12 photo(s)) possibly "Sarah Jones" (entity #42, distance 0.31 <= threshold 0.6)
# photo-exif: suggest-labels — checked 18 contact photo(s), 1 cluster(s) suggested
```

**Requires this connector's process to be able to read the file path LifeContext core returns** (`raw_path`, under core's `CONTACTS_RAW_DIR`) — i.e., this connector and core must share a filesystem (same machine, or a mounted/synced volume). There is no endpoint to fetch the raw bytes over HTTP; a `raw_path` this process can't read is skipped and logged, not fatal to the run. If `CONTACTS_RAW_DIR` is a relative path in core's `.env`, set it to an **absolute** path there for reliable resolution — a relative path resolves against whatever directory core's own process happened to start from, which this connector has no way to know. Already-labeled clusters are never re-suggested, and a reference photo with zero or multiple detected faces is skipped as ambiguous. Tune the match distance with `FACE_SEED_THRESHOLD` (defaults to `FACE_MATCH_THRESHOLD`) — see `.env.example`.

## Setup

1. `cp .env.example .env` and fill in `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY` / `PHOTO_ROOT`.
2. `npm install` (real dependency: `exifr`; the face worker additionally needs `@vladmandic/face-api`, `@tensorflow/tfjs-node`, and `canvas` — native modules, only required if you run `face-worker.js`).
3. Backfill: `node scan.js`.
4. Optionally, once you have a vision model pulled in Ollama (`ollama pull llava`): `node caption-worker.js`.
5. Optionally, for face → contact linking: download the face-api model weights into `FACE_MODELS_PATH` (the `ssdMobilenetv1`, `faceLandmark68Net`, and `faceRecognitionNet` weight files from the `@vladmandic/face-api` model repo — one-time, offline after), then `node face-worker.js`, browse clusters with `export-thumbnails`, and `label` the ones you recognize.

### Prep a Takeout download (Windows) — `prep-takeout.ps1`

A Google Takeout photo export arrives as multi-part zips (`takeout-*.zip`) that must be unzipped before `scan.js` can walk them, and the zips then eat a lot of disk. `prep-takeout.ps1` does that prep in one pass over `-PhotoRoot` (default `C:\Artifacts\life-context\photo`):

1. Extracts each `takeout-*.zip` into `-PhotoRoot` (the parts are independent archives that merge into the shared `Takeout\` tree; `-Force` overwrites byte-identical dupes across parts).
2. **Only after a zip extracts successfully**, sends that zip to the **Recycle Bin** (a failed extract leaves its zip in place and is logged — nothing is lost to a half-run).
3. Recurses the extracted tree and sends every movie file (`.mp4,.mov,.m4v,.avi,.mkv,.wmv,.mpg,.mpeg,.3gp,.webm` by default, `-VideoExtensions`) to the **Recycle Bin**, so videos never reach the library.

```powershell
powershell -File prep-takeout.ps1 -WhatIf   # dry-run: log every action, change nothing
powershell -File prep-takeout.ps1           # do it, then run `node scan.js`
```

**Persistent, append-only run log (`-LogPath`).** Stdout is ephemeral, so every run also **appends** to a log — default `<PhotoRoot>\prep-takeout.log`, overridable with `-LogPath` — that accumulates the full history of every part ever processed, so you can later answer "did I process every Takeout part?" or audit a destructive run. It is written *alongside* the stdout output (tee, so interactive use is unchanged), and is **append-only** (never truncated). Each line is `UTC-timestamp LEVEL message` (`LEVEL` = `INFO`/`WARN`); a run logs a run-start header (start time, PhotoRoot, zip count, WhatIf flag), a per-zip `extract ok|FAIL <reason>` and `recycle ok|FAIL <reason>` (the failure line carries the exception message, e.g. `A local file header is corrupt.`), a single `videos recycled=<n> failed=<n>` summary (not one line per video), and a final `run end ...` tally. When no zips match the pattern, the run logs the start header, a `no zips to process` line, and a `run end ... extracted=0 ...` tally — no per-zip or video-summary lines. `-WhatIf` lines carry a `[WhatIf]` marker. Logging is **best-effort** — an unwritable log degrades to a stdout warning and never aborts the run — and the `.log` is inert to the script's own scans (it is neither a `takeout-*.zip` nor a video). Example:

```
2026-07-16T20:14:03Z INFO  run start PhotoRoot=C:\Artifacts\life-context\photo zips=10 whatif=False
2026-07-16T20:14:03Z WARN  extract FAIL takeout-...-015.zip -- A local file header is corrupt.
2026-07-16T20:19:41Z INFO  extract ok takeout-...-021.zip
2026-07-16T20:19:58Z INFO  recycle ok takeout-...-021.zip
2026-07-16T21:02:10Z INFO  videos recycled=1234 failed=0
2026-07-16T21:02:10Z INFO  run end zips: extracted=9 recycled=9 failed=1 | videos: recycled=1234 failed=0
```

**Recycle Bin, never permanent delete** — recoverable, and matching this project's append-only ethos and the box's delete-blocked posture (the `rm`/`Remove-Item` deny); it uses `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(SendToRecycleBin)`, not `Remove-Item`. **Caveat:** the Recycle Bin still occupies disk until emptied — to actually reclaim the space after a verified run, empty it manually (the script can't, since permanent delete is blocked). Windows-only.

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

"Photos from Austin in 2019" works from EXIF alone before any caption exists; a captioned photo answers a content query ("photos of us cooking") without creating a duplicate artifact — guaranteed by the ingest contract's upsert-on-`(source, source_id)` semantics, since all three scripts compute the `(source, source_id)` key identically (`lib/shared.js`'s `keyForMedia`, from the file's content hash).

## Known limitations

- **Reverse geocoding happens in LifeContext core, not here** — this connector submits raw `latitude`/`longitude` only. `place_label` resolution (coarseness, the "near" prefix, the distance cutoff beyond which nothing is labeled) is core's behavior now (`src/geocode.js` in [`msih/life-context`](https://github.com/msih/life-context)), not this connector's.
- **`occurred_at` is never guessed from file mtime.** A photo with no `DateTimeOriginal` gets no `occurred_at` (and the core server's own warning), never an approximation — an import-time mtime would make a 2019 photo sort as "today," which is worse than an honest gap (doc 04 §3).
- **Source ID is the content hash.** The `source_id` is the file's sha256 (see keying above), so moving/renaming/re-exporting a photo, or the same photo appearing in several Takeout folders, all key to the *same* artifact. The tradeoff is the inverse of a path key: an **edited** copy (different bytes) is a distinct artifact even though it's "the same" photo — intended.
- **Year-bucket / folder-hint detection is English-only** (`Photos from <year>`). A non-English Takeout names year folders differently; such a folder would be read as an album and its name emitted as a (usually non-resolving, harmless) person hint.
- **The caption worker has no real vision model to test against in this repo's CI/dev environment** — `test.mjs` verifies the full flow (state tracking, upsert-only-what-changed, VLM-down handling) against a mock Ollama server, but the actual caption quality/latency of a real `llava` (or similar) model is unverified here.

## Testing without a real photo library or VLM

`test.mjs` (`npm test`) synthesizes JPEGs with injected EXIF via `piexifjs` (analogous to how the `imessage` connector's tests use `bplist-creator`) and runs the scripts against mock ingest/VLM HTTP servers. Covers: EXIF+GPS, GPS-only, and no-metadata photos; content-hash keying (generic `photo-exif`/`<hash>` vs. Google-origin `google-photos`/`gphotos:<hash>`); Takeout sidecar people/date/geo parsing; byte-identical copies collapsing to one payload with unioned hints; folder-name person hints (subfolder yes, root none, year bucket none); video (`type='video'`) typing; unchanged-file skipping on re-scan; caption enrichment preserving EXIF-sourced fields via upsert semantics; kill-safe per-photo state; and VLM-unreachable handling.

## Known limitations (face worker)

- **Clustering is approximate** — nearest-centroid with a fixed Euclidean threshold, not a trained recognizer. Expect occasional split clusters (same person, two buckets) or, rarely, a merged one; `export-thumbnails` + re-`label` is the correction path.
- **`export-thumbnails` writes the sample *image*, not a tight face crop** — a real crop would pull in the native image-processing stack at export time. Per-face bounding boxes aren't persisted today (the clusters file stores only centroid/count/label/sample), so a future cropped version would need to re-detect the sample image or start persisting boxes.
- **The ML stack is unverified in this repo's CI** — `test.mjs` covers the full clustering/label/ingest pipeline with an injected fixture detector (no models), so the wire behavior is tested, but real `face-api` detection quality/latency is a manual, on-device concern (same posture as the VLM caption worker).
- **Native dependencies** — `@tensorflow/tfjs-node` and `canvas` are native modules; they're only loaded (via dynamic import) when you actually run a scan, so the other two scripts and the test suite need none of them.
- **`suggest-labels` requires a shared filesystem with core (#84)** — it reads `raw_path` values LifeContext core returns; there's no HTTP endpoint to fetch those bytes, so this connector must be able to read the same disk (or a mounted/synced volume) core wrote contact photos to. Cross-machine setups (this connector on a different host than core, e.g. the Mac Mini/Windows-server iMessage topology) aren't supported for this command specifically — everything else in this connector works unchanged in that topology.

## Files

- `prep-takeout.ps1` — Windows pre-scan prep: unzip a Takeout export, recycle the zips + any videos (Recycle Bin, never permanent delete)
- `scan.js` — the media batch scanner (EXIF + Takeout sidecars + folder-name hints; walks images **and** videos)
- `caption-worker.js` — the VLM enrichment worker (images only)
- `face-worker.js` — the local face-detection/clustering worker, images only (`scan` / `label` / `export-thumbnails` / `suggest-labels`)
- `lib/shared.js` — env loading, media walk (`walkImageFiles`/`walkMediaFiles`), the content-hash keying resolver (`keyForMedia`), `mediaType`, ingest client, contact-photos fetch (`suggest-labels`)
- `lib/describe.js` — shared EXIF + Takeout-sidecar description logic (`describePhoto`/`readSidecar`/`sidecarPathFor`), used by every script so they can never drift
- `lib/caption-cache.js` — caption state (relPath→text map) + `currentTextRepr`, shared by caption + face workers
- `lib/face-cluster.js` — pure, IO-free descriptor clustering (euclidean, nearest-centroid, (de)serialization)
- `lib/face-detect.js` — lazy ML-model detector + the test fixture detector
- `test.mjs` — `node --test` suite
- `.env.example` — copy to `.env`
