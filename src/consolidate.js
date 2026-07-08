#!/usr/bin/env node
/**
 * Consolidation v1 — nightly daily digests (design §5 "the sleep cycle", roadmap M6,
 * docs/06-consolidation.md). One small-model call per day: summarize the day's
 * digest-eligible artifacts into a single `type='digest'` artifact, keyed
 * (source='consolidation', source_id='daily-<YYYY-MM-DD>'), occurred_at = that day —
 * so "what was I doing last October" answers in one hit instead of 400 rows.
 *
 * Isolated, restartable script (design §3): each day is independent and idempotent —
 * an input hash over the day's artifact set skips the LLM/embed calls entirely when
 * nothing changed, and late-arriving artifacts regenerate the digest through
 * upsertArtifactTxn (derived-only update; ingest_log keeps the prior text).
 *   Run:  npm run consolidate                      (yesterday)
 *         npm run consolidate -- --date=2026-07-07 (one day)
 *         npm run consolidate -- --backfill=30     (last 30 days, oldest first)
 */
import { pathToFileURL } from 'node:url';
import { db, upsertArtifactTxn, sha256, logEvent } from './db.js';
import { ai, embedToFloat32 } from './embeddings.js';
import { DIGEST_MODEL, DIGEST_TIMEOUT_MS, DIGEST_MAX_ARTIFACTS, DIGEST_TEXT_CLIP } from './config.js';
import { TYPE_REGISTRY } from './ingest-types.js';

const DIGEST_ELIGIBLE_TYPES = TYPE_REGISTRY.filter((t) => t.digest_eligible).map((t) => t.type);

// The day's inputs, oldest first. Capped: a heavy day degrades to "first N" rather than
// blowing the model's context — the cap is recorded in extra_json so it's visible later.
const eligibleStmt = db.prepare(`
  SELECT id, type, occurred_at, place_label, text_repr FROM artifacts
  WHERE date(occurred_at) = date(?)
    AND type IN (SELECT value FROM json_each(?))
  ORDER BY occurred_at ASC
  LIMIT ?
`);
const existingDigestStmt = db.prepare(
  `SELECT id, extra_json FROM artifacts WHERE source = 'consolidation' AND source_id = ?`
);

// Regenerate only when the day's input set changed: hash of sorted (id, text hash) pairs.
// text_repr participates so an enrichment wave (e.g. a photo caption upsert) refreshes the digest.
const inputHash = (rows) =>
  sha256(JSON.stringify(rows.map((r) => [r.id, sha256(r.text_repr || '')]).sort((a, b) => a[0] - b[0])));

// Category framing per roadmap M6: dev sessions -> worked on, messages -> talked with,
// photos/visits -> was at. Unlisted types land under "Also".
const DIGEST_SYSTEM_PROMPT = [
  'You write one compact daily digest of a person\'s day from a list of their artifacts.',
  'Group what happened into categories: "Worked on:" (dev_session), "Talked with:" (message, email),',
  '"Was at:" (photo, visit — use place labels), and "Also:" for anything else notable.',
  'Past tense, concrete, 2-6 sentences total, no preamble and no commentary.',
  'Skip empty categories. Start with exactly: Daily digest — <date>.',
].join('\n');

// Reasoning models (the default qwen3:8b) may emit <think> blocks in content — strip them.
const stripThink = (s) => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

async function generateDigest(date, rows) {
  const lines = rows.map((r) => {
    const t = (r.occurred_at || '').slice(11, 16);
    const place = r.place_label ? ` @ ${r.place_label}` : '';
    return `- [${r.type}]${t ? ` ${t}` : ''}${place} ${(r.text_repr || '').slice(0, DIGEST_TEXT_CLIP)}`;
  });
  const resp = await ai.chat.completions.create(
    {
      model: DIGEST_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: DIGEST_SYSTEM_PROMPT },
        { role: 'user', content: `Date: ${date}\nArtifacts:\n${lines.join('\n')}` },
      ],
    },
    { timeout: DIGEST_TIMEOUT_MS, maxRetries: 0 }
  );
  const text = stripThink(resp.choices[0]?.message?.content || '');
  if (!text) throw new Error(`consolidate: ${DIGEST_MODEL} returned an empty digest for ${date}`);
  return text;
}

/**
 * Consolidate one day. Returns { date, status: 'empty'|'unchanged'|'created'|'updated', id? }.
 * Enrich-then-commit: LLM digest + embedding are fetched BEFORE upsertArtifactTxn opens
 * (CLAUDE.md rule 4) — a failed Ollama call writes nothing.
 */
export async function consolidateDay(date) {
  const rows = eligibleStmt.all(date, JSON.stringify(DIGEST_ELIGIBLE_TYPES), DIGEST_MAX_ARTIFACTS);
  if (!rows.length) {
    console.log(`consolidate: ${date} no digest-eligible artifacts — skipped`);
    return { date, status: 'empty' };
  }
  const hash = inputHash(rows);
  const existing = existingDigestStmt.get(`daily-${date}`);
  if (existing) {
    try {
      if (JSON.parse(existing.extra_json || '{}').input_hash === hash) {
        console.log(`consolidate: ${date} unchanged (input_hash match) — skipped`);
        return { date, status: 'unchanged', id: existing.id };
      }
    } catch (err) {
      console.error(`consolidate: ${date} unparseable extra_json on existing digest — regenerating`, err);
    }
  }

  const text = await generateDigest(date, rows);
  const vec = await embedToFloat32(text);
  const types = [...new Set(rows.map((r) => r.type))];
  const extra = {
    input_hash: hash,
    artifact_count: rows.length,
    truncated: rows.length === DIGEST_MAX_ARTIFACTS,
    types,
    model: DIGEST_MODEL,
  };
  const r = upsertArtifactTxn(
    {
      type: 'digest',
      source: 'consolidation',
      source_id: `daily-${date}`,
      content_hash: sha256(text),
      occurred_at: date,
      text_repr: text,
      extra_json: JSON.stringify(extra),
    },
    vec,
    []
  );
  logEvent('consolidate_daily', 'consolidate.js', {
    date, artifact_id: r.id, created: r.created, artifact_count: rows.length,
  });
  const status = r.created ? 'created' : 'updated';
  console.log(`consolidate: ${date} digest ${status} (${rows.length} artifacts, ${types.length} types)`);
  return { date, status, id: r.id };
}

// Local calendar date (not UTC slice — a 9pm run must digest today's local day, minus offset).
const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => localDate(new Date(Date.now() - n * 86400000));

function parseArgs(argv) {
  const args = { date: null, backfill: null };
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--date=(\d{4}-\d{2}-\d{2})$/))) args.date = m[1];
    else if ((m = a.match(/^--backfill=(\d+)$/))) args.backfill = parseInt(m[1], 10);
    else throw new Error(`consolidate: unknown argument "${a}" (use --date=YYYY-MM-DD or --backfill=N)`);
  }
  if (args.date && args.backfill) throw new Error('consolidate: --date and --backfill are mutually exclusive');
  return args;
}

async function main() {
  const { date, backfill } = parseArgs(process.argv.slice(2));
  // Default: yesterday. Backfill: last N days ending yesterday, oldest first — each day is
  // its own transaction, so a mid-run failure keeps completed days (restartable, like migrate).
  const days = date
    ? [date]
    : Array.from({ length: backfill || 1 }, (_, i) => daysAgo((backfill || 1) - i));
  const tally = { created: 0, updated: 0, unchanged: 0, empty: 0 };
  for (const d of days) tally[(await consolidateDay(d)).status]++;
  console.log(
    `Consolidation complete: ${tally.created} created, ${tally.updated} updated, ` +
    `${tally.unchanged} unchanged, ${tally.empty} empty (${days.length} day(s), model ${DIGEST_MODEL}).`
  );
}

// Run only as a CLI, not when imported for tests (same guard as contacts.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Consolidation failed:', err); process.exit(1); });
}
