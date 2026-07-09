// Shared by scan.js and caption-worker.js so both build the exact same base description —
// drift here would mean the caption worker's "enriched" upsert contradicts the scanner's
// original text instead of extending it.
//
// This connector submits raw GPS only — it never resolves a place name itself. LifeContext
// core reverse-geocodes latitude/longitude into place_label server-side (issue #67), so this
// connector doesn't need its own bundled place dataset (and neither does any other connector
// that has GPS but no code of its own for describing where it is).
import exifr from 'exifr';

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
