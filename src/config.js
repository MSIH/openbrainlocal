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

// Boolean env: only an explicit falsey token turns a default-true flag off; anything else
// (unset, empty, "true", "1", junk) keeps the default. Case-insensitive.
const bool = (v, dflt) => {
  if (v === undefined) return dflt;
  const s = v.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  return dflt;
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

// Max bytes accepted by the contacts-UI photo upload (#96). Caps the express.raw body so a
// huge/hostile upload can't exhaust memory; 10 MB comfortably fits a phone photo.
export const CONTACT_PHOTO_MAX_BYTES = int(process.env.CONTACT_PHOTO_MAX_BYTES, 10 * 1024 * 1024);

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
// Query-planner controls (#179). The planner is a small JSON call, but on a CPU-only host a
// 3B model can take >10s — so fail over to pure-semantic FAST rather than stall every search.
// QUERY_PLAN_TIMEOUT_MS bounds the single planner attempt (was a hardcoded 8000); a fast/GPU
// host that answers within it still gets planned filters. QUERY_PLANNER_ENABLED=false skips the
// LLM call entirely (search behaves like usePlanner:false — pure semantic + keyword, sub-second)
// for a box where the planner never beats even a low timeout.
export const QUERY_PLAN_TIMEOUT_MS = int(process.env.QUERY_PLAN_TIMEOUT_MS, 2500);
export const QUERY_PLANNER_ENABLED = bool(process.env.QUERY_PLANNER_ENABLED, true);
// Cap on planner output tokens — the plan is a tiny JSON and generation time dominates on CPU,
// so bounding it is the single biggest per-search win. Env-overridable but left out of
// .env.example (an internal safety cap most installs never touch).
export const QUERY_PLAN_MAX_TOKENS = int(process.env.QUERY_PLAN_MAX_TOKENS, 128);

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

// --- Access logging (all surfaces: /api, /mcp, /ui) — #178 ---
// One request-logging middleware writes a per-request line (method/path/status/IP/latency/surface/
// auth) to a daily file; secrets (the api_key query param, capability path tokens) are redacted and
// request bodies are never logged. Default on; ACCESS_LOG_ENABLED=false (or 0/no/off) disables it.
const accessLogFlag = (process.env.ACCESS_LOG_ENABLED ?? '').trim().toLowerCase();
export const ACCESS_LOG_ENABLED = !(accessLogFlag === 'false' || accessLogFlag === '0' || accessLogFlag === 'no' || accessLogFlag === 'off');
export const ACCESS_LOG_DIR = process.env.ACCESS_LOG_DIR || 'logs/access';
// Days of dated files to keep; boot prunes older. A non-positive value (incl. an explicit 0) or a
// malformed one falls back to the 90-day default (0/unset = keep 90; a positive N prunes older).
const accessLogRetention = int(process.env.ACCESS_LOG_RETENTION_DAYS, 90);
export const ACCESS_LOG_RETENTION_DAYS = accessLogRetention > 0 ? accessLogRetention : 90;

// Optional capability-URL token for the claude.ai web MCP connector, which offers no header
// field (anthropics/claude-ai-mcp #112). Distinct from LIFECONTEXT_API_KEY — it rides in the
// URL path, so it lands in Cloudflare edge/proxy access logs and must be rotatable on its own
// without invalidating the header key CLI/Desktop clients use. Unset (undefined) = feature off:
// every /:token/mcp request 404s exactly like today. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
export const MCP_URL_TOKEN = process.env.MCP_URL_TOKEN;

// Optional capability-URL token for the browser web UI (#161) — a distinct secret from
// LIFECONTEXT_API_KEY and MCP_URL_TOKEN so each surface (REST key, MCP capability URL, browser UI)
// rotates independently. When SET, the UI is served ONLY at /ui/<token>/… (a bookmarkable capability
// URL, 404 otherwise) and requireAuth also accepts it, so the bookmarked page's /api calls authorize
// with no manual key entry. Unset/empty (trimmed) = feature off: the UI stays at the plain /ui mount
// (localhost dev). Like MCP_URL_TOKEN it rides in the URL (edge/proxy logs, browser history) — a
// browser-bookmark convenience credential; front /ui with Cloudflare Access for exposure (docs/07).
export const UI_URL_TOKEN = (process.env.UI_URL_TOKEN || '').trim() || undefined;
