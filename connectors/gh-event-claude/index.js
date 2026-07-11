#!/usr/bin/env node
// Claude Code `PostToolUse` hook. Fires AFTER a GitHub issue/PR create tool succeeds (see the
// matchers in .claude/settings.json), reads the hook JSON from stdin, extracts the issue/PR
// URL + number (+ title/branch, best-effort) from the tool call, and POSTs it to LifeContext as
// an `x-dev-event` artifact — so "when did I open issue/PR X" is recallable. Complements the
// devsession-claude connector, which captures the conversation, not the discrete event.
//
// Unlike devsession-claude this does NO LLM call and is registered UNGUARDED (fires locally and
// in cloud): ingest is upsert-by-(source, source_id) with source_id = the issue/PR URL, so a
// double-fire just refines the same artifact. Best-effort like every push connector: never throws
// past main(), always exits 0 so a slow/broken hook can't hang or fail the user's terminal
// (docs/04-connector-contract.md §7 "Failure posture").
import { readFile, appendFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadDotEnvIfPresent();

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const SPOOL_PATH = process.env.GH_EVENT_SPOOL_PATH
  || path.join(os.homedir(), '.life-context', 'gh-event-spool.jsonl');

const SOURCE = 'gh-event-claude';
const EVENT_TYPE = 'x-dev-event'; // issue/PR creation isn't a registered type; x- extension is accepted by ingest
// Owner/repo/kind/number from any github.com issue or PR URL, wherever it appears in the tool
// result (Bash `gh` stdout or a stringified MCP response). Kept loose on the host path segments.
const GH_URL_RE = /https:\/\/github\.com\/([^/\s"']+)\/([^/\s"']+)\/(issues|pull)\/(\d+)/;

// Tiny manual .env loader (no dependency): KEY=VALUE lines next to this script, never overriding a
// variable already set in the real environment. Mirrors devsession-claude.
function loadDotEnvIfPresent() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, rawValue = ''] = match;
    if (process.env[key] === undefined) process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Pull a plain-text title from either a Bash `--title "..."`/`-t "..."` flag or a parsed MCP
// response `.title`. Best-effort: a missing title just drops from text_repr, never throws.
function extractTitle(toolInput, toolResponse) {
  const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
  const flag = /(?:--title|-t)[= ]("([^"]*)"|'([^']*)'|(\S+))/.exec(command);
  if (flag) return flag[2] ?? flag[3] ?? flag[4] ?? null;
  if (typeof toolInput?.title === 'string' && toolInput.title.trim()) return toolInput.title.trim();
  const respTitle = pickFromResponse(toolResponse, 'title');
  return respTitle ?? null;
}

// MCP responses reach the hook in varying shapes (a structured object, or {content:[{text}]} with
// JSON inside). Search the object for a string field, then fall back to any embedded JSON — all
// optional-chained so an unexpected shape yields null rather than throwing.
function pickFromResponse(toolResponse, field) {
  if (toolResponse && typeof toolResponse === 'object' && typeof toolResponse[field] === 'string') {
    return toolResponse[field];
  }
  const text = stringifyResponse(toolResponse);
  const embedded = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`).exec(text);
  return embedded ? embedded[1] : null;
}

function stringifyResponse(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  try {
    return JSON.stringify(toolResponse ?? '');
  } catch {
    return '';
  }
}

// The created issue/PR URL is the anchor for source_id. Prefer an explicit `html_url` on a
// structured (MCP) response — matching the first github URL anywhere in the blob could pick up a
// link in the body/description ("Closes <url>") that precedes the created object's own link. Fall
// back to the first URL in the stringified response + Bash command; for Bash `gh` the stdout
// (prepended by the caller) is just the created URL, so first-match is the right one there.
function extractGithubUrlMatch(toolResponse, toolInput) {
  if (toolResponse && typeof toolResponse === 'object' && typeof toolResponse.html_url === 'string') {
    const fromField = GH_URL_RE.exec(toolResponse.html_url);
    if (fromField) return fromField;
  }
  const haystack = `${stringifyResponse(toolResponse)}\n${toolInput?.command ?? ''}`;
  return GH_URL_RE.exec(haystack);
}

// `mcp__github__issue_write` handles BOTH create and update; only a create is an "Opened…" event.
// (The dedicated `create_*` MCP tools and `gh … create` are creates by definition — nothing to
// check there.) An update still carries the issue's html_url, so without this guard it would be
// recorded as a phantom "Opened GitHub issue…" and pollute memory. Mirrors the gate's detection
// exactly (.claude/hooks/draft-issue-gate.sh): only an EXPLICIT non-create method is an update; a
// missing/unparseable method falls through as a create, so the two hooks agree on "a create".
function isNonCreateIssueWrite(toolName, toolInput) {
  const method = typeof toolInput?.method === 'string' ? toolInput.method : '';
  return toolName === 'mcp__github__issue_write' && method !== '' && method !== 'create';
}

// Current branch, best-effort — useful context on a PR. Never throws (detached HEAD, no git, …).
async function currentBranch(cwd) {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

async function postIngest(payload) {
  const res = await fetch(`${LIFECONTEXT_URL}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LIFECONTEXT_API_KEY },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`ingest returned ${res.status}`);
  return res.json();
}

async function spool(payload) {
  await mkdir(path.dirname(SPOOL_PATH), { recursive: true });
  await appendFile(SPOOL_PATH, `${JSON.stringify(payload)}\n`);
}

// Flush any payloads a prior server-unreachable run couldn't deliver, before the current event —
// the connector contract's failure posture (doc 04 §7): lose at most the uncommitted window.
async function flushSpool() {
  let lines;
  try {
    lines = (await readFile(SPOOL_PATH, 'utf8')).split('\n').filter((l) => l.trim());
  } catch {
    return; // no spool file yet
  }
  const remaining = [];
  for (const line of lines) {
    try {
      await postIngest(JSON.parse(line));
    } catch {
      remaining.push(line);
    }
  }
  if (remaining.length) await writeFile(SPOOL_PATH, `${remaining.join('\n')}\n`);
  else await rm(SPOOL_PATH, { force: true });
}

async function main() {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === 'change-this-to-a-long-secure-token') {
    console.error('gh-event-claude: LIFECONTEXT_API_KEY not configured (see .env.example); skipping');
    return;
  }

  const hookInput = JSON.parse(await readStdin());
  const { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse, cwd } = hookInput;

  // Skip issue_write updates before touching the response — an update is not an "Opened" event.
  if (isNonCreateIssueWrite(toolName, toolInput)) {
    console.error(`gh-event-claude: ${toolName} method=${toolInput?.method} is not a create; nothing to capture`);
    return;
  }

  // The URL is the anchor: no URL means the create didn't produce one (failed, or an update with
  // nothing to record) — nothing to remember.
  const urlMatch = extractGithubUrlMatch(toolResponse, toolInput);
  if (!urlMatch) {
    console.error(`gh-event-claude: no issue/PR URL in ${toolName} result; nothing to capture`);
    return;
  }
  const [url, owner, repo, kindPath, number] = urlMatch;
  const kind = kindPath === 'pull' ? 'pr' : 'issue';
  const repoSlug = `${owner}/${repo}`;
  const title = extractTitle(toolInput, toolResponse);
  const branch = kind === 'pr' ? await currentBranch(cwd) : null;

  await flushSpool().catch((err) => console.error('gh-event-claude: spool flush failed', err));

  const label = kind === 'pr' ? 'pull request' : 'issue';
  const titlePart = title ? ` "${title}"` : '';
  const branchPart = branch ? ` (branch ${branch})` : '';
  const textRepr = `Opened GitHub ${label} #${number}${titlePart} in ${repoSlug}${branchPart}. ${url}`;

  const payload = {
    source: SOURCE,
    source_id: url, // reproducible + globally unique → re-fire upserts, never duplicates
    type: EVENT_TYPE,
    text_repr: textRepr,
    occurred_at: new Date().toISOString(),
    extra: { kind, number: Number(number), url, repo: repoSlug, branch, tool_name: toolName, title },
  };

  try {
    await postIngest(payload);
  } catch (err) {
    console.error('gh-event-claude: ingest failed, spooling for next run', err);
    await spool(payload);
  }
}

main()
  .catch((err) => console.error('gh-event-claude: unexpected error', err))
  .finally(() => process.exit(0)); // never hang or fail the user's terminal
