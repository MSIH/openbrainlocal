// The three OOXML formats (docx/xlsx/pptx) share the docProps/core.xml metadata block, so
// occurred_at + title come from one jszip code path; bodies go through the format-appropriate
// extractor (mammoth for docx prose, exceljs for xlsx, raw slide XML for pptx). exceljs is
// used in document-model mode, not its streaming reader — the stream reader mis-handles zips
// whose worksheet entries precede workbook.xml (model.sheets undefined); memory is bounded by
// scan.js' DOCUMENTS_MAX_FILE_MB guard instead.
import JSZip from 'jszip';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

// One giant sheet must not eat the whole text_repr budget before later sheets get a line in.
const SHEET_TEXT_CAP = 4000;

export function loadZip(buffer) {
  return JSZip.loadAsync(buffer);
}

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

export function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

// Regex over XML is deliberate here: docProps/core.xml is machine-generated with fixed
// namespace prefixes (ECMA-376 mandates the dcterms/dc names), so a full XML parser
// dependency buys nothing.
export async function parseCoreXml(zip) {
  const entry = zip.file('docProps/core.xml');
  if (!entry) return { created: null, title: null };
  const xml = await entry.async('string');
  const titleMatch = /<dc:title[^>]*>([^<]+)<\/dc:title>/.exec(xml);
  const createdMatch = /<dcterms:created[^>]*>([^<]+)<\/dcterms:created>/.exec(xml);
  let created = null;
  if (createdMatch) {
    const date = new Date(createdMatch[1].trim()); // W3CDTF is ISO 8601 — Date parses it directly
    // Same sanity clamp as parsePdfDate: template-epoch and future dates mis-sort the
    // timeline, so reject rather than trust.
    if (!Number.isNaN(date.getTime()) && date.getFullYear() >= 1990 && date <= new Date()) created = date;
  }
  return { created, title: titleMatch ? decodeXmlEntities(titleMatch[1].trim()) || null : null };
}

export async function extractPptxText(zip) {
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1])); // slide10 after slide9
  const lines = [];
  for (const name of slideNames) {
    const xml = await zip.file(name).async('string');
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    const text = runs.join(' ').trim();
    if (text) lines.push(`Slide ${Number(name.match(/(\d+)/)[1])}: ${text}`);
  }
  return { text: lines.join('\n'), slideCount: slideNames.length };
}

export async function extractDocx(buffer) {
  const [{ value }, core] = await Promise.all([
    mammoth.extractRawText({ buffer }),
    loadZip(buffer).then(parseCoreXml),
  ]);
  const meta = {};
  if (core.title) meta.title = core.title;
  return { text: value ?? '', occurredAt: core.created, meta, needsOcr: false };
}

// Cell values from exceljs come in several shapes; flatten each to display text.
function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if (value.result != null) return cellText(value.result); // formula → cached result only
    if (value.text != null) return String(value.text); // hyperlink
    if (value.error != null) return String(value.error);
    return '';
  }
  return String(value);
}

export async function extractXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheetNames = [];
  const parts = [];
  wb.eachSheet((worksheet) => {
    sheetNames.push(worksheet.name);
    const lines = [`Sheet "${worksheet.name}":`];
    let chars = 0;
    let capped = false;
    worksheet.eachRow((row) => {
      if (capped) return;
      const cells = (row.values ?? []).map(cellText).filter((t) => t !== '');
      if (!cells.length) return;
      const line = cells.join(' | ');
      lines.push(line);
      chars += line.length;
      if (chars > SHEET_TEXT_CAP) {
        lines.push('[... sheet truncated ...]');
        capped = true;
      }
    });
    parts.push(lines.join('\n'));
  });
  const core = await loadZip(buffer).then(parseCoreXml);
  const meta = { sheet_count: sheetNames.length, sheet_names: sheetNames };
  if (core.title) meta.title = core.title;
  return { text: parts.join('\n\n'), occurredAt: core.created, meta, needsOcr: false };
}

export async function extractPptx(buffer) {
  const zip = await loadZip(buffer);
  const [{ text, slideCount }, core] = await Promise.all([extractPptxText(zip), parseCoreXml(zip)]);
  const meta = { slide_count: slideCount };
  if (core.title) meta.title = core.title;
  return { text, occurredAt: core.created, meta, needsOcr: false };
}
