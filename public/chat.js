// LifeContext webchat sidecar (#124) — a host-agnostic page to query memory in natural language
// beside any app, reaching tools that will never integrate via MCP. Read-only: query + render, no
// mutation. Vanilla ES module, no build step. Talks to POST /api/search (rich artifact results) or
// POST /api/recall (simple {content, created_at, distance}); the page is served token-only (#169)
// so its API credential is the path token itself, sent as x-api-key on every call. DOM is built via
// el() (text nodes, never innerHTML with result data) so a memory's own text can't inject markup.
// Mirrors the idioms in app.js (#96).

const RESULT_LIMIT = 10;
const SNIPPET_MAX = 400; // text_repr can be long prose; cap the card body, keep the whole thing on hover.

// --- tiny DOM helper (mirrors app.js) ---
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

// --- API layer (mirrors app.js) ---
// Token-only (#169): the credential is the capability token parsed from this page's own path
// (/<token>/ui/<file>, URL-decoded), sent as x-api-key — requireAuth accepts UI_URL_TOKEN (#163).
// The page is only reachable at that path, so the token is always present; no manual entry.
const apiKey = () => {
  const seg = location.pathname.match(/^\/([^/]+)\/ui\/[^/]+$/)?.[1];
  if (!seg) return '';
  try { return decodeURIComponent(seg); } catch { return seg; } // malformed %-escape: use the raw segment
};
class ApiError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }

async function api(method, path, { body } = {}) {
  const headers = { 'x-api-key': apiKey() };
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) { toast('Unauthorized — reopen the page from its full /<token>/ui/ URL.', true); throw new ApiError(401, 'unauthorized'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText, data);
  return data;
}

// --- state + refs ---
const $ = (id) => document.getElementById(id);
let mode = 'search'; // 'search' (rich) | 'recall' (simple)

// --- toast (mirrors app.js) ---
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
}
function reportError(err) {
  // 401 already surfaces its own toast in api(); don't double-report it.
  if (!(err instanceof ApiError && err.status === 401)) toast(err.message || 'Request failed', true);
}

// --- rendering ---
// Format a timestamp for a chip. Timestamps from the store are UTC in SQLite's 'YYYY-MM-DD HH:MM:SS'
// form (data-model.md: occurred_at/ingested_at are UTC); that shape has no zone, so pin it to UTC
// (T…Z) before parsing — otherwise the browser reads it as local and the card shows a time off by
// the viewer's offset. Anything else (already-ISO, or non-date) falls through as-is.
function fmtDate(ts) {
  if (!ts) return '';
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  const d = new Date(utc);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
// Distance is a cosine-ish distance (smaller = closer); FTS-only hits carry null.
const fmtDist = (d) => (d == null ? '—' : d.toFixed(3));

function metaChips(chips) {
  const row = el('div', { class: 'card-meta' });
  for (const [label, val] of chips) if (val) row.append(el('span', { class: 'chip', title: label }, val));
  return row;
}

// Card body: trim, cap at SNIPPET_MAX (full text on hover). text_repr/content can be long prose.
function cardBody(text) {
  const body = (text || '').trim();
  const long = body.length > SNIPPET_MAX;
  return el('p', { class: 'card-body', title: long ? body : null }, long ? body.slice(0, SNIPPET_MAX) + '…' : (body || '(no text)'));
}

// Linked entities (`links`: [{entity_id, role, canonical_name, kind}]) rendered as name chips;
// the role is shown when it's something other than the default 'self'.
function linkChips(links) {
  if (!links?.length) return null;
  const row = el('div', { class: 'card-links' });
  for (const l of links) row.append(el('span', { class: 'chip entity', title: `${l.kind} #${l.entity_id}` },
    l.canonical_name || `#${l.entity_id}`, l.role && l.role !== 'self' ? ` · ${l.role}` : ''));
  return row;
}

// A /api/search hit: full artifact row + `distance` + `links`. Render the fields the API returns
// (text_repr, occurred_at, type, source, place_label, distance, linked entities).
function searchCard(a) {
  return el('article', { class: 'card' },
    metaChips([
      ['type', a.type],
      ['source', a.source],
      ['when', fmtDate(a.occurred_at ?? a.ingested_at)],
      ['place', a.place_label],
      ['distance', `d ${fmtDist(a.distance)}`],
    ]),
    cardBody(a.display_text ?? a.text_repr), // #147: name-annotated text ("… from Amy Schneider (+1…)"); raw handle if unresolved
    linkChips(a.links));
}

// A /api/recall hit: the legacy shape {content, created_at, distance}.
function recallCard(r) {
  return el('article', { class: 'card' },
    metaChips([['when', fmtDate(r.created_at)], ['distance', `d ${fmtDist(r.distance)}`]]),
    cardBody(r.content));
}

function addTurn(query, turnMode) {
  const results = el('div', { class: 'results' }, el('p', { class: 'thinking' }, 'Searching…'));
  const turn = el('section', { class: 'turn' },
    el('div', { class: 'q' }, el('span', { class: 'q-mode' }, turnMode), el('span', { class: 'q-text' }, query)),
    results);
  const t = $('transcript');
  t.append(turn);
  turn.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return results;
}

function renderResults(container, rows, turnMode) {
  container.replaceChildren();
  if (!rows.length) { container.append(el('p', { class: 'empty' }, 'No matching memories.')); return; }
  const build = turnMode === 'recall' ? recallCard : searchCard;
  for (const r of rows) container.append(build(r));
}

// --- ask flow ---
async function ask(query) {
  // Snapshot the mode at submit time: the toggle can flip while this request is in flight, and the
  // returned shape (search artifact vs recall {content}) must be rendered with the matching card.
  const turnMode = mode;
  const slot = addTurn(query, turnMode);
  try {
    const path = turnMode === 'recall' ? '/api/recall' : '/api/search';
    const { results } = await api('POST', path, { body: { query, limit: RESULT_LIMIT } });
    renderResults(slot, results || [], turnMode);
  } catch (err) {
    slot.replaceChildren(el('p', { class: 'empty err' }, err instanceof ApiError && err.status === 401 ? 'Unauthorized — reopen this page from its full /<token>/ui/ URL.' : `Error: ${err.message || 'request failed'}`));
    reportError(err);
  }
}

$('askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('ask').value.trim();
  if (!q) return;
  void ask(q); // fire-and-forget: ask() funnels its own errors, so nothing rejects unobserved
  $('ask').value = '';
});

// --- mode toggle (button group: keep aria-pressed in sync with the .active class) ---
for (const b of $('modeToggle').querySelectorAll('button')) b.addEventListener('click', () => {
  mode = b.dataset.mode;
  for (const x of $('modeToggle').querySelectorAll('button')) {
    const on = x === b;
    x.classList.toggle('active', on);
    x.setAttribute('aria-pressed', String(on));
  }
  $('ask').focus();
});

// --- boot ---
// Token-only (#169): the page is only served at /<token>/ui/<file>, so apiKey() always resolves the
// credential from the path — nothing to bootstrap or prompt for. Focus the ask box and go.
$('ask').focus();
