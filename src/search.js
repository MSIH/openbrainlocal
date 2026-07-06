/**
 * Retrieval: the query planner (docs/03-ob2-design.md §4). A search becomes two stages:
 *   1. Parse the query into structured filters + a semantic core (one cheap LLM call).
 *   2. SQL-prefilter the candidate set, vector-rank + FTS-rank within it, fuse with RRF.
 *
 * Degrades gracefully: if the chat model (QUERY_MODEL) is unreachable we fall back to a
 * no-filter plan (pure semantic); if the embedding model is down we fall back to FTS-only.
 * Search never throws just because Ollama is offline.
 */
import { z } from 'zod';
import { db, resolveEntityIds, getEntity, getArtifactById } from './db.js';
import { ai, embedToFloat32 } from './embeddings.js';
import { QUERY_MODEL, RRF_K, KNN_OVERFETCH, KNN_MIN, KNN_MAX } from './config.js';

export const ARTIFACT_TYPES = ['email', 'document', 'photo', 'video', 'contact', 'post', 'location_ping', 'note'];

const PLAN_TIMEOUT_MS = 8000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const emptyish = (s) => (typeof s === 'string' && s.trim() ? s : null);

// --- Query-plan schema (validates the LLM's JSON; coerces junk to safe defaults) ---
const PlanSchema = z.object({
  types: z.array(z.enum(ARTIFACT_TYPES)).catch([]).default([]),
  entities: z.array(z.string()).catch([]).default([]),
  place: z.string().nullable().catch(null).default(null),
  time_start: z.string().nullable().catch(null).default(null),
  time_end: z.string().nullable().catch(null).default(null),
  semantic: z.string().catch('').default(''),
});

const fallbackPlan = (query) => ({ types: [], entities: [], place: null, time_start: null, time_end: null, semantic: query });

function planSystemPrompt(today) {
  return [
    `You convert a personal-memory query into a JSON filter plan. Today is ${today}.`,
    'Return ONLY a JSON object with keys:',
    `  types: array of any of [${ARTIFACT_TYPES.join(', ')}], or []`,
    '  entities: array of person/place/org names exactly as written, or []',
    '  place: a place string, or null',
    '  time_start, time_end: ISO dates (YYYY-MM-DD) resolving any relative time, or null',
    '  semantic: the meaning-bearing core of the query (always a non-empty string)',
    'Do not invent filters the query does not imply. Emit valid JSON only.',
  ].join('\n');
}

async function parseQuery(query) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const resp = await ai.chat.completions.create(
      {
        model: QUERY_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: planSystemPrompt(today) },
          { role: 'user', content: query },
        ],
      },
      { timeout: PLAN_TIMEOUT_MS, maxRetries: 0 }
    );
    const parsed = PlanSchema.safeParse(JSON.parse(resp.choices[0].message.content));
    if (parsed.success) {
      const p = parsed.data;
      return { ...p, semantic: emptyish(p.semantic) || query };
    }
    console.error('query-plan: schema mismatch, using pure-semantic fallback', parsed.error.issues);
  } catch (err) {
    console.error('query-plan: LLM parse failed, using pure-semantic fallback:', err.message);
  }
  return fallbackPlan(query);
}

// --- Statements ---
// One fixed prepared statement; each clause self-neutralizes when its param is NULL.
// Arrays are passed as JSON and unnested with json_each — keeps it a single compiled
// statement (no SQL string-building, coding-standards rule).
const candidateStmt = db.prepare(`
  SELECT DISTINCT a.id
  FROM artifacts a
  LEFT JOIN entity_links el ON el.artifact_id = a.id
  WHERE (@types_json IS NULL OR a.type IN (SELECT value FROM json_each(@types_json)))
    AND (@ents_json  IS NULL OR el.entity_id IN (SELECT value FROM json_each(@ents_json)))
    AND (@t0 IS NULL OR a.occurred_at >= @t0)
    AND (@t1 IS NULL OR a.occurred_at <= @t1)
    AND (@place IS NULL OR a.place_label LIKE @place)
`);
const knnStmt = db.prepare('SELECT artifact_id, distance FROM vec_artifacts WHERE embedding MATCH ? AND k = ? ORDER BY distance');
const ftsStmt = db.prepare('SELECT rowid AS artifact_id, bm25(artifacts_fts) AS score FROM artifacts_fts WHERE artifacts_fts MATCH ? ORDER BY score LIMIT ?');
const timelineStmt = db.prepare(`
  SELECT * FROM artifacts
  WHERE (@start IS NULL OR occurred_at >= @start)
    AND (@end   IS NULL OR occurred_at <= @end)
    AND (@types_json IS NULL OR type IN (SELECT value FROM json_each(@types_json)))
  ORDER BY occurred_at ASC
  LIMIT @limit
`);
const aboutStmt = db.prepare(`
  SELECT a.* FROM entity_links el JOIN artifacts a ON a.id = el.artifact_id
  WHERE el.entity_id = ? ORDER BY a.occurred_at DESC LIMIT ?
`);

// Turn free text into a safe FTS5 MATCH: OR of quoted word-tokens. Quoting each token
// neutralizes FTS5 operators (", *, NEAR, :) that would otherwise throw on raw input.
function toFtsQuery(text) {
  const terms = (text.match(/[\p{L}\p{N}]+/gu) || []).map((t) => `"${t}"`);
  return terms.length ? terms.join(' OR ') : null;
}

// Reciprocal rank fusion over N ranked id-lists: score = Σ 1/(RRF_K + rank).
function rrf(lists, k = RRF_K) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Hybrid search. Explicit args (types/timeRange/entities) win over the parsed plan;
 * the LLM fills whatever the caller didn't specify. Returns hydrated artifacts, with
 * `distance` from the vector arm when available (null for FTS-only hits).
 */
export async function hybridSearch(query, { limit = 3, types, timeRange, entities } = {}) {
  const plan = await parseQuery(query);

  const effTypes = types?.length ? types : plan.types;
  const t0 = emptyish(timeRange?.start) || emptyish(plan.time_start);
  const t1 = emptyish(timeRange?.end) || emptyish(plan.time_end);
  const entTerms = entities?.length ? entities : plan.entities;
  const place = emptyish(plan.place);

  const entityIds = entTerms.flatMap((t) => resolveEntityIds(t));

  // SQL prefilter -> candidate id set (skip entirely when there are no structured filters).
  let candidates = null;
  if (effTypes.length || entityIds.length || t0 || t1 || place) {
    const rows = candidateStmt.all({
      types_json: effTypes.length ? JSON.stringify(effTypes) : null,
      ents_json: entityIds.length ? JSON.stringify(entityIds) : null,
      t0: t0 || null,
      t1: t1 || null,
      place: place ? `%${place}%` : null,
    });
    candidates = new Set(rows.map((r) => r.id));
    if (candidates.size === 0) return []; // filters matched nothing — semantic can't rescue it
  }

  const k = clamp(limit * KNN_OVERFETCH, KNN_MIN, KNN_MAX);

  // Vector arm — best-effort; FTS still works if the embedding model is offline.
  let vec = [];
  try {
    const qvec = await embedToFloat32(plan.semantic || query);
    vec = knnStmt.all(qvec, k);
    if (candidates) vec = vec.filter((r) => candidates.has(r.artifact_id));
  } catch (err) {
    console.error('search: embedding unavailable, FTS-only:', err.message);
  }

  // Keyword arm.
  const ftsQuery = toFtsQuery(plan.semantic || query);
  let fts = ftsQuery ? ftsStmt.all(ftsQuery, k) : [];
  if (candidates) fts = fts.filter((r) => candidates.has(r.artifact_id));

  const fusedIds = rrf([vec.map((r) => r.artifact_id), fts.map((r) => r.artifact_id)]).slice(0, limit);
  const distById = new Map(vec.map((r) => [r.artifact_id, r.distance]));
  return fusedIds.map((id) => ({ ...getArtifactById(id), distance: distById.get(id) ?? null }));
}

export function timeline(start, end, types, limit = 50) {
  return timelineStmt.all({
    start: emptyish(start) || null,
    end: emptyish(end) || null,
    types_json: types?.length ? JSON.stringify(types) : null,
    limit,
  });
}

// Graph-only recall: no embedding. Resolve name -> entity -> recent linked artifacts.
export function aboutEntity(name, limit = 10) {
  const ids = resolveEntityIds(name);
  if (!ids.length) return { resolved: false, name, entities: [] };
  const entities = ids.map((id) => ({ entity: getEntity(id), artifacts: aboutStmt.all(id, limit) }));
  return { resolved: true, name, entities };
}

export { getArtifactById };
