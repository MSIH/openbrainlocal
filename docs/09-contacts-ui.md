# 09 — Contacts Management UI (#96)

A local web UI for curating the entity graph — the **spine** of LifeContext. Contacts imported from
vCards are messy (wrong emails, missing phones, unlinked relationships), and until now the only way
to fix the graph was `merge_entities`. This adds a browser UI + core REST endpoints to correct a
contact's fields, edit its aliases and relationships, and set a photo.

Open it at **`http://localhost:3000/ui/contacts.html`** (served as static assets from `public/`).

## Model: the entity graph is mutable curation state

The **artifact** store is append-only (design-philosophy §1) — the raw `contact` artifacts imported
from vCards (`raw_path`, `content_hash`) are **never touched** by this UI. What the UI edits is the
*derived* entity graph (`entities` / `entity_aliases` / `entity_relations`), exactly as
`merge_entities` already does. Every mutation writes an `ingest_log` row with before/after, so the
derived record's history stays reconstructable.

Why mutable rather than append-and-supersede: a *wrong* alias actively mis-resolves future ingests
(an email from the real owner won't match, a wrong number resolves to the wrong person). Removing it
repairs resolution — the whole point of the spine. Keeping a "deprecated" copy around wouldn't fix
that unless the resolution hot path learned to skip it. The original vCard remains the archive.

## Endpoints (`/api/v1/entities`, all `x-api-key`)

Core-owned curation surface — never a connector concern (contract §1.2), same family as
`/duplicates` and `/merge`. Errors map: `ALIAS_CONFLICT`→409, `NOT_FOUND`→404, `BAD_ALIAS`→422.

| Method + path | Body / query | Result |
|---|---|---|
| `GET /api/v1/entities` | `?query&kind&limit&offset` | `{ entities: [{id, kind, canonical_name, attrs, hasPhoto}] }` |
| `GET /api/v1/entities/:id` | — | `{ entity, aliases[], relations[], relations_in[], artifacts[] }` |
| `POST /api/v1/entities` | `{ kind: person\|org, canonical_name, attrs? }` | `201 { id }` |
| `PATCH /api/v1/entities/:id` | `{ canonical_name?, attrs? }` | `{ updated: true }` |
| `POST /api/v1/entities/:id/aliases` | `{ alias, alias_type: email\|phone\|name\|handle }` | `{ added }` |
| `DELETE /api/v1/entities/:id/aliases` | `{ alias, alias_type }` | `{ removed }` |
| `POST /api/v1/entities/:id/relations` | `{ to_entity_id, relation_type? \| raw_label? }` | `{ added, relation_type }` |
| `DELETE /api/v1/entities/:id/relations/:relationId` | — | `{ removed }` |
| `POST /api/v1/entities/:id/photo` | raw image bytes (`Content-Type: image/*`) | `{ photoFile }` |
| `GET /api/v1/entities/:id/photo` | — | image bytes (`404` if none) |

Backing helpers live in `src/db.js` (`listEntities`, `getEntityProfile`, `createEntity`,
`updateEntityAttrs`, `addAlias`, `removeAlias`, `removeRelation`, `setEntityPhotoFile`,
`getContactPhotoRawPath`) — relation adds reuse `upsertEntityRelation` + `canonicalRelationType`.

## Editing rules

- **Fields.** `PATCH` overwrites the contact's editable `attrs` (emails, phones, addresses, dates,
  org/title/department/note). Life dates `birthday` / `anniversary` / `deceased` are ISO date
  strings; a set `deceased` shows a "deceased" marker. Server-owned keys (`photoFile`, `raw_path`)
  can't be set or wiped via `PATCH` — they belong to the upload route and the importer.
- **Alias reconciliation.** On `PATCH`, added emails/phones become `entity_aliases`, dropped ones are
  deleted. A rename adds new name variants (`nameVariants`); old name aliases stay (a person may
  still be referenced by them).
- **Alias conflict.** email/phone are globally `UNIQUE(alias, alias_type)`. Adding one already owned
  by a *different* live entity returns `409 {error, conflict:{alias, alias_type, entity_id}}` — the
  two are likely the same person; merge them with `merge_entities` rather than forcing the alias.
  name/handle aliases are shareable (two people named "chris"), so they never conflict.
- **Relationships.** A relation is a directional edge (a `RELATION_TYPE_MAP` type, or `custom` with a
  free `raw_label`) to a target entity. **Multiple children/parents** are just multiple edges to
  distinct people — no schema change. The UI can create a new related person/org inline. Removing an
  edge is by its `relation_id` (now returned by `getRelations`).
- **Photos.** Upload sends the raw file bytes (not multipart); the server stores them
  content-addressed under `CONTACTS_RAW_DIR` (same store as vCard photos), records the basename in
  `attrs.photoFile`, and never overwrites (`flag:'wx'`). Display precedence: uploaded `photoFile`
  → the imported vCard photo (`raw_path`) → none. The UI fetches `/photo` as a blob with the key
  header and renders it (a plain `<img src>` can't send `x-api-key`). Cap: `CONTACT_PHOTO_MAX_BYTES`
  (default 10 MB → `413`); non-image `Content-Type` → `415`. Uploaded files are gitignored (`raw/`).
  The **list** marks which contacts have a photo with a small 📷 badge on the avatar, driven by
  `hasPhoto` on `GET /api/v1/entities` (uploaded `photoFile` OR imported `raw_path`) — no per-row
  image fetch (#113). This is the same "effective photo" precedence the face-match source uses (#112).

## Boundaries (out of scope)

- Editing a contact **does not re-embed** its original `contact` artifact (that's the ingest-upsert
  path's job). Corrections fix the profile + resolution aliases, not the artifact's vector.
- No bulk edit / CSV / undo UI; no auth beyond `x-api-key` (single trusted local user).

## Auth note

The static UI holds the API key in the browser's `localStorage` and sends it as `x-api-key` on
every data call. Fine for a local single-user tool; over a Cloudflare Tunnel (docs/07) the key is
exposed to that browser — acceptable since it's the owner's own browser, but don't embed the key in
a shared page.
