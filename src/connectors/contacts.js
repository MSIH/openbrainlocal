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
 * Hand-rolled minimal vCard parser (built-ins over deps): the handful of fields we need
 * plus RFC line-unfolding is simpler than a dependency.
 */
import { readFileSync } from 'node:fs';
import {
  db, storeArtifactTxn, sha256, logEvent,
  insertEntityStmt, insertAliasStmt, resolveEntityIds, normalizeName, normalizePhone,
} from '../db.js';
import { embedToFloat32 } from '../embeddings.js';

const findBySource = db.prepare('SELECT id FROM artifacts WHERE source = ? AND source_id = ?');
const findByHash = db.prepare('SELECT id FROM artifacts WHERE content_hash = ? LIMIT 1');

const unescape = (v) => v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

/**
 * Parse vCard text into structured contact objects. Exported for unit testing.
 * Handles RFC line-folding (continuation lines begin with space/tab) and multi-valued
 * EMAIL/TEL. Returns [{ fn, emails[], phones[], birthday, address, org, note, uid, raw }].
 */
export function parseVCards(text) {
  // Unfold folded lines, then normalize line endings.
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  const cards = [];
  let cur = null;
  for (const line of unfolded.split('\n')) {
    const trimmed = line.trim();
    if (/^BEGIN:VCARD$/i.test(trimmed)) { cur = { emails: [], phones: [], raw: [trimmed] }; continue; }
    if (!cur) continue;
    cur.raw.push(trimmed);
    if (/^END:VCARD$/i.test(trimmed)) { cur.raw = cur.raw.join('\n'); cards.push(cur); cur = null; continue; }

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const namePart = line.slice(0, colon);
    const value = unescape(line.slice(colon + 1).trim());
    if (!value) continue;
    const prop = namePart.split(';')[0].toUpperCase(); // strip params
    switch (prop) {
      case 'FN': cur.fn = value; break;
      case 'N': if (!cur.fn) { const [family, given] = value.split(';'); cur.fn = [given, family].filter(Boolean).join(' ').trim() || value; } break;
      case 'EMAIL': cur.emails.push(value); break;
      case 'TEL': cur.phones.push(value); break;
      case 'BDAY': cur.birthday = value; break;
      case 'ADR': cur.address = value.split(';').filter(Boolean).join(', '); break;
      case 'ORG': cur.org = value.split(';').filter(Boolean).join(', '); break;
      case 'TITLE': cur.title = value; break;
      case 'NOTE': cur.note = value; break;
      case 'UID': cur.uid = value; break;
      default: break;
    }
  }
  return cards.filter((c) => c.fn || c.emails.length || c.phones.length);
}

// Assemble the natural-language text_repr that gets embedded.
function contactTextRepr(c) {
  const parts = [c.fn || c.emails[0] || 'Unnamed contact'];
  if (c.title || c.org) parts.push([c.title, c.org].filter(Boolean).join(' at '));
  if (c.emails.length) parts.push(`Email: ${c.emails.join(', ')}`);
  if (c.phones.length) parts.push(`Phone: ${c.phones.join(', ')}`);
  if (c.birthday) parts.push(`Birthday: ${c.birthday}`);
  if (c.address) parts.push(`Address: ${c.address}`);
  if (c.note) parts.push(c.note);
  return parts.join('. ') + '.';
}

// Reuse an existing entity if any email or the name already resolves to one.
function resolveExistingEntity(c) {
  for (const email of c.emails) { const ids = resolveEntityIds(email); if (ids.length) return ids[0]; }
  if (c.fn) { const ids = resolveEntityIds(c.fn); if (ids.length) return ids[0]; }
  return null;
}

// One contact -> entity(+aliases) + contact artifact + self link, atomically.
const importOneTxn = db.transaction((c, textRepr, contentHash, vec) => {
  let entityId = resolveExistingEntity(c);
  let entityCreated = false;
  if (entityId == null) {
    const attrs = {
      emails: c.emails, phones: c.phones,
      birthday: c.birthday ?? null, address: c.address ?? null,
      org: c.org ?? null, title: c.title ?? null, note: c.note ?? null,
    };
    entityId = insertEntityStmt.run('person', c.fn || c.emails[0] || 'Unnamed', JSON.stringify(attrs)).lastInsertRowid;
    entityCreated = true;
  }
  if (c.fn) insertAliasStmt.run(entityId, normalizeName(c.fn), 'name');
  for (const e of c.emails) insertAliasStmt.run(entityId, normalizeName(e), 'email');
  for (const p of c.phones) { const d = normalizePhone(p); if (d) insertAliasStmt.run(entityId, d, 'phone'); }

  const res = storeArtifactTxn(
    { type: 'contact', source: 'vcard', source_id: c.uid ?? null, content_hash: contentHash,
      text_repr: textRepr, extra_json: JSON.stringify({ emails: c.emails, phones: c.phones }) },
    vec,
    [{ entity_id: entityId, role: 'self', confidence: 1.0 }]
  );
  return { entityCreated, artifactId: res.id, deduped: res.deduped };
});

export async function importContacts(text) {
  const cards = parseVCards(text);
  let entitiesCreated = 0, artifacts = 0, skipped = 0;
  for (const c of cards) {
    const textRepr = contactTextRepr(c);
    const contentHash = sha256(c.raw);
    // Pre-check dedup BEFORE embedding, so re-imports don't burn API calls.
    const exists = c.uid ? findBySource.get('vcard', c.uid) : findByHash.get(contentHash);
    if (exists) { skipped++; continue; }

    const vec = await embedToFloat32(textRepr); // enrich BEFORE the transaction
    const r = importOneTxn(c, textRepr, contentHash, vec);
    if (r.deduped) skipped++; else artifacts++;
    if (r.entityCreated) entitiesCreated++;
  }
  const summary = { cards: cards.length, entitiesCreated, artifacts, skipped };
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
    `(${summary.entitiesCreated} new entities), ${summary.skipped} skipped, of ${summary.cards} vCards.`
  );
  db.close();
}

// Run only as a CLI, not when imported for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error('Contacts import failed:', err); process.exit(1); });
}
