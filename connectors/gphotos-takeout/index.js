#!/usr/bin/env node
// Batch-ingests a Google Takeout "Google Photos" export into LifeContext as type='photo'
// artifacts, reusing the person-albums a user named in the Google Photos UI as `pictured`
// entity hints (issue #77). Google's Library/Picker APIs expose no face/person data, but a
// named face-group album becomes a folder in Takeout — so album membership is a supported,
// offline path to reuse Google's matching for the people who matter most.
//
// Takeout duplicates each photo into its year bucket AND every album it belongs to; those
// copies are collapsed into ONE artifact by content_hash (which is also the source_id), so a
// photo in three albums is a single artifact carrying all three albums' person hints. Core does
// embedding, reverse-geocoding, and entity resolution — this connector only describes.
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDotEnvIfPresent, contentHashOfFile, chunk, readJsonOr, writeJson, ingestClient, spoolClient,
} from './lib/shared.js';
import { walkTakeout, parseSidecar } from './lib/takeout.js';
import { loadPeopleConfig, hintsForAlbums } from './people.js';

const CONNECTOR_DIR = path.dirname(fileURLToPath(import.meta.url));
loadDotEnvIfPresent(CONNECTOR_DIR);

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const TAKEOUT_ROOT = process.env.TAKEOUT_ROOT;
const PEOPLE_CONFIG = process.env.GPHOTOS_PEOPLE_CONFIG || path.join(CONNECTOR_DIR, 'config.json');
const MANIFEST_PATH = process.env.GPHOTOS_MANIFEST_PATH
  || path.join(os.homedir(), '.life-context', 'gphotos-takeout-manifest.json');
const SPOOL_PATH = process.env.GPHOTOS_SPOOL_PATH
  || path.join(os.homedir(), '.life-context', 'gphotos-takeout-spool.jsonl');
const BATCH_MAX = 100; // contract cap (docs/04-connector-contract.md §2)

// A cached album title per metadata.json (the album's real name, which can differ from the
// sanitized folder name). Read lazily, once per album folder.
const albumTitleCache = new Map();
async function resolveAlbumTitle(record) {
  if (record.album == null) return null; // year bucket / root
  if (!record.albumMetaPath) return record.album;
  if (albumTitleCache.has(record.albumMetaPath)) return albumTitleCache.get(record.albumMetaPath);
  let title = record.album;
  try {
    const meta = JSON.parse(await readFile(record.albumMetaPath, 'utf8'));
    if (typeof meta.title === 'string' && meta.title.trim()) title = meta.title.trim();
  } catch {
    // No/broken album metadata.json — fall back to the folder name (already set).
  }
  albumTitleCache.set(record.albumMetaPath, title);
  return title;
}

function buildTextRepr({ occurredAt, albums, aliases, description, fileName }) {
  const parts = [occurredAt ? `Photo taken ${occurredAt.slice(0, 10)}` : `Photo: ${fileName}`];
  if (albums.length) parts.push(`albums: ${albums.join(', ')}`);
  if (aliases.length) parts.push(`people: ${aliases.join(', ')}`);
  if (description) parts.push(description);
  return parts.join(' — ');
}

// The canonical copy for raw_path: prefer a year-bucket copy (album null = Google's original
// location), else the shortest path, tiebroken lexicographically — deterministic across runs.
function canonicalPath(copies) {
  return [...copies].sort((a, b) => {
    if ((a.album == null) !== (b.album == null)) return a.album == null ? -1 : 1;
    if (a.absPath.length !== b.absPath.length) return a.absPath.length - b.absPath.length;
    return a.absPath < b.absPath ? -1 : 1;
  })[0].absPath;
}

// Signature of the derived record — re-send only when something core would store changed
// (adding a photo to a new person-album on a later run re-sends, so its links grow additively).
function signatureOf(payload) {
  return JSON.stringify({
    t: payload.text_repr,
    o: payload.occurred_at ?? null,
    la: payload.latitude ?? null,
    lo: payload.longitude ?? null,
    h: (payload.entity_hints ?? []).map((x) => `${x.alias}:${x.role}`).sort(),
  });
}

async function main() {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === 'change-this-to-a-long-secure-token') {
    console.error('gphotos-takeout: LIFECONTEXT_API_KEY not configured (see .env.example)');
    process.exit(1);
  }
  if (!TAKEOUT_ROOT || !existsSync(TAKEOUT_ROOT)) {
    console.error(`gphotos-takeout: TAKEOUT_ROOT not set or doesn't exist: ${TAKEOUT_ROOT}`);
    process.exit(1);
  }
  const peopleConfig = loadPeopleConfig(PEOPLE_CONFIG);

  const { postIngestBatch } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const { spool, flushSpool } = spoolClient({ spoolPath: SPOOL_PATH, postIngestBatch, batchMax: BATCH_MAX });
  const manifest = readJsonOr(MANIFEST_PATH, { hashes: {}, sent: {} });
  manifest.hashes ??= {};
  manifest.sent ??= {};

  // Deliver anything a prior server-down run spooled, before scanning the current tree (§7).
  // Mark flushed payloads sent so phase 2 doesn't redundantly re-send them (a later change to
  // the same photo still re-sends: phase 2 recomputes a fresh signature that won't match).
  const flushResult = await flushSpool();
  for (const p of flushResult.flushed) manifest.sent[p.source_id] = signatureOf(p);
  if (flushResult.flushed.length || flushResult.remaining) {
    console.error(`gphotos-takeout: spool flushed ${flushResult.flushed.length}, ${flushResult.remaining} still pending`);
  }

  // Phase 1 — walk + hash, collapsing every folder-copy of a photo into one group by content.
  const groups = new Map(); // hash -> { copies, albums:Set, occurredAt, lat, lon, description, fileName }
  let files = 0;
  for await (const record of walkTakeout(TAKEOUT_ROOT)) {
    files++;
    let hash;
    try {
      const stat = statSync(record.absPath);
      const statKey = `${stat.mtimeMs}:${stat.size}`;
      const cached = manifest.hashes[record.absPath];
      hash = cached && cached.statKey === statKey ? cached.hash : await contentHashOfFile(record.absPath);
      manifest.hashes[record.absPath] = { statKey, hash };
    } catch (err) {
      console.error(`gphotos-takeout: skipping unreadable file ${record.absPath}`, err);
      continue;
    }

    let group = groups.get(hash);
    if (!group) {
      group = { copies: [], albums: new Set(), occurredAt: null, lat: null, lon: null, description: null, fileName: record.fileName };
      groups.set(hash, group);
    }
    group.copies.push({ absPath: record.absPath, album: record.album });

    const albumTitle = await resolveAlbumTitle(record);
    if (albumTitle) group.albums.add(albumTitle);

    if (record.sidecarPath) {
      try {
        const parsed = parseSidecar(JSON.parse(await readFile(record.sidecarPath, 'utf8')));
        group.occurredAt ??= parsed.occurredAt;
        if (group.lat == null && parsed.latitude != null) { group.lat = parsed.latitude; group.lon = parsed.longitude; }
        group.description ??= parsed.description;
      } catch (err) {
        console.error(`gphotos-takeout: bad sidecar ${record.sidecarPath}`, err);
      }
    }
  }

  // Phase 2 — build one payload per group, skip unchanged, batch-ingest.
  const pending = [];
  let queued = 0;
  let skippedUnchanged = 0;
  let hintCount = 0;

  const flush = async () => {
    if (!pending.length) return;
    for (const group of chunk(pending, BATCH_MAX)) {
      try {
        const { results } = await postIngestBatch(group.map((g) => g.payload));
        results.forEach((r, i) => {
          if (r.error) {
            console.error('gphotos-takeout: item failed', group[i].payload.source_id, r.error, r.issues ?? '');
          } else {
            manifest.sent[group[i].payload.source_id] = group[i].signature; // cache success only
          }
        });
      } catch (err) {
        console.error('gphotos-takeout: batch failed, spooling for next run', err);
        await spool(group.map((g) => g.payload));
      }
    }
    pending.length = 0;
  };

  for (const [hash, group] of groups) {
    const albums = [...group.albums].sort();
    const hints = hintsForAlbums(albums, peopleConfig);
    const sourceId = `gphotos:${hash}`;
    const payload = {
      source: 'google-photos',
      source_id: sourceId,
      type: 'photo',
      text_repr: buildTextRepr({
        occurredAt: group.occurredAt, albums, aliases: hints.map((h) => h.alias), description: group.description, fileName: group.fileName,
      }),
      content_hash: hash,
      raw_path: canonicalPath(group.copies),
      extra: { source: 'google-photos-takeout', albums },
    };
    if (group.occurredAt) payload.occurred_at = group.occurredAt;
    if (group.lat != null) { payload.latitude = group.lat; payload.longitude = group.lon; }
    if (hints.length) payload.entity_hints = hints;

    const signature = signatureOf(payload);
    if (manifest.sent[sourceId] === signature) { skippedUnchanged++; continue; }

    queued++;
    hintCount += hints.length;
    pending.push({ payload, signature });
    if (pending.length >= BATCH_MAX) await flush();
  }
  await flush();
  writeJson(MANIFEST_PATH, manifest);

  console.error(
    `gphotos-takeout: ${files} media file(s) → ${groups.size} unique photo(s); `
    + `${queued} sent/updated, ${skippedUnchanged} unchanged, ${hintCount} pictured hint(s)`,
  );
}

main()
  .then(() => process.exit(0)) // fetch keep-alive sockets would otherwise hold the process open
  .catch((err) => {
    console.error('gphotos-takeout: scan failed', err);
    process.exit(1);
  });
