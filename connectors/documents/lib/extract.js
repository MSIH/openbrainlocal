// Extension → extractor dispatch. Every extractor returns the same shape:
// { text, occurredAt: Date|null, meta: {…type-specific counts/title}, needsOcr: boolean }.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractPdf } from './pdf.js';
import { extractDocx, extractXlsx, extractPptx } from './ooxml.js';

export function formatOf(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  return ext ? ext.slice(1) : null; // '.PDF' → 'pdf'
}

export async function extractDocument(absPath) {
  const format = formatOf(absPath);
  const buffer = await readFile(absPath);
  switch (format) {
    case 'pdf':
      return extractPdf(buffer);
    case 'docx':
      return extractDocx(buffer);
    case 'xlsx':
      return extractXlsx(buffer);
    case 'pptx':
      return extractPptx(buffer);
    default:
      throw new Error(`no extractor for ${absPath}`); // the walker only yields known extensions
  }
}
