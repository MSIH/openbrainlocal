// Synthesizes real fixture files in-test (hand-assembled PDFs, jszip-built docx/pptx,
// exceljs-built xlsx — no binary fixtures checked in) and runs scan.js / ocr-worker.js
// against them with a mock ingest server. The real tesseract/pdfjs OCR path is manual
// verification (README.md), same posture as photo-exif's no-VLM-in-CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { chunkByBudget, BATCH_MAX, BATCH_BYTE_BUDGET, DOCUMENT_EXTENSIONS } from './lib/shared.js';
import { truncateHeadTail, collapseWhitespace, buildHeader } from './lib/text-repr.js';
import { parsePdfDate, needsOcr } from './lib/pdf.js';
import { parseCoreXml, extractPptxText, decodeXmlEntities, loadZip } from './lib/ooxml.js';
import { formatOf } from './lib/extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs Node 20.11+; this connector declares >=18

// --- fixture builders ---

// Assembles a minimal but structurally valid PDF (computed xref offsets) — one page per entry
// in pageTexts; an empty string yields a page with no text layer (the "scanned PDF" case).
function makePdf({ pageTexts = ['Hello'], creationDate, title } = {}) {
  const n = pageTexts.length;
  const pageObj = (i) => 4 + 2 * i;
  const contentObj = (i) => 5 + 2 * i;
  const infoObj = 4 + 2 * n;
  const esc = (t) => t.replace(/([()\\])/g, '\\$1');

  const bodies = new Map();
  bodies.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  bodies.set(2, `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${n} >>`);
  bodies.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pageTexts.forEach((text, i) => {
    bodies.set(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj(i)} 0 R >>`);
    const stream = text ? `BT /F1 24 Tf 72 720 Td (${esc(text)}) Tj ET` : '';
    bodies.set(contentObj(i), `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const info = [];
  if (creationDate) info.push(`/CreationDate (${creationDate})`);
  if (title) info.push(`/Title (${esc(title)})`);
  bodies.set(infoObj, `<< ${info.join(' ')} >>`);

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (const [num, body] of bodies) {
    offsets[num] = out.length;
    out += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${infoObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= infoObj; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${infoObj + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'binary');
}

const CORE_XML = ({ created, title }) => `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${title ? `<dc:title>${title}</dc:title>` : ''}${created ? `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` : ''}</cp:coreProperties>`;

async function makeDocx({ paragraphs, created, title }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  if (created || title) zip.file('docProps/core.xml', CORE_XML({ created, title }));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makePptx({ slides, created, title }) {
  const zip = new JSZip();
  slides.forEach((runs, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${runs.map((r) => `<a:t>${r}</a:t>`).join('<a:t> </a:t>')}</p:spTree></p:cSld></p:sld>`);
  });
  if (created || title) zip.file('docProps/core.xml', CORE_XML({ created, title }));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeXlsx({ sheets, created }) {
  const wb = new ExcelJS.Workbook();
  if (created) wb.created = created;
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- test harness (mirrors photo-exif/test.mjs) ---

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

function batchOkHandler(req, body, res) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    summary: {},
    results: (body.artifacts ?? []).map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
  }));
}

function run(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// --- pure-function tests ---

test('truncateHeadTail: passthrough under cap, head+tail split over it', () => {
  assert.deepEqual(truncateHeadTail('short', 100), { text: 'short', truncated: false });
  const long = 'A'.repeat(900) + 'MIDDLE' + 'Z'.repeat(900);
  const { text, truncated } = truncateHeadTail(long, 200);
  assert.equal(truncated, true);
  assert.ok(text.length < long.length);
  assert.ok(text.startsWith('AAA'), 'head preserved');
  assert.ok(text.endsWith('ZZZ'), 'tail preserved');
  assert.match(text, /\[\.\.\. \d+ chars omitted \.\.\.\]/);
});

test('collapseWhitespace: collapses runs and blank-line stacks, keeps line structure', () => {
  assert.equal(collapseWhitespace('a  \t b\n\n\n\nc   \n  d'), 'a b\n\nc\nd');
});

test('buildHeader: format label, counts, title', () => {
  assert.equal(buildHeader('pdf', { page_count: 12, title: 'Tax Return' }, 'r/tax.pdf'), 'Document (PDF, 12 pages): r/tax.pdf — "Tax Return"');
  assert.equal(buildHeader('xlsx', { sheet_count: 1 }, 'b.xlsx'), 'Document (XLSX, 1 sheet): b.xlsx');
  assert.equal(buildHeader('docx', {}, 'notes.docx'), 'Document (DOCX): notes.docx');
});

test('chunkByBudget: splits by serialized size and by the 100-item cap', () => {
  const big = (i) => ({ payload: { source_id: `f${i}`, text_repr: 'x'.repeat(60 * 1024) } });
  const bigGroups = chunkByBudget([big(1), big(2), big(3), big(4), big(5)]);
  assert.ok(bigGroups.length >= 2, 'oversized payloads split into multiple groups');
  for (const g of bigGroups) {
    assert.ok(Buffer.byteLength(JSON.stringify({ artifacts: g.map((x) => x.payload) })) < 256 * 1024, 'every request stays under the 256KB cap');
  }
  const tiny = Array.from({ length: 150 }, (_, i) => ({ payload: { source_id: `t${i}` } }));
  const tinyGroups = chunkByBudget(tiny);
  assert.equal(tinyGroups.length, 2);
  assert.equal(tinyGroups[0].length, BATCH_MAX);
  assert.ok(BATCH_BYTE_BUDGET < 256 * 1024);
});

test('extension dispatch: known extensions map, case-insensitively; others are not walked', () => {
  assert.equal(formatOf('a/B.PDF'), 'pdf');
  assert.equal(formatOf('report.docx'), 'docx');
  assert.ok(DOCUMENT_EXTENSIONS.has('.pptx'));
  assert.ok(!DOCUMENT_EXTENSIONS.has('.txt'));
});

test('parsePdfDate: offsets, quote quirks, partial dates, garbage', () => {
  assert.equal(parsePdfDate("D:20190304143000+05'30'").toISOString(), '2019-03-04T09:00:00.000Z');
  assert.equal(parsePdfDate('D:20190304143000Z').toISOString(), '2019-03-04T14:30:00.000Z');
  assert.equal(parsePdfDate('D:2019').toISOString(), '2019-01-01T00:00:00.000Z');
  assert.equal(parsePdfDate('20190304143000Z').toISOString(), '2019-03-04T14:30:00.000Z'); // D: optional in the wild
  assert.equal(parsePdfDate('D:16010101000000Z'), null, 'epoch garbage rejected');
  assert.equal(parsePdfDate('D:29990101000000Z'), null, 'future rejected');
  assert.equal(parsePdfDate('not a date'), null);
  assert.equal(parsePdfDate(undefined), null);
});

test('parseCoreXml: valid W3CDTF + title, missing element, malformed date', async () => {
  const ok = await loadZip(await makePptx({ slides: [['x']], created: '2021-06-15T10:00:00Z', title: 'Deck &amp; Notes' }));
  const core = await parseCoreXml(ok);
  assert.equal(core.created.toISOString(), '2021-06-15T10:00:00.000Z');
  assert.equal(core.title, 'Deck & Notes');
  const none = await loadZip(await makePptx({ slides: [['x']] }));
  assert.deepEqual(await parseCoreXml(none), { created: null, title: null });
  const bad = await loadZip(await makePptx({ slides: [['x']], created: 'garbage' }));
  assert.equal((await parseCoreXml(bad)).created, null);
});

test('needsOcr: thresholds', () => {
  assert.equal(needsOcr('', 3), true);
  assert.equal(needsOcr('page 1  page 2  page 3', 3), true, 'stamp-only text still flagged');
  assert.equal(needsOcr('x'.repeat(5000), 3), false);
  assert.equal(needsOcr('', 0), false, 'zero pages is not a scan');
});

test('extractPptxText: slide order (slide10 after slide9), entity decode, slide numbering', async () => {
  const zip = new JSZip();
  for (let i = 1; i <= 10; i++) zip.file(`ppt/slides/slide${i}.xml`, `<p:sld xmlns:a="x"><a:t>Slide body ${i} &amp; more</a:t></p:sld>`);
  const { text, slideCount } = await extractPptxText(await loadZip(await zip.generateAsync({ type: 'nodebuffer' })));
  assert.equal(slideCount, 10);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Slide 1: Slide body 1 & more');
  assert.equal(lines[9], 'Slide 10: Slide body 10 & more');
  assert.equal(decodeXmlEntities('&lt;a&gt; &#65;&#x42;'), '<a> AB');
});

// --- end-to-end: scan.js against generated fixtures + mock ingest server ---

test('scan.js: mixed fixture dir → correct payloads per format; unchanged-file skip on re-run', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-test-'));
  writeFileSync(path.join(tmp, 'report.pdf'), makePdf({
    pageTexts: ['The quarterly engineering figures improved substantially this period.'],
    creationDate: 'D:20190304143000Z',
    title: 'Q1 Report',
  }));
  writeFileSync(path.join(tmp, 'notes.docx'), await makeDocx({
    paragraphs: ['Meeting notes about the veranda renovation budget.'],
    created: '2021-06-15T10:00:00Z',
    title: 'Renovation Notes',
  }));
  writeFileSync(path.join(tmp, 'budget.xlsx'), await makeXlsx({
    sheets: { Q1: [['Item', 'Cost'], ['Lumber', 1200]], Q2: [['Item', 'Cost'], ['Paint', 300]] },
    created: new Date('2022-01-05T08:00:00Z'),
  }));
  writeFileSync(path.join(tmp, 'deck.pptx'), await makePptx({
    slides: [['Roadmap overview'], ['Milestones &amp; risks']],
  }));

  const { server, port, requests } = await startMockServer(batchOkHandler);
  const manifestPath = path.join(tmp, 'manifest.json');
  const queuePath = path.join(tmp, 'ocr-queue.json');
  const env = {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_MANIFEST_PATH: manifestPath,
    DOCUMENTS_OCR_QUEUE_PATH: queuePath,
  };
  const result = await run('scan.js', env);
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const artifacts = requests.flatMap((r) => r.body.artifacts);
  assert.equal(artifacts.length, 4, result.stderr);
  for (const a of artifacts) {
    assert.equal(a.source, 'documents');
    assert.equal(a.type, 'document');
    assert.match(a.content_hash, /^[0-9a-f]{64}$/);
    assert.ok(path.isAbsolute(a.raw_path));
    assert.equal(a.extra.ocr_done, false);
  }

  const pdf = artifacts.find((a) => a.source_id === 'report.pdf');
  assert.ok(pdf.text_repr.startsWith('Document (PDF, 1 page): report.pdf — "Q1 Report"'));
  assert.ok(pdf.text_repr.includes('quarterly engineering figures'));
  assert.equal(pdf.occurred_at, '2019-03-04T14:30:00.000Z');
  assert.equal(pdf.extra.format, 'pdf');
  assert.equal(pdf.extra.page_count, 1);
  assert.equal(pdf.extra.needs_ocr, false);

  const docx = artifacts.find((a) => a.source_id === 'notes.docx');
  assert.ok(docx.text_repr.includes('veranda renovation budget'));
  assert.equal(docx.occurred_at, '2021-06-15T10:00:00.000Z');
  assert.equal(docx.extra.title, 'Renovation Notes');

  const xlsx = artifacts.find((a) => a.source_id === 'budget.xlsx');
  assert.ok(xlsx.text_repr.includes('Sheet "Q1":'));
  assert.ok(xlsx.text_repr.includes('Lumber | 1200'));
  assert.equal(xlsx.occurred_at, '2022-01-05T08:00:00.000Z');
  assert.deepEqual(xlsx.extra.sheet_names, ['Q1', 'Q2']);
  assert.equal(xlsx.extra.sheet_count, 2);

  const pptx = artifacts.find((a) => a.source_id === 'deck.pptx');
  assert.ok(pptx.text_repr.includes('Slide 1: Roadmap overview'));
  assert.ok(pptx.text_repr.includes('Slide 2: Milestones & risks'));
  assert.equal(pptx.occurred_at, undefined, 'no metadata date -> omitted, never guessed from mtime');
  assert.equal(pptx.extra.slide_count, 2);

  // Re-run with the same (populated) manifest: nothing changed on disk, so nothing re-sent.
  const { server: server2, port: port2, requests: requests2 } = await startMockServer(batchOkHandler);
  const rerun = await run('scan.js', { ...env, LIFECONTEXT_URL: `http://127.0.0.1:${port2}` });
  server2.closeAllConnections();
  server2.close();
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(requests2.length, 0, 'unchanged files are skipped on re-scan');
});

test('scan.js: image-only PDF ingests thin with needs_ocr and lands in the OCR queue', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-ocr-flag-'));
  writeFileSync(path.join(tmp, 'scanned.pdf'), makePdf({ pageTexts: ['', '', ''] }));

  const { server, port, requests } = await startMockServer(batchOkHandler);
  const queuePath = path.join(tmp, 'ocr-queue.json');
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
    DOCUMENTS_OCR_QUEUE_PATH: queuePath,
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);

  const [artifact] = requests[0].body.artifacts;
  assert.equal(artifact.extra.needs_ocr, true);
  assert.equal(artifact.text_repr, 'Document (PDF, 3 pages): scanned.pdf', 'header-only text_repr is still searchable by filename');

  const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
  const stat = statSync(path.join(tmp, 'scanned.pdf'));
  assert.deepEqual(Object.keys(queue), ['scanned.pdf']);
  assert.equal(queue['scanned.pdf'].statKey, `${stat.mtimeMs}:${stat.size}`);
  assert.equal(queue['scanned.pdf'].extra.needs_ocr, true, 'queue carries the full wave-1 extra for the whole-field upsert');
});

test('scan.js: same filename in different subdirectories gets distinct source_ids', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-nested-'));
  mkdirSync(path.join(tmp, '2019'), { recursive: true });
  mkdirSync(path.join(tmp, '2020'), { recursive: true });
  const docx = await makeDocx({ paragraphs: ['Same name, different year.'] });
  writeFileSync(path.join(tmp, '2019', 'notes.docx'), docx);
  writeFileSync(path.join(tmp, '2020', 'notes.docx'), docx);

  const { server, port, requests } = await startMockServer(batchOkHandler);
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
    DOCUMENTS_OCR_QUEUE_PATH: path.join(tmp, 'ocr-queue.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const ids = requests[0].body.artifacts.map((a) => a.source_id).sort();
  assert.deepEqual(ids, ['2019/notes.docx', '2020/notes.docx']);
});

test('scan.js: oversize file skipped without ingest or manifest entry', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-oversize-'));
  writeFileSync(path.join(tmp, 'big.pdf'), makePdf({ pageTexts: ['some text'] }));

  const { server, port, requests } = await startMockServer(batchOkHandler);
  const manifestPath = path.join(tmp, 'manifest.json');
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_MANIFEST_PATH: manifestPath,
    DOCUMENTS_OCR_QUEUE_PATH: path.join(tmp, 'ocr-queue.json'),
    DOCUMENTS_MAX_FILE_MB: '0', // explicit 0 must be honored, not fall back to the default
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /oversize/);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), {}, 'not manifested — raising the limit later picks it up');
});

test('ocr-worker.js: stale statKey entry dropped without ingest; queue rewritten', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'documents-stale-'));
  const queuePath = path.join(tmp, 'ocr-queue.json');
  // Entry points at a file that no longer exists — must be dropped before tesseract ever loads.
  writeFileSync(queuePath, JSON.stringify({ 'gone.pdf': { statKey: '1:1', extra: { format: 'pdf', needs_ocr: true } } }));

  const result = await run('ocr-worker.js', {
    LIFECONTEXT_URL: 'http://127.0.0.1:19999', // nothing listening — must not be contacted
    LIFECONTEXT_API_KEY: 'test-key',
    DOCUMENTS_SCAN_ROOT: tmp,
    DOCUMENTS_OCR_QUEUE_PATH: queuePath,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /dropping stale OCR queue entry gone\.pdf/);
  assert.deepEqual(JSON.parse(readFileSync(queuePath, 'utf8')), {});
});
