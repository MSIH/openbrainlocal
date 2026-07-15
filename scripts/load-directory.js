#!/usr/bin/env node
/**
 * Load a side contact directory (#154) from a full contacts export. This is a handle -> name
 * LOOKUP, deliberately SEPARATE from the curated entity graph: it creates NO entities/aliases.
 * Its only jobs downstream are (a) auto-labeling unknown handles for display and (b) staging
 * proposed_entities (name pre-filled) for review — promotion into the curated graph stays a
 * human-approved act (the whole point of keeping ~1000 contacts out of the graph).
 *
 * Reuses src/contacts.js's vCard parser; every phone/email of every card becomes one
 * contact_directory row keyed by its normalized handle (normalizePhone / lowercased email, #129).
 * Idempotent: UNIQUE(handle, handle_type) is first-writer-wins, a collision is logged, a re-run
 * loads 0 new rows. CSV exports are out of scope for now (vCard only).
 *   Run:  npm run directory:load <file.vcf>
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { db, insertDirectoryEntry, logEvent } from '../src/db.js';
import { parseVCards, preferredDisplayName } from '../src/contacts.js';

const directoryCountStmt = db.prepare('SELECT COUNT(*) AS n FROM contact_directory');

export function loadDirectory(text) {
  const cards = parseVCards(text);
  let contacts = 0, loaded = 0, collisions = 0;
  const run = db.transaction(() => {
    for (const c of cards) {
      // #158: first+last (drops a middle name), same rule as the curated display (#156); fall back
      // to the email as the label when a card has no FN but is addressable (parseVCards keeps those),
      // mirroring the import path's `preferredDisplayName(c) || c.emails[0]` — else we'd silently drop
      // directory coverage for nameless-but-addressable contacts (Copilot, PR #160).
      const name = (preferredDisplayName(c) || c.emails[0] || '').trim();
      if (!name) continue; // truly unlabelable (no name, no email) — nothing to show
      contacts++;
      for (const p of c.phones ?? []) { const r = insertDirectoryEntry(name, p, 'phone'); if (r.inserted) loaded++; if (r.collision) collisions++; }
      for (const e of c.emails ?? []) { const r = insertDirectoryEntry(name, e, 'email'); if (r.inserted) loaded++; if (r.collision) collisions++; }
    }
  });
  run();
  // total = distinct handles now in the directory (each row is one (handle, handle_type)); lets a
  // re-run confirm idempotency (loaded 0, total unchanged) and shows the directory size (#155).
  const summary = { contacts, loaded, collisions, total: directoryCountStmt.get().n };
  logEvent('directory_load', 'load-directory.js', summary);
  return summary;
}

// CLI only (not when imported for tests) — mirrors backfill-phone-aliases.js.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: npm run directory:load <file.vcf>'); process.exit(1); }
  const s = loadDirectory(readFileSync(file, 'utf8'));
  console.log(`directory:load — ${s.contacts} contacts, ${s.loaded} handle(s) loaded, ${s.collisions} collision(s); ${s.total} handle(s) in directory total.`);
  db.close();
}
