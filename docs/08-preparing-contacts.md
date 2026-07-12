# Preparing Contacts for Ingest

**Contacts are the spine of the entity graph** ([`03-ob2-design.md §2.2`](03-ob2-design.md)): every person you import seeds an `entity` + its aliases, and every later artifact (emails, texts, photos) links to that person by matching an alias. So the quality of recall — "what did Sarah text me", "everything about Mom" — is set by how clean your contacts are *before* import, not after.

This doc has two parts: a **primer** (what actually matters and why, grounded in what `src/contacts.js` does) and a **pre-clean checklist** (the source-side pass to run before `npm run import:contacts`).

> **The boundary this doc encodes:** *bulk cleanup happens at the source* (Google/Yahoo/iPhone — free-form editing, no audit-trail cost, do it now); *judgment calls happen in-system* (merge ambiguous people, assign relationships — logged and reversible via the curation API, #75 "entity merge + duplicate detection"). Don't try to do the second kind here.

---

## Part 1 — Primer: what the importer keys off

`import:contacts` (`src/contacts.js`) creates, per vCard: one person `entity`, a set of **aliases** (the full name, each nickname, each email, each phone), a searchable `type='contact'` artifact, and person↔person **relations** from `RELATED`/`X-ABRELATEDNAMES`. Resolution downstream matches against those aliases. So "good contacts" = "aliases that match what other sources will emit."

| What you set | How it's matched | Why it matters |
|---|---|---|
| **Email / phone** | Deterministic, **confidence 1.0** (`normalizePhone` = digits-only; email lowercased) | The money fields. Every channel — email `From:`, text sender, photo provenance — hard-links on these. A contact with *no* email/phone can only ever fuzzy-match by name. |
| **Name** | **Exact match after lowercasing** (`normalizeName` = `trim().toLowerCase()`) | No fuzzy matching, no accent folding (`José` ≠ `Jose`), no first/last reorder (`Smith, John` ≠ `John Smith`). Set the display name to the natural `First Last` form other sources produce. |
| **Nicknames** | Each becomes another **`name` alias** (capped at confidence 0.9) | The single biggest silent link-dropper. A text "from Mom" only links if `Mom` is a nickname. Add every variant: `Mom`/`Dad`, `Bob`→Robert, maiden names, initials. |
| **Company flag** | `X-ABSHOWAS:COMPANY` / `KIND:org` → `kind='org'` entity (#88) | Keeps businesses out of the *person* graph (dedup, face-matching, and person recall all skip `kind='org'`) so they don't surface as bogus people. |
| **Company (`ORG`)** on a person | Seeds a `worksAt` person→org edge (#88), resolved by the org **name** | Turns "Title at Acme" from fuzzy text into a queryable employment edge — `about_entity('Acme')` lists its people. Only forms if a **company contact** named exactly `Acme` is also imported (either order); an unmatched `ORG` invents no org entity, just stages the edge until one exists. |
| **Relationships** | `RELATED`/`X-ABRELATEDNAMES` → `entity_relations` edges (resolved by name) | Builds the person↔person graph (spouse/parent/sibling) that powers `about_entity`. Only resolves if the related name matches the *other* contact's name exactly. |
| **Contact photo** (`PHOTO`) | *(preserved once #74 "preserve vCard PHOTO on contact import" ships — currently dropped on import)* | The future face-recognition seed that can auto-label anonymous photo clusters. Keep it on the card. |

**Two things that are NOT worth your time:**

- **Phone *formatting*.** `(240) 997-4940`, `240.997.4940`, and `2409974940` all normalize to the identical digit string (`normalizePhone` strips every non-digit) and match. Don't reformat numbers. The *only* phone concern is digit **count** — a 10-digit `2409974940` won't match an 11-digit `12409974940` — so just be consistent about country code (US-default is fine if uniform).
- **Chasing 100% clean.** The store is append-only and corrections happen forward, and the curation API (#75) handles the residue. Get the bulk-obvious right and stop.

**Free dedup on import:** when a new card shares an **email or exact name** with an already-imported entity, `resolveExistingEntity` merges it into that entity automatically (aliases pooled). So importing overlapping exports collapses the overlaps for you — the leftover ("Bob" vs "Robert", no shared email) is the human residue for #75.

---

## Part 2 — Pre-clean checklist (source-side, before import)

**Golden rule: consolidate into ONE pile first, then clean once.** Cleaning Google, Yahoo, and iPhone separately just re-injects duplicates on import.

### 1. Consolidate everything into one Google account
- [ ] **Yahoo → vCard:** Yahoo Mail → Contacts → **Actions → Export** → **vCard** → download `.vcf`.
- [ ] **iPhone/iCloud → vCard:** [icloud.com](https://icloud.com) → **Contacts** → select all → gear (bottom-left) → **Export vCard…**.
- [ ] **Import both into Google:** [contacts.google.com](https://contacts.google.com) → **Import** → upload the Yahoo `.vcf`, then the iCloud `.vcf`. Everything now lives in one hub.

### 2. Kill duplicates (Google's built-in tool)
- [ ] [contacts.google.com](https://contacts.google.com) → **Merge & fix** → review and **Merge** the obvious ones. Skip anything that needs real judgment (see [Where to stop](#where-to-stop)).

### 3. Bulk-delete the junk *(no audit trail needed for these)*
- [ ] Dead business cards / vendors, no-name entries, spam/auto-added contacts, ancient work contacts you'll never reference. *(If unsure whether you'll want it — keep it; deletion here is permanent.)*

### 4. Fix names + add nicknames  ← highest ROI
- [ ] Fix garbled / ALL-CAPS / `"LASTNAME, First"` display names → natural **`First Last`**.
- [ ] Add a **Nickname** for every other name a source might use: `Mom`/`Dad`, short names (`Bob`→Robert, `Liz`→Elizabeth), maiden/previous names, initials/handles you actually use.
- [ ] Ensure each real person has **at least one email or phone** (the deterministic link keys).

### 5. Phone / address (light touch)
- [ ] **Do not reformat phones** — formatting is normalized away. Only fix a missing country code if your messaging data carries one. Low priority.
- [ ] Fix obviously wrong addresses if quick; otherwise leave (easy to append later).

### 6. Photos (optional, forward-looking)
- [ ] Where easy, keep a contact **photo** on key people — the future face-rec seed (#74). Don't go hunting; just don't strip existing ones.

### 7. Relationships — leave for later *(don't do this at the source)*
- [ ] **Skip.** Spouse/parent/sibling links, "is this Bob the same as Robert?", whose-contact-is-this (you vs spouse) — judgment calls, done **in-system** where each decision is logged and reversible (#75).

### 8. Export the clean pile and import
- [ ] [contacts.google.com](https://contacts.google.com) → select all → **Export** → **vCard** → download one clean `.vcf`. Keep it — it's your clean-state archive.
- [ ] `npm run import:contacts <clean.vcf>` (auto-merges on shared email/exact name).

---

## Where to stop

Stop the moment a decision needs judgment about a *person* rather than a *record*: merging ambiguous people, assigning relationships, untangling shared/spouse contacts, attaching camera-roll photos. Those are the in-system curation layer's job (#75 "entity merge + duplicate detection") — logged, reversible, and a much smaller pile once this bulk pass is done.

**Time-box it.** An hour or two on Steps 1–5 captures ~90% of the value. Past that is diminishing returns — the append-only store plus the curation API exist precisely so you don't have to make it perfect here.

---

## Ingest order & what happens on a no-match

**The order is two tiers, not a five-step chain.**

1. **Tier 1 — contacts.** Import these *first*: every person becomes an `entity` + its aliases, seeding the graph everything else resolves against.
2. **Tier 2 — everything else** (photos, emails, documents, texts): ingest in **any order**. Tier-2 artifacts carry entity *hints* (an email address, a phone, a name) that link to the *entities* contacts created — they never link to each other, so no Tier-2 source depends on another. Photos-before-emails, emails-before-texts: it doesn't matter.

**Contacts-first is a recommendation, not a hard requirement.** An artifact ingested before its contact exists is **not** dropped or rejected:

- It is stored, embedded, and FTS-indexed like any other artifact — fully recallable by **meaning, keyword, time, and place** immediately.
- Only the **entity link** is deferred: the unmatched hint is staged in `unresolved_aliases` (see [`03-ob2-design.md §2.2`](03-ob2-design.md) and [`04-connector-contract.md §4`](04-connector-contract.md)). Until it resolves, that artifact won't surface under `about_entity("<person>")` or an entity-filtered search — everything else about it works.
- When you later import the matching contact, the stage resolves **automatically** (`resolveStagedArtifactHints` runs on every contact import) and every queued artifact links to the new person — no re-ingest, no separate command (#102). A one-shot `npm run backfill:links` heals anything staged before that mechanism existed.

So the cost of ingesting out of order is temporary (missing person links until the contact lands), never permanent — which is why contacts-first is the *recommended* sequence rather than an enforced one.

## Other sources

*Placeholder — photo-prep and document-prep checklists will land here as the [`photo-exif`](../connectors/photo-exif/) and [`documents`](../connectors/documents/) pipelines mature. The same principle applies: cheap normalization at the source, judgment in-system.*
