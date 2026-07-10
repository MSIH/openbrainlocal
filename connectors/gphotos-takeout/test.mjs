// Synthesizes a Google Takeout "Google Photos" tree (media files + JSON sidecars, the same
// photo duplicated across a year bucket and albums) and runs index.js against a mock ingest
// server — no real Takeout export or Google account needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs 20.11+; this connector declares >=18

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sidecar = ({ ts, lat, lon, description } = {}) => {
  const o = {};
  if (ts != null) o.photoTakenTime = { timestamp: String(ts) };
  if (lat != null) o.geoData = { latitude: lat, longitude: lon };
  if (description) o.description = description;
  return JSON.stringify(o);
};

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

const okBatch = (req, body, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    summary: {},
    results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
  }));
};

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// Build a Takeout tree; returns the root to pass as TAKEOUT_ROOT.
function makeTakeout() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'gphotos-test-'));
  const gp = path.join(tmp, 'Takeout', 'Google Photos');
  const year = path.join(gp, 'Photos from 2019');
  const family = path.join(gp, 'Family');
  const mom = path.join(gp, 'Mom');
  for (const d of [year, family, mom]) mkdirSync(d, { recursive: true });

  // A: in year bucket + Family album (Family is NOT a person album). Has date + GPS.
  writeFileSync(path.join(year, 'IMG_0001.jpg'), 'AAAA');
  writeFileSync(path.join(year, 'IMG_0001.jpg.json'), sidecar({ ts: 1551710400, lat: 30.2672, lon: -97.7431 })); // 2019-03-04
  writeFileSync(path.join(family, 'metadata.json'), JSON.stringify({ title: 'Family' }));
  writeFileSync(path.join(family, 'IMG_0001.jpg'), 'AAAA'); // duplicate bytes
  writeFileSync(path.join(family, 'IMG_0001.jpg.json'), sidecar({ ts: 1551710400 }));

  // B: in year bucket (supplemental-metadata sidecar variant) + Mom person-album.
  writeFileSync(path.join(year, 'IMG_0002.jpg'), 'BBBB');
  writeFileSync(path.join(year, 'IMG_0002.jpg.supplemental-metadata.json'), sidecar({ ts: 1554302400 })); // 2019-04-03
  writeFileSync(path.join(mom, 'metadata.json'), JSON.stringify({ title: 'Mom' }));
  writeFileSync(path.join(mom, 'IMG_0002.jpg'), 'BBBB'); // duplicate bytes
  writeFileSync(path.join(mom, 'IMG_0002.jpg.json'), sidecar({ ts: 1554302400 }));

  // C: only in Mom, with a (0,0) geo (must be treated as absent) and no date.
  writeFileSync(path.join(mom, 'IMG_0003.jpg'), 'CCCC');
  writeFileSync(path.join(mom, 'IMG_0003.jpg.json'), sidecar({ lat: 0, lon: 0 }));

  // D: only in Mom, exercising the duplicate-counter sidecar shift name(1).jpg -> name.jpg(1).json.
  writeFileSync(path.join(mom, 'IMG_0004(1).jpg'), 'DDDD');
  writeFileSync(path.join(mom, 'IMG_0004.jpg(1).json'), sidecar({ ts: 1554302400 }));

  // E: a video in the Mom album — must be typed 'video', not 'photo', and still get the hint.
  writeFileSync(path.join(mom, 'VID_0005.mp4'), 'EEEE');
  writeFileSync(path.join(mom, 'VID_0005.mp4.json'), sidecar({ ts: 1554302400 }));

  return { root: path.join(tmp, 'Takeout'), tmp };
}

function writeConfig(tmp) {
  const configPath = path.join(tmp, 'config.json');
  writeFileSync(configPath, JSON.stringify({ person_albums: { Mom: { alias: 'Jane Doe' } } }));
  return configPath;
}

test('index.js: dedups copies by content, attaches person hints, parses sidecar date/geo, skips on re-run', async () => {
  const { root, tmp } = makeTakeout();
  const configPath = writeConfig(tmp);
  const manifestPath = path.join(tmp, 'manifest.json');
  const spoolPath = path.join(tmp, 'gphotos-takeout-spool.jsonl');

  const { server, port, requests } = await startMockServer(okBatch);
  const env = {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    TAKEOUT_ROOT: root,
    GPHOTOS_PEOPLE_CONFIG: configPath,
    GPHOTOS_MANIFEST_PATH: manifestPath,
    GPHOTOS_SPOOL_PATH: spoolPath,
  };
  const result = await run(env);
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const artifacts = requests[0].body.artifacts;
  assert.equal(artifacts.length, 5, 'A,B,C,D,E are 5 unique items despite year+album duplication');

  const byId = Object.fromEntries(artifacts.map((a) => [a.source_id, a]));
  const A = byId[`gphotos:${sha256('AAAA')}`];
  const B = byId[`gphotos:${sha256('BBBB')}`];
  const C = byId[`gphotos:${sha256('CCCC')}`];
  const D = byId[`gphotos:${sha256('DDDD')}`];
  const E = byId[`gphotos:${sha256('EEEE')}`];
  assert.ok(A && B && C && D && E, 'source_id is gphotos:<sha256 of bytes>');

  // A: Family album is not a person album → no pictured hint; date + GPS from sidecar.
  assert.equal(A.type, 'photo');
  assert.equal(A.entity_hints, undefined, 'non-person album yields no pictured hint');
  assert.equal(A.occurred_at, '2019-03-04T14:40:00.000Z');
  assert.equal(A.latitude, 30.2672);
  assert.equal(A.place_label, undefined); // core resolves place_label, not this connector
  assert.equal(A.content_hash, sha256('AAAA'));
  assert.deepEqual(A.extra.albums, ['Family']);

  // B: in the Mom person-album → one pictured hint mapped to the contact "Jane Doe".
  assert.deepEqual(B.entity_hints, [{ alias: 'Jane Doe', alias_type: 'name', role: 'pictured', confidence: 0.7 }]);
  assert.equal(B.occurred_at, '2019-04-03T14:40:00.000Z'); // supplemental-metadata sidecar parsed
  assert.deepEqual(B.extra.albums, ['Mom']);

  // C: (0,0) geo is Takeout's "unknown", not a real location; no date → occurred_at omitted.
  assert.equal(C.latitude, undefined);
  assert.equal(C.occurred_at, undefined);
  assert.equal(C.entity_hints[0].alias, 'Jane Doe');

  // D: duplicate-counter sidecar was found and parsed.
  assert.equal(D.occurred_at, '2019-04-03T14:40:00.000Z');
  assert.equal(D.entity_hints[0].alias, 'Jane Doe');

  // E: a video is typed 'video' (not 'photo'), described as a video, and still gets the hint.
  assert.equal(E.type, 'video');
  assert.match(E.text_repr, /^Video taken 2019-04-03/);
  assert.equal(E.entity_hints[0].alias, 'Jane Doe');

  // Re-run: nothing changed on disk → nothing re-sent.
  requests.length = 0;
  const { server: s2, port: p2, requests: r2 } = await startMockServer(okBatch);
  const rerun = await run({ ...env, LIFECONTEXT_URL: `http://127.0.0.1:${p2}` });
  s2.closeAllConnections();
  s2.close();
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(r2.length, 0, 'unchanged photos are skipped on re-run');
});

test('index.js: server down spools payloads, next run flushes them without duplicating', async () => {
  const { root, tmp } = makeTakeout();
  const configPath = writeConfig(tmp);
  const manifestPath = path.join(tmp, 'manifest.json');
  const spoolPath = path.join(tmp, 'gphotos-takeout-spool.jsonl');
  const baseEnv = {
    LIFECONTEXT_API_KEY: 'test-key',
    TAKEOUT_ROOT: root,
    GPHOTOS_PEOPLE_CONFIG: configPath,
    GPHOTOS_MANIFEST_PATH: manifestPath,
    GPHOTOS_SPOOL_PATH: spoolPath,
  };

  // Run 1: nothing listening → every payload spools to disk.
  const down = await run({ ...baseEnv, LIFECONTEXT_URL: 'http://127.0.0.1:19997' });
  assert.equal(down.status, 0, down.stderr);
  assert.ok(existsSync(spoolPath), 'payloads spooled when server unreachable');
  const spooledLines = readFileSync(spoolPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(spooledLines.length, 5, 'all 5 unique items spooled');

  // Run 2: server up → spool flushes, and phase 2 does NOT re-send the same photos.
  const { server, port, requests } = await startMockServer(okBatch);
  const up = await run({ ...baseEnv, LIFECONTEXT_URL: `http://127.0.0.1:${port}` });
  server.closeAllConnections();
  server.close();
  assert.equal(up.status, 0, up.stderr);
  assert.ok(!existsSync(spoolPath), 'spool cleared after successful flush');
  const allSent = requests.flatMap((r) => r.body.artifacts.map((a) => a.source_id));
  assert.equal(allSent.length, 5, 'each item delivered exactly once on recovery, no duplicate send');
  assert.equal(new Set(allSent).size, 5);
});

test('index.js: retries on 429 then delivers without spooling', async () => {
  const { root, tmp } = makeTakeout();
  const configPath = writeConfig(tmp);
  const spoolPath = path.join(tmp, 'gphotos-takeout-spool.jsonl');
  let calls = 0;
  const { server, port } = await startMockServer((req, body, res) => {
    calls++;
    if (calls === 1) { // first attempt rate-limited; Retry-After keeps the backoff short
      res.statusCode = 429;
      res.setHeader('retry-after', '1');
      res.end(JSON.stringify({ error: 'rate_limited' }));
      return;
    }
    okBatch(req, body, res);
  });
  const result = await run({
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    TAKEOUT_ROOT: root,
    GPHOTOS_PEOPLE_CONFIG: configPath,
    GPHOTOS_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
    GPHOTOS_SPOOL_PATH: spoolPath,
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls >= 2, 'connector retried after the 429');
  assert.ok(!existsSync(spoolPath), 'succeeded on retry, so nothing was spooled');
});

test('index.js: manifest prunes entries for files removed from the tree', async () => {
  const { root, tmp } = makeTakeout();
  const configPath = writeConfig(tmp);
  const manifestPath = path.join(tmp, 'manifest.json');
  const env = {
    LIFECONTEXT_API_KEY: 'test-key',
    TAKEOUT_ROOT: root,
    GPHOTOS_PEOPLE_CONFIG: configPath,
    GPHOTOS_MANIFEST_PATH: manifestPath,
    GPHOTOS_SPOOL_PATH: path.join(tmp, 'gphotos-takeout-spool.jsonl'),
  };

  const { server, port } = await startMockServer(okBatch);
  await run({ ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` });
  const first = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const cOnlyCopy = path.join(root, 'Google Photos', 'Mom', 'IMG_0003.jpg');
  assert.ok(first.hashes[cOnlyCopy], 'C is cached after the first run');
  assert.ok(first.sent[`gphotos:${sha256('CCCC')}`], 'C recorded as sent');

  // Remove C entirely and re-run: its stale hash + sent entries must be pruned.
  rmSync(cOnlyCopy);
  rmSync(path.join(root, 'Google Photos', 'Mom', 'IMG_0003.jpg.json'));
  await run({ ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port}` });
  server.closeAllConnections();
  server.close();
  const second = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(second.hashes[cOnlyCopy], undefined, 'removed file dropped from hash cache');
  assert.equal(second.sent[`gphotos:${sha256('CCCC')}`], undefined, 'removed photo dropped from sent map');
  assert.ok(second.sent[`gphotos:${sha256('AAAA')}`], 'surviving photo kept in sent map');
});
