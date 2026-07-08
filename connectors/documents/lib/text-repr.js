// text_repr assembly: an always-surviving header line + a whitespace-collapsed,
// head+tail-truncated body. Shared by scan.js and ocr-worker.js so wave-1 and OCR
// representations stay structurally identical.

const FORMAT_LABELS = { pdf: 'PDF', docx: 'DOCX', xlsx: 'XLSX', pptx: 'PPTX' };

function countLabel(meta) {
  if (meta.page_count != null) return `${meta.page_count} page${meta.page_count === 1 ? '' : 's'}`;
  if (meta.sheet_count != null) return `${meta.sheet_count} sheet${meta.sheet_count === 1 ? '' : 's'}`;
  if (meta.slide_count != null) return `${meta.slide_count} slide${meta.slide_count === 1 ? '' : 's'}`;
  return null;
}

// `Document (PDF, 12 pages): reports/2019/tax.pdf — "2019 Federal Tax Return"` — the header
// carries format, size, path, and title so the artifact stays findable by filename/title even
// when the body is thin (a not-yet-OCR'd scan) or truncated.
export function buildHeader(format, meta, relPath) {
  const count = countLabel(meta);
  const kind = count ? `${FORMAT_LABELS[format] ?? format}, ${count}` : FORMAT_LABELS[format] ?? format;
  const title = meta.title ? ` — "${meta.title}"` : '';
  return `Document (${kind}): ${relPath}${title}`;
}

// Collapse horizontal whitespace runs and blank-line stacks, keeping line structure — sheet
// rows and slide lines are meaningful units, so this is not a flatten-to-one-line collapse.
export function collapseWhitespace(text) {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 80/20 head+tail rather than head-only: the end of a letter/contract (conclusions, signature
// blocks) is often the most retrievable part, while full text can't fit — the ingest request
// cap is 256KB and a 1024-dim embedding of hundreds of KB is mush anyway. The full extract
// length is recorded in extra.extracted_chars and raw_path keeps the pointer to everything.
export function truncateHeadTail(text, cap) {
  if (text.length <= cap) return { text, truncated: false };
  const head = Math.floor(cap * 0.8);
  const tail = cap - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n[... ${omitted} chars omitted ...]\n${text.slice(-tail)}`,
    truncated: true,
  };
}

// header + body → { text_repr, extracted_chars, truncated }. The cap applies to the body;
// the header always survives whole.
export function buildTextRepr(format, meta, relPath, body, maxChars) {
  const header = buildHeader(format, meta, relPath);
  const collapsed = collapseWhitespace(body ?? '');
  const bodyCap = Math.max(0, maxChars - header.length - 2);
  const { text, truncated } = truncateHeadTail(collapsed, bodyCap);
  return {
    text_repr: text ? `${header}\n\n${text}` : header,
    extracted_chars: collapsed.length,
    truncated,
  };
}
