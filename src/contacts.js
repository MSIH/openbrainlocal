#!/usr/bin/env node
/**
 * Contacts connector (vCard). Contacts are the spine of the entity graph (design §2.2):
 * each contact seeds a person `entity` + its `entity_aliases` (name/email/phone), and a
 * `type='contact'` artifact so the person is semantically searchable and everything else
 * can hard-link to them later.
 *
 * Isolated, restartable script (design §3): idempotent via (source, source_id=UID) or
 * content_hash, and it merges a contact into an existing entity when an alias already
 * resolves — accepting the occasional manual merge over chasing full auto-resolution.
 *   Run:  npm run import:contacts <file.vcf>
 *
 * Hand-rolled minimal vCard parser (built-ins over deps): RFC line-unfolding plus a
 * connector-agnostic contact superset (docs/03-ob2-design.md §2.2) that Apple/Google/Android
 * exports map onto. Apple 3.0 groups labeled properties under an `itemN.` prefix and carries
 * an `X-ABLabel` sibling (e.g. `item1.X-ABDATE` + `item1.X-ABLabel:_$!<Anniversary>!$_`); we
 * split the group prefix off the property name and pair each value with its label after the
 * whole card is read (order-independent). vCard 4.0 equivalents (ANNIVERSARY/RELATED/NICKNAME)
 * are read by property name too, so both versions land in the same shape.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  db, storeArtifactTxn, sha256, logEvent,
  insertEntityStmt, insertAliasStmt, resolveEntityIds, normalizeName, normalizePhone,
  canonicalRelationType, upsertEntityRelation, stageRelationHint, resolveRelationHints,
} from './db.js';
import { embedToFloat32 } from './embeddings.js';
import { CONTACTS_RAW_DIR } from './config.js';

const findBySource = db.prepare('SELECT id FROM artifacts WHERE source = ? AND source_id = ?');
const findByHash = db.prepare('SELECT id FROM artifacts WHERE content_hash = ? LIMIT 1');

// Legacy single-property IM extensions (pre-IMPP). service = the tag after `X-`.
const LEGACY_IM_PROPS = new Set([
  'X-AIM', 'X-MSN', 'X-YAHOO', 'X-ICQ', 'X-JABBER', 'X-SKYPE', 'X-SKYPE-USERNAME', 'X-GTALK', 'X-GADUGADU', 'X-GROUPWISE',
]);

// Single-pass unescape: decode each escape once so a literal escaped backslash (\\n) isn't
// re-interpreted by a later pass.
const unescape = (v) => v.replace(/\\([nN,;\\])/g, (_, ch) => (ch === 'n' || ch === 'N' ? '\n' : ch));

// Apple wraps its built-in label tokens as `_$!<Anniversary>!$_`; custom labels are stored
// verbatim. Decode the wrapper, pass everything else through unchanged.
export function decodeAppleLabel(label) {
  if (!label) return label;
  const m = label.match(/^_\$!<(.*)>!\$_$/);
  return m ? m[1] : label;
}

// Split a vCard property head into an optional `itemN` group, the uppercased property name,
// and its params ([{key, value}], keys uppercased; keys may repeat, e.g. TYPE=HOME;TYPE=CELL).
function splitProp(head) {
  const tokens = head.split(';');
  let name = tokens[0];
  let group = null;
  const gm = name.match(/^(item\d+)\.(.+)$/i);
  if (gm) { group = gm[1].toLowerCase(); name = gm[2]; }
  const params = tokens.slice(1).map((t) => {
    const eq = t.indexOf('=');
    return eq === -1
      ? { key: t.toUpperCase(), value: '' }
      : { key: t.slice(0, eq).toUpperCase(), value: t.slice(eq + 1) };
  });
  return { group, prop: name.toUpperCase(), params };
}

const paramValue = (params, key) => {
  const p = params.find((x) => x.key === key.toUpperCase());
  return p ? p.value : null;
};

// vCard date encodings vary (19930808, 1993-08-08, --0808); normalize a full YYYYMMDD/
// YYYY-MM-DD to dashed form for the embedded text, pass anything else through untouched.
// The raw value is kept in the structured `dates[]` field — this is display-only.
function formatVcardDate(v) {
  const m = String(v).match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : v;
}

// An IMPP value is a URI (`xmpp:user@host`, `aim:goim?screenname=foo`); the service comes from
// the X-SERVICE-TYPE param when present, else the URI scheme. handle = the part after the scheme.
function parseImpp(value, params) {
  const colon = value.indexOf(':');
  const scheme = colon === -1 ? null : value.slice(0, colon);
  const handle = colon === -1 ? value : value.slice(colon + 1);
  return { service: paramValue(params, 'X-SERVICE-TYPE') || scheme, handle };
}

const PHOTO_EXT_BY_MEDIA = [[/PNG/i, 'png'], [/GIF/i, 'gif'], [/JPE?G/i, 'jpg']];
const extForPhotoType = (t) => PHOTO_EXT_BY_MEDIA.find(([re]) => re.test(t ?? ''))?.[1] ?? null;

// Parse a vCard PHOTO property into a pure descriptor — no I/O here (finalizeCard stays a
// pure parser; decode/write happens in persistContactPhoto). Three shapes: vCard 4.0 inline
// `data:` URI, an external http(s) URI (never fetched — see persistContactPhoto), and vCard
// 3.0 `ENCODING=b`/`BASE64` + `TYPE=`. Unrecognized shapes return null (photo silently absent,
// same as no PHOTO property at all — this is optional data, not a required field).
export function parsePhoto(value, params) {
  const typeParam = paramValue(params, 'TYPE');
  const mediaTypeParam = paramValue(params, 'MEDIATYPE');
  const dataUri = value.match(/^data:([^;,]*);base64,(.*)$/is);
  if (dataUri) {
    const mediaType = dataUri[1] || mediaTypeParam || 'image/jpeg';
    return { kind: 'base64', data: dataUri[2], mediaType, ext: extForPhotoType(mediaType) || extForPhotoType(typeParam) || 'jpg' };
  }
  if (/^https?:\/\//i.test(value)) {
    return { kind: 'uri', url: value, mediaType: mediaTypeParam || (typeParam ? `image/${typeParam.toLowerCase()}` : null) };
  }
  const encoding = (paramValue(params, 'ENCODING') || '').toUpperCase();
  if (encoding === 'B' || encoding === 'BASE64') {
    const mediaType = mediaTypeParam || (typeParam ? `image/${typeParam.toLowerCase()}` : 'image/jpeg');
    return { kind: 'base64', data: value, mediaType, ext: extForPhotoType(typeParam) || extForPhotoType(mediaTypeParam) || 'jpg' };
  }
  return null;
}

// Strict base64 decode: rejects anything containing non-base64 characters rather than Node's
// lenient Buffer.from (which silently skips invalid chars and still returns partial bytes).
// A vCard PHOTO worth keeping should decode cleanly; garbage input becomes a logged skip, not
// a corrupt image file.
function decodeBase64Strict(raw) {
  const cleaned = raw.replace(/\s+/g, '');
  if (!cleaned || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
  return Buffer.from(cleaned, 'base64');
}

// Decode/write a photo descriptor (I/O layer — called before the transaction, like the embed
// call). Inline base64 -> content-addressed file under CONTACTS_RAW_DIR (idempotent: same
// bytes -> same path, skip-if-exists). External URI -> record the URL only, never fetched
// (contacts import must not make arbitrary network requests). Returns null (and logs) on any
// decode/write failure so one bad photo never aborts the rest of the import.
export function persistContactPhoto(photo) {
  if (!photo) return null;
  try {
    if (photo.kind === 'uri') return { photo_url: photo.url, media_type: photo.mediaType ?? null };
    if (photo.kind === 'base64') {
      const bytes = decodeBase64Strict(photo.data);
      if (!bytes || !bytes.length) throw new Error('undecodable or empty PHOTO data');
      const rawPath = path.join(CONTACTS_RAW_DIR, `${sha256(bytes)}.${photo.ext || 'jpg'}`);
      mkdirSync(CONTACTS_RAW_DIR, { recursive: true });
      if (!existsSync(rawPath)) writeFileSync(rawPath, bytes);
      return { raw_path: rawPath, media_type: photo.mediaType ?? null };
    }
  } catch (err) {
    console.error('contacts: failed to persist contact photo', err);
  }
  return null;
}

// Build the connector-agnostic contact object from a card's parsed property lines. Labels are
// resolved first (a group's X-ABLabel may precede OR follow its value line), then each line is
// routed. New list fields default to []; scalar fields are absent unless present. `address`,
// `org` (scalars) are kept as before for back-compat; `addresses[]` carries the full list.
function finalizeCard(lines, raw) {
  const c = {
    emails: [], phones: [], addresses: [], urls: [], dates: [], relatedNames: [],
    categories: [], nicknames: [], im: [], socialProfiles: [], raw,
  };
  const groupLabels = {};
  for (const l of lines) {
    if (l.group && l.prop === 'X-ABLABEL') groupLabels[l.group] = decodeAppleLabel(l.value);
  }
  for (const { group, prop, params, value } of lines) {
    const label = group ? groupLabels[group] : null;
    switch (prop) {
      case 'FN': c.fn = value; break;
      case 'N': {
        const [family, given, additional, prefix, suffix] = value.split(';');
        c.name = { family, given, additional, prefix, suffix };
        if (!c.fn) c.fn = [given, family].filter(Boolean).join(' ').trim() || value;
        break;
      }
      case 'EMAIL': c.emails.push(value); break;
      case 'TEL': c.phones.push(value); break;
      case 'BDAY': c.birthday = value; break;
      case 'ADR': { const a = value.split(';').filter(Boolean).join(', '); c.address = a; c.addresses.push(a); break; }
      case 'ORG': { const parts = value.split(';'); c.org = parts.filter(Boolean).join(', '); if (parts[1]) c.department = parts[1]; break; }
      case 'TITLE': c.title = value; break;
      case 'ROLE': c.role = value; break;
      case 'NOTE': c.note = value; break;
      case 'UID': c.uid = value; break;
      case 'NICKNAME': for (const n of value.split(',').map((s) => s.trim()).filter(Boolean)) c.nicknames.push(n); break;
      case 'URL': c.urls.push(value); break;
      case 'CATEGORIES': for (const g of value.split(',').map((s) => s.trim()).filter(Boolean)) c.categories.push(g); break;
      case 'X-ABDATE': c.dates.push({ type: label || 'Other', value }); break;
      case 'ANNIVERSARY': c.dates.push({ type: 'Anniversary', value }); break; // vCard 4.0
      case 'X-ABRELATEDNAMES': c.relatedNames.push({ type: label || 'Other', name: value }); break;
      case 'RELATED': c.relatedNames.push({ type: paramValue(params, 'TYPE') || label || 'Other', name: value }); break; // vCard 4.0
      case 'IMPP': c.im.push(parseImpp(value, params)); break;
      case 'X-SOCIALPROFILE': c.socialProfiles.push({ service: paramValue(params, 'TYPE'), url: value }); break;
      case 'X-PHONETIC-FIRST-NAME': (c.phonetic ??= {}).given = value; break;
      case 'X-PHONETIC-LAST-NAME': (c.phonetic ??= {}).family = value; break;
      case 'X-ABSHOWAS': if (value.toUpperCase() === 'COMPANY') c.isCompany = true; break;
      case 'KIND': if (value.toLowerCase() === 'org') c.isCompany = true; break;
      case 'PHOTO': { const p = parsePhoto(value, params); if (p) c.photo = p; break; }
      default:
        if (LEGACY_IM_PROPS.has(prop)) c.im.push({ service: prop.replace(/^X-/, '').replace(/-USERNAME$/, ''), handle: value });
        break;
    }
  }
  return c;
}

/**
 * Parse vCard text into structured contact objects. Exported for unit testing.
 * Handles RFC line-folding (continuation lines begin with space/tab), the Apple `itemN.` group
 * prefix, and multi-valued properties. Returns the connector-agnostic superset objects
 * (see finalizeCard): { fn, name, emails[], phones[], addresses[], address, org, title, role,
 * birthday, dates[], relatedNames[], categories[], nicknames[], urls[], im[], socialProfiles[],
 * phonetic, isCompany, note, uid, photo, raw }.
 */
export function parseVCards(text) {
  // Unfold folded lines, then normalize line endings.
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  const cards = [];
  let lines = null;    // parsed property lines of the current card
  let raw = null;      // trimmed raw lines, joined at END for content_hash
  for (const line of unfolded.split('\n')) {
    const trimmed = line.trim();
    if (/^BEGIN:VCARD$/i.test(trimmed)) { lines = []; raw = [trimmed]; continue; }
    if (lines == null) continue;
    raw.push(trimmed);
    if (/^END:VCARD$/i.test(trimmed)) { cards.push(finalizeCard(lines, raw.join('\n'))); lines = null; raw = null; continue; }

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const value = unescape(line.slice(colon + 1).trim());
    if (!value) continue;
    const { group, prop, params } = splitProp(line.slice(0, colon)); // strip group + params
    lines.push({ group, prop, params, value });
  }
  return cards.filter((c) => c.fn || c.emails.length || c.phones.length);
}

// Assemble the natural-language text_repr that gets embedded. Every superset field that carries
// recall value is folded in as a labeled line so keyword + semantic search can reach it.
// Exported for unit testing alongside parseVCards.
export function contactTextRepr(c) {
  const parts = [c.fn || c.emails[0] || 'Unnamed contact'];
  if (c.title || c.org) parts.push([c.title, c.org].filter(Boolean).join(' at '));
  if (c.nicknames.length) parts.push(`Nickname: ${c.nicknames.join(', ')}`);
  if (c.emails.length) parts.push(`Email: ${c.emails.join(', ')}`);
  if (c.phones.length) parts.push(`Phone: ${c.phones.join(', ')}`);
  if (c.birthday) parts.push(`Birthday: ${c.birthday}`);
  for (const d of c.dates) parts.push(`${d.type}: ${formatVcardDate(d.value)}`);
  if (c.address) parts.push(`Address: ${c.address}`);
  for (const r of c.relatedNames) parts.push(`${r.type}: ${r.name}`);
  if (c.urls.length) parts.push(`URL: ${c.urls.join(', ')}`);
  if (c.im.length) parts.push(`IM: ${c.im.map((i) => (i.service ? `${i.service}:${i.handle}` : i.handle)).join(', ')}`);
  if (c.socialProfiles.length) parts.push(`Social: ${c.socialProfiles.map((s) => (s.service ? `${s.service} ${s.url}` : s.url)).join(', ')}`);
  if (c.categories.length) parts.push(`Categories: ${c.categories.join(', ')}`);
  if (c.note) parts.push(c.note);
  return parts.join('. ') + '.';
}

// The structured superset fields, shared by the entity attrs and the artifact extra_json.
function structuredFields(c) {
  return {
    emails: c.emails, phones: c.phones, addresses: c.addresses,
    nicknames: c.nicknames, dates: c.dates, relatedNames: c.relatedNames,
    categories: c.categories, urls: c.urls, im: c.im, socialProfiles: c.socialProfiles,
  };
}

// Reuse an existing entity if any email or the name already resolves to one.
function resolveExistingEntity(c) {
  for (const email of c.emails) { const ids = resolveEntityIds(email); if (ids.length) return ids[0]; }
  if (c.fn) { const ids = resolveEntityIds(c.fn); if (ids.length) return ids[0]; }
  return null;
}

// Turn parsed relatedNames[] into person<->person edges (issue #37). A related name that
// already resolves to an entity becomes an edge now; one that doesn't is staged on this
// contact's artifact and formed later when that person is imported. Then resolve any relations
// that earlier imports staged pointing at THIS person (the reverse import order).
function linkRelations(fromEntityId, artifactId, relatedNames) {
  for (const rel of relatedNames) {
    if (!rel?.name) continue;
    const relationType = canonicalRelationType(rel.type);
    const targets = resolveEntityIds(rel.name).filter((id) => id !== fromEntityId);
    if (targets.length) {
      for (const toId of targets) {
        upsertEntityRelation({ from_entity_id: fromEntityId, to_entity_id: toId, relation_type: relationType, raw_label: rel.type, confidence: 1.0, source: 'vcard' });
      }
    } else {
      stageRelationHint(artifactId, rel.name, rel.type);
    }
  }
  resolveRelationHints(fromEntityId);
}

// One contact -> entity(+aliases) + contact artifact + self link, atomically. `photo` is the
// already-persisted-to-disk result of persistContactPhoto (or null) — I/O happens before this
// transaction opens, same as the embed call.
const importOneTxn = db.transaction((c, textRepr, contentHash, vec, photo) => {
  let entityId = resolveExistingEntity(c);
  let entityCreated = false;
  if (entityId == null) {
    const attrs = {
      ...structuredFields(c),
      birthday: c.birthday ?? null, address: c.address ?? null,
      org: c.org ?? null, department: c.department ?? null,
      title: c.title ?? null, role: c.role ?? null, note: c.note ?? null,
      phonetic: c.phonetic ?? null, isCompany: c.isCompany ?? false,
    };
    entityId = insertEntityStmt.run('person', c.fn || c.emails[0] || 'Unnamed', JSON.stringify(attrs)).lastInsertRowid;
    entityCreated = true;
  }
  if (c.fn) insertAliasStmt.run(entityId, normalizeName(c.fn), 'name');
  for (const n of c.nicknames) insertAliasStmt.run(entityId, normalizeName(n), 'name');
  for (const e of c.emails) insertAliasStmt.run(entityId, normalizeName(e), 'email');
  for (const p of c.phones) { const d = normalizePhone(p); if (d) insertAliasStmt.run(entityId, d, 'phone'); }

  const extra = photo ? { ...structuredFields(c), photo } : structuredFields(c);
  const res = storeArtifactTxn(
    { type: 'contact', source: 'vcard', source_id: c.uid ?? null, content_hash: contentHash,
      text_repr: textRepr, raw_path: photo?.raw_path ?? null, extra_json: JSON.stringify(extra) },
    vec,
    [{ entity_id: entityId, role: 'self', confidence: 1.0 }]
  );
  // Relations need the self-link (just written) to derive the "from" side of a staged hint.
  // Skip on a dedup hit — the first import already formed/staged them (all steps are idempotent).
  if (!res.deduped) linkRelations(entityId, res.id, c.relatedNames);
  return { entityCreated, artifactId: res.id, deduped: res.deduped };
});

export async function importContacts(text) {
  const cards = parseVCards(text);
  let entitiesCreated = 0, artifacts = 0, skipped = 0, photos = 0;
  for (const c of cards) {
    const textRepr = contactTextRepr(c);
    const contentHash = sha256(c.raw);
    // Pre-check dedup BEFORE embedding, so re-imports don't burn API calls.
    const exists = c.uid ? findBySource.get('vcard', c.uid) : findByHash.get(contentHash);
    if (exists) { skipped++; continue; }

    const vec = await embedToFloat32(textRepr); // enrich BEFORE the transaction
    const photo = persistContactPhoto(c.photo); // I/O BEFORE the transaction, same reasoning
    const r = importOneTxn(c, textRepr, contentHash, vec, photo);
    if (r.deduped) skipped++; else artifacts++;
    if (r.entityCreated) entitiesCreated++;
    if (photo) photos++;
  }
  const summary = { cards: cards.length, entitiesCreated, artifacts, skipped, photos };
  logEvent('import_contacts', 'contacts.js', summary);
  return summary;
}

// --- CLI ---
async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run import:contacts <file.vcf>');
    process.exit(1);
  }
  const summary = await importContacts(readFileSync(file, 'utf8'));
  console.log(
    `Contacts import complete: ${summary.artifacts} contacts added ` +
    `(${summary.entitiesCreated} new entities, ${summary.photos} photos preserved), ` +
    `${summary.skipped} skipped, of ${summary.cards} vCards.`
  );
  db.close();
}

// Run only as a CLI, not when imported for tests. pathToFileURL handles spaces, non-ASCII,
// and Windows paths that a hand-built file:// string would mismatch.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Contacts import failed:', err); process.exit(1); });
}
