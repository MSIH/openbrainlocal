/**
 * The single-artifact ingest endpoint (connector contract doc 04 §2–§4, roadmap M0
 * deliverable 1) plus the batch endpoint (#19, roadmap M0 deliverable 2). Keeps
 * server.js a wiring file: the shared zod payload schema, warning computation, the
 * embed-then-upsert orchestration, and the router factory all live here so the JSON-schema
 * generator (#20) reuses ONE definition.
 *
 * Contract shape (§2): 201 on create / 200 on update, body
 * { id, created, resolved_entities, unresolved_aliases } plus an optional `warnings` array
 * (present only when non-empty). Validation failures are 422 { error:'validation', issues:[…] }.
 * Design bias (§2): accept-with-warning wherever data isn't destructive; reject at the door
 * only what would silently lose data (a typo'd key, a missing upsert id, a bad hash format).
 *
 * Batch (§2): POST /ingest/batch loops `executeIngest` per item — one enrich+commit
 * transaction per artifact (upsertArtifactTxn is itself a db.transaction), so item N's
 * failure never touches items 1..N-1. The envelope schema (BatchEnvelopeSchema) validates
 * only shape/count (1–100 items); each item is parsed individually so one malformed item
 * yields `{error}` at its index, not a request-wide 422. Always 200 on a well-formed
 * envelope — per-item outcomes live in the body (`summary` + index-aligned `results`).
 */
import express from 'express';
import { z } from 'zod';

import { upsertArtifactTxn, getArtifactBySource } from './db.js';
import { embedToFloat32 } from './embeddings.js';
import { reverseGeocode } from './geocode.js';
import { isRegisteredType, isExtensionType } from './ingest-types.js';

const JSON_BODY_LIMIT = '256kb'; // contract §2 per-request cap (raw media never travels here)
const INGEST_BATCH_MAX = 100; // contract §2/§7 batch cap — named, not a magic number

// alias_type / role vocabularies (doc 04 §4). A hint that violates these is dropped with a
// warning rather than failing the whole artifact.
const ALIAS_TYPES = ['email', 'phone', 'name', 'handle'];
const HINT_ROLES = ['sender', 'recipient', 'pictured', 'mentioned', 'author', 'self', 'location_of'];

// Bare lowercase sha256 hex (no algorithm prefix) — matches core's sha256() helper so
// cross-import dedup compares by exact string equality (doc 04 §3).
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

// Per-hint schema (strict: an unknown key inside a hint is a malformed hint → dropped+warned,
// never a 422 that loses the artifact). Validated element-by-element in validateHints, so the
// payload schema itself only checks that entity_hints is an array.
const HintSchema = z.object({
  alias: z.string().min(1),
  alias_type: z.enum(ALIAS_TYPES),
  role: z.enum(HINT_ROLES).optional(),
  confidence: z.number().optional(), // clamped/sanitized core-side (db.js hintConfidence)
}).strict();

// Strict payload schema (doc 04 §3). `.strict()` → an unknown top-level key is 422, not a
// silently-dropped field. Optional (not nullable): explicit null on an optional field is 422 —
// nothing can be cleared through this API (append-only). source/source_id required (upsert key).
export const IngestPayloadSchema = z.object({
  source: z.string().min(1),
  source_id: z.string().min(1),
  type: z.string().refine((t) => isRegisteredType(t) || isExtensionType(t), {
    message: 'type must be a registered type or an x- extension (see GET /api/v1/ingest/types)',
  }),
  text_repr: z.string().min(1),
  occurred_at: z.string().min(1).optional(),
  content_hash: z.string().regex(CONTENT_HASH_RE, 'content_hash must be a bare lowercase sha256 hex string').optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  place_label: z.string().optional(),
  raw_path: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  entity_hints: z.array(z.unknown()).optional(),
}).strict();

// Envelope shape only (doc 04 §2 batch rule): 1–100 items, each still `z.unknown()` — item
// validation happens per-item in the route so one malformed item never 422s the whole batch.
// Deliberately NOT .strict(): unlike IngestPayloadSchema (where an unknown key is a likely
// typo that would silently lose data), an unrecognized envelope key is forward-compatible —
// a future `meta` field shouldn't 422 against an older server. Only shape/count is enforced.
export const BatchEnvelopeSchema = z.object({
  artifacts: z.array(z.unknown()).min(1).max(INGEST_BATCH_MAX),
});

// Validate hints one at a time: good ones pass through, malformed ones are dropped and
// reported as warnings (the artifact itself is never lost over a bad hint — doc 04 §2).
function validateHints(rawHints) {
  const hints = [];
  const warnings = [];
  (rawHints ?? []).forEach((h, i) => {
    const parsed = HintSchema.safeParse(h);
    if (parsed.success) hints.push(parsed.data);
    else warnings.push(`entity_hints[${i}] dropped: ${parsed.error.issues.map((x) => x.message).join('; ')}`);
  });
  return { hints, warnings };
}

// Non-destructive issues stay accept-with-warning (doc 04 §2): a missing occurred_at falls
// back to ingested_at for the timeline; an x- type is accepted but flagged unregistered.
export function computeWarnings(payload) {
  const warnings = [];
  if (payload.occurred_at == null) warnings.push('occurred_at missing; ingested_at used for timeline');
  // The schema guarantees a registered type OR an x- extension, so "not registered" ⇒ x-.
  if (!isRegisteredType(payload.type)) {
    warnings.push(`type "${payload.type}" is not in the registry; accepted as an x- extension type`);
  }
  return warnings;
}

/**
 * Orchestrate one ingest: decide whether the embedding must be (re)computed, fetch it BEFORE
 * the transaction (enrich-then-commit), then upsert. Re-embeds only when text_repr is new or
 * changed — a metadata-only upsert (or an identical retry) never calls Ollama. Returns
 * { result, warnings } where result is upsertArtifactTxn's { id, created, resolved, unresolved }.
 */
export async function executeIngest(payload) {
  const { hints, warnings: hintWarnings } = validateHints(payload.entity_hints);
  const warnings = [...computeWarnings(payload), ...hintWarnings];

  const existing = getArtifactBySource(payload.source, payload.source_id);
  const textChanged = !existing || payload.text_repr !== existing.text_repr;
  const vector = textChanged ? await embedToFloat32(payload.text_repr) : null;

  // Present fields only (the schema is .strict(), so unknown keys are already rejected 422, and
  // absent optionals are simply not on the object); serialize `extra` into extra_json. The
  // update path leaves any field not present here untouched.
  const { extra, entity_hints, ...rest } = payload;
  const artifact = { ...rest };
  if (extra !== undefined) artifact.extra_json = JSON.stringify(extra);

  // place_label is schema-optional but not schema-non-empty (unlike e.g. entity_hints' alias,
  // which is .min(1)) — a "" from a connector means "I don't have one," not "clear it." Treat
  // it exactly like an absent field: never forward it to upsertArtifactTxn, where a non-null ""
  // would win the COALESCE and silently wipe an existing value despite the contract's "nothing
  // can be cleared" rule (that rule only rejects an explicit `null`, not an empty string).
  if (artifact.place_label === '') delete artifact.place_label;

  // Core resolves place_label from raw coordinates when neither this payload nor the artifact's
  // current stored row already has one (issue #67) — mirrors the text_repr -> embedding
  // enrichment just above, but needs no textChanged-style gate: reverseGeocode is a pure local
  // lookup, not a network call, so it's cheap enough to just always run when eligible. Checking
  // `existing` (not just this payload) matters: a later upsert wave that resends lat/lon without
  // place_label must never clobber a value already resolved — whether that value came from a
  // connector's own explicit label or from this same enrichment on an earlier ingest.
  if (
    payload.latitude != null && payload.longitude != null && !payload.place_label
    && !existing?.place_label
  ) {
    const label = reverseGeocode(payload.latitude, payload.longitude);
    if (label) artifact.place_label = label;
  }

  const result = upsertArtifactTxn(artifact, vector, hints);
  return { result, warnings };
}

// Shared response shape (§2) for a successful ingest, single or batch — one place to change
// if the contract ever adds a field, instead of the single route and the batch loop drifting.
function formatIngestResult(result, warnings) {
  const body = {
    id: result.id,
    created: result.created,
    resolved_entities: result.resolved,
    unresolved_aliases: result.unresolved,
  };
  if (warnings.length) body.warnings = warnings;
  return body;
}

// Route-local wrapper (mirrors server.js): funnels async rejections into next(err) so the
// router error middleware / the app error funnel handle them.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// One item of a batch: validate then run the exact same executeIngest path as single ingest —
// UNCHANGED, so batch is a loop, not a second code path (#19 design decision). Never throws —
// a validation failure or a runtime failure (embed, constraint) becomes `{error, issues?}` at
// the caller's index instead of aborting the loop, so item N never poisons items 1..N-1
// (roadmap M0 deliverable 2 — one transaction per artifact; upsertArtifactTxn is itself a
// db.transaction, so a thrown error there rolls back only this item's own write).
async function ingestBatchItem(rawItem, index) {
  const parsed = IngestPayloadSchema.safeParse(rawItem);
  if (!parsed.success) return { error: 'validation', issues: parsed.error.issues };
  try {
    const { result, warnings } = await executeIngest(parsed.data);
    return formatIngestResult(result, warnings);
  } catch (err) {
    // Full detail logged server-side with the item index so a batch failure is attributable
    // (design-philosophy §4); the item is skipped, the loop continues. The client-facing body
    // stays generic — mirrors the app's own 500 posture (server.js's error funnel masks
    // internal errors behind "Internal server error"), so an embed/DB failure never leaks
    // internal connection details (e.g. the Ollama URL) to an API-key holder.
    console.error(`ingest batch item ${index} failed`, err);
    return { error: 'ingest_failed' };
  }
}

/**
 * Build the /api/v1 connector router. Mounted BEFORE the global 32 KB parser in server.js
 * so the 256 KB cap (contract §2) applies to ingest bodies while legacy routes keep their cap.
 * `requireAuth` is the shared x-api-key middleware, injected so this module stays server-agnostic.
 */
export function buildIngestRouter({ requireAuth }) {
  const router = express.Router();

  // Auth BEFORE the body parser: reject an unauthenticated caller on headers alone, so no one
  // without a key can make the server buffer/parse up to 256 KB (8x the legacy 32 KB budget).
  router.post('/ingest', requireAuth, express.json({ limit: JSON_BODY_LIMIT }), wrap(async (req, res) => {
    const payload = IngestPayloadSchema.parse(req.body); // ZodError → router error mw → 422
    const { result, warnings } = await executeIngest(payload);
    res.status(result.created ? 201 : 200).json(formatIngestResult(result, warnings));
  }));

  // Batch (#19, doc 04 §2): envelope-level 422 only for shape/count problems (not an array, 0
  // items, >100 items) — the same z.ZodError → 422 middleware below handles that. Item-level
  // failures never reach that middleware; they're caught per item in ingestBatchItem and
  // reported at their index. Always 200 on a well-formed envelope, per-item outcomes in the
  // body, so a connector never re-sends 99 good items because 1 failed.
  router.post('/ingest/batch', requireAuth, express.json({ limit: JSON_BODY_LIMIT }), wrap(async (req, res) => {
    const { artifacts } = BatchEnvelopeSchema.parse(req.body); // ZodError → router error mw → 422
    const summary = { created: 0, updated: 0, failed: 0 };
    const results = [];
    for (let i = 0; i < artifacts.length; i++) {
      const entry = await ingestBatchItem(artifacts[i], i);
      results.push(entry);
      if (entry.error) summary.failed++;
      else if (entry.created) summary.created++;
      else summary.updated++;
    }
    res.status(200).json({ summary, results });
  }));

  // Contract §2 validation shape (422) lives here, not in the app funnel — the legacy routes
  // keep their existing 400 "Validation Failed" body. Body-parser errors (413 oversize, 400
  // malformed JSON) carry a numeric status and fall through to the app error funnel.
  router.use((err, req, res, next) => {
    if (err instanceof z.ZodError) {
      return res.status(422).json({ error: 'validation', issues: err.issues });
    }
    next(err);
  });

  return router;
}
