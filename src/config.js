/**
 * Single source of config. dotenv.config() runs HERE, before any other module reads
 * process.env — under ESM, imports are hoisted and evaluated before the importing
 * module's body, so loading .env inside each consumer would race. Every module imports
 * its constants from here, guaranteeing .env is loaded first.
 *
 * All values are env-overridable (CLAUDE.md absolute rule 1). Defaults match the
 * historical hardcoded values so existing installs are unaffected.
 */
import dotenv from 'dotenv';

dotenv.config();

const int = (v, dflt) => {
  if (v === undefined) return dflt;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : n; // malformed env → default, never NaN into SQL/search math
};

export const PORT = process.env.PORT || 3000;

// Local file store. Overridable via DB_PATH — set it in .env to point at an existing DB.
export const DB_PATH = process.env.DB_PATH || 'life-context.db';

// --- Embedding / LLM gateway (local Ollama, OpenAI-compatible) ---
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'qwen3-embedding:0.6b';
// MUST equal the embedding model's output length. qwen3-embedding:0.6b -> 1024.
// Changing the model means changing this AND re-embedding (see data-model.md rule 2).
export const VECTOR_DIMENSION = int(process.env.VECTOR_DIMENSION, 1024);
// Chat model used only by the query planner to parse a query into filters. Optional at
// runtime: if it's unreachable, search degrades gracefully to pure semantic (see search.js).
export const QUERY_MODEL = process.env.QUERY_MODEL || 'qwen2.5:3b';
// Request timeout (ms) for the embedding/LLM gateway — a hung Ollama shouldn't block for the SDK's 10-min default.
export const EMBED_TIMEOUT_MS = int(process.env.EMBED_TIMEOUT_MS, 60000);

// --- Hybrid search tuning ---
export const RRF_K = int(process.env.RRF_K, 60);          // reciprocal-rank-fusion constant
export const KNN_OVERFETCH = int(process.env.KNN_OVERFETCH, 5); // fetch limit*this before fusion/filter
export const KNN_MIN = int(process.env.KNN_MIN, 50);      // floor on k so fusion has depth
export const KNN_MAX = int(process.env.KNN_MAX, 500);     // ceiling on k (perf guard)

// --- Auth --- (raw value; the server validates it — scripts don't need it)
export const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
export const LIFECONTEXT_API_KEY_PLACEHOLDER = 'change-this-to-a-long-secure-token';
