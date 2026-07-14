// Shared by scan.js and caption-worker.js so both build the exact same base description —
// drift here would mean the caption worker's "enriched" upsert contradicts the scanner's
// original text instead of extending it.
//
// This connector submits raw GPS only — it never resolves a place name itself. LifeContext
// core reverse-geocodes latitude/longitude into place_label server-side (issue #67), so this
// connector doesn't need its own bundled place dataset (and neither does any other connector
// that has GPS but no code of its own for describing where it is).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';

// Resolve the Google Takeout sidecar path for a media file by trying its known names (cheap
// existsSync probes only — never a directory scan, so scanning a plain non-Takeout PHOTO_ROOT
// stays O(1) per image). Naming observed across a real export:
//   "<file>.supplemental-metadata.json"          (the common case)
//   "<stem><ext>.supplemental-metadata(N).json"  (for a duplicate media "<stem>(N)<ext>")
//   "<file>.json"                                (older exports)
// Google's length-truncated names (rare; absent from the sample export) are not matched — that's a
// documented best-effort limitation, not worth an O(dir) scan per image. Returns abs path or null.
function sidecarPathFor(absPath) {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  const candidates = [`${base}.supplemental-metadata.json`, `${base}.json`];
  const dup = base.match(/^(.*)\((\d+)\)(\.[^.]+)$/); // IMG_0503(1).HEIC -> IMG_0503.HEIC.supplemental-metadata(1).json
  if (dup) candidates.push(`${dup[1]}${dup[3]}.supplemental-metadata(${dup[2]}).json`);
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (existsSync(p)) return p;
  }
  return null;
}

// Best-effort Google Takeout sidecar enrichment (#152). Returns { names, takenTime, latitude,
// longitude } or null when no sidecar is found. The connector submits names as entity_hints only —
// it never resolves entities itself (doc 04 §4). geoData {0,0} is Google's "no location" sentinel
// (~60% of a real export) and yields null coords, never a false (0,0). photoTakenTime is a unix-
// seconds string (UTC, zone-unambiguous). Any read/parse failure returns null — never throws.
export function readSidecar(absPath) {
  const file = sidecarPathFor(absPath);
  if (!file) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`photo-exif: unreadable sidecar ${path.basename(file)}`, err.message);
    return null;
  }
  const names = Array.isArray(data.people)
    ? data.people.map((p) => (typeof p?.name === 'string' ? p.name.trim() : '')).filter(Boolean)
    : [];
  const ts = Number(data.photoTakenTime?.timestamp);
  const takenTime = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null;
  const g = data.geoData ?? {};
  const hasGeo = typeof g.latitude === 'number' && typeof g.longitude === 'number'
    && !(g.latitude === 0 && g.longitude === 0);
  return { names, takenTime, latitude: hasGeo ? g.latitude : null, longitude: hasGeo ? g.longitude : null };
}

export async function describePhoto(absPath) {
  // exifr resolves to undefined (not an error) when the file has no EXIF/GPS at all.
  const parsed = await exifr.parse(absPath, { pick: ['DateTimeOriginal'] }).catch(() => undefined);
  const gps = await exifr.gps(absPath).catch(() => undefined);
  const date = parsed?.DateTimeOriginal instanceof Date ? parsed.DateTimeOriginal : null;
  const dateStr = date ? date.toISOString().slice(0, 10) : null;
  return {
    date,
    dateStr,
    latitude: gps?.latitude ?? null,
    longitude: gps?.longitude ?? null,
  };
}

export function buildTextRepr(dateStr, filename) {
  if (dateStr) return `Photo taken ${dateStr}`;
  return `Photo: ${filename}`;
}
