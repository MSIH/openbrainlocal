#!/usr/bin/env node
// Batch-scans a photo archive: EXIF DateTimeOriginal + GPS, sha256 content_hash, minimal
// text_repr — POSTed to LifeContext via /api/v1/ingest/batch. GPS is submitted raw; core
// reverse-geocodes it into place_label server-side (issue #67 — doc 04's transducer split:
// this connector describes, core embeds/resolves). See README.md for setup and the exit test.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent, walkMediaFiles, keyForMedia, mediaType, contentHashOfFile, chunk, ingestClient } from './lib/shared.js';
import { describePhoto, buildTextRepr, readSidecar, sidecarPathFor } from './lib/describe.js';

loadDotEnvIfPresent(path.dirname(fileURLToPath(import.meta.url)));

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const PHOTO_ROOT = process.env.PHOTO_ROOT;
const MANIFEST_PATH = process.env.PHOTO_EXIF_MANIFEST_PATH
  || path.join(os.homedir(), '.life-context', 'photo-exif-manifest.json');
const BATCH_MAX = 100; // contract cap (docs/04-connector-contract.md §2)
// Google Takeout `people[]` are user-curated face tags — high trust, but core caps name/handle
// hints at 0.9 regardless (doc 04 §4), so 0.9 is the effective ceiling we ask for (#152). The
// folder-name pictured hint (a person-named album/folder) rides the same confidence.
const PICTURED_HINT_CONFIDENCE = 0.9;
// Google's year buckets ("Photos from 2019"), never a person — English default only (a
// non-English Takeout names these differently; a documented best-effort limitation).
const YEAR_BUCKET_RE = /^Photos from \d{4}$/;

function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeManifest(manifest) {
  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest));
}

async function buildPayload(absPath, relPath) {
  const { date, dateStr, latitude, longitude } = await describePhoto(absPath);
  const contentHash = await contentHashOfFile(absPath);
  // Google Takeout sidecar (#152): people tags → entity_hints, and takenTime/geo as a FALLBACK for
  // the common case where Takeout stripped the image's own EXIF. EXIF always wins when present; the
  // sidecar only fills a gap. Best-effort — readSidecar returns null on any miss/parse failure, and
  // text_repr is left EXIF-only (the caption/face workers rebuild it, so names live in entity_hints).
  const sidecar = readSidecar(absPath);
  // A file with a sidecar next to it is Google-origin; content-hash keying (never the file path)
  // makes the id reproducible from the bytes and dedups Takeout's per-album copies (see keyForMedia).
  const { source, source_id } = keyForMedia(contentHash, sidecarPathFor(absPath) != null);
  const type = mediaType(path.basename(absPath));

  const payload = {
    source,
    source_id,
    type,
    text_repr: buildTextRepr(dateStr, path.basename(absPath), type),
    content_hash: contentHash,
    raw_path: absPath,
    extra: { captioned: false },
  };
  // occurred_at is when the photo was TAKEN, never a mtime/import-time guess — doc 04 §3 is
  // explicit that a 2019 photo imported today must still sort into 2019, so an unknown date
  // is omitted (and warned on) rather than approximated with something that's actively wrong.
  const occurred = date ?? sidecar?.takenTime ?? null;
  if (occurred) payload.occurred_at = occurred.toISOString();
  const lat = latitude ?? sidecar?.latitude ?? null;
  const lon = longitude ?? sidecar?.longitude ?? null;
  if (lat != null && lon != null) {
    payload.latitude = lat;
    payload.longitude = lon;
  }
  // Pictured-name hints from two sources: the sidecar's people[] (authoritative for Google
  // photos) and the immediate containing folder name (a person-named album/folder — this is what
  // lets a JSON-less photo in ".../Aunt Mary/" map to that person; a non-person folder simply
  // won't resolve core-side, harmless). A file directly in PHOTO_ROOT emits no folder hint, and a
  // Takeout year bucket is never a person. The folder hint is deduped against sidecar names.
  const names = [...(sidecar?.names ?? [])];
  if (relPath.includes('/')) {
    const folder = path.basename(path.dirname(absPath));
    if (!YEAR_BUCKET_RE.test(folder) && !names.some((n) => n.toLowerCase() === folder.toLowerCase())) {
      names.push(folder);
    }
  }
  const hints = names.map((name) => ({
    alias: name, alias_type: 'name', role: 'pictured', confidence: PICTURED_HINT_CONFIDENCE,
  }));
  if (hints.length) payload.entity_hints = hints;
  return payload;
}

// Two byte-identical copies of one photo (Takeout puts a photo in its year bucket AND every album
// it's in) share a content hash → the same source_id. Collapse them into one payload, unioning the
// pictured hints (dedup by alias|role) and filling a missing occurred_at / coordinate from a later
// copy that has it; the first copy's other fields win.
function mergePayloads(base, dup) {
  const merged = [...(base.entity_hints ?? [])];
  const seen = new Set(merged.map((h) => `${h.alias}|${h.role}`));
  for (const h of dup.entity_hints ?? []) {
    const key = `${h.alias}|${h.role}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(h);
    }
  }
  if (merged.length) base.entity_hints = merged;
  if (base.occurred_at == null && dup.occurred_at != null) base.occurred_at = dup.occurred_at;
  if (base.latitude == null && dup.latitude != null) {
    base.latitude = dup.latitude;
    base.longitude = dup.longitude;
  }
}

async function main() {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === 'change-this-to-a-long-secure-token') {
    console.error('photo-exif: LIFECONTEXT_API_KEY not configured (see .env.example)');
    process.exit(1);
  }
  if (!PHOTO_ROOT || !existsSync(PHOTO_ROOT)) {
    console.error(`photo-exif: PHOTO_ROOT not set or doesn't exist: ${PHOTO_ROOT}`);
    process.exit(1);
  }

  const { postIngestBatch } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const manifest = readManifest();
  let scanned = 0;
  let skippedUnchanged = 0;
  // Keyed by source_id so byte-identical copies collapse to one payload (with unioned hints)
  // before the wire. Each entry carries every contributing copy's relPath+statKey so the manifest
  // (still keyed by relPath — the unchanged-file skip cache) is updated for all of them on success.
  const pending = new Map();

  const flush = async () => {
    if (!pending.size) return;
    const entries = [...pending.values()];
    pending.clear();
    for (const group of chunk(entries, BATCH_MAX)) {
      const result = await postIngestBatch(group.map((e) => e.payload));
      result.results.forEach((r, i) => {
        if (r.error) {
          console.error('photo-exif: item failed', group[i].payload.source_id, r.error, r.issues ?? '');
        } else {
          // Only cache success — a failed item must be retried on the next scan, not skipped
          // as "unchanged" forever. Mark every copy that shared this source_id.
          for (const { relPath, statKey } of group[i].copies) manifest[relPath] = statKey;
        }
      });
    }
  };

  for await (const { absPath, relPath } of walkMediaFiles(PHOTO_ROOT)) {
    // statSync AND buildPayload share one try/catch — a permission error or broken file entry
    // can throw from either, and either way it must skip just this file, not abort the scan.
    let statKey;
    let payload;
    try {
      const stat = statSync(absPath);
      statKey = `${stat.mtimeMs}:${stat.size}`;
      if (manifest[relPath] === statKey) {
        skippedUnchanged++;
        continue;
      }
      payload = await buildPayload(absPath, relPath);
    } catch (err) {
      console.error(`photo-exif: skipping unreadable file ${relPath}`, err);
      continue;
    }
    scanned++;
    const existing = pending.get(payload.source_id);
    if (existing) {
      mergePayloads(existing.payload, payload);
      existing.copies.push({ relPath, statKey });
    } else {
      pending.set(payload.source_id, { payload, copies: [{ relPath, statKey }] });
    }
    if (pending.size >= BATCH_MAX) await flush();
  }
  await flush();
  writeManifest(manifest);

  console.error(`photo-exif: scanned ${scanned} new/changed file(s), skipped ${skippedUnchanged} unchanged`);
}

main()
  .then(() => process.exit(0)) // fetch's keep-alive sockets would otherwise hold the process open
  .catch((err) => {
    console.error('photo-exif: scan failed', err);
    process.exit(1);
  });
