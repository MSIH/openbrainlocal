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
import { db, resolveEntityIds, resolveNameByPrefix, getEntity, getArtifactById, getRelations, getRelationsTo, mergeEntities, listProbableDuplicates, listContactPhotos, annotateArtifactRows } from './db.js';
import { ai, embedToFloat32 } from './embeddings.js';
import { geocodePlace, haversineKm } from './geocode.js';
import { normalizeUsState } from './us-states.js';
import { QUERY_MODEL, QUERY_PLAN_TIMEOUT_MS, QUERY_PLANNER_ENABLED, QUERY_PLAN_MAX_TOKENS, RRF_K, KNN_OVERFETCH, KNN_MIN, KNN_MAX, DIGEST_TIMELINE_DAYS, GEO_RADIUS_DEFAULT_KM, GEO_RADIUS_MAX_KM } from './config.js';
import { ARTIFACT_TYPES, TYPE_REGISTRY } from './ingest-types.js';

// Re-exported so the planner prompt below, the plan-schema filter, and every existing
// importer of ARTIFACT_TYPES from search.js pick up the registry (docs/04-connector-contract.md
// §6) without a second definition — src/ingest-types.js is the one source of truth.
export { ARTIFACT_TYPES };

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
  near: z.string().nullable().catch(null).default(null),
  time_start: z.string().nullable().catch(null).default(null),
  time_end: z.string().nullable().catch(null).default(null),
  // "where / located / last seen / been" with no place named -> restrict to geotagged rows (#190).
  geo_required: z.boolean().catch(false).default(false),
  // "last / latest / most recent" -> order the candidate set by occurred_at DESC instead of RRF (#190).
  sort: z.enum(['relevance', 'recent']).catch('relevance').default('relevance'),
  semantic: z.string().catch('').default(''),
});

const fallbackPlan = (query) => ({ types: [], entities: [], place: null, near: null, time_start: null, time_end: null, geo_required: false, sort: 'relevance', semantic: query });

function planSystemPrompt(today) {
  return [
    `You convert a personal-memory query into a JSON filter plan. Today is ${today}.`,
    'Return ONLY a JSON object with keys:',
    `  types: array of any of [${ARTIFACT_TYPES.join(', ')}], or []`,
    '  entities: array of person/place/org names exactly as written, or []',
    '  place: a place string for "in"/"at" location wording (matched against the stored label), or null',
    '  near: a place name for proximity wording ("near", "around", "close to", "nearby") — a geographic-radius search — or null',
    '  A US state, city, or country name (e.g. "Texas", "Austin", "France") is a LOCATION: put it in place (or near for proximity wording), NEVER in entities. entities is only for people and organizations.',
    '  Only set types when the query explicitly names an artifact kind (photo, email, message, note, document, video). A "when/where was X" question is NOT a type constraint — leave types [].',
    '  time_start, time_end: ISO dates (YYYY-MM-DD) resolving any relative time, or null',
    '  geo_required: true when the query asks WHERE something happened — "where", "located", "last seen", "been" — WITHOUT naming a place; else false. (When a place IS named, use place/near instead.)',
    '  sort: "recent" when the query wants the latest/most-recent — "last", "latest", "most recent", "last seen"; else "relevance"',
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
        // The plan is a tiny JSON; generation time dominates on a CPU host, so cap output (#179).
        max_tokens: QUERY_PLAN_MAX_TOKENS,
        messages: [
          { role: 'system', content: planSystemPrompt(today) },
          { role: 'user', content: query },
        ],
      },
      { timeout: QUERY_PLAN_TIMEOUT_MS, maxRetries: 0 }
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
    AND (@place IS NULL OR a.place_label LIKE @place OR (@place2 IS NOT NULL AND a.place_label LIKE @place2))
    AND (@geo_required = 0 OR a.place_label IS NOT NULL)
`);
// Recency ordering (#190): order a fixed candidate id set by occurred_at DESC (ties broken by id
// DESC for determinism). Used when the plan/caller sort is 'recent' — the candidate set already
// carries the topical (type/entity/geo) constraint, so recency over it is the "last seen" answer.
const recentOrderStmt = db.prepare(`
  SELECT id FROM artifacts
  WHERE id IN (SELECT value FROM json_each(?))
  ORDER BY occurred_at DESC, id DESC
  LIMIT ?
`);
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
const ftsInStmt = db.prepare(`
  SELECT rowid AS artifact_id, bm25(artifacts_fts) AS score
  FROM artifacts_fts
  WHERE artifacts_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))
  ORDER BY score LIMIT ?
`);
// Cheap existence probe: is this place string a usable filter at all? Same two-pattern shape as
// candidateStmt's place clause (#186) — a US-state term supplies both a full-name and a code
// pattern, so the probe succeeds if either form is present in any stored label.
const placeExistsStmt = db.prepare('SELECT 1 FROM artifacts WHERE place_label LIKE @place OR (@place2 IS NOT NULL AND place_label LIKE @place2) LIMIT 1');
// Geo-radius candidates (#68): a cheap lat/lon bounding-box prefilter over artifacts that carry
// coordinates; the caller refines the box corners with an exact haversine pass (geoCandidateIds).
const geoBboxStmt = db.prepare(`
  SELECT id, latitude, longitude FROM artifacts
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    AND latitude BETWEEN @latMin AND @latMax
    AND longitude BETWEEN @lonMin AND @lonMax
`);
// Per-day digest substitution (roadmap M6 deliverable 3): within the range, a day that has a
// daily digest is represented by it — its digest-eligible raw rows are folded away; undigested
// days keep their raw artifacts (partial backfill must never hide data), and types the digest
// doesn't summarize (digest_eligible: false, e.g. contact) are never hidden. When the range
// holds no digests at all, the NOT IN set is empty and this is identical to timelineStmt.
const DIGEST_ELIGIBLE_JSON = JSON.stringify(TYPE_REGISTRY.filter((t) => t.digest_eligible).map((t) => t.type));
// default_searchable enforcement (#121): the type set an ordinary no-type search is restricted to.
// Low-signal session/visit artifacts (default_searchable:false) are excluded so they don't pollute
// recall — they surface only when their type is named explicitly. Substituted by `prefilter` below
// whenever the effective type list is empty.
const SEARCHABLE_TYPES_JSON = JSON.stringify(TYPE_REGISTRY.filter((t) => t.default_searchable).map((t) => t.type));
const timelineDigestStmt = db.prepare(`
  SELECT * FROM artifacts
  WHERE date(occurred_at) >= date(@start) AND date(occurred_at) <= date(@end)
    AND (type = 'digest'
      OR type NOT IN (SELECT value FROM json_each(@eligible_json))
      OR date(occurred_at) NOT IN (
        SELECT date(occurred_at) FROM artifacts
        WHERE type = 'digest' AND date(occurred_at) >= date(@start) AND date(occurred_at) <= date(@end)))
  ORDER BY occurred_at ASC
  LIMIT @limit
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

// Artifact ids within `radiusKm` of a center point (#68). A degree-based bounding box narrows
// the SQL scan to a rectangle around the center, then an exact haversine pass trims it to a true
// circle. Near a pole (cos(lat)→0 blows up the longitude span) the box widens to the full
// longitude band; antimeridian wraparound is out of scope (documented). Returns an id Set.
const KM_PER_DEG_LAT = 111.32;
const POLE_COS_EPSILON = 1e-6;  // below this |cos(lat)| the longitude span blows up — cover the whole band
const LON_ABS_MAX = 180;        // longitude range is [-180, 180]
function geoCandidateIds(center, radiusKm) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  // Near a pole longitude is meaningless (all meridians converge), so the box spans the ENTIRE
  // [-180, 180] band regardless of center.lon; otherwise a degree-based half-width around center.
  const nearPole = Math.abs(cosLat) < POLE_COS_EPSILON;
  const dLon = nearPole ? 0 : radiusKm / (KM_PER_DEG_LAT * Math.abs(cosLat));
  const rows = geoBboxStmt.all({
    latMin: center.lat - dLat, latMax: center.lat + dLat,
    lonMin: nearPole ? -LON_ABS_MAX : center.lon - dLon,
    lonMax: nearPole ? LON_ABS_MAX : center.lon + dLon,
  });
  const ids = new Set();
  for (const r of rows) {
    if (haversineKm(center.lat, center.lon, r.latitude, r.longitude) <= radiusKm) ids.add(r.id);
  }
  return ids;
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
 * `QUERY_PLANNER_ENABLED=false` (#179) forces that same no-LLM path globally — for a CPU-only
 * host where the planner never beats even a low timeout, so search stays sub-second.
 * `near` (a place name or {lat, lon}) plus `radiusKm` add a geo-radius filter (#68): artifacts
 * within the radius by coordinate, not just by place-label text.
 */
export async function hybridSearch(query, { limit = 3, types, timeRange, entities, near, radiusKm, geoRequired, sort, usePlanner = true } = {}) {
  const plan = usePlanner && QUERY_PLANNER_ENABLED ? await parseQuery(query) : fallbackPlan(query);

  const effTypes = types?.length ? types : plan.types;
  const t0 = emptyish(timeRange?.start) || emptyish(plan.time_start);
  const t1 = emptyish(timeRange?.end) || emptyish(plan.time_end);
  const entTerms = entities?.length ? entities : plan.entities;
  // geo_required + sort (#190): a caller opt wins over the plan (mirrors types/timeRange/entities).
  // Track whether each came from the caller so the zero-candidate retry can keep a caller-supplied
  // filter (honest empty) while demoting a plan-derived one (demote-never-drop).
  const geoReqFromCaller = geoRequired === true;
  const sortFromCaller = sort != null;
  const effGeoRequired = geoRequired ?? plan.geo_required;
  let effSort = sort ?? plan.sort;

  // Resolve entity terms. Terms that don't resolve can't filter — but they must not
  // vanish either, so they're folded back into the ranked-search text below.
  const entityIds = [];
  const unresolvedTerms = [];
  for (const term of entTerms) {
    const ids = resolveEntityIds(term);
    if (ids.length) { entityIds.push(...ids); continue; }
    // Exact match missed — try the query-time given-name prefix fallback (#184). Resolves a bare
    // first name to a person stored under a full name, but only when it's unambiguous (one entity).
    const prefixIds = resolveNameByPrefix(term);
    if (prefixIds.length) {
      entityIds.push(...prefixIds);
      console.error(`entity-resolve: given-name "${term}" -> entity ${prefixIds[0]} (prefix, unambiguous)`);
    } else {
      unresolvedTerms.push(term);
    }
  }

  // Place is only a filter if it can match at least one place_label; otherwise it's a keyword.
  // A US-state term (#186) expands to TWO patterns so the filter is label-format-independent:
  // the full-name form ("%Texas%", migrated / current labels) and the code form ("%, TX",
  // coordinate-less or not-yet-migrated legacy labels). The canonical name/code are used
  // regardless of how the user wrote the state ("tx"/"texas"/"TEXAS"). A non-state place keeps
  // its single substring pattern (unchanged behavior). `placePattern`/`placeAltPattern` are the
  // LIKE strings threaded to both the existence probe and the prefilter.
  let place = emptyish(plan.place);
  let placePattern = null;
  let placeAltPattern = null;
  if (place) {
    const st = normalizeUsState(place);
    if (st) {
      placePattern = `%${st.name}%`;
      placeAltPattern = `%, ${st.code}`;
    } else {
      placePattern = `%${place}%`;
    }
    if (!placeExistsStmt.get({ place: placePattern, place2: placeAltPattern })) {
      unresolvedTerms.push(place);
      placePattern = null;
      placeAltPattern = null;
    }
  }

  // Geo-radius (#68). Explicit {lat,lon} wins; a name (caller `near` or plan.near) resolves via
  // the bundled gazetteer. A name that resolves to no center isn't a filter — it's folded into
  // the ranked-search text, same demote-never-drop posture as an unmatched place. `geoFromCaller`
  // tracks whether the filter is the caller's (survives the zero-candidate retry) or plan-invented.
  const nearInput = near ?? emptyish(plan.near);
  const radius = clamp(radiusKm ?? GEO_RADIUS_DEFAULT_KM, 0, GEO_RADIUS_MAX_KM);
  let geoIds = null;
  let geoFromCaller = false;
  if (nearInput != null) {
    let center = null;
    if (typeof nearInput === 'object' && nearInput.lat != null && nearInput.lon != null) {
      // Guard out-of-range coordinates (mirrors reverseGeocode): a garbage center yields no geo
      // filter rather than a bounding box that silently matches nothing.
      if (Math.abs(nearInput.lat) <= 90 && Math.abs(nearInput.lon) <= 180) {
        center = { lat: nearInput.lat, lon: nearInput.lon };
      }
    } else if (typeof nearInput === 'string') {
      const resolved = geocodePlace(nearInput);
      if (resolved) center = { lat: resolved.lat, lon: resolved.lon };
      else unresolvedTerms.push(nearInput);
    }
    if (center) {
      geoIds = geoCandidateIds(center, radius);
      geoFromCaller = near != null;
    }
  }

  // What both ranking arms actually search: semantic core + everything the filters
  // couldn't absorb.
  const searchText = [plan.semantic || query, ...unresolvedTerms].join(' ');

  // SQL prefilter -> candidate id set. Always applies a type constraint: the explicit/planner
  // list when non-empty, else the default_searchable set (#121) — so a no-type search never
  // surfaces low-signal session/visit artifacts. The prefilter therefore always runs.
  const prefilter = (f) =>
    new Set(
      candidateStmt
        .all({
          types_json: f.types.length ? JSON.stringify(f.types) : SEARCHABLE_TYPES_JSON,
          ents_json: f.entityIds.length ? JSON.stringify(f.entityIds) : null,
          t0: f.t0 || null,
          t1: f.t1 || null,
          place: f.placePattern ?? null,
          place2: f.placeAltPattern ?? null,
          geo_required: f.geoRequired ? 1 : 0,
        })
        .map((r) => r.id)
    );

  // Geo is an id Set (or null when absent); it intersects the SQL candidate set the same way
  // an extra WHERE clause would (null SQL set + geo => geo alone).
  const applyGeo = (sqlSet, geo) => {
    if (geo == null) return sqlSet;
    if (sqlSet == null) return geo;
    // Intersect by scanning the smaller set and probing the larger — avoids materializing an
    // intermediate array from the (possibly large) SQL candidate set.
    const [small, big] = sqlSet.size <= geo.size ? [sqlSet, geo] : [geo, sqlSet];
    const out = new Set();
    for (const id of small) if (big.has(id)) out.add(id);
    return out;
  };

  // The prefilter always runs — a type constraint is always present (explicit/planner effTypes,
  // else the default_searchable default; #121) — so `candidates` is always a Set, never null.
  let candidates = applyGeo(prefilter({ types: effTypes, entityIds, t0, t1, placePattern, placeAltPattern, geoRequired: effGeoRequired }), geoIds);
  if (candidates.size === 0) {
    // A plan-derived recency intent is demoted with the plan filters here — only a caller-supplied
    // `sort` survives (#190), so a "where was X last seen" with no geotagged match degrades to a
    // normal relevance search rather than returning the most-recent artifacts overall.
    if (!sortFromCaller) effSort = 'relevance';
    // Planner-overfilter fix (M2 rule: demote, never drop): zero candidates conflates
    // "caller's explicit filters matched nothing" (honest) with "the LLM invented a
    // filter" (silent planner failure — e.g. the prompt steers summary queries to
    // types=['digest'], which must not empty the search when no digests exist for the
    // period). Retry with only the caller's explicit args — explicit types/time/entities
    // plus a caller-supplied `near`; place and plan-derived `near` are always dropped here.
    const caller = {
      types: types?.length ? types : [],
      entityIds: entities?.length ? entityIds : [],
      t0: emptyish(timeRange?.start),
      t1: emptyish(timeRange?.end),
      placePattern: null,
      placeAltPattern: null,
      // geo_required survives the retry only when the CALLER set it (like explicit types/entities):
      // an explicit geoRequired:true stays in force and yields an honest empty; a plan-derived one is
      // dropped (demote-never-drop — a "where was X" with no geotagged match degrades to a normal search).
      geoRequired: geoReqFromCaller,
    };
    const callerGeo = geoFromCaller ? geoIds : null;
    const callerHasSql = caller.types.length || caller.entityIds.length || caller.t0 || caller.t1 || caller.geoRequired;
    if (callerHasSql || callerGeo != null) {
      candidates = applyGeo(prefilter(caller), callerGeo);
      if (candidates.size === 0) return []; // the caller's own filters matched nothing — honest empty
    } else {
      // Every filter was plan-invented — fall back to the default search: default_searchable
      // types only (not all types), so a bad planner filter degrades to normal recall, never
      // to a widened one that re-admits sessions/visits.
      candidates = prefilter({ types: [], entityIds: [], t0: null, t1: null, placePattern: null, placeAltPattern: null, geoRequired: false });
    }
  }
  if (candidates.size === 0) return []; // no default_searchable artifacts to rank
  const candidatesJson = JSON.stringify([...candidates]);

  // Recency ordering (#190): once the candidate set carries the topical constraint (type/entity/geo),
  // "last seen" is a pure recency question — order by occurred_at DESC and skip the vec/FTS/RRF arms
  // (no embedding call, so this path is unaffected by the embedder being offline). `distance` is null,
  // like an FTS-only hit. getArtifactById attaches display_text just as the RRF path does.
  if (effSort === 'recent') {
    return recentOrderStmt
      .all(candidatesJson, limit)
      .map((r) => getArtifactById(r.id))
      .filter(Boolean)
      .map((a) => ({ ...a, distance: null }));
  }

  const k = clamp(limit * KNN_OVERFETCH, KNN_MIN, KNN_MAX);

  // Vector arm — ranked *within* the candidate set (filter-then-rank).
  // Best-effort; FTS still works if the embedding model is offline.
  let vec = [];
  try {
    const qvec = await embedToFloat32(searchText);
    vec = knnInStmt.all(qvec, Math.min(k, candidates.size), candidatesJson);
  } catch (err) {
    console.error('search: embedding unavailable, FTS-only:', err.message);
  }

  // Keyword arm — same constraint.
  const ftsQuery = toFtsQuery(searchText);
  let fts = [];
  if (ftsQuery) {
    fts = ftsInStmt.all(ftsQuery, candidatesJson, k);
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
  // Month-scale ranges answer from daily digests where they exist (per-day substitution —
  // see timelineDigestStmt): a bounded span >= DIGEST_TIMELINE_DAYS with no explicit type
  // filter. Explicit types always win; open-ended ranges are unchanged. +1: the range is
  // inclusive on both ends (a 14-day calendar span).
  if (!types?.length && s && e) {
    const spanDays = (new Date(e) - new Date(s)) / MS_PER_DAY + 1;
    if (spanDays >= DIGEST_TIMELINE_DAYS) {
      return annotateArtifactRows(timelineDigestStmt.all({ start: s, end: e, eligible_json: DIGEST_ELIGIBLE_JSON, limit }));
    }
  }
  return annotateArtifactRows(timelineStmt.all({
    start: s,
    end: e,
    types_json: types?.length ? JSON.stringify(types) : null,
    limit,
  }));
}

// Graph-only recall: no embedding. Resolve name -> entity -> recent linked artifacts +
// entity relations (issue #37; person->org #88). `relations` is the entity's outgoing edges
// (worksAt, spouse, …); `relations_in` its incoming edges (#88) — for an org, the people who
// work there. Both [] when the entity has none. Merge
// redirect (#75) is inherited from resolveEntityIds — a name that used to resolve to an
// absorbed entity now resolves straight to the survivor, so no extra redirect logic is needed
// here; the survivor's `aboutStmt` results already include the absorbed entity's re-pointed
// links (the merge).
export function aboutEntity(name, limit = 10) {
  const ids = resolveEntityIds(name);
  if (!ids.length) return { resolved: false, name, entities: [] };
  const entities = ids.map((id) => ({ entity: getEntity(id), artifacts: annotateArtifactRows(aboutStmt.all(id, limit)), relations: getRelations(id), relations_in: getRelationsTo(id) }));
  return { resolved: true, name, entities };
}

export { getArtifactById, rrf, mergeEntities, listProbableDuplicates, listContactPhotos };
