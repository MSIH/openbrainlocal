// LifeContext contacts management UI (#96). Vanilla ES module — no framework, no build step.
// Talks to the core /api/v1/entities curation endpoints; the API key lives in localStorage and
// rides x-api-key on every call. DOM is built via el() (text nodes, never innerHTML with user
// data) so a contact's own fields can't inject markup.

const KEY_STORAGE = 'lifecontext_api_key';
// Canonical relation vocabulary (mirrors RELATION_TYPE_MAP in src/db.js) + custom (free label).
const RELATION_TYPES = ['spouse', 'partner', 'domesticPartner', 'child', 'parent', 'mother', 'father',
  'sibling', 'brother', 'sister', 'friend', 'relative', 'assistant', 'manager', 'referredBy', 'worksAt', 'custom'];

// --- tiny DOM helper ---
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

// --- API layer ---
const apiKey = () => localStorage.getItem(KEY_STORAGE) || '';
class ApiError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }

async function api(method, path, { body, rawBody, contentType } = {}) {
  const headers = { 'x-api-key': apiKey() };
  let payload;
  if (rawBody !== undefined) { payload = rawBody; if (contentType) headers['Content-Type'] = contentType; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) { showKeyBar('Invalid or missing API key.'); throw new ApiError(401, 'unauthorized'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText, data);
  return data;
}

async function fetchPhotoObjectURL(id) {
  const res = await fetch(`/api/v1/entities/${id}/photo`, { headers: { 'x-api-key': apiKey() } });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

// --- state + refs ---
const $ = (id) => document.getElementById(id);
let currentId = null, currentProfile = null, currentKind = '', searchTerm = '', lastPhotoURL = null;
let currentSave = null; // set by renderDetail to the open contact's save closure; used by the top-bar Save (#127)

// --- API key bar ---
// A review drawer (.duppanel: position:fixed, inset:0) would cover the key bar, trapping the user
// with no way to enter a key — so close any open drawer before revealing/focusing it. Covers every
// path that surfaces the key bar (no-key open, 401 mid-action) for both the duplicates and proposed drawers.
function showKeyBar(msg = '') {
  if (!$('dupPanel').hidden) closeDuplicates();
  if (!$('propPanel').hidden) closeProposed();
  $('keyBar').hidden = false; $('keyMsg').textContent = msg; $('keyInput').value = apiKey(); $('keyInput').focus();
}
function hideKeyBar() { $('keyBar').hidden = true; }
$('keySave').addEventListener('click', () => {
  const v = $('keyInput').value.trim();
  if (!v) return;
  localStorage.setItem(KEY_STORAGE, v);
  hideKeyBar();
  loadList();
});
$('keyEdit').addEventListener('click', () => showKeyBar());

// --- toast ---
let toastTimer;
// action (optional): { label, onClick } renders an inline button in the toast (e.g. the 409
// "Review duplicates" affordance). A toast carrying an action lingers longer so it's clickable.
function toast(msg, isErr = false, action = null) {
  const t = $('toast');
  t.replaceChildren(document.createTextNode(msg));
  if (action) t.append(' ', el('button', { type: 'button', class: 'toast-action', onclick: () => { t.hidden = true; action.onClick(); } }, action.label));
  t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), action ? 8000 : 3200);
}
function reportError(err) {
  if (err instanceof ApiError && err.status === 409 && err.data?.conflict) {
    const c = err.data.conflict;
    toast(`That ${c.alias_type} already belongs to contact #${c.entity_id}.`, true, { label: 'Review duplicates', onClick: openDuplicates });
  } else if (!(err instanceof ApiError && err.status === 401)) {
    toast(err.message || 'Request failed', true);
  }
}

// --- list ---
const initials = (name) => (name || '?').split(/\s+/).slice(0, 2).map((s) => s[0] || '').join('').toUpperCase();

async function loadList() {
  if (!apiKey()) return showKeyBar('Enter your API key to begin.');
  try {
    const params = new URLSearchParams();
    if (searchTerm) params.set('query', searchTerm);
    if (currentKind) params.set('kind', currentKind);
    params.set('limit', '200');
    const { entities } = await api('GET', `/api/v1/entities?${params}`);
    renderList(entities);
  } catch (err) { reportError(err); }
}

function renderList(entities) {
  const list = $('list');
  list.replaceChildren();
  if (!entities.length) { list.append(el('p', { class: 'empty', style: 'padding:16px' }, 'No contacts match.')); return; }
  for (const e of entities) {
    const attrs = e.attrs || {};
    const meta = attrs.emails?.[0] || attrs.phones?.[0] || attrs.org || '';
    // Avatar shows initials; a 📷 badge marks contacts that have a photo (uploaded or imported) —
    // hasPhoto comes from the list endpoint, so no per-row image fetch here.
    const avatar = el('div', { class: 'avatar' }, initials(e.canonical_name));
    if (e.hasPhoto) avatar.append(el('span', { class: 'photo-badge', role: 'img', 'aria-label': 'Has a photo', title: 'Has a photo' }, '📷'));
    const row = el('div', { class: 'row' + (e.id === currentId ? ' selected' : ''), 'data-id': e.id, onclick: () => selectContact(e.id) },
      avatar,
      el('div', {},
        el('div', { class: 'rname' }, e.canonical_name, e.kind === 'org' ? ' ' : '', e.kind === 'org' ? el('span', { class: 'kind-badge' }, 'org') : ''),
        meta ? el('div', { class: 'rmeta' }, meta) : ''),
    );
    list.append(row);
  }
}

// --- detail ---
async function selectContact(id) {
  currentId = id;
  try {
    currentProfile = await api('GET', `/api/v1/entities/${id}`);
    renderDetail(currentProfile);
    for (const r of $('list').querySelectorAll('.row')) r.classList.toggle('selected', Number(r.dataset.id) === id);
  } catch (err) { reportError(err); }
}

// multi-value row editor (emails / phones / addresses)
function multiField(label, values, placeholder) {
  const wrap = el('div', { class: 'multi field' }, el('label', {}, label));
  const rows = el('div', {});
  const addRow = (v = '') => {
    const input = el('input', { type: 'text', value: v, placeholder });
    const row = el('div', { class: 'mrow' }, input, el('button', { type: 'button', class: 'danger', title: 'Remove', onclick: () => row.remove() }, '✕'));
    rows.append(row);
  };
  (values && values.length ? values : []).forEach((v) => addRow(v));
  wrap.append(rows, el('button', { type: 'button', class: 'addlink', onclick: () => addRow() }, '+ add'));
  wrap._collect = () => [...rows.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
  return wrap;
}

// date field that preserves a non-ISO original (e.g. vCard "--05-14") unless the user changes it
function dateField(label, key, orig) {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(orig || '') ? orig : '';
  const input = el('input', { type: 'date', value: iso });
  const loaded = input.value; // what type=date actually accepted
  const wrap = el('div', { class: 'field' }, el('label', {}, label), input);
  wrap._collect = () => (input.value !== loaded ? (input.value || null) : (orig || null));
  return wrap;
}
function textField(label, key, val, textarea = false) {
  const input = el(textarea ? 'textarea' : 'input', textarea ? { rows: 3 } : { type: 'text' });
  input.value = val || '';
  const wrap = el('div', { class: 'field' }, el('label', {}, label), input);
  wrap._collect = () => input.value.trim() || null;
  return wrap;
}

function renderDetail(profile) {
  const { entity, aliases, relations, relations_in } = profile;
  const attrs = entity.attrs || {};
  const detail = $('detail');
  detail.replaceChildren();

  // header: photo + name + kind + deceased tag
  const photo = el('div', { class: 'photo' }, initials(entity.canonical_name));
  const fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  fileInput.addEventListener('change', () => uploadPhoto(fileInput.files[0]));
  const nameInput = el('input', { type: 'text', value: entity.canonical_name });
  const head = el('div', { class: 'dhead' }, photo,
    el('div', { style: 'flex:1' },
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
        el('span', { class: 'kind-badge' }, entity.kind),
        attrs.deceased ? el('span', { class: 'deceased-tag', title: `Deceased ${attrs.deceased}` }, 'deceased') : ''),
      el('div', { class: 'field' }, el('label', {}, 'Name'), nameInput),
      el('div', {}, el('button', { type: 'button', onclick: () => fileInput.click() }, '📷 Upload photo'), fileInput)));
  detail.append(head);
  loadPhoto(entity.id, photo);

  // contact fields
  const emails = multiField('Emails', attrs.emails, 'name@example.com');
  const phones = multiField('Phones', attrs.phones, '+1 555 123 4567');
  const addresses = multiField('Addresses', attrs.addresses, 'Street, City');
  const info = el('fieldset', {}, el('legend', {}, 'Contact'), emails, phones, addresses);
  detail.append(info);

  const birthday = dateField('Birthday', 'birthday', attrs.birthday);
  const anniversary = dateField('Anniversary', 'anniversary', attrs.anniversary);
  const deceased = dateField('Deceased', 'deceased', attrs.deceased);
  const org = textField('Organization', 'org', attrs.org);
  const title = textField('Title', 'title', attrs.title);
  const department = textField('Department', 'department', attrs.department);
  const note = textField('Note', 'note', attrs.note, true);
  const more = el('fieldset', {}, el('legend', {}, 'Details'),
    el('div', { class: 'grid2' }, birthday, anniversary, deceased, org, title, department), note);
  detail.append(more);

  // save handler collects name + attrs (preserving unedited attr keys). Shared by the bottom
  // "Save changes" and the top-bar "Save" (#127) via the module-level currentSave.
  const doSave = () => saveContact(entity.id, {
    canonical_name: nameInput.value.trim(),
    attrs: {
      ...attrs,
      emails: emails._collect(), phones: phones._collect(), addresses: addresses._collect(),
      birthday: birthday._collect(), anniversary: anniversary._collect(), deceased: deceased._collect(),
      org: org._collect(), title: title._collect(), department: department._collect(), note: note._collect(),
    },
  });
  currentSave = doSave;
  // Reveal the top-bar Save once a contact is open. Intentionally hidden (not a dead greyed
  // 'disabled' button) before the first selection; the UI has no deselect, so it stays visible after.
  $('saveTop').hidden = false;
  detail.append(el('div', { class: 'actions' }, el('button', { type: 'button', class: 'primary', onclick: doSave }, 'Save changes')));

  detail.append(renderAliases(entity.id, aliases));
  detail.append(renderRelations(entity.id, relations, relations_in));
}

async function loadPhoto(id, photoEl) {
  if (lastPhotoURL) { URL.revokeObjectURL(lastPhotoURL); lastPhotoURL = null; }
  const url = await fetchPhotoObjectURL(id);
  if (url && currentId === id) { lastPhotoURL = url; const img = el('img', { class: 'photo', src: url, alt: 'photo' }); photoEl.replaceWith(img); }
}

async function saveContact(id, payload) {
  // Save against the entity the form was built for — NOT the global currentId, which selectContact
  // sets before its GET resolves, so a Save during a load would otherwise PATCH the newly-selected
  // contact with the previously-displayed form (#127 review).
  try {
    await api('PATCH', `/api/v1/entities/${id}`, { body: payload });
    toast('Saved.');
    await selectContact(id);
    loadList();
  } catch (err) { reportError(err); }
}

async function uploadPhoto(file) {
  if (!file) return;
  try {
    await api('POST', `/api/v1/entities/${currentId}/photo`, { rawBody: file, contentType: file.type || 'application/octet-stream' });
    toast('Photo updated.');
    await selectContact(currentId);
  } catch (err) { reportError(err); }
}

// --- aliases ---
function renderAliases(id, aliases) {
  const fs = el('fieldset', {}, el('legend', {}, 'Aliases'));
  fs.append(el('p', { class: 'hint' }, 'Names/handles a contact resolves by. Emails & phones are managed above; removing one here also drops it.'));
  for (const a of aliases) {
    fs.append(el('div', { class: 'alias' },
      el('span', { class: 'atype' }, a.alias_type || '—'),
      el('span', { class: 'aval' }, a.alias),
      el('button', { type: 'button', class: 'danger', title: 'Remove alias', onclick: () => removeAlias(id, a) }, '✕')));
  }
  // add name/handle alias
  const aliasInput = el('input', { type: 'text', placeholder: 'add another name or handle' });
  const typeSel = el('select', {}, el('option', { value: 'name' }, 'name'), el('option', { value: 'handle' }, 'handle'));
  // Add button between the type dropdown and the input (#127) — consistent with the relationship row.
  fs.append(el('div', { class: 'addrel' }, typeSel,
    el('button', { type: 'button', onclick: () => addAlias(id, aliasInput.value.trim(), typeSel.value) }, 'Add'),
    aliasInput));
  return fs;
}
async function addAlias(id, alias, alias_type) {
  if (!alias) return;
  try { await api('POST', `/api/v1/entities/${id}/aliases`, { body: { alias, alias_type } }); toast('Alias added.'); await selectContact(id); }
  catch (err) { reportError(err); }
}
async function removeAlias(id, a) {
  try { await api('DELETE', `/api/v1/entities/${id}/aliases`, { body: { alias: a.alias, alias_type: a.alias_type } }); toast('Alias removed.'); await selectContact(id); }
  catch (err) { reportError(err); }
}

// --- relationships ---
function renderRelations(id, relations, relationsIn) {
  const fs = el('fieldset', {}, el('legend', {}, 'Relationships'));
  // group outgoing edges by type (multiple children/parents live here as multiple rows)
  const groups = {};
  for (const r of relations) (groups[r.relation_type] ||= []).push(r);
  for (const type of Object.keys(groups).sort()) {
    const g = el('div', { class: 'rel-group' }, el('h4', {}, type));
    for (const r of groups[type]) {
      g.append(el('div', { class: 'rel' },
        el('span', { class: 'rel-name' }, r.name || `#${r.entity_id}`, r.raw_label && r.raw_label !== type ? ` (${r.raw_label})` : ''),
        el('button', { type: 'button', class: 'danger', title: 'Remove', onclick: () => removeRelation(id, r.relation_id ?? r.id, r) }, '✕')));
    }
    fs.append(g);
  }
  if (relationsIn?.length) {
    const g = el('div', { class: 'rel-group' }, el('h4', {}, 'referenced by'));
    for (const r of relationsIn) g.append(el('div', { class: 'rel' },
      el('span', { class: 'rel-name' }, r.name || `#${r.entity_id}`), el('span', { class: 'rel-dir' }, `${r.relation_type} →`)));
    fs.append(g);
  }
  fs.append(buildAddRelation(id));
  return fs;
}

function buildAddRelation(id) {
  const typeSel = el('select', {}, ...RELATION_TYPES.map((t) => el('option', { value: t }, t)));
  const target = el('input', { type: 'text', placeholder: 'search a contact, or type a new name' });
  const results = el('div', { class: 'results', hidden: true });
  let chosen = null; // { id, name }
  const addBtn = el('button', { type: 'button' }, 'Add');

  let searchTimer;
  target.addEventListener('input', () => {
    chosen = null;
    clearTimeout(searchTimer);
    const q = target.value.trim();
    if (!q) { results.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const { entities } = await api('GET', `/api/v1/entities?query=${encodeURIComponent(q)}&limit=8`);
        results.replaceChildren();
        for (const e of entities) if (e.id !== id) results.append(el('div', { onclick: () => { chosen = { id: e.id, name: e.canonical_name }; target.value = e.canonical_name; results.hidden = true; } }, `${e.canonical_name} (${e.kind})`));
        results.append(el('div', { style: 'color:var(--muted)', onclick: () => createAndChoose(q, 'person', target, (c) => { chosen = c; results.hidden = true; }) }, `+ Create person "${q}"`));
        results.append(el('div', { style: 'color:var(--muted)', onclick: () => createAndChoose(q, 'org', target, (c) => { chosen = c; results.hidden = true; }) }, `+ Create org "${q}"`));
        results.hidden = false;
      } catch (err) { reportError(err); }
    }, 220);
  });

  addBtn.addEventListener('click', async () => {
    if (!chosen) { toast('Pick a contact from the list (or create one) first.', true); return; }
    const type = typeSel.value;
    const body = type === 'custom' ? { to_entity_id: chosen.id, raw_label: target.value.trim() || 'related' } : { to_entity_id: chosen.id, relation_type: type };
    try { await api('POST', `/api/v1/entities/${id}/relations`, { body }); toast('Relationship added.'); await selectContact(id); }
    catch (err) { reportError(err); }
  });

  // Add button between the type dropdown and the target field (#127).
  return el('div', {}, el('div', { class: 'addrel' }, typeSel, addBtn, el('div', { class: 'reltarget' }, target, results)));
}

async function createAndChoose(name, kind, targetInput, cb) {
  try {
    const { id } = await api('POST', '/api/v1/entities', { body: { kind, canonical_name: name } });
    targetInput.value = name;
    toast(`Created ${kind} "${name}".`);
    loadList();
    cb({ id, name });
  } catch (err) { reportError(err); }
}

async function removeRelation(entityId, relationId, r) {
  if (relationId == null) { toast('Cannot remove: missing relation id.', true); return; }
  try { await api('DELETE', `/api/v1/entities/${entityId}/relations/${relationId}`, {}); toast('Relationship removed.'); await selectContact(entityId); }
  catch (err) { reportError(err); }
}

// --- duplicates + merge (#120) ---
// Consumes GET /api/v1/entities/duplicates and POST /api/v1/entities/merge (server-owned; connectors
// may never merge — contract §1.2). Merge is one-way: the absorbed id is tombstoned (entities.merged_into),
// never deleted, so the survivor is the user's explicit choice.
// Focus management for the role=dialog overlay: move focus into the panel on open and restore it
// to whatever was focused (the Duplicates button, or a toast action) on close.
let dupReturnFocus = null;
function openDuplicates() {
  dupReturnFocus = document.activeElement;
  $('dupPanel').hidden = false;
  $('dupClose').focus();
  loadDuplicates();
}
function closeDuplicates() {
  $('dupPanel').hidden = true;
  if (dupReturnFocus && typeof dupReturnFocus.focus === 'function') dupReturnFocus.focus();
  dupReturnFocus = null;
}

async function loadDuplicates() {
  if (!apiKey()) return showKeyBar('Enter your API key to begin.');
  try {
    const { pairs = [] } = await api('GET', '/api/v1/entities/duplicates?limit=50');
    renderDuplicates(pairs);
  } catch (err) { reportError(err); }
}

function renderDuplicates(pairs) {
  const wrap = $('dupList');
  wrap.replaceChildren();
  if (!pairs.length) { wrap.append(el('p', { class: 'empty' }, 'No probable duplicates.')); return; }
  for (const p of pairs) {
    // A radio per side picks the survivor (default: the first, higher-ranked side); the other is absorbed.
    const grp = `keep-${p.a.id}-${p.b.id}`;
    const inputA = el('input', { type: 'radio', name: grp, checked: true });
    const inputB = el('input', { type: 'radio', name: grp });
    const choice = (input, side) => el('label', { class: 'dup-choice' }, input,
      el('span', { class: 'dup-name' }, side.name || `#${side.id}`), el('span', { class: 'dup-id' }, `#${side.id}`));
    const mergeBtn = el('button', { type: 'button', class: 'primary' }, 'Merge');
    mergeBtn.addEventListener('click', () => {
      const keepId = inputA.checked ? p.a.id : p.b.id;
      const absorbId = inputA.checked ? p.b.id : p.a.id;
      mergePair(keepId, absorbId);
    });
    wrap.append(el('div', { class: 'dup-pair' },
      el('div', { class: 'dup-top' }, el('span', { class: 'dup-score' }, String(p.score)), el('span', { class: 'dup-reason' }, p.reason || '')),
      el('div', { class: 'dup-choices' }, choice(inputA, p.a), choice(inputB, p.b)),
      el('div', { class: 'dup-actions' }, el('span', { class: 'hint' }, 'Keep the selected contact; the other is merged in (one-way).'), mergeBtn)));
  }
}

async function mergePair(keepId, absorbId) {
  if (!confirm(`Merge contact #${absorbId} into #${keepId}? This is one-way and cannot be undone.`)) return;
  try {
    const { moved = {} } = await api('POST', '/api/v1/entities/merge', { body: { keep_id: keepId, absorb_id: absorbId } });
    toast(`Merged: ${moved.aliases || 0} aliases, ${moved.links || 0} links, ${moved.relations || 0} relations.`);
    // If the open contact was the one absorbed, its detail is now a tombstone — follow to the survivor.
    if (currentId === absorbId) selectContact(keepId);
    loadList();
    loadDuplicates();
  } catch (err) { reportError(err); }
}

$('duplicates').addEventListener('click', openDuplicates);
$('dupClose').addEventListener('click', closeDuplicates);
// Escape closes the dialog (focus is inside the panel while it's open, so the handler receives it).
$('dupPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDuplicates(); });

// --- proposed entities review (#143) ---
// Human-approval gate for auto-proposed person/org entities (#119 proposed_entities table): email
// senders, OCR'd doc vendors, etc. land as status='pending' instead of silently minting a contact.
// Consumes GET /api/v1/entities/proposed + POST /api/v1/entities/proposed/:id/{approve,reject}. Approve
// mints (or links to an existing) entity and returns {entity_id}; Reject marks it rejected
// (append-only — a re-ingest never re-raises it). Same drawer/focus discipline as #dupPanel.
let propReturnFocus = null;
function openProposed() {
  propReturnFocus = document.activeElement;
  $('propPanel').hidden = false;
  $('propClose').focus();
  loadProposed();
}
function closeProposed() {
  $('propPanel').hidden = true;
  if (propReturnFocus && typeof propReturnFocus.focus === 'function') propReturnFocus.focus();
  propReturnFocus = null;
}

async function loadProposed() {
  if (!apiKey()) return showKeyBar('Enter your API key to begin.');
  try {
    const { proposals = [] } = await api('GET', '/api/v1/entities/proposed?status=pending&limit=50');
    renderProposed(proposals);
  } catch (err) { reportError(err); }
}

function renderProposed(proposals) {
  const wrap = $('propList');
  wrap.replaceChildren();
  if (!proposals.length) { wrap.append(el('p', { class: 'empty' }, 'No pending proposals.')); return; }
  for (const p of proposals) {
    const approveBtn = el('button', { type: 'button', class: 'primary', onclick: () => approveProposal(p.id) }, 'Approve');
    const rejectBtn = el('button', { type: 'button', class: 'danger', onclick: () => rejectProposal(p.id) }, 'Reject');
    wrap.append(el('div', { class: 'dup-pair' },
      el('div', { class: 'dup-top' },
        el('span', { class: 'kind-badge' }, p.suggested_kind || '?'),
        el('span', { class: 'dup-name' }, p.suggested_name || `#${p.id}`),
        el('span', { class: 'dup-id' }, `#${p.id}`)),
      el('div', { class: 'prop-fields' },
        el('span', {}, `${p.alias} (${p.alias_type})`),
        el('span', { class: 'dup-reason' }, `source: ${p.source ?? '—'}`),
        el('span', { class: 'dup-reason' }, `confidence: ${p.confidence ?? '—'}`),
        el('span', { class: 'dup-reason' }, p.created_at || '')),
      el('div', { class: 'dup-actions' }, approveBtn, rejectBtn)));
  }
}

async function approveProposal(id) {
  if (!confirm(`Approve proposal #${id}? This mints (or links) a contact in the graph.`)) return;
  try {
    const { entity_id } = await api('POST', `/api/v1/entities/proposed/${id}/approve`, {});
    toast(`Approved → contact #${entity_id}.`, false, { label: 'View', onClick: () => { closeProposed(); selectContact(entity_id); } });
    loadProposed();
    loadList();
  } catch (err) { reportError(err); loadProposed(); } // 409 already-resolved / 404: surface + drop the stale row
}

async function rejectProposal(id) {
  try {
    await api('POST', `/api/v1/entities/proposed/${id}/reject`, {});
    toast('Proposal rejected.');
    loadProposed();
  } catch (err) { reportError(err); loadProposed(); } // 409 already-approved / 404: surface + re-fetch
}

// #162: stage proposals from the side contact directory (#154) into the queue, then refresh it.
async function stageFromDirectory() {
  if (!apiKey()) return showKeyBar('Enter your API key to begin.');
  try {
    const { scanned = 0, proposed = 0 } = await api('POST', '/api/v1/entities/proposed/stage-from-directory', {});
    toast(`Staged ${proposed} proposal(s) from directory (${scanned} handle(s) scanned).`);
    loadProposed();
  } catch (err) { reportError(err); }
}

$('proposed').addEventListener('click', openProposed);
$('propStage').addEventListener('click', stageFromDirectory);
$('propClose').addEventListener('click', closeProposed);
$('propPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProposed(); });

// --- new contact ---
$('newContact').addEventListener('click', async () => {
  const name = prompt('New contact name:');
  if (!name || !name.trim()) return;
  const kind = confirm('Is this an organization? OK = org, Cancel = person') ? 'org' : 'person';
  try {
    const { id } = await api('POST', '/api/v1/entities', { body: { kind, canonical_name: name.trim() } });
    await loadList();
    selectContact(id);
  } catch (err) { reportError(err); }
});

// Top-bar Save (#127): saves the open contact via the current detail closure. Hidden until one is open.
$('saveTop').addEventListener('click', () => { if (currentSave) currentSave(); });

// --- search + filter wiring ---
let searchTimer;
$('search').addEventListener('input', (e) => { searchTerm = e.target.value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 220); });
for (const b of $('kindFilter').querySelectorAll('button')) b.addEventListener('click', () => {
  currentKind = b.dataset.kind;
  for (const x of $('kindFilter').querySelectorAll('button')) x.classList.toggle('active', x === b);
  loadList();
});

// --- boot ---
// Capability-URL bootstrap (#161): when served under /ui/<token>/<file> (UI_URL_TOKEN set), seed the
// API key from the path token so a bookmark authorizes /api calls with no manual entry. The plain
// /ui/<file> dev mount has no token segment, so this no-ops and the manual key flow below runs.
seedKeyFromPathToken();
if (apiKey()) loadList(); else showKeyBar('Enter your API key to begin.');

function seedKeyFromPathToken() {
  const seg = location.pathname.match(/^\/([^/]+)\/ui\/[^/]+$/)?.[1]; // token-first /<token>/ui/<file> (#165)
  if (!seg) return;
  if (localStorage.getItem(KEY_STORAGE)) return; // don't clobber an already-stored key / needlessly persist the token (Copilot, PR #163)
  try { localStorage.setItem(KEY_STORAGE, decodeURIComponent(seg)); }
  catch { localStorage.setItem(KEY_STORAGE, seg); } // malformed %-escape: fall back to the raw segment
}
