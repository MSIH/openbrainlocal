#!/usr/bin/env node
/**
 * Architecture: Unlimited Local Shared Brain (Web API + Streamable HTTP MCP Server)
 *
 * Adapted from Nate B. Jones's OB1 (Open Brain) framework.
 * https://github.com/NateBJones-Projects/OB1
 *
 * v2.2 changes (this pass):
 *  - Per-session McpServer factory (fixes cross-session response routing)
 *  - transport.onclose set as a property, not a constructor option (fixes session-map leak)
 *  - New sessions gated on isInitializeRequest (stray POSTs no longer spawn transports)
 *  - GET and DELETE handlers added for /mcp (notification stream + explicit termination)
 *  - Shutdown closes active transports before closing the HTTP server, with a force-exit timer
 */

import express from 'express';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { timingSafeEqual, createHash, randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';

dotenv.config();

// --- CONFIGURATION CONSTANTS ---
const PORT = process.env.PORT || 3000;
const EMBEDDING_MODEL = "qwen3-embedding:0.6b"; // local Ollama embedding model
const VECTOR_DIMENSION = 1024;                  // was 1536 (OpenAI); Qwen3 embeddings are 1024-dim

// Fail closed instantly if the secret is unset or still the placeholder
const BRAIN_SECRET_KEY = process.env.BRAIN_SECRET_KEY;
if (!BRAIN_SECRET_KEY || BRAIN_SECRET_KEY === "change-this-to-a-long-secure-token") {
  console.error("❌ CRITICAL ERROR: BRAIN_SECRET_KEY is unset or insecure. System halting.");
  process.exit(1);
}

// --- DATABASE CORE SETUP (WAL MODE) ---
const db = new Database('unlimited_shared_brain.db');
sqliteVec.load(db);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
    memory_id INTEGER PRIMARY KEY,
    embedding float[${VECTOR_DIMENSION}]
  );
`);

// --- LOCAL EMBEDDING GATEWAY (Ollama; was OpenRouter) ---
const openrouter = new OpenAI({
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama", // Ollama ignores it, but the OpenAI SDK requires a non-empty string
});

// Prepared statements, compiled once
const insertRawStmt = db.prepare('INSERT INTO memories (content) VALUES (?)');
const insertVecStmt = db.prepare('INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)');
const recallStmt = db.prepare(`
  SELECT m.content, m.created_at, v.distance
  FROM vec_memories v
  JOIN memories m ON v.memory_id = m.id
  WHERE v.embedding MATCH ? AND k = ?
  ORDER BY v.distance ASC
`);

// Atomic store: both inserts succeed or neither does
const storeTxn = db.transaction((content, float32Vector) => {
  const info = insertRawStmt.run(content);
  const memoryId = info.lastInsertRowid;
  insertVecStmt.run(memoryId, float32Vector);
  return memoryId;
});

// --- CORE ASYNC UTILITIES ---
async function getEmbedding(text) {
  const response = await openrouter.embeddings.create({ input: [text], model: EMBEDDING_MODEL });
  return response.data[0].embedding;
}

async function executeStore(content) {
  // Fetch the embedding BEFORE touching the DB, so a failed API call never orphans a row
  const embeddingArray = await getEmbedding(content);
  const float32Vector = new Float32Array(embeddingArray);
  return storeTxn(content, float32Vector);
}

async function executeRecall(query, limit) {
  const embeddingArray = await getEmbedding(query);
  const float32Vector = new Float32Array(embeddingArray);
  const matches = recallStmt.all(float32Vector, limit);
  return matches.map(row => ({
    content: row.content,
    created_at: row.created_at,
    distance: row.distance
  }));
}

// --- SHARED VALIDATION SCHEMAS (REST + MCP use the same bounds) ---
const ContentSchema = z.string().min(1, "Content cannot be empty");
const LimitSchema = z.number().int().min(1).max(50).default(3);
const RememberSchema = z.object({ content: ContentSchema });
const RecallSchema = z.object({ query: z.string().min(1, "Query cannot be empty"), limit: LimitSchema });

// --- AUTH ---
function secureCompare(input, secret) {
  if (typeof input !== 'string' || typeof secret !== 'string') return false;
  const inputHash = createHash('sha256').update(input).digest();
  const secretHash = createHash('sha256').update(secret).digest();
  return timingSafeEqual(inputHash, secretHash);
}

function requireHeaderAuth(req, res, next) {
  const token = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!secureCompare(token, BRAIN_SECRET_KEY)) {
    return res.status(401).json({ error: "Unauthorized: Invalid or missing secret key token." });
  }
  next();
}

// --- MCP SERVER FACTORY ---
// A fresh McpServer per session. connect() binds a server to exactly one transport;
// sharing a single global server across sessions causes responses to cross-route.
function buildMcpServer() {
  const server = new McpServer({ name: "secure-web-brain", version: "2.2.0" });

  server.tool("store_memory", { content: ContentSchema }, async ({ content }) => {
    const id = await executeStore(content);
    return { content: [{ type: "text", text: `Memory logged successfully under local ID: ${id}` }] };
  });

  server.tool(
    "search_memories",
    { query: z.string().min(1), limit: LimitSchema.optional() },
    async ({ query, limit = 3 }) => {
      const matches = await executeRecall(query, limit);
      if (matches.length === 0) {
        return { content: [{ type: "text", text: "No relevant long-term context found." }] };
      }
      const txt = matches.map(r => `- [Score: ${r.distance.toFixed(3)}] ${r.content}`).join("\n");
      return { content: [{ type: "text", text: txt }] };
    }
  );

  return server;
}

// --- EXPRESS APP ---
const app = express();
app.use(express.json({ limit: '32kb' }));

// If deployed behind a reverse proxy (nginx, Cloudflare), uncomment so rate limiting
// and IP logging use the real client IP instead of the proxy's:
// app.set('trust proxy', 1);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: "Rate limit breached. Request rejected." }
});
app.use(apiLimiter);

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
