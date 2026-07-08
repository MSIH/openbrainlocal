#!/usr/bin/env node
/**
 * Architecture: Unlimited Local Shared Brain (Web API + Streamable HTTP MCP Server)
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
import rateLimit from 'express-rate-limit';

import { PORT, LIFECONTEXT_API_KEY, LIFECONTEXT_API_KEY_PLACEHOLDER } from './config.js';
import { db, storeArtifactTxn, sha256 } from './db.js';
import { embedToFloat32 } from './embeddings.js';
import { hybridSearch, timeline, aboutEntity, getArtifactById, ARTIFACT_TYPES } from './search.js';
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
  return results.map((a) => ({ content: a.text_repr, created_at: a.occurred_at ?? a.ingested_at, distance: a.distance }));
}

// --- SHARED VALIDATION SCHEMAS (REST + MCP use the same bounds) ---
const ContentSchema = z.string().min(1, "Content cannot be empty");
const LimitSchema = z.number().int().min(1).max(50).default(3);
const TypeEnum = z.enum(ARTIFACT_TYPES);
const RememberSchema = z.object({ content: ContentSchema });
const RecallSchema = z.object({ query: z.string().min(1, "Query cannot be empty"), limit: LimitSchema });
const SearchSchema = z.object({
  query: z.string().min(1, "Query cannot be empty"),
  types: z.array(TypeEnum).optional(),
  time_range: z.object({ start: z.string(), end: z.string() }).partial().optional(),
  entities: z.array(z.string()).optional(),
  limit: LimitSchema.optional(),
});
const TimelineSchema = z.object({
  start: z.string().min(1), end: z.string().min(1),
  types: z.array(TypeEnum).optional(), limit: LimitSchema.optional(),
});
const AboutEntitySchema = z.object({ name: z.string().min(1), limit: LimitSchema.optional() });
const GetArtifactSchema = z.object({ id: z.coerce.number().int().positive() });

// --- OUTPUT FORMATTERS (MCP tools return text) ---
const snippet = (s, n = 200) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");
const artifactLine = (a) => `- [${a.type}${a.occurred_at ? ` · ${a.occurred_at}` : ""}${a.distance != null ? ` · ${a.distance.toFixed(3)}` : ""}] (#${a.id}) ${snippet(a.text_repr)}`;

// --- AUTH ---
function secureCompare(input, secret) {
  if (typeof input !== 'string' || typeof secret !== 'string') return false;
  const inputHash = createHash('sha256').update(input).digest();
  const secretHash = createHash('sha256').update(secret).digest();
  return timingSafeEqual(inputHash, secretHash);
}

function requireHeaderAuth(req, res, next) {
  const token = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!secureCompare(token, LIFECONTEXT_API_KEY)) {
    return res.status(401).json({ error: "Unauthorized: Invalid or missing secret key token." });
  }
  next();
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
        limit: LimitSchema.optional().describe("Max results (1-50, default 3)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, types, time_range, entities, limit = 3 }) => {
      const results = await hybridSearch(query, { limit, types, timeRange: time_range, entities });
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
      const blocks = res.entities.map(({ entity, artifacts }) => {
        const header = `${entity.canonical_name} (${entity.kind})${entity.attrs ? ` — ${JSON.stringify(entity.attrs)}` : ""}`;
        const items = artifacts.map(artifactLine).join("\n");
        return `${header}\n${items || "  (no linked artifacts yet)"}`;
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

  return server;
}

// --- EXPRESS APP ---
const app = express();

// If deployed behind a reverse proxy (nginx, Cloudflare), uncomment so rate limiting
// and IP logging use the real client IP instead of the proxy's:
// app.set('trust proxy', 1);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: "Rate limit breached. Request rejected." }
});
app.use(apiLimiter); // rate-limit every route first, before any body parsing

// The /api/v1 connector router carries its OWN 256 KB JSON parser (contract §2). Mounting it
// ahead of the global 32 KB parser lets ingest bodies exceed 32 KB while every legacy route
// keeps the 32 KB cap — the global parser below no-ops on the ingest body it already parsed.
app.use('/api/v1', buildIngestRouter({ requireAuth: requireHeaderAuth }));

app.use(express.json({ limit: '32kb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- REST ENDPOINTS ---
app.post('/api/remember', requireHeaderAuth, wrap(async (req, res) => {
  const { content } = RememberSchema.parse(req.body);
  const id = await executeStore(content);
  res.json({ success: true, id });
}));

app.post('/api/recall', requireHeaderAuth, wrap(async (req, res) => {
  const { query, limit } = RecallSchema.parse(req.body);
  const results = await executeRecall(query, limit);
  res.json({ results });
}));

app.post('/api/search', requireHeaderAuth, wrap(async (req, res) => {
  const { query, types, time_range, entities, limit } = SearchSchema.parse(req.body);
  const results = await hybridSearch(query, { limit: limit ?? 3, types, timeRange: time_range, entities });
  res.json({ results });
}));

app.post('/api/timeline', requireHeaderAuth, wrap(async (req, res) => {
  const { start, end, types, limit } = TimelineSchema.parse(req.body);
  res.json({ results: timeline(start, end, types, limit ?? 50) });
}));

app.post('/api/about_entity', requireHeaderAuth, wrap(async (req, res) => {
  const { name, limit } = AboutEntitySchema.parse(req.body);
  res.json(aboutEntity(name, limit ?? 10));
}));

app.get('/api/artifact/:id', requireHeaderAuth, wrap(async (req, res) => {
  const { id } = GetArtifactSchema.parse({ id: req.params.id });
  const a = getArtifactById(id);
  if (!a) return res.status(404).json({ error: "Not found" });
  res.json(a);
}));

// First /api/v1 route (docs/04-connector-contract.md §6, roadmap M0 deliverable 4): the
// registry connectors self-check against at startup. No streams array — the event lane
// is deferred, and advertising streams with no POST /api/v1/events behind them would
// mislead connector authors.
app.get('/api/v1/ingest/types', requireHeaderAuth, wrap(async (req, res) => {
  res.json({ version: 'v1', types: TYPE_REGISTRY });
}));

// --- STREAMABLE HTTP MCP TRANSPORT ---
const activeMcpTransports = new Map();

app.post("/mcp", requireHeaderAuth, wrap(async (req, res) => {
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
}));

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

app.get("/mcp", requireHeaderAuth, handleExistingSession);
app.delete("/mcp", requireHeaderAuth, handleExistingSession);

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
  console.log(`🔒 Local Ollama-Powered Streamable HTTP Brain operating on port ${PORT}`);
});

// --- GRACEFUL SHUTDOWN ---
const shutdown = () => {
  // Close active MCP transports first — an open GET/notification stream would
  // otherwise keep serverInstance.close() waiting indefinitely.
  for (const transport of activeMcpTransports.values()) {
    transport.close();
  }
  serverInstance.close(() => {
    db.close();
    process.exit(0);
  });
  // Belt-and-suspenders: force exit if something still won't close.
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
