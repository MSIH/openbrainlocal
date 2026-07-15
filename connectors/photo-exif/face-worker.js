#!/usr/bin/env node
// Third photo-exif pass (issue #53): detect faces locally, cluster them into anonymous groups,
// and — once a human names a cluster — emit `pictured` entity hints on the same photo artifacts
// scan.js already created. Follows the caption worker's enrichment pattern: walk the same
// PHOTO_ROOT, keep local state, upsert the SAME (source='photo-exif', source_id=relPath) — never
// a new artifact. Detection is local/offline; descriptors stay in the local clusters file and
// NEVER go on the wire (doc 04 §4/§11) — only human-assigned names do, as name hints.
//
// Commands:
//   node face-worker.js                      scan: detect + cluster + emit hints for labeled faces
//   node face-worker.js label <id> "<name>"  name a cluster and re-emit its photos' hints
//   node face-worker.js export-thumbnails <dir>  write one sample image per cluster + index.json
//   node face-worker.js suggest-labels       print (never apply) name suggestions for unlabeled
//                                             clusters, matched against contact photos (#84)
//
// Kill-safe: state is saved after every photo. Nightly-window scheduling is config, not code —
// see README.md (same posture as caption-worker.js).
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent, walkImageFiles, keyForMedia, isTakeoutRoot, contentHashOfFile, ingestClient, fetchContactPhotos } from './lib/shared.js';
import { describePhoto } from './lib/describe.js';
import { readCaptionCache, currentTextRepr } from './lib/caption-cache.js';
import { assignCluster, euclideanDistance, parseClustersFile, serializeClustersFile } from './lib/face-cluster.js';
import { resolveDetector } from './lib/face-detect.js';

const CONNECTOR_DIR = path.dirname(fileURLToPath(import.meta.url));
loadDotEnvIfPresent(CONNECTOR_DIR);

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const PHOTO_ROOT = process.env.PHOTO_ROOT;
const FACE_MODELS_PATH = process.env.FACE_MODELS_PATH;
const FACE_FIXTURE = process.env.PHOTO_EXIF_FACE_FIXTURE; // test seam (see face-detect.js)
const HOME_STATE = (name) => path.join(os.homedir(), '.life-context', name);
const FACE_STATE_PATH = process.env.PHOTO_EXIF_FACE_STATE_PATH || HOME_STATE('photo-exif-faces.json');
const CLUSTERS_PATH = process.env.PHOTO_EXIF_FACE_CLUSTERS_PATH || HOME_STATE('photo-exif-face-clusters.json');
const CAPTION_STATE_PATH = process.env.PHOTO_EXIF_CAPTION_STATE_PATH || HOME_STATE('photo-exif-captions.json');
// Number()-with-isFinite so an explicit 0 isn't overridden by a `|| default` (0 is falsy).
const matchRaw = Number(process.env.FACE_MATCH_THRESHOLD);
const FACE_MATCH_THRESHOLD = Number.isFinite(matchRaw) ? matchRaw : 0.6;
const confRaw = Number(process.env.FACE_HINT_CONFIDENCE);
const FACE_HINT_CONFIDENCE = Number.isFinite(confRaw) ? confRaw : 0.6;
const throttleRaw = Number(process.env.FACE_THROTTLE_MS);
const FACE_THROTTLE_MS = Number.isFinite(throttleRaw) ? throttleRaw : 0;
// #84 — distance threshold for matching a contact's reference photo against an unlabeled
// cluster centroid. Separate from FACE_MATCH_THRESHOLD (intra-camera-roll clustering): a posed
// contact photo and a candid camera-roll photo differ enough in framing/lighting that
// cross-source matching may warrant a different threshold. Defaults to the same value so
// behavior is a pure addition until tuned.
const seedRaw = Number(process.env.FACE_SEED_THRESHOLD);
const FACE_SEED_THRESHOLD = Number.isFinite(seedRaw) ? seedRaw : FACE_MATCH_THRESHOLD;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requireApiKey = () => {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === 'change-this-to-a-long-secure-token') {
    console.error('photo-exif: LIFECONTEXT_API_KEY not configured (see .env.example)');
    process.exit(1);
  }
};

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

function loadClusters() {
  return existsSync(CLUSTERS_PATH) ? parseClustersFile(readFileSync(CLUSTERS_PATH, 'utf8')) : { version: 0, clusters: [] };
}

function saveClusters(state) {
  mkdirSync(path.dirname(CLUSTERS_PATH), { recursive: true });
  writeFileSync(CLUSTERS_PATH, serializeClustersFile(state.version, state.clusters));
}

// The pictured names on a photo = the labels of the (distinct) clusters its faces fall into.
function picturedNames(clusterIds, clustersById) {
  const names = new Set();
  for (const id of clusterIds) {
    const label = clustersById.get(id)?.label;
    if (label) names.add(label);
  }
  return [...names].sort();
}

// Build the enrichment payload for one photo from its stored face entry + current cluster labels.
// text_repr is REQUIRED by the contract on every ingest (IngestPayloadSchema.text_repr is not
// optional), so we always send it — reconstructed as base + caption (from the caption cache) so a
// caption is preserved rather than clobbered — and append "Pictured: …" only when a cluster the
// photo belongs to has been named. Hints are added only for labeled clusters.
function buildPayload(relPath, entry, clustersById, captionCache) {
  const pictured = picturedNames(entry.clusters, clustersById);
  const caption = captionCache[relPath] ?? null;
  const baseText = currentTextRepr(entry.dateStr, path.basename(relPath), caption);
  // entry.{source,source_id} is the content-hash key scan() computed and persisted (keyForMedia),
  // so a labeled photo enriches the SAME artifact scan.js/caption-worker created.
  const payload = {
    source: entry.source,
    source_id: entry.source_id,
    type: 'photo',
    text_repr: pictured.length ? `${baseText} Pictured: ${pictured.join(', ')}.` : baseText,
    extra: { faces_detected: entry.faces, pictured, captioned: caption != null },
  };
  if (pictured.length) {
    payload.entity_hints = pictured.map((alias) => ({ alias, alias_type: 'name', role: 'pictured', confidence: FACE_HINT_CONFIDENCE }));
  }
  return payload;
}

// Everything in the payload that can change between runs — used to skip an upsert that would be
// byte-for-byte identical to the last one we sent for this photo.
const payloadSignature = (p) => JSON.stringify({ e: p.extra, h: p.entity_hints ?? null, t: p.text_repr ?? null });

// Shared by scan() and suggestLabels() — models unavailable/unloadable stops the run before
// touching anything, same as the VLM-down path.
async function loadDetectorOrExit() {
  try {
    return await resolveDetector({ modelsPath: FACE_MODELS_PATH, fixturePath: FACE_FIXTURE });
  } catch (err) {
    console.error('photo-exif: face detector unavailable (check FACE_MODELS_PATH)', err);
    process.exit(1);
  }
}

async function scan() {
  requireApiKey();
  if (!PHOTO_ROOT || !existsSync(PHOTO_ROOT)) {
    console.error(`photo-exif: PHOTO_ROOT not set or doesn't exist: ${PHOTO_ROOT}`);
    process.exit(1);
  }
  const detectFaces = await loadDetectorOrExit();
  // Same scan-level Google-origin decision scan.js makes, so the persisted key matches (#176).
  const isTakeout = isTakeoutRoot(PHOTO_ROOT, process.env.PHOTO_TAKEOUT);

  const { postIngest } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const faceState = readJson(FACE_STATE_PATH, {});
  const clustersState = loadClusters();
  const captionCache = readCaptionCache(CAPTION_STATE_PATH);
  const clustersById = new Map(clustersState.clusters.map((c) => [c.id, c]));

  let detected = 0;
  let emitted = 0;
  let skippedUnchanged = 0;

  const emit = async (relPath, entry) => {
    const payload = buildPayload(relPath, entry, clustersById, captionCache);
    const sig = payloadSignature(payload);
    if (entry.ingestedSig === sig) return false;
    await postIngest(payload);
    entry.ingestedSig = sig;
    return true;
  };

  for await (const { absPath, relPath } of walkImageFiles(PHOTO_ROOT)) {
    let statKey;
    try {
      const st = statSync(absPath);
      statKey = `${st.mtimeMs}:${st.size}`;
    } catch (err) {
      console.error(`photo-exif: skipping unreadable file ${relPath}`, err);
      continue;
    }

    let entry = faceState[relPath];
    if (!entry || entry.statKey !== statKey) {
      // New or changed file → (re)detect. A per-file failure skips just this file (scan.js posture).
      let faces;
      try {
        faces = await detectFaces(absPath, relPath);
      } catch (err) {
        console.error(`photo-exif: face detection failed for ${relPath}, skipping`, err);
        continue;
      }
      const { dateStr } = await describePhoto(absPath);
      const clusterIds = [];
      for (const face of faces) {
        const id = assignCluster(face.descriptor, clustersState.clusters, FACE_MATCH_THRESHOLD);
        clusterIds.push(id);
        const cl = clustersState.clusters.find((c) => c.id === id);
        if (!cl.sample) cl.sample = relPath;
        clustersById.set(id, cl);
      }
      entry = { statKey, faces: faces.length, clusters: [...new Set(clusterIds)], dateStr, ingestedSig: null };
      faceState[relPath] = entry;
      // Persist BOTH the clusters and the face-state entry before the network step, together, so a
      // crash here can't leave clusters updated but the entry missing (which would re-detect this
      // photo next run and double-count its centroids).
      saveClusters(clustersState);
      writeJson(FACE_STATE_PATH, faceState);
      detected++;
    }

    // The content-hash key (keyForMedia) — computed once and persisted on the entry so it's stable
    // across runs and reused by label(). Also backfills an entry from before this key was stored.
    if (!entry.source_id) {
      let contentHash;
      try {
        contentHash = await contentHashOfFile(absPath);
      } catch (err) {
        console.error(`photo-exif: skipping unreadable file ${relPath}`, err);
        continue;
      }
      const { source, source_id } = keyForMedia(contentHash, isTakeout);
      entry.source = source;
      entry.source_id = source_id;
      writeJson(FACE_STATE_PATH, faceState);
    }

    try {
      if (await emit(relPath, entry)) emitted++;
      else skippedUnchanged++;
    } catch (err) {
      console.error(`photo-exif: ingest failed for ${relPath}, will retry next run`, err);
    }
    writeJson(FACE_STATE_PATH, faceState); // after every photo — kill-safe
    if (FACE_THROTTLE_MS) await sleep(FACE_THROTTLE_MS);
  }

  writeJson(FACE_STATE_PATH, faceState);
  saveClusters(clustersState);
  console.error(`photo-exif: faces — detected ${detected} new/changed photo(s), emitted ${emitted}, ${skippedUnchanged} unchanged`);
}

async function label(clusterIdArg, name) {
  requireApiKey();
  const clusterId = Number(clusterIdArg);
  if (!Number.isInteger(clusterId) || !name) {
    console.error('photo-exif: usage: face-worker.js label <clusterId> "<name>"');
    process.exit(1);
  }
  const clustersState = loadClusters();
  const cluster = clustersState.clusters.find((c) => c.id === clusterId);
  if (!cluster) {
    console.error(`photo-exif: no cluster with id ${clusterId} (run scan first, or export-thumbnails to browse)`);
    process.exit(1);
  }
  cluster.label = name;
  clustersState.version += 1;
  saveClusters(clustersState);

  const { postIngest } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const faceState = readJson(FACE_STATE_PATH, {});
  const captionCache = readCaptionCache(CAPTION_STATE_PATH);
  const clustersById = new Map(clustersState.clusters.map((c) => [c.id, c]));

  let reingested = 0;
  for (const [relPath, entry] of Object.entries(faceState)) {
    if (!entry.clusters.includes(clusterId)) continue;
    const payload = buildPayload(relPath, entry, clustersById, captionCache);
    const sig = payloadSignature(payload);
    if (entry.ingestedSig === sig) continue;
    try {
      await postIngest(payload);
      entry.ingestedSig = sig;
      writeJson(FACE_STATE_PATH, faceState); // kill-safe after each
      reingested++;
    } catch (err) {
      console.error(`photo-exif: re-ingest failed for ${relPath}, will retry on next scan`, err);
    }
  }
  console.error(`photo-exif: labeled cluster ${clusterId} "${name}", re-emitted ${reingested} photo(s)`);
}

// #84 — suggest names for unlabeled clusters using each contact's own preserved photo (#74) as a
// reference face. NEVER writes cluster.label and NEVER emits a hint — only prints candidate
// matches; a human still confirms via the existing `label <id> "<name>"` command. Requires this
// connector's process to be able to read the raw_path core returns (same filesystem/shared
// volume as core — see README); an unreadable/undetectable reference photo is skipped, not
// fatal to the run.
const CONTACT_PHOTOS_FETCH_LIMIT = 500; // matches the server's own GET /api/v1/entities/photos max

async function suggestLabels() {
  requireApiKey();
  const clustersState = loadClusters();
  const unlabeled = clustersState.clusters.filter((c) => !c.label);
  if (unlabeled.length === 0) {
    console.error('photo-exif: suggest-labels — no unlabeled clusters; nothing to suggest');
    return;
  }

  const detectFaces = await loadDetectorOrExit();

  let contacts;
  try {
    contacts = await fetchContactPhotos({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY, limit: CONTACT_PHOTOS_FETCH_LIMIT });
  } catch (err) {
    console.error('photo-exif: suggest-labels — could not fetch contact photos from LifeContext', err);
    process.exit(1);
  }
  if (contacts.length === CONTACT_PHOTOS_FETCH_LIMIT) {
    console.error(`photo-exif: suggest-labels — hit the ${CONTACT_PHOTOS_FETCH_LIMIT}-contact fetch limit; some contacts may not have been checked`);
  }

  const suggestedClusterIds = new Set(); // unique clusters, not contact×cluster match count
  let skipped = 0;
  for (const contact of contacts) {
    let faces;
    try {
      // Second arg is the fixture detector's lookup key (see lib/face-detect.js); the real
      // detector uses only the first arg (the actual file path) and ignores the second.
      faces = await detectFaces(contact.raw_path, contact.raw_path);
    } catch (err) {
      console.error(`photo-exif: suggest-labels — skipping "${contact.name}" (entity #${contact.entity_id}): reference photo unreadable/undetectable`, err);
      skipped++;
      continue;
    }
    if (faces.length !== 1) {
      console.error(`photo-exif: suggest-labels — skipping "${contact.name}" (entity #${contact.entity_id}): detected ${faces.length} faces, expected exactly 1`);
      skipped++;
      continue;
    }
    const [{ descriptor }] = faces;
    for (const cluster of unlabeled) {
      const dist = euclideanDistance(descriptor, cluster.centroid);
      if (dist <= FACE_SEED_THRESHOLD) {
        console.error(
          `photo-exif: suggest — cluster ${cluster.id} (${cluster.count} photo(s)) possibly "${contact.name}" ` +
          `(entity #${contact.entity_id}, distance ${dist.toFixed(2)} <= threshold ${FACE_SEED_THRESHOLD})`
        );
        suggestedClusterIds.add(cluster.id);
      }
    }
  }
  // A run where every contact was skipped must not read the same as "checked N, found nothing" —
  // that's indistinguishable from a healthy zero-match run otherwise (e.g. a CONTACTS_RAW_DIR /
  // shared-filesystem misconfiguration would silently look like "nothing to suggest").
  if (contacts.length > 0 && skipped === contacts.length) {
    console.error(`photo-exif: suggest-labels — all ${skipped} contact photo(s) were unreadable/undetectable; check the same-filesystem setup (see README)`);
  }
  console.error(`photo-exif: suggest-labels — checked ${contacts.length} contact photo(s) (${skipped} skipped), ${suggestedClusterIds.size} cluster(s) suggested`);
}

// Write one representative SAMPLE image per cluster (whole image, not a tight face crop — a crop
// would pull in the native image stack, and per-face boxes aren't persisted today, only
// centroid/count/label/sample) plus index.json, so a human can eyeball who each anonymous cluster
// is before labeling.
function exportThumbnails(outDir) {
  if (!outDir) {
    console.error('photo-exif: usage: face-worker.js export-thumbnails <dir>');
    process.exit(1);
  }
  if (!PHOTO_ROOT || !existsSync(PHOTO_ROOT)) {
    console.error(`photo-exif: PHOTO_ROOT not set or doesn't exist: ${PHOTO_ROOT}`);
    process.exit(1);
  }
  const clustersState = loadClusters();
  mkdirSync(outDir, { recursive: true });
  const index = {};
  let written = 0;
  for (const c of clustersState.clusters) {
    index[c.id] = { label: c.label ?? null, count: c.count, sample: c.sample ?? null };
    if (!c.sample) continue;
    const src = path.join(PHOTO_ROOT, c.sample);
    try {
      copyFileSync(src, path.join(outDir, `${c.id}${path.extname(c.sample) || '.jpg'}`));
      written++;
    } catch (err) {
      console.error(`photo-exif: could not copy sample for cluster ${c.id} (${src})`, err);
    }
  }
  writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.error(`photo-exif: exported ${written} cluster sample(s) + index.json to ${outDir}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'scan') return scan();
  if (cmd === 'label') return label(rest[0], rest[1]);
  if (cmd === 'export-thumbnails') return exportThumbnails(rest[0]);
  if (cmd === 'suggest-labels') return suggestLabels();
  console.error(`photo-exif: unknown command "${cmd}" (expected: scan | label | export-thumbnails | suggest-labels)`);
  process.exit(1);
}

main()
  .then(() => process.exit(0)) // fetch keep-alive sockets would otherwise hold the process open
  .catch((err) => {
    console.error('photo-exif: face worker failed', err);
    process.exit(1);
  });
