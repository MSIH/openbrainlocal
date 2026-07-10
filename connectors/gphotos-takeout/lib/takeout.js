// Reads a Google Takeout "Google Photos" export tree: pairs each media file with its JSON
// sidecar, classifies its containing folder (year bucket vs. named album), and extracts the
// only fields core needs — when it was taken and where. Takeout duplicates a photo into its
// year bucket AND every album it belongs to; index.js dedups those copies by content_hash, so
// this module's job is per-file description + album membership, not dedup.
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.gif', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.3gp']);

// Google's year buckets ("Photos from 2019"), NOT user albums. English default only — a
// non-English Takeout names these differently; documented as a known limitation (README).
const YEAR_BUCKET_RE = /^Photos from \d{4}$/;

export function isMediaFile(name) {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

// The core artifact type for a media file — both 'photo' and 'video' are registered types
// (src/ingest-types.js). A Takeout export mixes both; a video must not be stored as a photo.
export function mediaType(name) {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()) ? 'video' : 'photo';
}

// A sidecar is any *.json that isn't the album's own metadata.json.
function isSidecarJson(name) {
  return name.toLowerCase().endsWith('.json') && name.toLowerCase() !== 'metadata.json';
}

// Takeout's sidecar naming is notoriously inconsistent across export vintages. For media
// `IMG_1234.jpg` the sidecar may be any of: `IMG_1234.jpg.json` (classic),
// `IMG_1234.jpg.supplemental-metadata.json` (2023+), the duplicate-counter shift
// `IMG_1234.jpg(1).json` for a `IMG_1234(1).jpg` media file, or a name Google truncated to fit
// its filename length cap. Try the precise forms first, then fall back to a prefix match.
export function findSidecar(mediaName, jsonNames) {
  const set = jsonNames instanceof Set ? jsonNames : new Set(jsonNames);
  const direct = [
    `${mediaName}.json`,
    `${mediaName}.supplemental-metadata.json`,
    `${mediaName}.supplemental-meta.json`,
  ];
  for (const c of direct) if (set.has(c)) return c;

  // Duplicate-counter shift: media `base(1).ext` → sidecar `base.ext(1).json`.
  const dup = /^(.*)(\(\d+\))(\.[^.]+)$/.exec(mediaName);
  if (dup) {
    const [, base, counter, ext] = dup;
    for (const c of [`${base}${ext}${counter}.json`, `${base}${ext}${counter}.supplemental-metadata.json`]) {
      if (set.has(c)) return c;
    }
  }

  // Truncation fallback: a sidecar whose stripped stem is a prefix of the media filename.
  // Length floor avoids matching an unrelated short-named sidecar in the same folder.
  for (const j of set) {
    const stripped = j.replace(/\.supplemental-meta(data)?\.json$/i, '').replace(/\.json$/i, '');
    if (stripped.length >= 6 && mediaName.startsWith(stripped)) return j;
  }
  return null;
}

// Extract occurred_at (ISO) + geo from a parsed sidecar. photoTakenTime is when the shutter
// fired; creationTime is upload time and is deliberately NOT used as a fallback — a wrong
// occurred_at silently mis-sorts the timeline, worse than a missing one (doc 04 §3/§4).
// Takeout writes (0,0) for "no location"; treat that as absent, not the Gulf of Guinea.
export function parseSidecar(sidecar) {
  const out = { occurredAt: null, latitude: null, longitude: null, description: null };
  const takenTs = sidecar?.photoTakenTime?.timestamp;
  if (takenTs != null && `${takenTs}`.match(/^\d+$/)) {
    out.occurredAt = new Date(Number(takenTs) * 1000).toISOString();
  }
  const geo = pickGeo(sidecar?.geoData) ?? pickGeo(sidecar?.geoDataExif);
  if (geo) {
    out.latitude = geo.latitude;
    out.longitude = geo.longitude;
  }
  const desc = (sidecar?.description ?? '').trim();
  if (desc) out.description = desc;
  return out;
}

function pickGeo(geo) {
  const lat = geo?.latitude;
  const lon = geo?.longitude;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (lat === 0 && lon === 0) return null; // Takeout's "unknown location" sentinel
  return { latitude: lat, longitude: lon };
}

// Walk the export tree once, directory by directory (so each folder's JSON set is known when we
// match its media files). Yields one record per media file with its resolved sidecar + album.
// `root` should point at the "Google Photos" directory; if the caller points one level up at
// the Takeout root, descend into the "Google Photos" child automatically.
export async function* walkTakeout(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const gphotosChild = entries.find((e) => e.isDirectory() && e.name === 'Google Photos');
  const start = gphotosChild ? path.join(root, 'Google Photos') : root;
  yield* walkDir(start, start);
}

async function* walkDir(dir, gphotosRoot) {
  const entries = await readdir(dir, { withFileTypes: true });
  const jsonNames = new Set(entries.filter((e) => e.isFile() && isSidecarJson(e.name)).map((e) => e.name));
  const albumMeta = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'metadata.json');
  const album = albumForDir(dir, gphotosRoot);

  for (const entry of entries) {
    if (entry.isDirectory()) {
      yield* walkDir(path.join(dir, entry.name), gphotosRoot);
    } else if (entry.isFile() && isMediaFile(entry.name)) {
      const absPath = path.join(dir, entry.name);
      const sidecarName = findSidecar(entry.name, jsonNames);
      yield {
        absPath,
        fileName: entry.name,
        album, // null for year buckets / the gphotos root itself
        sidecarPath: sidecarName ? path.join(dir, sidecarName) : null,
        albumMetaPath: albumMeta ? path.join(dir, albumMeta.name) : null,
      };
    }
  }
}

// The album title a media file's folder represents, or null when the folder is a year bucket
// (or the gphotos root). Caller resolves the real title from metadata.json when present; the
// folder name is the fallback.
function albumForDir(dir, gphotosRoot) {
  if (path.resolve(dir) === path.resolve(gphotosRoot)) return null;
  const name = path.basename(dir);
  if (YEAR_BUCKET_RE.test(name)) return null;
  return name;
}
