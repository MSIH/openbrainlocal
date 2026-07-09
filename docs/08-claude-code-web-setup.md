# Auto-Capture Your Claude Code Web Sessions into LifeContext

When you work in [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
(the cloud sessions at <https://claude.ai/code>), each session runs in a throwaway container
in Anthropic's cloud — not on your machine. That's great for convenience, but it means the
`SessionEnd`/`PreCompact` hook you rely on locally (the `devsession-claude` connector, which
turns every coding session into a searchable memory) doesn't run unless the repo itself tells
it to. This guide gets those cloud sessions flowing into your LifeContext, the same way your
laptop sessions already do.

**The good news:** the hook wiring already ships in this repo. You do **not** edit any config
files, register any hook, or write any code. All you do is fill in a few settings on the
Claude Code *environment* — three env vars and one network setting. This guide is entirely
"click here, paste that," with fake example values you replace with your own.

> **How it works, in one sentence:** this repo's `.claude/settings.json` registers the
> `devsession-claude` connector under `SessionEnd` and `PreCompact`, guarded so it runs **only**
> in cloud containers (`CLAUDE_CODE_REMOTE=true`). Your local sessions keep being captured by
> your personal `~/.claude` hook; the committed one stands down locally, so nothing is captured
> twice. See [`connectors/devsession-claude/README.md`](../connectors/devsession-claude/README.md)
> for the mechanics.

---

## Before you start

You need two things:

1. **LifeContext reachable from the internet.** A cloud container can't reach `localhost` on
   your machine — it's a different computer in a different data center. Put your server on a real
   address first, using [`docs/07-cloudflare-tunnel-setup.md`](07-cloudflare-tunnel-setup.md).
   By the end of that guide you'll have something like `https://lc.example.com` that answers with
   your API key. Keep that URL and the key handy.

2. **A Claude Code web environment for this repo.** If you've run even one cloud session on
   `life-context`, you already have one — cloud sessions always run inside an *environment*
   (the thing that holds your env vars, network policy, and setup script). If not, you'll create
   one in Step 1 below. Claude Code web is a research-preview feature for Pro, Max, Team, and
   eligible Enterprise users.

> This guide is about the **session-capture hook**. Pointing the *claude.ai web MCP connector*
> at your memory (so Claude can `search`/`store_memory` live) is a separate setup — see
> [`docs/07`, Part C](07-cloudflare-tunnel-setup.md#connecting-claudeai-web-capability-url). The
> two are independent; you can do either, both, or neither.

---

## Step 1 — Open your environment's settings

Environments are managed from the Claude Code web interface (not from a config file in the repo).

- **To create one:** click the **cloud icon** showing the current environment's name to open the
  environment selector, then choose **Add environment**. The new-environment dialog has fields for
  the name, **Network access** level, **Environment variables**, and **Setup script** — exactly the
  ones this guide fills in.
- **To edit an existing one:** click the same **cloud icon** to open the selector, hover over the
  environment you use for `life-context`, and click the **settings icon** that appears on its right.

Give it a recognizable name — e.g. `life-context` — so you can tell it apart later. Everything below
is entered in this one dialog.

---

## Step 2 — Add the environment variables

In the **Environment variables** field, add the settings the connector reads. The field uses
`.env` format: **one `KEY=value` per line, and do not wrap values in quotes** (Claude Code stores
the quotes as part of the value, which will break things).

Paste this and swap in your real values:

```text
LIFECONTEXT_URL=https://lc.example.com
LIFECONTEXT_API_KEY=paste-your-real-32-byte-hex-key-here
```

| Variable | What to put | Fake example |
|----------|-------------|--------------|
| `LIFECONTEXT_URL` | Your server's **public** address from `docs/07` — never `localhost` | `https://lc.example.com` |
| `LIFECONTEXT_API_KEY` | The exact `LIFECONTEXT_API_KEY` from your server's `.env` (the `x-api-key` value) | `a1b2c3d4e5f6...` (64 hex chars) |

Optional — only if you want to override the defaults (most people don't need these):

```text
# The default summarizer shells out to the `claude` binary already in the container (no extra
# key, no local LLM). Uncomment to pick a different model, or to use an OpenAI-compatible endpoint.
CHAT_MODEL=haiku
# CHAT_PROVIDER=openai
# CHAT_BASE_URL=https://your-openai-compatible-host/v1
# CHAT_API_KEY=paste-that-endpoints-key-here
```

> **Secrets warning (from Anthropic's docs):** there's no dedicated secrets store yet. Environment
> variables are stored in the environment config and are **visible to anyone who can edit that
> environment**. For a personal environment that's usually fine — just treat `LIFECONTEXT_API_KEY`
> as a rotatable secret: if you ever share edit access or suspect exposure, regenerate it on the
> server (see `docs/07`) and update this field. It is a *separate* secret from the
> `MCP_URL_TOKEN` used for the claude.ai web MCP connector — leaking one doesn't compromise the other.

---

## Step 3 — Allow your server through the network policy

This is the step people miss. By default an environment uses **Trusted** network access, which
allows package registries, GitHub, and a long built-in list — but **not** your personal tunnel
domain. The connector's summary is delivered by a plain `POST` from inside the container, and that
outbound request is subject to the environment's network policy. If your host isn't allowed, the
POST is blocked, the summary only lands in the container's throwaway spool file, and the memory is
lost when the container is reclaimed.

> **Why doesn't the MCP connector need this?** MCP connector traffic is routed through Anthropic's
> servers and bypasses the network allowlist. A hook's direct `fetch` does **not** get that bypass —
> so the capture hook specifically needs your host allowlisted, even if the MCP connector already works.

In the environment dialog:

1. Set the **Network access** selector to **Custom**.
2. An **Allowed domains** field appears. Enter your server's host, one domain per line (host only —
   no `https://`, no path):

   ```text
   lc.example.com
   ```

   Use a leading `*.` for wildcard subdomains if you need it, e.g. `*.example.com`.
3. Check **Also include default list of common package managers** so npm/apt/etc. still work for
   this repo's `session-start.sh` bootstrap. Leaving it unchecked would allow *only* `lc.example.com`
   and break dependency installs.

(If you'd rather not maintain an allowlist and trust the environment fully, **Full** access also
works — it allows any domain. **Custom** is the tighter choice and what this guide recommends.)

---

## Step 4 — Setup script: leave it empty

You don't need one. This repo ships a `SessionStart` hook (`.claude/hooks/session-start.sh`) that
bootstraps Node dependencies in cloud sessions automatically, and the container already has Node 20–22
and everything else the connector needs (it's zero-dependency). Leave the **Setup script** field blank
unless you're customizing something unrelated. Save the dialog.

---

## Step 5 — Test it

1. Start a fresh cloud session on `life-context` at <https://claude.ai/code> and do a little real
   work — ask Claude a question, make an edit, whatever.
2. End the session (or let it `/compact` if it runs long). The hook fires on the way out.
3. From any client pointed at your LifeContext (your laptop's MCP, or a REST call), run a recall:

   ```bash
   curl -sS https://lc.example.com/api/search \
     -H "x-api-key: $LIFECONTEXT_API_KEY" -H 'content-type: application/json' \
     -d '{"query":"where did I leave off"}'
   ```

   You should get back a `dev_session` artifact summarizing what you just did, with the project name
   in its metadata. That's the whole point — tomorrow's you (or tomorrow's Claude) can ask "where did
   I leave off" and get a real answer.

---

## If something doesn't work

| What you see | What it means | Fix |
|--------------|---------------|-----|
| No `dev_session` artifact after a cloud session | `LIFECONTEXT_API_KEY` isn't set (or is the placeholder) — the connector logs `LIFECONTEXT_API_KEY not configured … skipping` and exits quietly | Re-check Step 2; the value must match the server's `.env` exactly, no quotes |
| Session ran but nothing arrived, and no error you can see | The POST was blocked by the network policy and the payload went to the (ephemeral) spool | Do Step 3 — set **Custom** + add your host to **Allowed domains** |
| Connector logs a connection error to `localhost` | `LIFECONTEXT_URL` still points at `localhost`, which doesn't exist in the container | Set it to your public/tunnel URL (`https://lc.example.com`) |
| `ingest returned 401` in the logs | Wrong API key | Copy the exact `LIFECONTEXT_API_KEY` from the server's `.env` |
| `ingest returned 404` | `LIFECONTEXT_URL` is wrong or the server isn't reachable | Confirm `https://lc.example.com/api/recall` answers (see `docs/07` Part B) |
| Local sessions suddenly captured twice | Shouldn't happen — the committed hook is gated to cloud only | Confirm you didn't also add a *project-level* registration; your personal `~/.claude` one is correct and should stay |

Remember the capture is **best-effort by design**: a cloud container can be reclaimed without a
clean `SessionEnd`, and its spool file doesn't survive that. Registering `PreCompact` (which this
repo does) captures long sessions earlier, but a very short cloud session that neither compacts nor
ends cleanly may still be missed. That's an accepted trade-off for a memory hook that must never
hang or fail your session — see the connector contract's failure posture in
[`docs/04`, §7](04-connector-contract.md).

---

## What about my other repos?

This wiring lives in `life-context`'s own `.claude/settings.json`, so it only captures cloud sessions
*on this repo*. Cloud sessions on your other projects won't have it — cloud sessions load hooks only
from that repo's committed settings, never from your personal `~/.claude`. To capture those too, you'd
add the same two hook entries to that repo's `.claude/settings.json` and make the (single, zero-dependency)
`index.js` reachable there — by vendoring it or fetching it in that environment's setup script. That's a
separate design question; this guide covers `life-context` only.
