/**
 * The single-artifact ingest endpoint (connector contract doc 04 §2–§4, roadmap M0
 * deliverable 1). Keeps brainserver.js a wiring file: the shared zod payload schema, warning
 * computation, the embed-then-upsert orchestration, and the router factory all live here so
 * the future batch endpoint (#19) and the JSON-schema generator (#20) reuse ONE definition.
 *
 * Contract shape (§2): 201 on create / 200 on update, body
 * { id, created, resolved_entities, unresolved_aliases } plus an optional `warnings` array
 * (present only when non-empty). Validation failures are 422 { error:'validation', issues:[…] }.
 * Design bias (§2): accept-with-warning wherever data isn't destructive; reject at the door
 * only what would silently lose data (a typo'd key, a missing upsert id, a bad hash format).
 */
import express from 'express';
import { z } from 'zod';

import { upsertArtifactTxn, getArtifactBySource } from './db.js';
import { embedToFloat32 } from './embeddings.js';
import { isRegisteredType, isExtensionType } from './ingest-types.js';

const JSON_BODY_LIMIT = '256kb'; // contract §2 per-request cap (raw media never travels here)

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

  // Present fields only (zod strips unknown keys and omits absent optionals); serialize
  // `extra` into extra_json. The update path leaves any field not present here untouched.
  const { extra, entity_hints, ...rest } = payload;
  const artifact = { ...rest };
  if (extra !== undefined) artifact.extra_json = JSON.stringify(extra);

  const result = upsertArtifactTxn(artifact, vector, hints);
  return { result, warnings };
}

// Route-local wrapper (mirrors brainserver.js): funnels async rejections into next(err) so the
// router error middleware / the app error funnel handle them.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Build the /api/v1 connector router. Mounted BEFORE the global 32 KB parser in brainserver.js
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
    const body = {
      id: result.id,
      created: result.created,
      resolved_entities: result.resolved,
      unresolved_aliases: result.unresolved,
    };
    if (warnings.length) body.warnings = warnings;
    res.status(result.created ? 201 : 200).json(body);
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
