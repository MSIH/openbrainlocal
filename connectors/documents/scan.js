#!/usr/bin/env node
// Batch-scans a document tree (.pdf/.docx/.xlsx/.pptx): extracts text + created-date metadata,
// sha256 content_hash, capped text_repr — POSTed to LifeContext via /api/v1/ingest/batch.
// Image-only PDFs are ingested immediately with their thin header (findable by filename from
// wave 1) and queued for ocr-worker.js, which later upserts an OCR'd text_repr onto the same
// (source, source_id). See README.md for setup and the exit test.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent, walkDocumentFiles, sourceIdFor, contentHashOfFile, chunkByBudget, ingestClient, BATCH_MAX } from './lib/shared.js';
import { extractDocument, formatOf } from './lib/extract.js';
import { buildTextRepr } from './lib/text-repr.js';

loadDotEnvIfPresent(path.dirname(fileURLToPath(import.meta.url)));

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const SCAN_ROOT = process.env.DOCUMENTS_SCAN_ROOT;
const MANIFEST_PATH = process.env.DOCUMENTS_MANIFEST_PATH
  || path.join(os.homedir(), '.life-context', 'documents-manifest.json');
const OCR_QUEUE_PATH = process.env.DOCUMENTS_OCR_QUEUE_PATH
  || path.join(os.homedir(), '.life-context', 'documents-ocr-queue.json');
// `|| dflt` would override an explicit 0 (0 is falsy) — Number.isFinite distinguishes
// "not set" (NaN) from "set to zero" (a real, useful value for tests).
const rawMaxMb = Number(process.env.DOCUMENTS_MAX_FILE_MB);
const MAX_FILE_BYTES = (Number.isFinite(rawMaxMb) ? rawMaxMb : 50) * 1024 * 1024;
// Hard ceiling 100,000 chars: keeps any single serialized payload safely under the batch
// byte budget (lib/shared.js) no matter what the env says.
const rawMaxChars = Number(process.env.DOCUMENTS_TEXT_REPR_MAX_CHARS);
const TEXT_REPR_MAX_CHARS = Math.min(Number.isFinite(rawMaxChars) ? rawMaxChars : 12000, 100000);

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

async function buildPayload(absPath, relPath) {
  const format = formatOf(absPath);
  const { text, occurredAt, meta, needsOcr } = await extractDocument(absPath);
  const contentHash = await contentHashOfFile(absPath);
  const { text_repr, extracted_chars, truncated } = buildTextRepr(format, meta, relPath, text, TEXT_REPR_MAX_CHARS);

  const payload = {
    source: 'documents',
    source_id: sourceIdFor(relPath),
    type: 'document',
    text_repr,
    content_hash: contentHash,
    raw_path: absPath,
    extra: { format, extracted_chars, truncated, needs_ocr: needsOcr, ocr_done: false, ...meta },
  };
  // occurred_at is when the document was CREATED (its own metadata), never a mtime/import-time
  // guess — doc 04 §3 is explicit that a 2019 document imported today must still sort into
  // 2019, so an unknown date is omitted (and warned on) rather than approximated with
  // something that's actively wrong.
  if (occurredAt) payload.occurred_at = occurredAt.toISOString();
  return payload;
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

  const { postIngestBatch } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const manifest = readJson(MANIFEST_PATH);
  // Queue entries carry the file's full `extra` so ocr-worker.js can send a complete
  // replacement — the server's upsert overwrites extra_json whole, never merges keys.
  const ocrQueue = readJson(OCR_QUEUE_PATH);
  let scanned = 0;
  let skippedUnchanged = 0;
  let skippedOversize = 0;
  const pending = [];

  const flush = async () => {
    if (!pending.length) return;
    for (const group of chunkByBudget(pending)) {
      const result = await postIngestBatch(group.map((p) => p.payload));
      result.results.forEach((r, i) => {
        if (r.error) {
          console.error('documents: item failed', group[i].payload.source_id, r.error, r.issues ?? '');
        } else {
          // Only cache success — a failed item must be retried on the next scan, not skipped
          // as "unchanged" forever. Same rule for the OCR queue: flag on success, and clear
          // any stale entry when a changed file now has a real text layer.
          const { relPath, statKey, payload } = group[i];
          manifest[relPath] = statKey;
          if (payload.extra.needs_ocr) ocrQueue[relPath] = { statKey, extra: payload.extra };
          else delete ocrQueue[relPath];
        }
      });
    }
    pending.length = 0;
  };

  for await (const { absPath, relPath } of walkDocumentFiles(SCAN_ROOT)) {
    // statSync AND buildPayload share one try/catch — a permission error or a corrupt file
    // can throw from either, and either way it must skip just this file, not abort the scan.
    let statKey;
    let payload;
    try {
      const stat = statSync(absPath);
      // Oversize files are skipped but NOT manifested — every extractor (pdfjs, mammoth,
      // exceljs, jszip) buffers the whole file, so the guard bounds memory; raising the
      // limit later picks them up.
      if (stat.size > MAX_FILE_BYTES) {
        console.error(`documents: skipping oversize file ${relPath} (${Math.round(stat.size / 1024 / 1024)}MB)`);
        skippedOversize++;
        continue;
      }
      statKey = `${stat.mtimeMs}:${stat.size}`;
      if (manifest[relPath] === statKey) {
        skippedUnchanged++;
        continue;
      }
      payload = await buildPayload(absPath, relPath);
    } catch (err) {
      console.error(`documents: skipping unreadable file ${relPath}`, err);
      continue;
    }
    scanned++;
    pending.push({ relPath, statKey, payload });
    if (pending.length >= BATCH_MAX) await flush();
  }
  await flush();
  writeJson(MANIFEST_PATH, manifest);
  writeJson(OCR_QUEUE_PATH, ocrQueue);

  const queued = Object.keys(ocrQueue).length;
  console.error(`documents: scanned ${scanned} new/changed file(s), skipped ${skippedUnchanged} unchanged, ${skippedOversize} oversize; ${queued} awaiting OCR`);
}

main()
  .then(() => process.exit(0)) // fetch's keep-alive sockets would otherwise hold the process open
  .catch((err) => {
    console.error('documents: scan failed', err);
    process.exit(1);
  });
