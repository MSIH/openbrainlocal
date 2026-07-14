// Synthesizes JPEGs with injected EXIF (piexifjs — no real photo library needed) and runs
// scan.js / caption-worker.js against them with mock ingest/VLM servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import piexif from 'piexifjs';
import { euclideanDistance, assignCluster, parseClustersFile, serializeClustersFile } from './lib/face-cluster.js';
import { readCaptionCache, writeCaptionCache, currentTextRepr } from './lib/caption-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs Node 20.11+; this connector declares >=18

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

  const { server, port, requests } = await startMockServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      summary: {},
      results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
    }));
  });

  const manifestPath = path.join(tmp, 'manifest.json');
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_MANIFEST_PATH: manifestPath,
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const artifacts = requests[0].body.artifacts;
  assert.equal(artifacts.length, 3);

  const both = artifacts.find((a) => a.source_id === 'with-both.jpg');
  assert.equal(both.type, 'photo');
  assert.equal(both.text_repr, 'Photo taken 2019-03-04');
  assert.equal(both.occurred_at, '2019-03-04T14:30:00.000Z');
  assert.equal(both.latitude, 30.2672);
  assert.equal(both.place_label, undefined); // this connector never resolves place_label; core does (issue #67)
  assert.match(both.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(both.extra.captioned, false);

  const gpsOnly = artifacts.find((a) => a.source_id === 'gps-only.jpg');
  assert.equal(gpsOnly.text_repr, 'Photo: gps-only.jpg'); // no date, and no place phrase (GPS alone no longer produces one)
  assert.equal(gpsOnly.occurred_at, undefined); // no date -> omitted, never guessed from mtime

  const noMeta = artifacts.find((a) => a.source_id === 'no-metadata.jpg');
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
  const noExif = () => Buffer.from(BASE_JPEG_BASE64, 'base64');
  const TAKEN = 1764458538; // unix seconds — UTC, zone-unambiguous
  const takenISO = new Date(TAKEN * 1000).toISOString();

  // (a) no EXIF + full sidecar: people → hints, takenTime → occurred_at, real geo → coords
  writeFileSync(path.join(tmp, 'sidecar-full.jpg'), noExif());
  sidecar('sidecar-full.jpg', { people: [{ name: 'April Delugach Paine' }, { name: 'Matt Paine' }, { name: 'Amy Schneider' }], photoTakenTime: { timestamp: String(TAKEN) }, geoData: { latitude: 38.8981222, longitude: -77.0334917 } });

  // (b) EXIF present: EXIF date/gps WIN over the sidecar, but people still become hints
  writeFileSync(path.join(tmp, 'exif-wins.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00', lat: 30.2672, lon: -97.7431 }));
  sidecar('exif-wins.jpg', { people: [{ name: 'Amy Schneider' }], photoTakenTime: { timestamp: String(TAKEN) }, geoData: { latitude: 10, longitude: 20 } });

  // (c) geoData {0,0} is Google's "no location" sentinel → no coords (but date + hints still set)
  writeFileSync(path.join(tmp, 'zero-geo.jpg'), noExif());
  sidecar('zero-geo.jpg', { people: [{ name: 'Amy Schneider' }], photoTakenTime: { timestamp: String(TAKEN) }, geoData: { latitude: 0, longitude: 0 } });

  // (d) duplicate-media naming: sidecar is "<stem><ext>.supplemental-metadata(N).json"
  writeFileSync(path.join(tmp, 'dup(1).jpg'), noExif());
  writeFileSync(path.join(tmp, 'dup.jpg.supplemental-metadata(1).json'), JSON.stringify({ people: [{ name: 'Matt Paine' }], photoTakenTime: { timestamp: String(TAKEN) } }));

  // (e) no sidecar and (f) malformed sidecar → EXIF-only, must not throw/abort the scan
  writeFileSync(path.join(tmp, 'no-sidecar.jpg'), noExif());
  writeFileSync(path.join(tmp, 'bad-sidecar.jpg'), noExif());
  writeFileSync(path.join(tmp, 'bad-sidecar.jpg.supplemental-metadata.json'), '{ not valid json');

  const { server, port, requests } = await startMockServer((req, body, res) => {
    res.end(JSON.stringify({ summary: {}, results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })) }));
  });
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp, PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'), TZ: 'UTC',
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const arts = requests[0].body.artifacts;
  const by = (id) => arts.find((a) => a.source_id === id);

  const full = by('sidecar-full.jpg');
  assert.deepEqual(full.entity_hints, [
    { alias: 'April Delugach Paine', alias_type: 'name', role: 'pictured', confidence: 0.9 },
    { alias: 'Matt Paine', alias_type: 'name', role: 'pictured', confidence: 0.9 },
    { alias: 'Amy Schneider', alias_type: 'name', role: 'pictured', confidence: 0.9 },
  ]);
  assert.equal(full.occurred_at, takenISO, 'sidecar photoTakenTime fills occurred_at when EXIF has none');
  assert.equal(full.latitude, 38.8981222);
  assert.equal(full.longitude, -77.0334917);

  const exif = by('exif-wins.jpg');
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
  assert.equal(by('bad-sidecar.jpg').entity_hints, undefined, 'malformed sidecar → EXIF-only, no crash');
});

test('scan.js: same filename in different subdirectories gets distinct source_ids', async () => {
  // Regression test: walkImageFiles() used to recompute relPath relative to the CURRENT
  // recursion directory rather than the original root, so "2019/trip/IMG_1234.jpg" and
  // "2020/trip/IMG_1234.jpg" both collapsed to source_id "IMG_1234.jpg" and silently
  // overwrote each other via upsert instead of being two artifacts.
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-nested-test-'));
  mkdirSync(path.join(tmp, '2019', 'trip'), { recursive: true });
  mkdirSync(path.join(tmp, '2020', 'trip'), { recursive: true });
  writeFileSync(path.join(tmp, '2019', 'trip', 'IMG_1234.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  writeFileSync(path.join(tmp, '2020', 'trip', 'IMG_1234.jpg'), jpegWithExif({ dateTimeOriginal: '2020:03:04 14:30:00' }));

  const { server, port, requests } = await startMockServer((req, body, res) => {
    res.end(JSON.stringify({
      summary: {},
      results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
    }));
  });

  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);

  const artifacts = requests[0].body.artifacts;
  assert.equal(artifacts.length, 2, 'two distinct photos, not one collapsed into the other');
  const ids = artifacts.map((a) => a.source_id).sort();
  assert.deepEqual(ids, ['2019/trip/IMG_1234.jpg', '2020/trip/IMG_1234.jpg']);
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
  assert.equal(payload.source_id, 'photo.jpg');
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
    assert.equal(typeof r.extra.faces_detected, 'number');
    assert.equal(r.entity_hints, undefined, 'no hints while every cluster is unlabeled');
    assert.equal(typeof r.text_repr, 'string', 'text_repr is required by the contract and always sent');
    assert.doesNotMatch(r.text_repr, /Pictured:/, 'no Pictured sentence while unlabeled');
  }
  // Caption preserved through the unlabeled scan (reconstructed from the cache, not clobbered).
  assert.equal(scanReqs.find((r) => r.source_id === 'a.jpg').text_repr, 'Photo: a.jpg a sunny beach');
  assert.equal(scanReqs.find((r) => r.source_id === 'b.jpg').text_repr, 'Photo: b.jpg');
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
  const aReq = labelReqs.find((r) => r.source_id === 'a.jpg');
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
