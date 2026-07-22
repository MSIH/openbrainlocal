#!/usr/bin/env node
/**
 * Architecture: LifeContext (Web API + Streamable HTTP MCP Server)
 *
 * Adapted from Nate B. Jones's OB1 (Open Brain) framework.
 * https://github.com/NateBJones-Projects/OB1
 *
 * OB2 Phase 2.0 (this pass): the store moves from a single `memories` table to the unified
 * artifact + entity-graph + hybrid-search model (see docs/03-ob2-design.md and src/db.js).
 *  - Persistence, embeddings, and search are extracted to db.js / embeddings.js / search.js
 *    so the headless connectors (migrate, contacts) share one store and one embedding path.
 *  - store_memory / search_memories and /api/remember / /api/recall are unchanged on the
 *    wire — they now write type='note' artifacts and recall via hybrid search.
 *  - New tools/routes: search, timeline, about_entity, get_artifact.
 *
 * Retained from v2.2: per-session McpServer factory, transport.onclose as a property,
 * initialize-gated session creation, GET/DELETE /mcp handlers, graceful shutdown.
 */

import express from 'express';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';

import { PORT, TRUST_PROXY, DB_PATH, LIFECONTEXT_API_KEY, LIFECONTEXT_API_KEY_PLACEHOLDER, MCP_URL_TOKEN, UI_URL_TOKEN, GEO_RADIUS_DEFAULT_KM, GEO_RADIUS_MAX_KM, CONTACTS_RAW_DIR, CONTACT_PHOTO_MAX_BYTES, ACCESS_LOG_ENABLED, ACCESS_LOG_DIR, ACCESS_LOG_RETENTION_DAYS } from './config.js';
import { accessLogMiddleware, pruneOldLogs, ensureCompressed, closeAccessLog } from './access-log.js';
import { db, storeArtifactTxn, sha256, listEntities, getEntityProfile, getEntity, createEntity, updateEntityAttrs, addAlias, removeAlias, removeRelation, setEntityPhotoFile, getContactPhotoRawPath, upsertEntityRelation, canonicalRelationType, resolveEntityIds, proposeEntity, listProposedEntities, approveProposedEntity, rejectProposedEntity, backfillDirectoryProposals, logEvent, normalizeName, normalizePhone } from './db.js';
import { savePhotoBytes } from './contacts.js';
import { embedToFloat32 } from './embeddings.js';
import { hybridSearch, timeline, aboutEntity, getArtifactById, ARTIFACT_TYPES, mergeEntities, listProbableDuplicates, listContactPhotos } from './search.js';
import { TYPE_REGISTRY } from './ingest-types.js';
import { buildIngestRouter } from './ingest.js';

// Fail closed instantly if the secret is unset or still the placeholder.
if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === LIFECONTEXT_API_KEY_PLACEHOLDER) {
  console.error("❌ CRITICAL ERROR: LIFECONTEXT_API_KEY is unset or insecure. System halting.");
  process.exit(1);
}

// --- CORE ASYNC UTILITIES (enrich-then-commit: embed BEFORE the transaction) ---
async function executeStore(content) {
  const vec = await embedToFloat32(content);
  // A manual note: source='manual', no source_id (each note is a distinct row).
  const { id } = storeArtifactTxn({ type: 'note', source: 'manual', content_hash: sha256(content), text_repr: content }, vec);
  return id;
}

// Legacy recall shape: hybrid search over artifacts, mapped back to {content, created_at, distance}.
// usePlanner:false — the legacy path is a plain semantic+keyword lookup, so skip the LLM query
// parse (avoids a per-recall model call and its fallback logging when QUERY_MODEL isn't pulled).
async function executeRecall(query, limit) {
  const results = await hybridSearch(query, { limit, usePlanner: false });
  return results.map((a) => ({ content: a.display_text ?? a.text_repr, created_at: a.occurred_at ?? a.ingested_at, distance: a.distance }));
}

// --- SHARED VALIDATION SCHEMAS (REST + MCP use the same bounds) ---
const ContentSchema = z.string().min(1, "Content cannot be empty");
const LimitSchema = z.number().int().min(1).max(50).default(3);
const TypeEnum = z.enum(ARTIFACT_TYPES);
const RememberSchema = z.object({ content: ContentSchema });
const RecallSchema = z.object({ query: z.string().min(1, "Query cannot be empty"), limit: LimitSchema });
// Geo-radius center (#68): a place name (resolved to a center point via the bundled gazetteer)
// or explicit coordinates. Shared by the REST schema and the MCP search tool.
const NearSchema = z.union([z.string().trim().min(1), z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })]);
const RadiusSchema = z.number().positive();
const SearchSchema = z.object({
  query: z.string().min(1, "Query cannot be empty"),
  types: z.array(TypeEnum).optional(),
  time_range: z.object({ start: z.string(), end: z.string() }).partial().optional(),
  entities: z.array(z.string()).optional(),
  near: NearSchema.optional(),
  radius_km: RadiusSchema.optional(),
  limit: LimitSchema.optional(),
});
const TimelineSchema = z.object({
  start: z.string().min(1), end: z.string().min(1),
  types: z.array(TypeEnum).optional(), limit: LimitSchema.optional(),
});
const AboutEntitySchema = z.object({ name: z.string().min(1), limit: LimitSchema.optional() });
const GetArtifactSchema = z.object({ id: z.coerce.number().int().positive() });
// Entity merge + duplicate detection (#75) — the curation admin surface, distinct from the
// connector ingest lane. keep_id === absorb_id is a 422 the app layer raises (mergeEntities),
// not a zod .refine() — that error must map to 422, not the ZodError middleware's 400.
const MergeEntitiesSchema = z.object({ keep_id: z.coerce.number().int().positive(), absorb_id: z.coerce.number().int().positive() });
const DuplicatesQuerySchema = z.object({ limit: z.coerce.number().int().positive().max(100).optional() });
// #84 — reference-face input for photo-exif's suggest-labels; a connector concern, hence no
// MCP tool (unlike duplicates/merge, which a human drives conversationally).
const ContactPhotosQuerySchema = z.object({ limit: z.coerce.number().int().positive().max(500).optional() });
// Contacts curation surface (#96): the web UI's edits to the entity graph. `attrs` is the open
// vCard superset object; server-owned keys (photoFile/raw_path) are stripped in updateEntityAttrs,
// never trusted from the client. Query/param values arrive as strings, hence z.coerce.
const EntityKindSchema = z.enum(['person', 'org', 'place', 'event', 'topic']);
const AliasTypeSchema = z.enum(['email', 'phone', 'name', 'handle']);
const AttrsSchema = z.record(z.string(), z.any());
const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });
const RelationParamSchema = z.object({ id: z.coerce.number().int().positive(), relationId: z.coerce.number().int().positive() });
const ListEntitiesQuerySchema = z.object({
  query: z.string().optional(),
  kind: EntityKindSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const CreateEntitySchema = z.object({ kind: z.enum(['person', 'org', 'place', 'event']), canonical_name: z.string().trim().min(1), attrs: AttrsSchema.optional() });
const UpdateEntitySchema = z.object({ canonical_name: z.string().trim().min(1).optional(), attrs: AttrsSchema.optional() })
  .refine((v) => v.canonical_name !== undefined || v.attrs !== undefined, { message: 'nothing to update' });
const AliasBodySchema = z.object({ alias: z.string().trim().min(1), alias_type: AliasTypeSchema });
const AddRelationSchema = z.object({
  to_entity_id: z.coerce.number().int().positive(),
  relation_type: z.string().trim().min(1).optional(),
  raw_label: z.string().trim().min(1).optional(),
}).refine((v) => v.relation_type || v.raw_label, { message: 'relation_type or raw_label required' });
// Proposed-entities review queue (#119): the human-approval gate for entities the connector-ingest
// lane proposed creating from an artifact signal (vendor/sender). Core-owned, same family as merge.
const ProposedQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
// propose_entity (#232): the external WRITE entry into the #119 queue. An agent (MCP/REST) SUGGESTS an
// entity; it is staged pending, never minted — human approval (list/approve_proposed_entity, or the UI
// "Proposed contacts" panel) is the gate that keeps an agent from polluting the graph. alias/alias_type
// default to (name,'name') when no handle is supplied (a supplied alias requires its type). kind mirrors
// CreateEntitySchema's set. Shared by the REST route and the MCP tool so the rules live in one place.
const ProposeEntitySchema = z.object({
  kind: z.enum(['person', 'org', 'place', 'event']),
  name: z.string().trim().min(1),
  alias: z.string().trim().min(1).optional(),
  alias_type: AliasTypeSchema.optional(),
  source: z.string().trim().min(1).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  attrs: AttrsSchema.optional(),
}).refine((v) => (v.alias === undefined) === (v.alias_type === undefined), { message: 'alias and alias_type must be provided together' })
  .transform((v) => (v.alias ? v : { ...v, alias: v.name, alias_type: 'name' }));
// Stage a proposal from a validated ProposeEntitySchema value (agent-facing default source). Returns
// { id, created, status } from proposeEntity so callers can report the queue row + whether it was new.
// This is the external write entry point, so it owns the proposed_entity_staged audit row (proposeEntity
// itself stays silent for the internal hint/backfill/cluster paths — see its comment).
const stageProposedEntity = ({ kind, name, alias, alias_type, source, confidence, attrs }) => {
  const src = source ?? 'mcp-proposal';
  // Normalize the resolution key exactly as ingest does (resolveEntityHints): phone via normalizePhone,
  // everything else lowercased/trimmed. Without this an email/phone alias stages un-normalized — it
  // breaks idempotency (two casings stage twice) and, on approval, won't match the normalized lookup
  // path. `name` stays the raw display string (the entity's canonical_name at approval).
  const normAlias = alias_type === 'phone' ? normalizePhone(alias) : normalizeName(alias);
  const result = proposeEntity({ suggested_kind: kind, name, alias: normAlias, alias_type, source: src, confidence: confidence ?? null, attrs_json: attrs ?? null });
  if (result.created) logEvent('proposed_entity_staged', src, { proposal_id: result.id, suggested_kind: kind, suggested_name: name, alias: normAlias, alias_type });
  return result;
};

// Resolve an entity reference (a numeric id OR a name) to { id, name }, for add_relationship (#234).
// A number is treated as an id and existence-checked; a string goes through the exact-match
// resolveEntityIds — 0 matches → NOT_FOUND, >1 → AMBIGUOUS (message lists the candidate ids so the
// caller can retry with an explicit id; a wrong edge is worse than a guessed one). Throws a typed Error.
export const resolveEntityRef = (ref) => {
  if (typeof ref === 'number') {
    const e = getEntity(ref);
    if (!e) { const err = new Error(`no entity with id ${ref}`); err.code = 'NOT_FOUND'; throw err; }
    return { id: ref, name: e.canonical_name };
  }
  const ids = resolveEntityIds(ref);
  if (ids.length === 0) { const err = new Error(`no entity named "${ref}"`); err.code = 'NOT_FOUND'; throw err; }
  if (ids.length > 1) { const err = new Error(`"${ref}" is ambiguous (entities ${ids.map((i) => `#${i}`).join(', ')}) — pass a numeric id`); err.code = 'AMBIGUOUS'; throw err; }
  return { id: ids[0], name: getEntity(ids[0])?.canonical_name ?? ref };
};

// Create a directional edge between two EXISTING entities (#234), the logic behind the add_relationship
// MCP tool. Resolves each ref by name-or-id, rejects a self-loop and a missing type, then writes the edge
// via upsertEntityRelation (append-only, OR IGNORE idempotent, ungated — both endpoints are already
// curated). Throws typed errors (NOT_FOUND/AMBIGUOUS/SELF_LOOP/MISSING_TYPE); returns { added, relation_type,
// from, to } for the caller to format. Exported so the logic is unit-tested without an MCP transport.
export function addRelationship({ from, to, relation_type = null, raw_label = null }) {
  if (!relation_type && !raw_label) { const err = new Error('relation_type or raw_label required'); err.code = 'MISSING_TYPE'; throw err; }
  const a = resolveEntityRef(from);
  const b = resolveEntityRef(to);
  if (a.id === b.id) { const err = new Error('a relation cannot point at itself'); err.code = 'SELF_LOOP'; throw err; }
  const type = relation_type ?? canonicalRelationType(raw_label);
  const added = upsertEntityRelation({ from_entity_id: a.id, to_entity_id: b.id, relation_type: type, raw_label: raw_label ?? null, confidence: 1.0, source: 'mcp' });
  return { added, relation_type: type, from: a.name, to: b.name };
}

// --- OUTPUT FORMATTERS (MCP tools return text) ---
const snippet = (s, n = 200) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");
// Prefer display_text (#147): the read-time, name-annotated form of text_repr set by getArtifactById.
// timeline/about_entity rows are fetched without links and lack it — snippet falls back to text_repr.
const artifactLine = (a) => `- [${a.type}${a.occurred_at ? ` · ${a.occurred_at}` : ""}${a.distance != null ? ` · ${a.distance.toFixed(3)}` : ""}] (#${a.id}) ${snippet(a.display_text ?? a.text_repr)}`;

// --- AUTH ---
// Query-param fallback name mirrors the `x-api-key` header so the credential is named the same
// across channels. Only for clients that can't send a header (a bare MCP connection URL — gemini,
// some VS Code extensions). NOT for the Claude.ai web connector: the MCP spec forbids tokens in
// the query string, so web still needs the header (Request-headers beta) or OAuth. It also leaks
// the key into access/proxy logs, browser history, and Referer — prefer the header (see docs/07).
const AUTH_QUERY_PARAM = 'api_key';

function secureCompare(input, secret) {
  if (typeof input !== 'string' || typeof secret !== 'string') return false;
  const inputHash = createHash('sha256').update(input).digest();
  const secretHash = createHash('sha256').update(secret).digest();
  return timingSafeEqual(inputHash, secretHash);
}

// Header wins over query param; a duplicated ?api_key= (Express yields an array) is a non-string,
// which secureCompare rejects as invalid rather than crashing. The Authorization scheme is
// case-insensitive per RFC 7235, so match `Bearer` loosely and only when it's a well-formed string.
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const bearer = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(.+)$/i)?.[1] : undefined;
  const token = req.headers['x-api-key']
    || bearer
    || req.query?.[AUTH_QUERY_PARAM];
  // The browser UI's capability-URL token (#161, token-only #169) is a full-access alternative
  // credential when set, so a bookmarked /<token>/ui/ page (which reads the token from its own path
  // and sends it as x-api-key) authorizes /api with no manual key entry. It never weakens the
  // primary key path — that check comes first.
  if (secureCompare(token, LIFECONTEXT_API_KEY) || (UI_URL_TOKEN && secureCompare(token, UI_URL_TOKEN))) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized: Invalid or missing secret key token." });
}

// Capability-URL auth for the claude.ai web MCP connector (issue #63): the token lives in the
// path, e.g. https://host/<token>/mcp. 404 (never 401) on mismatch/unset so the endpoint's
// existence is never confirmed by probing — the same reasoning as returning a generic 404 for
// any unknown route, but here it also has to hide behind MCP_URL_TOKEN being unset entirely.
function requirePathToken(req, res, next) {
  if (MCP_URL_TOKEN && secureCompare(req.params.token, MCP_URL_TOKEN)) return next();
  res.status(404).end();
}

// The same capability-URL guard, bound to UI_URL_TOKEN, for the browser web UI (#161, token-first
// #165): the static UI is served only at /<token>/ui/… when the segment matches. 404 (never 401) on
// a wrong/absent token so the tokened mount's existence isn't confirmed by probing — same as MCP.
function requireUiPathToken(req, res, next) {
  if (UI_URL_TOKEN && secureCompare(req.params.token, UI_URL_TOKEN)) return next();
  res.status(404).end();
}

// --- MCP SERVER FACTORY ---
// A fresh McpServer per session. connect() binds a server to exactly one transport;
// sharing a single global server across sessions causes responses to cross-route.
function buildMcpServer() {
  const server = new McpServer(
    { name: "secure-web-brain", version: "2.3.0" },
    {
      instructions:
        "This server is the user's personal, long-term memory over their whole digital footprint. " +
        "Proactively call store_memory whenever the user shares a durable fact, preference, decision, or event. " +
        "Call search before answering questions about the user or their history and ground your answer in the results. " +
        "Use timeline for 'what was I doing' date-range questions, about_entity for 'everything about <person>', and " +
        "get_artifact to expand one result. Memories persist across sessions and every tool that connects here.",
    }
  );

  server.registerTool(
    "store_memory",
    {
      title: "Store a memory",
      description:
        "Save a single durable fact to the user's long-term memory for recall in future sessions. Use for " +
        "preferences, relationships, decisions, and events — not for transient conversational filler.",
      inputSchema: {
        content: ContentSchema.describe(
          "One self-contained fact to remember, phrased so it stands alone without surrounding context " +
          "(e.g. \"User's sister Sarah lives in Austin and is a pediatric nurse.\")."
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ content }) => {
      const id = await executeStore(content);
      return { content: [{ type: "text", text: `Memory logged successfully under local ID: ${id}` }] };
    }
  );

  server.registerTool(
    "search_memories",
    {
      title: "Search memories",
      description:
        "Hybrid semantic + keyword search over the user's stored memories. Call before answering questions about " +
        "the user or referencing past context; returns the closest memories (lower score = closer when shown).",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language description of what to recall, e.g. \"where does my sister live\"."),
        limit: LimitSchema.optional().describe("Maximum number of memories to return (1-50, default 3)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit = 3 }) => {
      const matches = await executeRecall(query, limit);
      if (matches.length === 0) {
        return { content: [{ type: "text", text: "No relevant long-term context found." }] };
      }
      const txt = matches.map((r) => `- [Score: ${r.distance != null ? r.distance.toFixed(3) : "n/a"}] ${r.content}`).join("\n");
      return { content: [{ type: "text", text: txt }] };
    }
  );

  server.registerTool(
    "search",
    {
      title: "Search memory (hybrid, filtered)",
      description:
        "Hybrid search across every artifact type with optional filters. The query is parsed for time/place/person/type " +
        "and fused (vector + keyword) ranking. Prefer this for anything richer than a plain note lookup.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language query, e.g. \"emails from Sarah about the trip last spring\"."),
        types: z.array(TypeEnum).optional().describe(`Restrict to these artifact types: ${ARTIFACT_TYPES.join(", ")}.`),
        time_range: z.object({ start: z.string(), end: z.string() }).partial().optional().describe("ISO date bounds {start,end} to constrain occurred_at."),
        entities: z.array(z.string()).optional().describe("People/places/orgs to require (resolved via the entity graph)."),
        near: NearSchema.optional().describe("Search near a place: a name (e.g. \"San Francisco\") or explicit {lat, lon}. Surfaces artifacts within radius_km by coordinate, catching nearby places the label text doesn't literally name."),
        radius_km: RadiusSchema.optional().describe(`Radius in km for \`near\` (default ${GEO_RADIUS_DEFAULT_KM}, max ${GEO_RADIUS_MAX_KM}).`),
        limit: LimitSchema.optional().describe("Max results (1-50, default 3)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, types, time_range, entities, near, radius_km, limit = 3 }) => {
      const results = await hybridSearch(query, { limit, types, timeRange: time_range, entities, near, radiusKm: radius_km });
      if (results.length === 0) return { content: [{ type: "text", text: "No matching artifacts found." }] };
      return { content: [{ type: "text", text: results.map(artifactLine).join("\n") }] };
    }
  );

  server.registerTool(
    "timeline",
    {
      title: "Timeline (chronological recall)",
      description: "Return artifacts in a date range, oldest first — for \"what was I doing\" questions. No semantic ranking.",
      inputSchema: {
        start: z.string().min(1).describe("ISO start date/datetime (inclusive)."),
        end: z.string().min(1).describe("ISO end date/datetime (inclusive)."),
        types: z.array(TypeEnum).optional().describe(`Restrict to these types: ${ARTIFACT_TYPES.join(", ")}.`),
        limit: LimitSchema.optional().describe("Max results (1-50, default 50)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ start, end, types, limit = 50 }) => {
      const rows = timeline(start, end, types, limit);
      if (rows.length === 0) return { content: [{ type: "text", text: "No artifacts in that range." }] };
      return { content: [{ type: "text", text: rows.map(artifactLine).join("\n") }] };
    }
  );

  server.registerTool(
    "about_entity",
    {
      title: "About an entity",
      description: "Resolve a person/place/org by name, email, or phone and return their profile plus recent linked artifacts.",
      inputSchema: {
        name: z.string().min(1).describe("Name, email, or phone of the entity, e.g. \"Sarah Jones\" or \"sarah.j@gmail.com\"."),
        limit: LimitSchema.optional().describe("Max linked artifacts per entity (1-50, default 10)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name, limit = 10 }) => {
      const res = aboutEntity(name, limit);
      if (!res.resolved) return { content: [{ type: "text", text: `No entity found for "${name}".` }] };
      const blocks = res.entities.map(({ entity, artifacts, relations, relations_in }) => {
        const header = `${entity.canonical_name} (${entity.kind})${entity.attrs ? ` — ${JSON.stringify(entity.attrs)}` : ""}`;
        const rels = relations?.length ? `\nRelations: ${relations.map((r) => `${r.relation_type} → ${r.name}`).join(", ")}` : "";
        // Incoming edges (#88) — e.g. an org's employees (worksAt ← person). Same arrow idiom,
        // reversed, so "who works at Acme" is answerable over MCP, not just REST.
        const relsIn = relations_in?.length ? `\nRelated from: ${relations_in.map((r) => `${r.relation_type} ← ${r.name}`).join(", ")}` : "";
        const items = artifacts.map(artifactLine).join("\n");
        return `${header}${rels}${relsIn}\n${items || "  (no linked artifacts yet)"}`;
      });
      return { content: [{ type: "text", text: blocks.join("\n\n") }] };
    }
  );

  server.registerTool(
    "get_artifact",
    {
      title: "Get an artifact",
      description: "Fetch one artifact by id: full text, metadata, raw_path, and its entity links.",
      inputSchema: { id: z.coerce.number().int().positive().describe("The numeric artifact id.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const a = getArtifactById(id);
      if (!a) return { content: [{ type: "text", text: `No artifact with id ${id}.` }] };
      return { content: [{ type: "text", text: JSON.stringify(a, null, 2) }] };
    }
  );

  server.registerTool(
    "list_probable_duplicates",
    {
      title: "List probable duplicate contacts",
      description:
        "Rank likely-duplicate person entities (contacts imported from multiple sources rarely dedup " +
        "perfectly) by shared phone/email and name similarity, so a human can review and merge them with " +
        "merge_entities. Read-only — never merges anything itself.",
      inputSchema: {
        limit: z.coerce.number().int().positive().max(100).optional().describe("Max pairs to return (default 20)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit = 20 }) => {
      const pairs = listProbableDuplicates(limit);
      if (pairs.length === 0) return { content: [{ type: "text", text: "No probable duplicates found." }] };
      const txt = pairs
        .map((p) => `- [score ${p.score}] (#${p.a.id}) "${p.a.name}" <-> (#${p.b.id}) "${p.b.name}" — ${p.reason}`)
        .join("\n");
      return { content: [{ type: "text", text: txt }] };
    }
  );

  server.registerTool(
    "merge_entities",
    {
      title: "Merge two entities",
      description:
        "Merge two person entities that are the same real-world person (surfaced by list_probable_duplicates, " +
        "or already known). The absorbed entity is tombstoned, never deleted; its aliases, artifact links, and " +
        "relations move to the kept entity.",
      inputSchema: {
        keep_id: z.coerce.number().int().positive().describe("Entity id to keep (the survivor)."),
        absorb_id: z.coerce.number().int().positive().describe("Entity id to merge into keep_id (tombstoned, not deleted)."),
      },
      // destructiveHint: true — tombstones an entity and repoints/deletes graph edges; there
      // is no unmerge yet (#75 Out of Scope), so a client should treat this as hard to undo.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ keep_id, absorb_id }) => {
      try {
        const result = mergeEntities(keep_id, absorb_id);
        return {
          content: [{
            type: "text",
            text: `Merged entity #${absorb_id} into #${keep_id}. Moved: ${result.moved.aliases} aliases, ` +
              `${result.moved.links} links, ${result.moved.relations} relations.`,
          }],
        };
      } catch (err) {
        console.error("merge_entities tool failed:", err);
        return { content: [{ type: "text", text: `Merge failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "propose_entity",
    {
      title: "Propose a new entity for review",
      description:
        "Suggest a NEW entity (person, org, place, event) — e.g. a broker or agent you learned about — so a " +
        "human can approve it. This does NOT create the entity: it stages a pending proposal in the review " +
        "queue (list_proposed_entities → approve_proposed_entity). Use this instead of asserting entities " +
        "directly; approval is what keeps the graph clean. Idempotent — re-proposing the same one is a no-op.",
      inputSchema: {
        kind: z.enum(['person', 'org', 'place', 'event']).describe("Entity kind."),
        name: z.string().trim().min(1).describe("Display/canonical name of the proposed entity."),
        alias: z.string().trim().min(1).optional().describe("Resolution key (email/phone/handle/name). Defaults to name when omitted."),
        alias_type: z.enum(['email', 'phone', 'name', 'handle']).optional().describe("Type of alias; required if alias is given."),
        source: z.string().trim().min(1).optional().describe("Where this suggestion came from (default 'mcp-proposal')."),
        confidence: z.coerce.number().min(0).max(1).optional().describe("Optional 0–1 confidence in the suggestion."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const { id, created, status } = stageProposedEntity(ProposeEntitySchema.parse(args));
        const text = created
          ? `Staged proposal #${id} [${args.kind}] "${args.name}". Review with list_proposed_entities, then approve_proposed_entity.`
          : `Already ${status} as proposal #${id} — not re-staged.`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        console.error("propose_entity tool failed:", err);
        return { content: [{ type: "text", text: `Propose failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "list_proposed_entities",
    {
      title: "List proposed entities awaiting review",
      description:
        "List entities the connector-ingest lane PROPOSED creating from an artifact signal (e.g. a document " +
        "vendor, an email sender) but that no human has approved yet. Review, then approve_proposed_entity or " +
        "reject_proposed_entity. Read-only — proposes nothing itself.",
      inputSchema: {
        status: z.enum(['pending', 'approved', 'rejected']).optional().describe("Filter by status (default pending)."),
        limit: z.coerce.number().int().positive().max(100).optional().describe("Max rows to return (default 20)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status = 'pending', limit = 20 }) => {
      const rows = listProposedEntities(status, limit);
      if (rows.length === 0) return { content: [{ type: "text", text: `No ${status} proposed entities.` }] };
      const txt = rows
        .map((p) => `- (#${p.id}) [${p.suggested_kind}] "${p.suggested_name}" via ${p.alias_type} "${p.alias}"${p.source ? ` from ${p.source}` : ""} — ${p.status}`)
        .join("\n");
      return { content: [{ type: "text", text: txt }] };
    }
  );

  server.registerTool(
    "approve_proposed_entity",
    {
      title: "Approve a proposed entity",
      description:
        "Approve a pending proposed entity (from list_proposed_entities): create it and retroactively link the " +
        "artifact(s) that referenced it. This is the gate that keeps low-signal senders out of the graph.",
      inputSchema: {
        id: z.coerce.number().int().positive().describe("proposed_entities id to approve."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const { entity_id } = approveProposedEntity(id);
        return { content: [{ type: "text", text: `Approved proposal #${id} → created entity #${entity_id} and linked its artifacts.` }] };
      } catch (err) {
        console.error("approve_proposed_entity tool failed:", err);
        return { content: [{ type: "text", text: `Approve failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "reject_proposed_entity",
    {
      title: "Reject a proposed entity",
      description:
        "Reject a proposed entity so it is not created. The proposal is retained (never re-raised on re-ingest). " +
        "Use for low-signal senders/vendors you don't want on the graph.",
      inputSchema: {
        id: z.coerce.number().int().positive().describe("proposed_entities id to reject."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        rejectProposedEntity(id);
        return { content: [{ type: "text", text: `Rejected proposal #${id}. It will not be re-raised.` }] };
      } catch (err) {
        console.error("reject_proposed_entity tool failed:", err);
        return { content: [{ type: "text", text: `Reject failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "add_relationship",
    {
      title: "Link two existing entities",
      description:
        "Create a directional relationship between two entities that ALREADY exist in the graph (e.g. a person " +
        "worksAt an org). Each side is a name (resolved) or a numeric entity id; the edge points from → to. Both " +
        "entities must exist first — if one doesn't, propose_entity it and get it approved, then call this. Give a " +
        "canonical relation_type (e.g. worksAt, spouse, manager) or a free-text raw_label. Idempotent.",
      inputSchema: {
        from: z.union([z.number().int().positive(), z.string().trim().min(1)]).describe("Source entity (edge points from here): a name or a numeric id. For employment, the person."),
        to: z.union([z.number().int().positive(), z.string().trim().min(1)]).describe("Target entity: a name or a numeric id. For employment, the org."),
        relation_type: z.string().trim().min(1).optional().describe("Canonical type, e.g. worksAt, spouse, parent, manager. One of relation_type/raw_label is required."),
        raw_label: z.string().trim().min(1).optional().describe("Free-text label for a relation with no canonical type."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, to, relation_type, raw_label }) => {
      try {
        const { added, relation_type: type, from: fromName, to: toName } = addRelationship({ from, to, relation_type, raw_label });
        const arrow = `"${fromName}" —[${type}]→ "${toName}"`;
        return { content: [{ type: "text", text: added ? `Linked ${arrow}.` : `Relationship already existed: ${arrow}.` }] };
      } catch (err) {
        console.error("add_relationship tool failed:", err);
        return { content: [{ type: "text", text: `Add relationship failed: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

// --- EXPRESS APP ---
const app = express();

// Behind a reverse proxy (Cloudflare Tunnel — docs/07-cloudflare-tunnel-setup.md) rate limiting
// and IP logging must use the real client IP from X-Forwarded-For, not the proxy's 127.0.0.1.
app.set('trust proxy', TRUST_PROXY);

// Access logging (#178): one funnel for every /api, /mcp, /ui request. Mounted FIRST — after
// `trust proxy` so req.ip is the real client IP (not the tunnel's 127.0.0.1), and before the rate
// limiter so a 429 is logged too. Secrets in the URL (api_key query, capability path tokens) are
// redacted before writing; bodies are never logged. Boot housekeeping (best-effort, non-fatal):
// ensure the dir is NTFS-compressed so new daily files inherit it, then prune past the retention window.
if (ACCESS_LOG_ENABLED) {
  app.use(accessLogMiddleware);
  ensureCompressed(ACCESS_LOG_DIR)
    .then((r) => console.log(`access log: ${path.resolve(ACCESS_LOG_DIR)} · compress ${JSON.stringify(r)}`))
    .catch((err) => console.error("access-log: ensureCompressed failed", err));
  pruneOldLogs(ACCESS_LOG_DIR, ACCESS_LOG_RETENTION_DAYS)
    .then((r) => console.log(`access log: retention ${ACCESS_LOG_RETENTION_DAYS}d · pruned ${r.pruned}, kept ${r.kept}`))
    .catch((err) => console.error("access-log: prune failed", err));
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: "Rate limit breached. Request rejected." }
});
app.use(apiLimiter); // rate-limit every route first, before any body parsing

// The /api/v1 connector router carries its OWN 256 KB JSON parser (contract §2). Mounting it
// ahead of the global 32 KB parser lets ingest bodies exceed 32 KB while every legacy route
// keeps the 32 KB cap — the global parser below no-ops on the ingest body it already parsed.
app.use('/api/v1', buildIngestRouter({ requireAuth }));

app.use(express.json({ limit: '32kb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- REST ENDPOINTS ---
app.post('/api/remember', requireAuth, wrap(async (req, res) => {
  const { content } = RememberSchema.parse(req.body);
  const id = await executeStore(content);
  res.json({ success: true, id });
}));

app.post('/api/recall', requireAuth, wrap(async (req, res) => {
  const { query, limit } = RecallSchema.parse(req.body);
  const results = await executeRecall(query, limit);
  res.json({ results });
}));

app.post('/api/search', requireAuth, wrap(async (req, res) => {
  const { query, types, time_range, entities, near, radius_km, limit } = SearchSchema.parse(req.body);
  const results = await hybridSearch(query, { limit: limit ?? 3, types, timeRange: time_range, entities, near, radiusKm: radius_km });
  res.json({ results });
}));

app.post('/api/timeline', requireAuth, wrap(async (req, res) => {
  const { start, end, types, limit } = TimelineSchema.parse(req.body);
  res.json({ results: timeline(start, end, types, limit ?? 50) });
}));

app.post('/api/about_entity', requireAuth, wrap(async (req, res) => {
  const { name, limit } = AboutEntitySchema.parse(req.body);
  res.json(aboutEntity(name, limit ?? 10));
}));

app.get('/api/artifact/:id', requireAuth, wrap(async (req, res) => {
  const { id } = GetArtifactSchema.parse({ id: req.params.id });
  const a = getArtifactById(id);
  if (!a) return res.status(404).json({ error: "Not found" });
  res.json(a);
}));

// First /api/v1 route (docs/04-connector-contract.md §6, roadmap M0 deliverable 4): the
// registry connectors self-check against at startup. No streams array — the event lane
// is deferred, and advertising streams with no POST /api/v1/events behind them would
// mislead connector authors.
app.get('/api/v1/ingest/types', requireAuth, wrap(async (req, res) => {
  res.json({ version: 'v1', types: TYPE_REGISTRY });
}));

// Entity merge + duplicate detection (#75): the core-owned curation admin surface (doc
// 03 §7's "accept occasional manual merges" — connectors may never merge/assert entities,
// contract §1.2, so this exists in core, separate from the /api/v1/ingest connector lane).
app.get('/api/v1/entities/duplicates', requireAuth, wrap(async (req, res) => {
  const { limit } = DuplicatesQuerySchema.parse(req.query);
  res.json({ pairs: listProbableDuplicates(limit ?? 20) });
}));

app.post('/api/v1/entities/merge', requireAuth, wrap(async (req, res) => {
  const { keep_id, absorb_id } = MergeEntitiesSchema.parse(req.body);
  try {
    const result = mergeEntities(keep_id, absorb_id);
    res.json({ merged: true, ...result });
  } catch (err) {
    if (err.code === 'SELF_MERGE') return res.status(422).json({ error: err.message });
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    throw err; // unexpected — let the generic error middleware handle it
  }
}));

// #84 — photographed contacts, for photo-exif's face-worker suggest-labels command to use as
// reference faces. Read-only; core never touches face descriptors (doc 04 §11, both directions).
// Shared contact-photo resolver (#112): the single precedence BOTH the UI route and the
// face-match source honor — the uploaded UI override (attrs.photoFile, confined to
// CONTACT_PHOTO_DIR + existence-checked) wins over the imported vCard photo (raw_path). Returns an
// absolute path that exists on disk, or null. Defined before the first user (this /photos route)
// so the two readers share one definition rather than diverging as they did before #112.
const CONTACT_PHOTO_DIR = path.resolve(CONTACTS_RAW_DIR);
const fileExists = async (p) => { try { await access(p); return true; } catch { return false; } };
async function resolveContactPhotoFile({ photoFile, rawPath }) {
  if (photoFile) {
    const resolved = path.resolve(CONTACT_PHOTO_DIR, photoFile);
    if (resolved.startsWith(CONTACT_PHOTO_DIR + path.sep) && await fileExists(resolved)) return resolved;
  }
  if (rawPath && await fileExists(rawPath)) return rawPath;
  return null;
}

app.get('/api/v1/entities/photos', requireAuth, wrap(async (req, res) => {
  const { limit } = ContactPhotosQuerySchema.parse(req.query);
  // Apply the shared precedence to each candidate pair; drop contacts whose current photo isn't on
  // disk. Output keeps the `raw_path` FIELD NAME (fetchContactPhotos' wire contract) but its value
  // is now the RESOLVED current photo — the uploaded override if present, else the imported vCard.
  const resolved = await Promise.all(listContactPhotos(limit ?? 100).map(async (r) => {
    const file = await resolveContactPhotoFile({ photoFile: r.photo_file, rawPath: r.raw_path });
    return file ? { entity_id: r.entity_id, name: r.name, raw_path: file } : null;
  }));
  res.json({ contacts: resolved.filter(Boolean) });
}));

// --- CONTACTS CURATION SURFACE (#96) ---
// Web-UI-driven edits to the entity graph — correct aliases/attrs, edit relationships, set a
// photo. Core-owned (connectors may never mutate entities — contract §1.2), same family as the
// merge/duplicates routes above. db.js err.code maps to HTTP (ALIAS_CONFLICT→409, NOT_FOUND→404,
// BAD_ALIAS→422) mirroring the /merge handler. The literal /entities routes above are registered
// before these `/:id` routes, so they win the match.
const mapEntityError = (err, res) => {
  if (err.code === 'ALIAS_CONFLICT') return res.status(409).json({ error: err.message, conflict: err.conflict });
  if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
  if (err.code === 'BAD_ALIAS') return res.status(422).json({ error: err.message });
  throw err; // unexpected — let the generic error middleware handle it
};

app.get('/api/v1/entities', requireAuth, wrap(async (req, res) => {
  const { query, kind, limit, offset } = ListEntitiesQuerySchema.parse(req.query);
  res.json({ entities: listEntities({ query, kind, limit: limit ?? 50, offset: offset ?? 0 }) });
}));

app.post('/api/v1/entities', requireAuth, wrap(async (req, res) => {
  const body = CreateEntitySchema.parse(req.body);
  try { res.status(201).json({ id: createEntity(body) }); }
  catch (err) { mapEntityError(err, res); }
}));

// Proposed-entities review queue (#119). Literal '/proposed*' paths MUST precede the '/:id' route
// below, or Express matches "proposed" as an :id (which then fails IdParamSchema coercion).
app.get('/api/v1/entities/proposed', requireAuth, wrap(async (req, res) => {
  const { status, limit } = ProposedQuerySchema.parse(req.query);
  res.json({ proposals: listProposedEntities(status ?? 'pending', limit ?? 20) });
}));

// #232: propose a new entity (agent-facing WRITE). Stages a pending proposal — never mints — so it
// lands in the same review queue the GET above serves. 201 when newly staged, 200 when the
// (name, alias, alias_type) already existed (idempotent; returns the existing id + status).
app.post('/api/v1/entities/proposed', requireAuth, wrap(async (req, res) => {
  const { id, created, status } = stageProposedEntity(ProposeEntitySchema.parse(req.body));
  res.status(created ? 201 : 200).json({ id, proposed: created, status });
}));

app.post('/api/v1/entities/proposed/:id/approve', requireAuth, wrap(async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  try { res.json(approveProposedEntity(id)); }
  catch (err) {
    if (err.code === 'ALREADY_RESOLVED') return res.status(409).json({ error: err.message });
    mapEntityError(err, res); // NOT_FOUND → 404, else rethrow to the generic middleware
  }
}));

app.post('/api/v1/entities/proposed/:id/reject', requireAuth, wrap(async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  try { res.json(rejectProposedEntity(id)); }
  catch (err) {
    if (err.code === 'ALREADY_RESOLVED') return res.status(409).json({ error: err.message });
    mapEntityError(err, res); // NOT_FOUND → 404, else rethrow to the generic middleware
  }
}));

// #162: stage review proposals from the loaded side contact directory (#154) — the same idempotent,
// zero-entity-minting pass as `npm run backfill:directory-proposals`. No body; returns { scanned, proposed }.
app.post('/api/v1/entities/proposed/stage-from-directory', requireAuth, wrap(async (req, res) => {
  res.json(backfillDirectoryProposals());
}));

app.get('/api/v1/entities/:id', requireAuth, wrap(async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const profile = getEntityProfile(id);
  if (!profile) return res.status(404).json({ error: "Not found" });
  res.json(profile);
}));

app.patch('/api/v1/entities/:id', requireAuth, wrap(async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const body = UpdateEntitySchema.parse(req.body);
  try { res.json(updateEntityAttrs(id, body)); }
  catch (err) { mapEntityError(err, res); }
}));

app.post('/api/v1/entities/:id/aliases', requireAuth, wrap(async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const { alias, alias_type } = AliasBodySchema.parse(req.body);
  try { res.json(addAlias(id, alias, alias_type)); }
  catch (err) { mapEntityError(err, res); }
}));

app.delete('/api/v1/entities/:id/aliases', requireAuth, wrap(async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const { alias, alias_type } = AliasBodySchema.parse(req.body);
  res.json(removeAlias(id, alias, alias_type));
}));

app.post('/api/v1/entities/:id/relations', requireAuth, wrap(async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const { to_entity_id, relation_type, raw_label } = AddRelationSchema.parse(req.body);
  if (id === to_entity_id) return res.status(422).json({ error: "a relation cannot point at itself" });
  if (!getEntity(to_entity_id)) return res.status(404).json({ error: `entity ${to_entity_id} not found` });
  const type = relation_type ?? canonicalRelationType(raw_label);
  const added = upsertEntityRelation({ from_entity_id: id, to_entity_id, relation_type: type, raw_label: raw_label ?? null, confidence: 1.0, source: 'contacts-ui' });
  res.json({ added, relation_type: type });
}));

app.delete('/api/v1/entities/:id/relations/:relationId', requireAuth, wrap(async (req, res) => {
  const { relationId } = RelationParamSchema.parse(req.params);
  res.json(removeRelation(relationId));
}));

// Photo upload: raw image bytes (not multipart) — the browser POSTs the File as the body with its
// own Content-Type; express.raw buffers it (capped → 413 via the error middleware). Non-image →
// 415. Bytes go to the content-addressed store; the basename is recorded in attrs.photoFile. The
// imported contact artifact's raw_path is never touched (append-only).
app.post('/api/v1/entities/:id/photo', requireAuth, express.raw({ type: () => true, limit: CONTACT_PHOTO_MAX_BYTES }), wrap(async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const mediaType = req.headers['content-type'] || '';
  if (!/^image\//i.test(mediaType)) return res.status(415).json({ error: "Content-Type must be image/*" });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "Empty image body" });
  try { res.json(setEntityPhotoFile(id, await savePhotoBytes(req.body, mediaType))); }
  catch (err) { mapEntityError(err, res); }
}));

// Photo download: the uploaded override (attrs.photoFile, confined to CONTACTS_RAW_DIR) wins over
// the imported vCard photo (raw_path); 404 when the contact has neither. The UI fetches this with
// the key header and renders the blob (a plain <img src> can't send x-api-key).
app.get('/api/v1/entities/:id/photo', requireAuth, wrap(async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const profile = getEntityProfile(id);
  if (!profile) return res.status(404).json({ error: "Not found" });
  const file = await resolveContactPhotoFile({ photoFile: profile.entity.attrs?.photoFile, rawPath: getContactPhotoRawPath(id) });
  if (!file) return res.status(404).json({ error: "No photo" });
  // dotfiles:'allow' — send() defaults to 'ignore', which 404s any path whose segments start with
  // a dot (e.g. a data dir under a hidden ancestor). resolveContactPhotoFile already validated it
  // (an uploaded photoFile is confined to CONTACT_PHOTO_DIR; both branches are existence-checked via
  // access()), so serving it is safe; send still sets Content-Type from the extension.
  res.sendFile(file, { dotfiles: 'allow' });
}));

// --- STATIC WEB UI (#96, token-only #169) ---
// Token-only by construction (#169): the UI is served ONLY when UI_URL_TOKEN is set, and ONLY at
// /<token>/ui/… — there is NO open /ui mount. This closes a secure-by-default gap: an unset token
// behind a tunnel used to serve the UI page to the whole internet. Unset now means no UI mount at
// all, so /ui/* and /<anything>/ui/* all fall through to 404 (a tunnel can expose nothing). The
// page's browser credential is the path token itself (parsed from location.pathname, sent as
// x-api-key), which requireAuth accepts (#163) — so there is no manual-key entry path anymore.
// Static files carry no secret. Asset/nav refs in the HTML are RELATIVE (./style.css) so they
// resolve under the tokened mount. Mounted after the rate limiter so page/asset loads are limited.
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
if (UI_URL_TOKEN) {
  // Capability-URL gate (#161, #165): token-FIRST, matching the MCP capability URL /<token>/mcp
  // (#63), so both surfaces share one convention. Two-segment ('/:token/ui') NOT a bare '/:token'
  // router: the latter would shadow /api/* (#63); this only matches paths whose 2nd segment is
  // 'ui', so /api/recall never does. The guard 404s a wrong/absent token; the bare /ui (no token)
  // never matches, so it falls through to 404 — world-unloadable without the URL.
  app.use('/:token/ui', requireUiPathToken, express.static(publicDir));
}

// --- STREAMABLE HTTP MCP TRANSPORT ---
const activeMcpTransports = new Map();

async function handleMcpPost(req, res) {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && activeMcpTransports.has(sessionId)) {
    const transport = activeMcpTransports.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        activeMcpTransports.set(id, transport);
      }
    });

    // onclose is a property on the transport instance, not a constructor option
    transport.onclose = () => {
      if (transport.sessionId) activeMcpTransports.delete(transport.sessionId);
    };

    const server = buildMcpServer(); // fresh server for this session
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // No valid session and not an initialize request — reject rather than silently
  // spinning up a transport for a stray/expired/malformed POST.
  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: No valid session ID provided" },
    id: null
  });
}

app.post("/mcp", requireAuth, wrap(handleMcpPost));

// GET opens the server-initiated notification stream; DELETE explicitly ends a session.
// Both need an existing, valid session — neither should ever create one.
const handleExistingSession = wrap(async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = activeMcpTransports.get(sessionId);
  if (!transport) {
    return res.status(400).send("Invalid or missing session ID");
  }
  await transport.handleRequest(req, res);
});

app.get("/mcp", requireAuth, handleExistingSession);
app.delete("/mcp", requireAuth, handleExistingSession);

// Path-token form of the same three routes, header-free, for clients that can only take a
// bare URL (claude.ai web — issue #63). Explicit two-segment "/:token/mcp" rather than a
// router mounted at "/:token": the latter would run its guard for "/api/..." too and shadow
// every REST route. Registered only when MCP_URL_TOKEN is set — otherwise even a wrong-shaped
// 404 from requirePathToken would be distinguishable from Express's default "no such route"
// 404, letting a probe learn this feature exists at all. Unset means these routes never exist.
if (MCP_URL_TOKEN) {
  app.post("/:token/mcp", requirePathToken, wrap(handleMcpPost));
  app.get("/:token/mcp", requirePathToken, handleExistingSession);
  app.delete("/:token/mcp", requirePathToken, handleExistingSession);
}

// --- ERROR MIDDLEWARE ---
app.use((err, req, res, next) => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: "Validation Failed", details: err.issues });
  }
  // Body-parser (and other middleware) errors carry a numeric HTTP status: the 256 KB ingest
  // cap surfaces as err.type='entity.too.large' / status 413, a malformed JSON body as 400.
  // Honor a 4xx here so it doesn't fall into the generic 500 branch (this also fixes the latent
  // bug where the legacy 32 KB cap 500'd). 5xx / unstatus'd errors → opaque 500 below.
  const status = err.status ?? err.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return res.status(status).json({ error: err.type ?? err.message ?? "Bad Request" });
  }
  console.error("🔥 System Exception Blocked:", err);
  res.status(500).json({ error: "Internal server error" });
});

const serverInstance = app.listen(PORT, () => {
  // Log the resolved DB file (#170) so a stray/mis-pointed instance — e.g. a dev server that
  // should be on a copy but isn't — is obvious in the log and `ps`, not silently sharing the live DB.
  console.log(`🔒 Local Ollama-Powered Streamable HTTP Brain operating on port ${PORT} · db ${path.resolve(DB_PATH)}`);
  // UI state at a glance (#169): token-only, no open mount. The token value itself is never logged.
  console.log(UI_URL_TOKEN ? 'web UI: /<token>/ui/… (UI_URL_TOKEN set)' : 'web UI: disabled (set UI_URL_TOKEN)');
});

// --- GRACEFUL SHUTDOWN ---
const shutdown = () => {
  // Close active MCP transports first — an open GET/notification stream would
  // otherwise keep serverInstance.close() waiting indefinitely.
  for (const transport of activeMcpTransports.values()) {
    transport.close();
  }
  serverInstance.close(async () => {
    await closeAccessLog(); // flush the access-log stream so a buffered final line isn't lost on exit
    db.close();
    process.exit(0);
  });
  // Belt-and-suspenders: force exit if something still won't close.
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Test seams (no runtime behavior): the app + its listener for an in-process HTTP smoke test,
// and the constant-time auth comparator for a direct unit test. Not imported by any src/ module.
export { app, serverInstance, secureCompare };
