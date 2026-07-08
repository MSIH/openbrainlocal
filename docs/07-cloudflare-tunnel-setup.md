# Reach Your LifeContext From Anywhere (Cloudflare Tunnel + Your Own Domain)

Right now your LifeContext server only answers on the computer it runs on
(`http://localhost:3000`). This guide gives it a real address on the internet — like
`https://lc.yourdomain.com` — so your phone, laptop, and cloud AI tools can all talk to the
same memory. Written for normal people: every step is either a click in a website or one
command you copy and paste.

**What you'll build, in plain words:** a small helper program called `cloudflared` runs on
your server and opens a private, outbound connection to Cloudflare. When someone visits
`https://lc.yourdomain.com`, Cloudflare passes the request down that private connection to
your server. Nothing on your network is opened up — no router settings, no port forwarding,
no "static IP" from your internet provider. The connection is encrypted, and your API key is
still required for every request.

> **One honest caveat:** Cloudflare decrypts traffic at its edge before passing it down the
> tunnel — that's how the service works. For most people that's a fine trade for remote
> access to your own memory; if "no third party ever sees a request" is a hard requirement
> for you, stop here and keep the server local-only.

---

## Before you start (10 minutes, one-time)

You need three things:

1. **A domain name managed by Cloudflare.** If you own a domain (from GoDaddy, Namecheap,
   anywhere), add it to a free Cloudflare account at <https://dash.cloudflare.com> — click
   **Add a domain** and follow the prompts to point your domain's *nameservers* at
   Cloudflare (the wizard shows exactly what to change at your registrar). If you don't own
   a domain yet, buy one — Cloudflare itself sells them for ~$10/year.

2. **Your LifeContext server running.** If `npm start` works and stays running, you're set.
   Even better, run it as a Windows service so it survives reboots — see
   [`windows-service-winsw.md`](windows-service-winsw.md).

3. **A strong API key.** Once your server is on the internet, the `LIFECONTEXT_API_KEY` in
   your `.env` file is the *only* lock on the door. If yours is short or guessable, generate
   a strong one now (paste into PowerShell):

   ```powershell
   $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
   ```

   (This uses Windows' cryptographic random generator — the right tool for a secret. Works
   in both Windows PowerShell 5.1 and PowerShell 7.)

   Put the result in `.env` as `LIFECONTEXT_API_KEY=<the new value>` and restart the server.
   Update any tool that was using the old key.

---

## Part A — Create the tunnel (mostly clicking)

### Step 1: Install the helper program

On the server, open PowerShell and paste:

```powershell
winget install --id Cloudflare.cloudflared
```

Close and reopen PowerShell afterward so it can find the new program.

### Step 2: Create the tunnel in Cloudflare's dashboard

1. Go to <https://one.dash.cloudflare.com> (the "Zero Trust" dashboard — free plan is fine;
   it may ask you to pick a team name the first time, any name works).
2. In the left menu: **Networks → Tunnels → Create a tunnel**.
3. Choose **Cloudflared** as the connector type, name it `lifecontext`, click **Save**.
4. The page now shows install commands for several systems. Click **Windows**, and copy the
   command that looks like this (the long blob is your tunnel's token):

   ```powershell
   cloudflared service install <LONG-TOKEN>
   ```

5. Paste it into PowerShell **run as Administrator** (right-click PowerShell → *Run as
   administrator*). This installs `cloudflared` as a Windows service, so the tunnel starts
   automatically on boot. Back in the dashboard, the connector should show as **Connected**
   within a minute.

### Step 3: Give the tunnel your address

Still in the tunnel screen, open the **Public Hostname** tab and click **Add a public
hostname**:

| Field | What to enter |
|-------|---------------|
| Subdomain | `lc` (or whatever you like) |
| Domain | your domain, e.g. `yourdomain.com` |
| Type | `HTTP` |
| URL | `localhost:3000` |

Click **Save**. Cloudflare creates the DNS record for you — there is nothing else to
configure, no config files to edit.

That's it. `https://lc.yourdomain.com` now reaches your server.

---

## Part B — Test it

From a **different** device (your phone's browser won't do POSTs easily, so use another
computer, or the same one is fine for a first pass):

```powershell
$KEY = "<your LIFECONTEXT_API_KEY>"
Invoke-RestMethod -Method Post -Uri https://lc.yourdomain.com/api/remember `
  -Headers @{ 'x-api-key' = $KEY } -ContentType 'application/json' `
  -Body '{"content":"tunnel smoke test"}'
Invoke-RestMethod -Method Post -Uri https://lc.yourdomain.com/api/recall `
  -Headers @{ 'x-api-key' = $KEY } -ContentType 'application/json' `
  -Body '{"query":"tunnel smoke test"}'
```

The first call should answer `success: True` with an id; the second should return your
"tunnel smoke test" memory with a distance score. If both work, you're done — anything that
could talk to `localhost:3000` can now talk to `https://lc.yourdomain.com` instead.

---

## Part C — Point your AI tools at it

Wherever a tool asked for your LifeContext address, swap `http://localhost:3000` for
`https://lc.yourdomain.com`:

- **MCP clients** (Claude Code, Claude Desktop, anything MCP): the server URL becomes
  `https://lc.yourdomain.com/mcp`, with the same `x-api-key` header as before.
- **Connectors** (`connectors/*/.env`): set `LIFECONTEXT_URL=https://lc.yourdomain.com` —
  this is exactly the "public/tunnel URL" their READMEs mention for cloud sessions.
- **REST scripts**: same paths as always (`/api/remember`, `/api/recall`, …), new host.

---

## Part D — Optional extra locks (recommended, still free)

- **Check the direct port is closed.** The tunnel talks to your server privately, so nothing
  on the internet should reach port 3000 directly. Windows Firewall blocks inbound
  connections by default; make sure nobody added an *inbound allow* rule for 3000:

  ```powershell
  Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True |
    Where-Object { ($_ | Get-NetFirewallPortFilter).LocalPort -eq 3000 } |
    Select-Object DisplayName
  ```

  No output means no enabled inbound-allow rule opens port 3000 — good. If a rule comes
  back, open **Windows Defender Firewall with Advanced Security** and delete it unless you
  created it on purpose. (One caveat: this only tells you about the firewall's own rules —
  if Windows Firewall itself is turned off, or another firewall/VPN is in play, verify
  there too. The surest test is to try reaching `http://<your-server-ip>:3000` from another
  device and confirm it *fails*.)

- **A second key that you can revoke.** In the Zero Trust dashboard, **Access →
  Applications → Add an application** for `lc.yourdomain.com`, then create a **Service
  Token**. Clients then send two extra headers (`CF-Access-Client-Id` and
  `CF-Access-Client-Secret`) that Cloudflare checks *before* the request ever reaches your
  server — and you can revoke a token from the dashboard without touching the server. Skip
  this if your tool can only send one custom header.

- **Turn on Cloudflare's free firewall.** On your domain's dashboard under **Security**,
  enable the free managed WAF rules so obvious attack traffic is dropped at Cloudflare's
  edge instead of reaching your tunnel.

---

## If something doesn't work

| What you see | What it means | Fix |
|--------------|---------------|-----|
| Cloudflare error page 530 / 1033 | The tunnel itself is down | On the server: `Start-Service cloudflared`, then check the connector shows **Connected** in the dashboard |
| Error 502 Bad Gateway | Tunnel is up, but LifeContext isn't | Start the server (`npm start` or the Windows service); confirm `http://localhost:3000` answers locally |
| `Rate limit breached` for everyone at once | The server is treating all remote users as one visitor | The `trust proxy` setting is missing — see the note below; it ships enabled in this repo |
| 403 Forbidden from Cloudflare | An Access policy or firewall rule is blocking | Check **Zero Trust → Logs** and your Access application settings |
| `{"error":"Unauthorized"}` | Wrong or missing API key | Send the exact `LIFECONTEXT_API_KEY` value in the `x-api-key` header |

---

## Appendix 1 — For technical users: CLI-managed tunnel instead

If you'd rather keep the tunnel's config in a file under version control than in
Cloudflare's dashboard:

```powershell
cloudflared tunnel login                       # browser auth; pick your zone
cloudflared tunnel create lifecontext          # prints the tunnel UUID
cloudflared tunnel route dns lifecontext lc.yourdomain.com
```

Write `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: C:\Users\<you>\.cloudflared\<TUNNEL-UUID>.json
ingress:
  - hostname: lc.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

Test in the foreground with `cloudflared tunnel run lifecontext`. To install it as a
service, note the gotcha: the service runs as `LocalSystem`, whose home folder is **not**
yours, so copy the config there first:

```powershell
New-Item -ItemType Directory -Force C:\Windows\System32\config\systemprofile\.cloudflared
Copy-Item $env:USERPROFILE\.cloudflared\config.yml, $env:USERPROFILE\.cloudflared\<TUNNEL-UUID>.json `
  C:\Windows\System32\config\systemprofile\.cloudflared\
cloudflared service install
Start-Service cloudflared
```

## Appendix 2 — Why the server sets `trust proxy`

Behind the tunnel, every request reaches Express from `127.0.0.1` (the tunnel's local end).
Without `app.set('trust proxy', 1)`, the rate limiter would see one visitor — the whole
internet sharing a single 100-requests-per-minute bucket — and `express-rate-limit` logs
`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` validation errors. With it, Express reads the real
client address from the `X-Forwarded-For` header Cloudflare sets, and rate limiting works
per visitor. It's on by default and harmless for plain localhost use (local requests carry
no forwarded header and behave exactly as before). If your server is reachable directly on
your LAN and you *don't* use a tunnel or proxy, you can set `TRUST_PROXY=0` in `.env` so
forwarded headers are never trusted.
