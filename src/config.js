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

// Express 'trust proxy' hop count. 1 = one reverse proxy in front (Cloudflare Tunnel —
// docs/07-cloudflare-tunnel-setup.md); harmless for direct localhost use. Set TRUST_PROXY=0
// to never trust forwarded headers (direct-only installs).
export const TRUST_PROXY = int(process.env.TRUST_PROXY, 1);

// Local file store. Overridable via DB_PATH — set it in .env to point at an existing DB.
export const DB_PATH = process.env.DB_PATH || 'life-context.db';

// Where contacts.js writes decoded vCard PHOTO bytes (raw_path target). Relative to cwd by
// default so a fresh install just works; override to keep raw originals on a bigger disk.
export const CONTACTS_RAW_DIR = process.env.CONTACTS_RAW_DIR || 'raw/contacts';

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
export const GEO_RADIUS_DEFAULT_KM = int(process.env.GEO_RADIUS_DEFAULT_KM, 25); // default radius for `near` search (#68)
export const GEO_RADIUS_MAX_KM = int(process.env.GEO_RADIUS_MAX_KM, 500);        // clamp ceiling on radius_km

// --- Consolidation (nightly daily digests — docs/06-consolidation.md) ---
// Chat model that writes the digest. Roadmap M6 default; any Ollama chat model works.
export const DIGEST_MODEL = process.env.DIGEST_MODEL || 'qwen3:8b';
export const DIGEST_TIMEOUT_MS = int(process.env.DIGEST_TIMEOUT_MS, 120000); // digest is a bigger call than a query parse
export const DIGEST_MAX_ARTIFACTS = int(process.env.DIGEST_MAX_ARTIFACTS, 200); // cap per day so a heavy day can't blow the context
export const DIGEST_TEXT_CLIP = int(process.env.DIGEST_TEXT_CLIP, 500);     // chars of text_repr fed to the model per artifact
export const DIGEST_TIMELINE_DAYS = int(process.env.DIGEST_TIMELINE_DAYS, 14); // timeline spans >= this prefer digests over raw rows

// --- Auth --- (raw value; the server validates it — scripts don't need it)
export const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
export const LIFECONTEXT_API_KEY_PLACEHOLDER = 'change-this-to-a-long-secure-token';

// Optional capability-URL token for the claude.ai web MCP connector, which offers no header
// field (anthropics/claude-ai-mcp #112). Distinct from LIFECONTEXT_API_KEY — it rides in the
// URL path, so it lands in Cloudflare edge/proxy access logs and must be rotatable on its own
// without invalidating the header key CLI/Desktop clients use. Unset (undefined) = feature off:
// every /:token/mcp request 404s exactly like today. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
export const MCP_URL_TOKEN = process.env.MCP_URL_TOKEN;
