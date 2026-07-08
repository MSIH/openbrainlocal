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
import { db, resolveEntityIds, getEntity, getArtifactById, getRelations } from './db.js';
import { ai, embedToFloat32 } from './embeddings.js';
import { QUERY_MODEL, RRF_K, KNN_OVERFETCH, KNN_MIN, KNN_MAX, DIGEST_TIMELINE_DAYS } from './config.js';
import { ARTIFACT_TYPES } from './ingest-types.js';

// Re-exported so the planner prompt below, the plan-schema filter, and every existing
// importer of ARTIFACT_TYPES from search.js pick up the registry (docs/04-connector-contract.md
// §6) without a second definition — src/ingest-types.js is the one source of truth.
export { ARTIFACT_TYPES };

const PLAN_TIMEOUT_MS = 8000;
const MS_PER_DAY = 86_400_000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const emptyish = (s) => (typeof s === 'string' && s.trim() ? s : null);

// --- Query-plan schema (validates the LLM's JSON; coerces junk to safe defaults) ---
const PlanSchema = z.object({
  // Drop only invalid type values, not the whole list — a single bad enum from the LLM
  // (e.g. "reel") must not silently discard the caller's real type constraints.
  types: z.array(z.string()).catch([]).transform((a) => a.filter((t) => ARTIFACT_TYPES.includes(t))),
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
    'For week- or month-scale summary questions ("what was I doing in October"), set types to ["digest"] — daily digests answer those in one hit.',
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
    AND (@t0 IS NULL OR date(a.occurred_at) >= date(@t0))
    AND (@t1 IS NULL OR date(a.occurred_at) <= date(@t1))
    AND (@place IS NULL OR a.place_label LIKE @place)
`);
const knnStmt = db.prepare(
  'SELECT artifact_id, distance FROM vec_artifacts WHERE embedding MATCH ? AND k = ? ORDER BY distance'
);
// Filter-then-rank: KNN constrained to the prefiltered candidate set. sqlite-vec (>= 0.1.6)
// supports IN constraints on the vec0 primary key in KNN queries — this ranks *within* the
// candidates instead of hoping a global top-k happens to intersect a tight filter. Compiled
// at startup, so an sqlite-vec too old to support it fails loudly at boot rather than
// silently degrading (verified against 0.1.9).
const knnInStmt = db.prepare(`
  SELECT artifact_id, distance FROM vec_artifacts
  WHERE embedding MATCH ? AND k = ?
    AND artifact_id IN (SELECT value FROM json_each(?))
  ORDER BY distance
`);
const ftsStmt = db.prepare(
  'SELECT rowid AS artifact_id, bm25(artifacts_fts) AS score FROM artifacts_fts WHERE artifacts_fts MATCH ? ORDER BY score LIMIT ?'
);
const ftsInStmt = db.prepare(`
  SELECT rowid AS artifact_id, bm25(artifacts_fts) AS score
  FROM artifacts_fts
  WHERE artifacts_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))
  ORDER BY score LIMIT ?
`);
// Cheap existence probe: is this place string a usable filter at all?
const placeExistsStmt = db.prepare('SELECT 1 FROM artifacts WHERE place_label LIKE ? LIMIT 1');
// Same probe shape for digests: does the range have any daily digest to answer from?
const digestExistsStmt = db.prepare(`
  SELECT 1 FROM artifacts WHERE type = 'digest'
    AND date(occurred_at) >= date(?) AND date(occurred_at) <= date(?) LIMIT 1
`);
const timelineStmt = db.prepare(`
  SELECT * FROM artifacts
  WHERE (@start IS NULL OR date(occurred_at) >= date(@start))
    AND (@end   IS NULL OR date(occurred_at) <= date(@end))
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
 * `distance` from the vector arm when available (null for FTS-only hits). Ranking is
 * constrained to the prefiltered candidate set. Pass `usePlanner: false` to skip the LLM
 * parse entirely (the legacy recall path — a plain semantic+keyword lookup, no NL filters).
 */
export async function hybridSearch(query, { limit = 3, types, timeRange, entities, usePlanner = true } = {}) {
  const plan = usePlanner ? await parseQuery(query) : fallbackPlan(query);

  const effTypes = types?.length ? types : plan.types;
  const t0 = emptyish(timeRange?.start) || emptyish(plan.time_start);
  const t1 = emptyish(timeRange?.end) || emptyish(plan.time_end);
  const entTerms = entities?.length ? entities : plan.entities;

  // Resolve entity terms. Terms that don't resolve can't filter — but they must not
  // vanish either, so they're folded back into the ranked-search text below.
  const entityIds = [];
  const unresolvedTerms = [];
  for (const term of entTerms) {
    const ids = resolveEntityIds(term);
    if (ids.length) entityIds.push(...ids);
    else unresolvedTerms.push(term);
  }

  // Place is only a filter if it can match at least one place_label; otherwise it's a keyword.
  let place = emptyish(plan.place);
  if (place && !placeExistsStmt.get(`%${place}%`)) {
    unresolvedTerms.push(place);
    place = null;
  }

  // What both ranking arms actually search: semantic core + everything the filters
  // couldn't absorb.
  const searchText = [plan.semantic || query, ...unresolvedTerms].join(' ');

  // SQL prefilter -> candidate id set (skip entirely when there are no structured filters).
  let candidates = null;
  let candidatesJson = null;
  if (effTypes.length || entityIds.length || t0 || t1 || place) {
    const rows = candidateStmt.all({
      types_json: effTypes.length ? JSON.stringify(effTypes) : null,
      ents_json: entityIds.length ? JSON.stringify(entityIds) : null,
      t0: t0 || null,
      t1: t1 || null,
      place: place ? `%${place}%` : null,
    });
    candidates = new Set(rows.map((r) => r.id));
    // TODO(planner-overfilter): empty here conflates "caller's explicit filters matched
    // nothing" (honest) with "the LLM invented a filter" (silent planner failure). Retry
    // with only the caller's explicit args, folding plan-derived terms into searchText.
    if (candidates.size === 0) return []; // filters matched nothing — semantic can't rescue it
    candidatesJson = JSON.stringify([...candidates]);
  }

  const k = clamp(limit * KNN_OVERFETCH, KNN_MIN, KNN_MAX);

  // Vector arm — ranked *within* the candidate set when one exists (filter-then-rank).
  // Best-effort; FTS still works if the embedding model is offline.
  let vec = [];
  try {
    const qvec = await embedToFloat32(searchText);
    vec = candidates
      ? knnInStmt.all(qvec, Math.min(k, candidates.size), candidatesJson)
      : knnStmt.all(qvec, k);
  } catch (err) {
    console.error('search: embedding unavailable, FTS-only:', err.message);
  }

  // Keyword arm — same constraint.
  const ftsQuery = toFtsQuery(searchText);
  let fts = [];
  if (ftsQuery) {
    fts = candidates ? ftsInStmt.all(ftsQuery, candidatesJson, k) : ftsStmt.all(ftsQuery, k);
  }

  const fusedIds = rrf([vec.map((r) => r.artifact_id), fts.map((r) => r.artifact_id)]).slice(0, limit);
  const distById = new Map(vec.map((r) => [r.artifact_id, r.distance]));
  // Skip any id an index returns that no longer hydrates (orphaned after partial/corrupt state)
  // rather than emitting a malformed row.
  return fusedIds
    .map((id) => {
      const a = getArtifactById(id);
      return a ? { ...a, distance: distById.get(id) ?? null } : null;
    })
    .filter(Boolean);
}

export function timeline(start, end, types, limit = 50) {
  const s = emptyish(start);
  const e = emptyish(end);
  let effTypes = types?.length ? types : null;
  // Month-scale ranges answer from daily digests when they exist (roadmap M6 deliverable 3):
  // a bounded span >= DIGEST_TIMELINE_DAYS with no explicit type filter returns the digests,
  // not hundreds of raw rows. Explicit types always win; open-ended or digest-less ranges
  // fall through unchanged. +1: the range is inclusive on both ends (a 14-day calendar span).
  if (!effTypes && s && e) {
    const spanDays = (new Date(e) - new Date(s)) / MS_PER_DAY + 1;
    if (spanDays >= DIGEST_TIMELINE_DAYS && digestExistsStmt.get(s, e)) effTypes = ['digest'];
  }
  return timelineStmt.all({
    start: s,
    end: e,
    types_json: effTypes ? JSON.stringify(effTypes) : null,
    limit,
  });
}

// Graph-only recall: no embedding. Resolve name -> entity -> recent linked artifacts +
// person<->person relations (issue #37). `relations` is [] when the person has none.
export function aboutEntity(name, limit = 10) {
  const ids = resolveEntityIds(name);
  if (!ids.length) return { resolved: false, name, entities: [] };
  const entities = ids.map((id) => ({ entity: getEntity(id), artifacts: aboutStmt.all(id, limit), relations: getRelations(id) }));
  return { resolved: true, name, entities };
}

export { getArtifactById };
