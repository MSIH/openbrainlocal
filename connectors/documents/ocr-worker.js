#!/usr/bin/env node
// Low-priority background worker: drains the OCR queue scan.js writes (image-only PDFs),
// rasterizes each with pdfjs + @napi-rs/canvas, OCRs the pages with tesseract.js (pure WASM,
// fully local), and upserts the SAME (source, source_id) with an enriched text_repr. One file
// at a time, queue rewritten after each (kill-safe at any point), throttled between files.
//
// Scope: image-only PDFs ONLY. Standalone images are photo-exif's source ownership — OCRing
// them here would create a second artifact for the same file under a different `source`.
//
// Nightly-window scheduling is config, not code — this script does a single pass and exits;
// start/stop it on a schedule with cron or Task Scheduler. See README.md.
import { existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';
import { loadDotEnvIfPresent, sourceIdFor, ingestClient } from './lib/shared.js';
import { buildTextRepr } from './lib/text-repr.js';
import { rasterizePdf } from './lib/rasterize.js';

loadDotEnvIfPresent(path.dirname(fileURLToPath(import.meta.url)));

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const SCAN_ROOT = process.env.DOCUMENTS_SCAN_ROOT;
const OCR_QUEUE_PATH = process.env.DOCUMENTS_OCR_QUEUE_PATH
  || path.join(os.homedir(), '.life-context', 'documents-ocr-queue.json');
const OCR_LANG = process.env.DOCUMENTS_OCR_LANG || 'eng';
// Where tesseract caches its ~15MB language model — defaulted OUT of the repo/connector dir
// (tesseract.js downloads into cachePath, which defaults to cwd; an uncontained default
// would drop eng.traineddata into the working tree).
const OCR_CACHE_PATH = process.env.DOCUMENTS_OCR_CACHE_PATH
  || path.join(os.homedir(), '.life-context', 'tesseract');
// Number.isFinite, not `||` — an explicit 0 must win over the default (see scan.js).
const rawMaxPages = Number(process.env.DOCUMENTS_OCR_MAX_PAGES);
const OCR_MAX_PAGES = Number.isFinite(rawMaxPages) ? rawMaxPages : 20;
const rawThrottle = Number(process.env.DOCUMENTS_OCR_THROTTLE_MS);
const OCR_THROTTLE_MS = Number.isFinite(rawThrottle) ? rawThrottle : 1000;
const rawMaxChars = Number(process.env.DOCUMENTS_TEXT_REPR_MAX_CHARS);
const TEXT_REPR_MAX_CHARS = Math.min(Number.isFinite(rawMaxChars) ? rawMaxChars : 12000, 100000);

// Queue shape (written by scan.js): { [relPath]: { statKey, extra } }. The stored extra is the
// file's complete wave-1 extra — resent whole because the server's upsert overwrites
// extra_json as one field, never merges keys.
async function readQueue() {
  try {
    return JSON.parse(await readFile(OCR_QUEUE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeQueue(queue) {
  mkdirSync(path.dirname(OCR_QUEUE_PATH), { recursive: true });
  writeFileSync(OCR_QUEUE_PATH, JSON.stringify(queue));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === 'change-this-to-a-long-secure-token') {
    console.error('documents: LIFECONTEXT_API_KEY not configured (see .env.example)');
    process.exit(1);
  }
  if (!SCAN_ROOT || !existsSync(SCAN_ROOT)) {
    console.error(`documents: DOCUMENTS_SCAN_ROOT not set or doesn't exist: ${SCAN_ROOT}`);
    process.exit(1);
  }

  const queue = await readQueue();
  const entries = Object.entries(queue);
  if (!entries.length) {
    console.error('documents: OCR queue empty, nothing to do');
    return;
  }

  const { postIngest } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });

  // Drop stale entries BEFORE paying tesseract init: a file that moved or changed since it
  // was flagged is dropped — if it's still image-only, the next scan.js run re-flags it
  // against the new statKey.
  const live = [];
  for (const [relPath, entry] of entries) {
    const absPath = path.join(SCAN_ROOT, relPath);
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      stat = null;
    }
    if (!stat || `${stat.mtimeMs}:${stat.size}` !== entry.statKey) {
      console.error(`documents: dropping stale OCR queue entry ${relPath}`);
      delete queue[relPath];
      writeQueue(queue);
    } else {
      live.push({ relPath, entry, absPath });
    }
  }
  if (!live.length) {
    console.error('documents: OCR queue had only stale entries, nothing to do');
    return;
  }

  // One shared tesseract worker for the whole run — model init is the expensive step.
  let tesseract;
  try {
    mkdirSync(OCR_CACHE_PATH, { recursive: true });
    tesseract = await createWorker(OCR_LANG, 1, { cachePath: OCR_CACHE_PATH });
  } catch (err) {
    console.error('documents: tesseract failed to initialize, stopping (queue left intact)', err);
    return;
  }

  let done = 0;
  try {
    for (const { relPath, entry, absPath } of live) {
      let body;
      let ocrPages;
      try {
        const { images } = await rasterizePdf(await readFile(absPath), OCR_MAX_PAGES);
        const pages = [];
        for (let i = 0; i < images.length; i++) {
          const { data } = await tesseract.recognize(images[i]);
          const text = data.text.trim();
          if (text) pages.push(`Page ${i + 1}:\n${text}`);
        }
        body = pages.join('\n\n');
        ocrPages = images.length;
      } catch (err) {
        // A single bad PDF must not loop forever — drop it loudly; scan.js re-flags it only
        // if the file itself changes.
        console.error(`documents: OCR failed for ${relPath}, dropping from queue`, err);
        delete queue[relPath];
        writeQueue(queue);
        continue;
      }

      const { text_repr, extracted_chars, truncated } = buildTextRepr('pdf', entry.extra, relPath, body, TEXT_REPR_MAX_CHARS);
      try {
        // Present fields only: text_repr + extra. Per doc 04 §3 upsert merge semantics,
        // everything scan.js already stored (occurred_at, raw_path, content_hash) is left
        // untouched. extra is the complete wave-1 object with the OCR outcome layered on,
        // because extra_json overwrites whole — a partial extra would erase the counts.
        await postIngest({
          source: 'documents',
          source_id: sourceIdFor(relPath),
          type: 'document',
          text_repr,
          extra: { ...entry.extra, extracted_chars, truncated, needs_ocr: false, ocr_done: true, ocr_pages: ocrPages },
        });
      } catch (err) {
        console.error(`documents: ingest failed for ${relPath}, stopping run (will resume next time)`, err);
        break; // server unreachable — keep the entry and everything after it
      }
      delete queue[relPath];
      writeQueue(queue); // after every success, not batched — kill-safe at any point
      done++;

      await sleep(OCR_THROTTLE_MS);
    }
  } finally {
    await tesseract.terminate();
  }

  console.error(`documents: OCR'd ${done} file(s) this run, ${Object.keys(queue).length} remaining`);
}

main()
  .then(() => process.exit(0)) // tesseract/fetch would otherwise hold the process open
  .catch((err) => {
    console.error('documents: ocr worker failed', err);
    process.exit(1);
  });
