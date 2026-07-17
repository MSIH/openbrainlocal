// Synthesizes JPEGs with injected EXIF (piexifjs — no real photo library needed) and runs
// scan.js / caption-worker.js against them with mock ingest/VLM servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import piexif from 'piexifjs';
import { euclideanDistance, assignCluster, parseClustersFile, serializeClustersFile } from './lib/face-cluster.js';
import { readCaptionCache, writeCaptionCache, currentTextRepr } from './lib/caption-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs Node 20.11+; this connector declares >=18

// source_id is now the content hash (keyForMedia): generic photos → source='photo-exif',
// source_id=<sha256>; Google-origin (the scan ROOT is a Takeout export — isTakeoutRoot, #176, NOT
// per-file sidecar) → source='google-photos', source_id='gphotos:<sha256>'. Tests force/expect
// Takeout via a marker (a "Photos from <YYYY>" dir / a "Google Photos" root) or PHOTO_TAKEOUT.
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => sha256(readFileSync(p));

// A minimal valid 1x1 JPEG (no EXIF) — piexifjs inserts EXIF into a real JPEG rather than
// building one from scratch.
const BASE_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

function jpegWithExif({ dateTimeOriginal, lat, lon } = {}) {
  const binaryStr = Buffer.from(BASE_JPEG_BASE64, 'base64').toString('binary');
  const exifObj = { '0th': {}, Exif: {}, GPS: {} };
  if (dateTimeOriginal) exifObj.Exif[piexif.ExifIFD.DateTimeOriginal] = dateTimeOriginal;
  if (lat != null && lon != null) {
    exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
    exifObj.GPS[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lat));
    exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = lon >= 0 ? 'E' : 'W';
    exifObj.GPS[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lon));
  }
  const exifBytes = piexif.dump(exifObj);
  return Buffer.from(piexif.insert(exifBytes, binaryStr), 'binary');
}

function startMockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, body: parsed });
      handler(req, parsed, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

// Mock the connector-facing REST surface (#198): /api/v1/exists → { exists } and
// /api/v1/ingest/batch → per-item created results. `exists(sourceIds)` lets a test declare which
// ids core already has (default: none stored → every file is new, i.e. pre-#198 behavior). Pass
// `existsStatus: 404` to simulate an older core with no /exists route (graceful-degrade path).
function ingestMock({ exists = () => [], existsStatus = 200 } = {}) {
  return (req, body, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/exists') {
      if (existsStatus !== 200) { res.statusCode = existsStatus; res.end(JSON.stringify({ error: 'not found' })); return; }
      res.end(JSON.stringify({ exists: exists(body.source_ids) }));
      return;
    }
    res.end(JSON.stringify({
      summary: {},
      results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
    }));
  };
}

// The single /api/v1/ingest/batch request (scan.js also calls /api/v1/exists first, #198).
const batchReq = (requests) => requests.find((r) => r.url === '/api/v1/ingest/batch');
const batchReqs = (requests) => requests.filter((r) => r.url === '/api/v1/ingest/batch');

function run(script, env, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('scan.js: EXIF + GPS photo, GPS-only photo, no-metadata photo, unchanged-file skip', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-test-'));
  writeFileSync(path.join(tmp, 'with-both.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00', lat: 30.2672, lon: -97.7431 }));
  writeFileSync(path.join(tmp, 'gps-only.jpg'), jpegWithExif({ lat: 51.5074, lon: -0.1278 }));
  writeFileSync(path.join(tmp, 'no-metadata.jpg'), Buffer.from(BASE_JPEG_BASE64, 'base64'));

  const { server, port, requests } = await startMockServer(ingestMock());

  const manifestPath = path.join(tmp, 'manifest.json');
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_MANIFEST_PATH: manifestPath,
    TZ: 'UTC', // pin so the EXIF-local DateTimeOriginal → UTC assertion is deterministic (matches the sidecar test)
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(batchReqs(requests).length, 1);
  const artifacts = batchReq(requests).body.artifacts;
  assert.equal(artifacts.length, 3);

  const both = artifacts.find((a) => a.raw_path.endsWith('with-both.jpg'));
  assert.equal(both.type, 'photo');
  assert.equal(both.source, 'photo-exif'); // no sidecar -> generic keying
  assert.equal(both.source_id, both.content_hash); // generic source_id IS the bare content hash
  assert.match(both.source_id, /^[0-9a-f]{64}$/);
  assert.equal(both.text_repr, 'Photo taken 2019-03-04');
  assert.equal(both.occurred_at, '2019-03-04T14:30:00.000Z');
  assert.equal(both.latitude, 30.2672);
  assert.equal(both.place_label, undefined); // this connector never resolves place_label; core does (issue #67)
  assert.match(both.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(both.extra.captioned, false);
  assert.equal(both.entity_hints, undefined); // in PHOTO_ROOT (no subfolder) -> no folder hint

  const gpsOnly = artifacts.find((a) => a.raw_path.endsWith('gps-only.jpg'));
  assert.equal(gpsOnly.text_repr, 'Photo: gps-only.jpg'); // no date, and no place phrase (GPS alone no longer produces one)
  assert.equal(gpsOnly.occurred_at, undefined); // no date -> omitted, never guessed from mtime

  const noMeta = artifacts.find((a) => a.raw_path.endsWith('no-metadata.jpg'));
  assert.equal(noMeta.text_repr, 'Photo: no-metadata.jpg');
  assert.equal(noMeta.latitude, undefined);

  // Re-run with the same (populated) manifest: nothing changed on disk, so nothing re-sent.
  requests.length = 0;
  const { server: server2, port: port2, requests: requests2 } = await startMockServer((req, body, res) => {
    res.end(JSON.stringify({ summary: {}, results: [] }));
  });
  const rerun = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port2}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_MANIFEST_PATH: manifestPath,
  });
  server2.closeAllConnections();
  server2.close();
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(requests2.length, 0, 'unchanged files are skipped on re-scan');
});

test('scan.js: Google Takeout sidecar → pictured hints + takenTime/geo fallback (#152)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-takeout-'));
  const sidecar = (mediaName, body) => writeFileSync(path.join(tmp, `${mediaName}.supplemental-metadata.json`), JSON.stringify(body));
  // Distinct trailing bytes per file so each is a distinct content hash (a valid JPEG with junk
  // after EOI; exifr reads from the start and still sees no EXIF). Identical bytes would collapse
  // under content-hash keying — that's exercised deliberately in the dedup test, not here.
  const noExif = (salt) => Buffer.concat([Buffer.from(BASE_JPEG_BASE64, 'base64'), Buffer.from(`\n${salt}`, 'utf8')]);
  const TAKEN = 1764458538; // unix seconds — UTC, zone-unambiguous
  const takenISO = new Date(TAKEN * 1000).toISOString();

  // (a) no EXIF + full sidecar: people → hints, takenTime → occurred_at, real geo → coords
  writeFileSync(path.join(tmp, 'sidecar-full.jpg'), noExif('sidecar-full'));
  sidecar('sidecar-full.jpg', { people: [{ name: 'April Delugach Paine' }, { name: 'Matt Paine' }, { name: 'Amy Schneider' }], photoTakenTime: { timestamp: String(TAKEN) }, geoData: { latitude: 38.8981222, longitude: -77.0334917 } });

  // (b) EXIF present: EXIF date/gps WIN over the sidecar, but people still become hints
  writeFileSync(path.join(tmp, 'exif-wins.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00', lat: 30.2672, lon: -97.7431 }));
  sidecar('exif-wins.jpg', { people: [{ name: 'Amy Schneider' }], photoTakenTime: { timestamp: String(TAKEN) }, geoData: { latitude: 10, longitude: 20 } });

  // (c) geoData {0,0} is Google's "no location" sentinel → no coords (but date + hints still set)
  writeFileSync(path.join(tmp, 'zero-geo.jpg'), noExif('zero-geo'));
  sidecar('zero-geo.jpg', { people: [{ name: 'Amy Schneider' }], photoTakenTime: { timestamp: String(TAKEN) }, geoData: { latitude: 0, longitude: 0 } });

  // (d) duplicate-media naming: sidecar is "<stem><ext>.supplemental-metadata(N).json"
  writeFileSync(path.join(tmp, 'dup(1).jpg'), noExif('dup'));
  writeFileSync(path.join(tmp, 'dup.jpg.supplemental-metadata(1).json'), JSON.stringify({ people: [{ name: '  Matt Paine  ' }], photoTakenTime: { timestamp: String(TAKEN) } })); // padded name → asserted trimmed below

  // (e) no sidecar and (f) malformed sidecar → EXIF-only, must not throw/abort the scan
  writeFileSync(path.join(tmp, 'no-sidecar.jpg'), noExif('no-sidecar'));
  writeFileSync(path.join(tmp, 'bad-sidecar.jpg'), noExif('bad-sidecar'));
  writeFileSync(path.join(tmp, 'bad-sidecar.jpg.supplemental-metadata.json'), '{ not valid json');

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'), TZ: 'UTC',
    PHOTO_TAKEOUT: 'true', // this temp root has no marker → force Takeout so keying is google-photos
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const arts = batchReq(requests).body.artifacts;
  const by = (name) => arts.find((a) => a.raw_path.endsWith(name));

  const full = by('sidecar-full.jpg');
  assert.equal(full.source, 'google-photos', 'a file in a Takeout tree is Google-origin');
  assert.match(full.source_id, /^gphotos:[0-9a-f]{64}$/, 'Google-origin source_id is gphotos:<hash>');
  assert.equal(full.source_id, `gphotos:${full.content_hash}`);
  assert.deepEqual(full.entity_hints, [
    { alias: 'April Delugach Paine', alias_type: 'name', role: 'pictured', confidence: 0.9 },
    { alias: 'Matt Paine', alias_type: 'name', role: 'pictured', confidence: 0.9 },
    { alias: 'Amy Schneider', alias_type: 'name', role: 'pictured', confidence: 0.9 },
  ]);
  assert.equal(full.occurred_at, takenISO, 'sidecar photoTakenTime fills occurred_at when EXIF has none');
  assert.equal(full.latitude, 38.8981222);
  assert.equal(full.longitude, -77.0334917);

  const exif = by('exif-wins.jpg');
  assert.equal(exif.source, 'google-photos'); // sidecar present -> Google-origin even though EXIF wins for date/gps
  assert.equal(exif.occurred_at, '2019-03-04T14:30:00.000Z', 'EXIF date wins over the sidecar');
  assert.equal(exif.latitude, 30.2672, 'EXIF GPS wins over the sidecar');
  assert.deepEqual(exif.entity_hints, [{ alias: 'Amy Schneider', alias_type: 'name', role: 'pictured', confidence: 0.9 }]);

  const zero = by('zero-geo.jpg');
  assert.equal(zero.occurred_at, takenISO);
  assert.equal(zero.latitude, undefined, 'geoData {0,0} is not submitted as a coordinate');
  assert.equal(zero.longitude, undefined);

  assert.deepEqual(by('dup(1).jpg').entity_hints, [{ alias: 'Matt Paine', alias_type: 'name', role: 'pictured', confidence: 0.9 }], 'duplicate-named sidecar is resolved');

  assert.equal(by('no-sidecar.jpg').entity_hints, undefined, 'no sidecar → no hints');
  assert.equal(by('no-sidecar.jpg').occurred_at, undefined);
  // #176: in a Takeout tree, a sidecar-less file is STILL google-photos (tree-level, not per-file).
  assert.equal(by('no-sidecar.jpg').source, 'google-photos', 'no sidecar but Takeout tree → google-photos');
  assert.match(by('no-sidecar.jpg').source_id, /^gphotos:[0-9a-f]{64}$/);
  assert.equal(by('bad-sidecar.jpg').entity_hints, undefined, 'malformed sidecar → EXIF-only, no crash');
  assert.equal(by('bad-sidecar.jpg').source, 'google-photos');
});

test('scan.js: same filename, different content in different subdirectories gets distinct source_ids', async () => {
  // source_id is the content hash now: two photos with the same filename but DIFFERENT bytes
  // (different EXIF here) must key distinctly and stay two artifacts. (The inverse — identical
  // bytes collapsing to one — is the dedup test below.)
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-nested-test-'));
  mkdirSync(path.join(tmp, '2019', 'trip'), { recursive: true });
  mkdirSync(path.join(tmp, '2020', 'trip'), { recursive: true });
  writeFileSync(path.join(tmp, '2019', 'trip', 'IMG_1234.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  writeFileSync(path.join(tmp, '2020', 'trip', 'IMG_1234.jpg'), jpegWithExif({ dateTimeOriginal: '2020:03:04 14:30:00' }));

  const { server, port, requests } = await startMockServer(ingestMock());

  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);

  const artifacts = batchReq(requests).body.artifacts;
  assert.equal(artifacts.length, 2, 'two distinct photos, not one collapsed into the other');
  const ids = artifacts.map((a) => a.source_id);
  assert.notEqual(ids[0], ids[1], 'different bytes -> different content-hash source_ids');
  for (const a of artifacts) {
    assert.equal(a.source, 'photo-exif'); // no sidecar -> generic
    assert.match(a.source_id, /^[0-9a-f]{64}$/);
    assert.equal(a.source_id, a.content_hash);
  }
});

test('scan.js: a video ingests as type=video, a still as type=photo', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-video-'));
  writeFileSync(path.join(tmp, 'clip.mp4'), Buffer.from('fake-mp4-bytes'));
  writeFileSync(path.join(tmp, 'oldclip.3gpp'), Buffer.from('fake-3gpp-bytes'));
  writeFileSync(path.join(tmp, 'still.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const arts = batchReq(requests).body.artifacts;
  assert.equal(arts.length, 3, 'both videos and the still are walked (walkMediaFiles)');
  const video = arts.find((a) => a.raw_path.endsWith('clip.mp4'));
  assert.equal(video.type, 'video');
  assert.match(video.text_repr, /^Video[: ]/, "a video's text_repr says Video, not Photo");
  const gpp = arts.find((a) => a.raw_path.endsWith('oldclip.3gpp'));
  assert.equal(gpp.type, 'video', '.3gpp is recognized as a video, not skipped');
  assert.equal(arts.find((a) => a.raw_path.endsWith('still.jpg')).type, 'photo');
});

test('scan.js: byte-identical copies in different folders collapse to one payload with unioned pictured hints', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-dedup-'));
  // The SAME photo (identical bytes) sits in two person-named album folders, each with its own
  // sidecar naming a different person — Takeout's per-album duplication. Both have a sidecar →
  // Google-origin → the same content-hash source_id → they must collapse into ONE artifact.
  const bytes = Buffer.from('one-identical-photo');
  mkdirSync(path.join(tmp, 'Alice Album'));
  mkdirSync(path.join(tmp, 'Bob Album'));
  writeFileSync(path.join(tmp, 'Alice Album', 'photo.jpg'), bytes);
  writeFileSync(path.join(tmp, 'Alice Album', 'photo.jpg.supplemental-metadata.json'), JSON.stringify({ people: [{ name: 'Alice' }] }));
  writeFileSync(path.join(tmp, 'Bob Album', 'photo.jpg'), bytes);
  writeFileSync(path.join(tmp, 'Bob Album', 'photo.jpg.supplemental-metadata.json'), JSON.stringify({ people: [{ name: 'Bob' }] }));

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
    PHOTO_TAKEOUT: 'true', // album folders, no root marker → force Takeout for google-photos keying
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const arts = batchReq(requests).body.artifacts;
  assert.equal(arts.length, 1, 'two byte-identical copies collapse to one payload');
  const [art] = arts;
  assert.equal(art.source, 'google-photos');
  assert.equal(art.source_id, `gphotos:${art.content_hash}`);
  // Union of both sidecars' people AND both folder-name hints, deduped by alias|role.
  const aliases = art.entity_hints.map((h) => h.alias).sort();
  assert.deepEqual(aliases, ['Alice', 'Alice Album', 'Bob', 'Bob Album']);
  for (const h of art.entity_hints) {
    assert.equal(h.alias_type, 'name');
    assert.equal(h.role, 'pictured');
    assert.equal(h.confidence, 0.9);
  }
});

test('scan.js: folder-name pictured hint — subfolder yes, root none, year bucket none', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-folderhint-'));
  writeFileSync(path.join(tmp, 'root.jpg'), Buffer.from('img-root')); // directly in PHOTO_ROOT
  mkdirSync(path.join(tmp, 'Aunt Mary'));
  writeFileSync(path.join(tmp, 'Aunt Mary', 'm.jpg'), Buffer.from('img-aunt'));
  mkdirSync(path.join(tmp, 'Photos from 2019'));
  writeFileSync(path.join(tmp, 'Photos from 2019', 'y.jpg'), Buffer.from('img-year'));

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const arts = batchReq(requests).body.artifacts;
  const by = (name) => arts.find((a) => a.raw_path.endsWith(name));
  assert.equal(by('root.jpg').entity_hints, undefined, 'a file directly in PHOTO_ROOT emits no folder hint');
  assert.deepEqual(by('m.jpg').entity_hints, [{ alias: 'Aunt Mary', alias_type: 'name', role: 'pictured', confidence: 0.9 }], 'a person-named subfolder becomes a pictured hint');
  assert.equal(by('y.jpg').entity_hints, undefined, 'a Takeout year bucket is never a person');
});

test('scan.js: Takeout detected at tree level — a sidecar-less .mp4 keys google-photos (#176)', async () => {
  // The repro: a motion-photo/Live-Photo .MP4 has no sidecar of its own, but it IS a Takeout export
  // item. Per-file sidecar detection mis-keyed it generic and duplicated the google-photos row.
  // Detection is now tree-level: PHOTO_ROOT named "Google Photos" is auto-recognized (no override).
  const base = mkdtempSync(path.join(tmpdir(), 'photo-exif-takeoutroot-'));
  const tmp = path.join(base, 'Google Photos');
  mkdirSync(tmp);
  writeFileSync(path.join(tmp, 'IMG_7078.MP4'), Buffer.from('sidecar-less-motion-video-bytes')); // no sidecar

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(base, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const [art] = batchReq(requests).body.artifacts;
  assert.equal(art.type, 'video');
  assert.equal(art.source, 'google-photos', 'sidecar-less Takeout media keys google-photos, not generic');
  assert.equal(art.source_id, `gphotos:${art.content_hash}`);
});

test('scan.js: album-layout Takeout (child dirs with metadata.json, no year bucket) keys google-photos (#177)', async () => {
  // Copilot #177: the common layout where PHOTO_ROOT holds one folder per album, each with its own
  // metadata.json, and the root is NOT named "Google Photos" and has no "Photos from <YYYY>" bucket.
  // A sidecar-less .mp4 in such a tree must still key google-photos (auto-detected, no override).
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-albumlayout-'));
  mkdirSync(path.join(tmp, 'Adam Schneider'));
  writeFileSync(path.join(tmp, 'Adam Schneider', 'metadata.json'), JSON.stringify({ title: 'Adam Schneider' }));
  writeFileSync(path.join(tmp, 'Adam Schneider', 'IMG_9001.MP4'), Buffer.from('album-layout-sidecar-less-video')); // no sidecar

  const { server, port, requests } = await startMockServer(ingestMock());
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const mp4 = batchReq(requests).body.artifacts.find((a) => a.raw_path.endsWith('IMG_9001.MP4'));
  assert.equal(mp4.source, 'google-photos', 'album-layout Takeout detected via child metadata.json');
  assert.equal(mp4.source_id, `gphotos:${mp4.content_hash}`);
});

test('scan.js: PHOTO_TAKEOUT overrides detection both ways (#176)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-override-'));
  writeFileSync(path.join(tmp, 'x.jpg'), Buffer.from('override-bytes')); // no sidecar, no marker
  const runOnce = async (override) => {
    const { server, port, requests } = await startMockServer(ingestMock());
    const result = await run('scan.js', {
      LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
      PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, `manifest-${override}.json`),
      PHOTO_TAKEOUT: override,
    });
    server.closeAllConnections();
    server.close();
    assert.equal(result.status, 0, result.stderr);
    return batchReq(requests).body.artifacts[0];
  };
  assert.equal((await runOnce('true')).source, 'google-photos', 'PHOTO_TAKEOUT=true forces google-photos');
  assert.equal((await runOnce('false')).source, 'photo-exif', 'PHOTO_TAKEOUT=false forces generic');
});

test('scan.js: /exists skips already-stored files (no ingest) and a 404 falls back to full processing (#198)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-exists-'));
  // Two distinct files → two distinct content hashes → two distinct source_ids. No sidecar/marker,
  // so generic keying: source='photo-exif', source_id === the bare content hash.
  writeFileSync(path.join(tmp, 'stored.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  writeFileSync(path.join(tmp, 'new.jpg'), jpegWithExif({ dateTimeOriginal: '2020:03:04 14:30:00' }));
  const storedHash = sha256File(path.join(tmp, 'stored.jpg'));
  const newHash = sha256File(path.join(tmp, 'new.jpg'));

  // (1) /exists reports stored.jpg already present → only new.jpg is enriched + ingested.
  const manifestPath = path.join(tmp, 'manifest.json');
  const { server, port, requests } = await startMockServer(ingestMock({ exists: (ids) => ids.filter((id) => id === storedHash) }));
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: manifestPath, TZ: 'UTC',
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);

  const existsReq = requests.find((r) => r.url === '/api/v1/exists');
  assert.ok(existsReq, 'scan.js calls /api/v1/exists');
  assert.deepEqual([...existsReq.body.source_ids].sort(), [newHash, storedHash].sort(), 'both hashed source_ids are checked');
  const batch = batchReq(requests);
  assert.equal(batch.body.artifacts.length, 1, 'only the not-already-stored file is ingested');
  assert.equal(batch.body.artifacts[0].source_id, newHash);
  assert.match(result.stderr, /skip-check — 2 hashed, 1 already stored, 1 new/);

  // The already-stored file is still recorded in the manifest, so subsequent LOCAL runs skip it via
  // a cheap stat with no hash and no server round-trip.
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(Object.keys(manifest).length, 2, 'both files (stored + ingested) are manifest-recorded');

  // (2) 404 fallback: an older core with no /exists route → process everything, no crash. A fresh
  // manifest path forces both files to miss the local skip cache and be re-hashed + checked.
  const { server: s2, port: p2, requests: r2 } = await startMockServer(ingestMock({ existsStatus: 404 }));
  const result2 = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${p2}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest-404.json'), TZ: 'UTC',
  });
  s2.closeAllConnections();
  s2.close();
  assert.equal(result2.status, 0, result2.stderr);
  assert.match(result2.stderr, /\/api\/v1\/exists unavailable \(404\)/);
  assert.equal(batchReq(r2).body.artifacts.length, 2, '404 → all files processed (graceful fallback)');
});

test('caption-worker.js: enriches text_repr in place, preserves EXIF fields via upsert semantics, kill-safe state', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-caption-test-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00', lat: 30.2672, lon: -97.7431 }));

  const ingestRequests = [];
  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    ingestRequests.push(body);
    res.end(JSON.stringify({ id: 1, created: false, resolved_entities: 0, unresolved_aliases: 0 }));
  });

  const vlmRequests = [];
  const vlmServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      vlmRequests.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: 'two people cooking pasta in a kitchen' }));
    });
  });
  const vlmPort = await new Promise((resolve) => vlmServer.listen(0, '127.0.0.1', () => resolve(vlmServer.address().port)));

  const statePath = path.join(tmp, 'captions.json');
  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: statePath,
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
  });

  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(vlmRequests.length, 1);
  assert.ok(vlmRequests[0].images[0].length > 0, 'sent base64 image data');
  assert.equal(ingestRequests.length, 1);
  const payload = ingestRequests[0];
  // Same content-hash key scan.js would compute (no sidecar → generic), so the caption enriches
  // the SAME artifact rather than creating a new one.
  assert.equal(payload.source, 'photo-exif');
  assert.equal(payload.source_id, sha256File(path.join(tmp, 'photo.jpg')));
  assert.equal(payload.text_repr, 'Photo taken 2019-03-04 two people cooking pasta in a kitchen');
  assert.equal(payload.extra.captioned, true);
  // Upsert-only-what-changed: no occurred_at/latitude/place_label/raw_path/content_hash resent —
  // those were already stored by scan.js and must be left untouched (doc 04 §3 merge semantics).
  assert.equal(payload.occurred_at, undefined);
  assert.equal(payload.latitude, undefined);
  assert.equal(payload.place_label, undefined);

  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { 'photo.jpg': 'two people cooking pasta in a kitchen' });

  // Re-run: already captioned, VLM should not be called again.
  const rerun = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: statePath,
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
  });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(vlmRequests.length, 1, 'already-captioned photo is not re-sent to the VLM');
});

test('caption-worker.js: legacy array-format state entries are re-captioned to populate the text map', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-legacy-caption-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  const statePath = path.join(tmp, 'captions.json');
  writeFileSync(statePath, JSON.stringify(['photo.jpg'])); // legacy array -> loaded as { 'photo.jpg': null }

  const ingestRequests = [];
  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    ingestRequests.push(body);
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const vlmRequests = [];
  const vlmServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      vlmRequests.push(JSON.parse(body));
      res.end(JSON.stringify({ response: 'a dog on a beach' }));
    });
  });
  const vlmPort = await new Promise((resolve) => vlmServer.listen(0, '127.0.0.1', () => resolve(vlmServer.address().port)));

  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: statePath,
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
  });
  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(vlmRequests.length, 1, 'a legacy (text-less) entry is re-captioned, not skipped');
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { 'photo.jpg': 'a dog on a beach' }, 'map now holds the caption text');
});

test('caption-worker.js: VLM unreachable stops the run without marking anything captioned', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-caption-down-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  const statePath = path.join(tmp, 'captions.json');

  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: 'http://127.0.0.1:19999',
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: statePath,
    VLM_BASE_URL: 'http://127.0.0.1:19998', // nothing listening
    VLM_THROTTLE_MS: '0',
  });

  assert.equal(result.status, 0, result.stderr); // stops cleanly, not a crash
  assert.throws(() => readFileSync(statePath, 'utf8')); // nothing was captioned
});

// --- #53: face worker ------------------------------------------------------------------------

test('face-cluster: euclidean + nearest-centroid grouping and new-cluster creation', () => {
  assert.equal(euclideanDistance([0, 0, 0], [0, 0, 0]), 0);
  assert.ok(Math.abs(euclideanDistance([0, 0, 0], [3, 4, 0]) - 5) < 1e-9);

  const clusters = [];
  const a = assignCluster([0, 0, 0], clusters, 0.6);
  const b = assignCluster([0.05, 0, 0], clusters, 0.6); // within threshold -> same cluster
  const c = assignCluster([9, 9, 9], clusters, 0.6); // far -> new cluster
  assert.equal(a, b, 'nearby descriptors share a cluster');
  assert.notEqual(a, c, 'distant descriptor starts a new cluster');
  assert.equal(clusters.length, 2);
  assert.equal(clusters.find((x) => x.id === a).count, 2);

  // serialize round-trips version + clusters
  const round = parseClustersFile(serializeClustersFile(3, clusters));
  assert.equal(round.version, 3);
  assert.equal(round.clusters.length, 2);
  assert.deepEqual(parseClustersFile('not json'), { version: 0, clusters: [] });
});

test('caption-cache: legacy array read, map round-trip, currentTextRepr', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'caption-cache-'));
  const p = path.join(tmp, 'captions.json');

  writeFileSync(p, JSON.stringify(['2019/a.jpg', '2019/b.jpg'])); // legacy array
  assert.deepEqual(readCaptionCache(p), { '2019/a.jpg': null, '2019/b.jpg': null });

  writeCaptionCache(p, { 'x.jpg': 'a cat on a sofa' });
  assert.deepEqual(readCaptionCache(p), { 'x.jpg': 'a cat on a sofa' });
  assert.deepEqual(readCaptionCache(path.join(tmp, 'missing.json')), {}); // absent -> empty

  assert.equal(currentTextRepr('2019-03-04', 'a.jpg', null), 'Photo taken 2019-03-04');
  assert.equal(currentTextRepr('2019-03-04', 'a.jpg', 'a cat'), 'Photo taken 2019-03-04 a cat');
  assert.equal(currentTextRepr(null, 'a.jpg', null), 'Photo: a.jpg');
});

test('face-worker: scan clusters + records faces, label emits pictured hints preserving caption, re-scan is idempotent', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-worker-'));
  // Plain files — the fixture detector supplies descriptors; describePhoto tolerates non-EXIF.
  writeFileSync(path.join(tmp, 'a.jpg'), 'aaaa');
  writeFileSync(path.join(tmp, 'b.jpg'), 'bbbb');
  writeFileSync(path.join(tmp, 'c.jpg'), 'cccc');
  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    'a.jpg': [[0, 0, 0]],
    'b.jpg': [[0.05, 0, 0]], // same person as a
    'c.jpg': [[9, 9, 9]], // different person
  }));
  // Pre-seed a caption for a.jpg so we can prove the "Pictured" append keeps the caption text.
  const captionState = path.join(tmp, 'captions.json');
  writeFileSync(captionState, JSON.stringify({ 'a.jpg': 'a sunny beach' }));

  // source_id is the content hash now (no sidecars here → generic keying).
  const hashA = sha256(Buffer.from('aaaa'));
  const hashB = sha256(Buffer.from('bbbb'));

  const faceState = path.join(tmp, 'faces.json');
  const clustersState = path.join(tmp, 'clusters.json');
  const env = {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_STATE_PATH: faceState,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
    PHOTO_EXIF_CAPTION_STATE_PATH: captionState,
    FACE_THROTTLE_MS: '0',
    FACE_HINT_CONFIDENCE: '0.6',
  };

  // --- scan ---
  const scanReqs = [];
  const { server, port } = await startMockServer((req, body, res) => {
    scanReqs.push(body);
    res.end(JSON.stringify({ id: 1, created: false, resolved_entities: 0, unresolved_aliases: 0 }));
  });
  const scan = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` });
  server.closeAllConnections();
  server.close();
  assert.equal(scan.status, 0, scan.stderr);
  assert.equal(scanReqs.length, 3, 'one upsert per photo');
  for (const r of scanReqs) {
    assert.equal(r.type, 'photo');
    assert.equal(r.source, 'photo-exif'); // content-hash keying, no sidecar
    assert.match(r.source_id, /^[0-9a-f]{64}$/);
    assert.equal(typeof r.extra.faces_detected, 'number');
    assert.equal(r.entity_hints, undefined, 'no hints while every cluster is unlabeled');
    assert.equal(typeof r.text_repr, 'string', 'text_repr is required by the contract and always sent');
    assert.doesNotMatch(r.text_repr, /Pictured:/, 'no Pictured sentence while unlabeled');
  }
  // Caption preserved through the unlabeled scan (reconstructed from the cache, not clobbered).
  assert.equal(scanReqs.find((r) => r.source_id === hashA).text_repr, 'Photo: a.jpg a sunny beach');
  assert.equal(scanReqs.find((r) => r.source_id === hashB).text_repr, 'Photo: b.jpg');
  const clusters = parseClustersFile(readFileSync(clustersState, 'utf8')).clusters;
  assert.equal(clusters.length, 2, 'a+b cluster, c alone');
  const person = clusters.find((c) => c.count === 2); // the a+b cluster (id independent of walk order)
  assert.ok(person, 'the two same-person photos formed one cluster');
  assert.ok(existsSync(faceState), 'face state written (kill-safe)');

  // --- label the a+b cluster ---
  const labelReqs = [];
  const { server: s2, port: p2 } = await startMockServer((req, body, res) => {
    labelReqs.push(body);
    res.end(JSON.stringify({ id: 1, created: false, resolved_entities: 1, unresolved_aliases: 0 }));
  });
  const lab = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${p2}` }, ['label', String(person.id), 'Sarah Jones']);
  s2.closeAllConnections();
  s2.close();
  assert.equal(lab.status, 0, lab.stderr);
  assert.equal(labelReqs.length, 2, 'only the two photos in the labeled cluster are re-emitted');
  for (const r of labelReqs) {
    assert.deepEqual(r.entity_hints, [{ alias: 'Sarah Jones', alias_type: 'name', role: 'pictured', confidence: 0.6 }]);
    assert.match(r.text_repr, /Pictured: Sarah Jones\.$/);
    assert.deepEqual(r.extra.pictured, ['Sarah Jones']);
  }
  const aReq = labelReqs.find((r) => r.source_id === hashA);
  assert.equal(aReq.text_repr, 'Photo: a.jpg a sunny beach Pictured: Sarah Jones.', 'caption preserved, Pictured appended');

  // --- re-scan: nothing changed on disk or in labels -> no new upserts ---
  const reReqs = [];
  const { server: s3, port: p3 } = await startMockServer((req, body, res) => {
    reReqs.push(body);
    res.end(JSON.stringify({ id: 1, created: false }));
  });
  const rescan = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${p3}` });
  s3.closeAllConnections();
  s3.close();
  assert.equal(rescan.status, 0, rescan.stderr);
  assert.equal(reReqs.length, 0, 'idempotent: unchanged photos + labels re-emit nothing');
});

test('face-worker: export-thumbnails writes a sample per cluster + index.json', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-export-'));
  writeFileSync(path.join(tmp, 'a.jpg'), 'aaaa');
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 2, label: 'Sarah Jones', sample: 'a.jpg' },
    { id: 2, centroid: [9, 9, 9], count: 1, label: null, sample: 'a.jpg' },
  ]));
  const outDir = path.join(tmp, 'faces-out');
  const res = await run('face-worker.js', {
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
  }, ['export-thumbnails', outDir]);
  assert.equal(res.status, 0, res.stderr);
  const index = JSON.parse(readFileSync(path.join(outDir, 'index.json'), 'utf8'));
  assert.equal(index['1'].label, 'Sarah Jones');
  assert.equal(index['2'].label, null);
  assert.ok(existsSync(path.join(outDir, '1.jpg')), 'sample image copied per cluster');
});

test('face-worker: suggest-labels (#84) matches unlabeled clusters against contact reference photos, never writes labels', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-'));
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 2, label: null, sample: 'a.jpg' },                // unlabeled, near Sarah's reference
    { id: 2, centroid: [9, 9, 9], count: 1, label: null, sample: 'c.jpg' },                // unlabeled, far from every reference
    { id: 3, centroid: [0.01, 0, 0], count: 3, label: 'Already Named', sample: 'd.jpg' },  // labeled — must be excluded even though it's the closest match
  ]));

  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    '/fake/raw/sarah.jpg': [[0.02, 0, 0]],              // one face, close to cluster 1
    '/fake/raw/ambiguous.jpg': [[1, 1, 1], [2, 2, 2]],  // two faces -> ambiguous reference, skip
  }));

  const env = {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
    FACE_SEED_THRESHOLD: '0.6',
  };
  const beforeClusters = readFileSync(clustersState, 'utf8');

  const { server, port } = await startMockServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/v1/entities/photos')) {
      res.end(JSON.stringify({
        contacts: [
          { entity_id: 10, name: 'Sarah Jones', raw_path: '/fake/raw/sarah.jpg' },
          { entity_id: 11, name: 'Ambiguous Contact', raw_path: '/fake/raw/ambiguous.jpg' },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({})); // any other route (e.g. an accidental ingest) — never expected here
  });
  const res = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` }, ['suggest-labels']);
  server.closeAllConnections();
  server.close();

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /suggest — cluster 1 \(2 photo\(s\)\) possibly "Sarah Jones" \(entity #10/, 'cluster 1 is suggested as Sarah Jones');
  assert.equal(
    (res.stderr.match(/suggest — cluster/g) || []).length, 1,
    'exactly one suggestion — the far cluster and the already-labeled cluster (despite being the closest match) are not suggested'
  );
  assert.match(
    res.stderr, /skipping "Ambiguous Contact".*detected 2 faces, expected exactly 1/,
    'a multi-face reference photo is skipped, never treated as a match'
  );
  assert.equal(readFileSync(clustersState, 'utf8'), beforeClusters, 'suggest-labels never writes cluster.label — clusters file is byte-identical');
});

test('face-worker: suggest-labels exits early (no detector load, no network fetch) when every cluster is already labeled', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-early-exit-'));
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 2, label: 'Already Named', sample: 'a.jpg' },
  ]));
  // LIFECONTEXT_URL is deliberately unreachable, and no FACE_MODELS_PATH/fixture is set — if the
  // early exit didn't fire before loading a detector or fetching contacts, this would fail loudly.
  const res = await run('face-worker.js', {
    LIFECONTEXT_API_KEY: 'test-key',
    LIFECONTEXT_URL: 'http://127.0.0.1:1',
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
  }, ['suggest-labels']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /no unlabeled clusters/);
});

test('face-worker: suggest-labels warns distinctly when every contact photo was unreadable/undetectable', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-allskip-'));
  const clustersState = path.join(tmp, 'clusters.json');
  writeFileSync(clustersState, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 1, label: null, sample: 'a.jpg' },
  ]));
  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({})); // empty — every raw_path lookup misses -> 0 faces detected

  const env = {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
  };
  const { server, port } = await startMockServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ contacts: [{ entity_id: 20, name: 'Nobody Detected', raw_path: '/fake/raw/missing.jpg' }] }));
  });
  const res = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` }, ['suggest-labels']);
  server.closeAllConnections();
  server.close();

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /all 1 contact photo\(s\) were unreadable\/undetectable/, 'a total-skip run is distinguishable from a healthy zero-match run');
});

test('face-worker: suggest-labels summary counts unique clusters, not contact×cluster matches', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'face-suggest-unique-'));
  const clustersState = path.join(tmp, 'clusters.json');
  // One unlabeled cluster; TWO different contacts both happen to match it.
  writeFileSync(clustersState, serializeClustersFile(1, [
    { id: 1, centroid: [0, 0, 0], count: 2, label: null, sample: 'a.jpg' },
  ]));
  const fixturePath = path.join(tmp, 'faces-fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    '/fake/raw/one.jpg': [[0.01, 0, 0]],
    '/fake/raw/two.jpg': [[0.02, 0, 0]],
  }));

  const env = {
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_EXIF_FACE_FIXTURE: fixturePath,
    PHOTO_EXIF_FACE_CLUSTERS_PATH: clustersState,
    FACE_SEED_THRESHOLD: '0.6',
  };
  const { server, port } = await startMockServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      contacts: [
        { entity_id: 30, name: 'Contact One', raw_path: '/fake/raw/one.jpg' },
        { entity_id: 31, name: 'Contact Two', raw_path: '/fake/raw/two.jpg' },
      ],
    }));
  });
  const res = await run('face-worker.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` }, ['suggest-labels']);
  server.closeAllConnections();
  server.close();

  assert.equal(res.status, 0, res.stderr);
  assert.equal((res.stderr.match(/suggest — cluster/g) || []).length, 2, 'both contacts are printed as suggestions for the one cluster');
  assert.match(res.stderr, /checked 2 contact photo\(s\) \(0 skipped\), 1 cluster\(s\) suggested/, 'the summary counts the one unique cluster, not the two contact matches');
});
