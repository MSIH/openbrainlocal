# Node/Express API as a Windows Service (WinSW)

A proper Windows service — appears in `services.msc`, starts on boot, restarts on
crash, and handles stop signals — using **WinSW v3**. The service definition is a
single XML file you can commit alongside your code.

> **Why a wrapper is unavoidable:** the Service Control Manager (SCM) requires the
> registered process to report `SERVICE_RUNNING` during startup. `node.exe` never
> makes that callback, so registering it directly with `sc.exe` fails the startup
> handshake. WinSW *is* the SCM-aware process; it launches and supervises Node.

---

## 1. Get WinSW

Download `WinSW-x64.exe` from the [releases page](https://github.com/winsw/winsw/releases)
(v3 native build — no .NET Framework dependency).

Place it in your app folder and **rename it to match your service id**. WinSW finds
its config by matching the exe name to a sibling `.xml`:

```
C:\app\
  MyExpressApi.exe      <- renamed WinSW-x64.exe
  MyExpressApi.xml      <- config below
  server.js
  node_modules\
  ...
```

---

## 2. Config: `MyExpressApi.xml`

```xml
<service>
  <id>MyExpressApi</id>
  <name>My Express API</name>
  <description>Node/Express web API - auto-start, auto-restart</description>

  <!-- What to run -->
  <executable>C:\Program Files\nodejs\node.exe</executable>
  <arguments>server.js</arguments>
  <workingdirectory>C:\app</workingdirectory>

  <!-- Start on boot -->
  <startmode>Automatic</startmode>
  <!-- Optional: wait until after boot-critical services / network are up -->
  <delayedAutoStart>true</delayedAutoStart>

  <!-- Wait for the network stack before starting (optional) -->
  <depend>Tcpip</depend>

  <!-- Restart on crash: retry after 10s, then 20s; reset the counter after 1h clean -->
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="20 sec"/>
  <resetfailure>1 hour</resetfailure>

  <!-- Rotating logs: 10 MB per file, keep 8 -->
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>

  <!-- Environment -->
  <env name="NODE_ENV" value="production"/>
  <env name="PORT" value="3000"/>

  <!-- Graceful shutdown window before force-kill -->
  <stoptimeout>15 sec</stoptimeout>
  <stopparentprocessfirst>true</stopparentprocessfirst>
</service>
```

Notes:
- `sizeThreshold` is in **KB** (10240 = 10 MB).
- `startmode` `Automatic` is the boot-start setting; drop `<delayedAutoStart>` if you
  want it up as early as possible instead of slightly after boot.
- Remove `<depend>Tcpip</depend>` if you don't want a hard start dependency.

---

## 3. Install and start (Administrator shell)

```powershell
cd C:\app
.\MyExpressApi.exe install
.\MyExpressApi.exe start
```

Verify:

```powershell
.\MyExpressApi.exe status
Get-Service MyExpressApi
```

It now shows in `services.msc` and will start automatically on every boot.

---

## 4. Manage

```powershell
.\MyExpressApi.exe stop
.\MyExpressApi.exe restart
.\MyExpressApi.exe refresh      # apply XML changes without reinstalling
.\MyExpressApi.exe uninstall
```

---

## 5. Graceful shutdown in your app

On stop, WinSW signals the child and waits up to `<stoptimeout>` before force-killing.
Handle it in Express so in-flight requests drain and DB pools close cleanly:

```javascript
const server = app.listen(process.env.PORT || 3000);

function shutdown() {
  server.close(() => {
    // close DB pools / flush writes here
    process.exit(0);
  });
  // safety net if close() hangs
  setTimeout(() => process.exit(1), 12_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

> Windows signal delivery to Node under a service is imperfect — **test an actual
> `stop`** and confirm your handler fires. If it doesn't, WinSW's force-kill still
> stops the process at `stoptimeout`, you just lose the clean drain.

---

## 6. Remote restart via GitHub Actions

Bounce the service on demand from the GitHub Actions tab — no RDP session. The workflow
(`.github/workflows/restart-service.yml`) is `workflow_dispatch`-only (a **Run workflow**
button; no restart on push) and runs `Restart-Service LifeContext -Force`, then verifies the
service is `Running` and the API port is accepting connections (#240).

The box sits behind residential internet with no inbound exposure, so a GitHub-hosted runner
can't reach it. The workflow therefore targets a **self-hosted runner installed on this
machine** (`runs-on: [self-hosted, windows]`).

### One-time setup

1. **Register a repo-level self-hosted runner** for `MSIH/life-context` (a personal/User
   account can't have org-scoped runners, so it must be repo-level). In GitHub:
   *Settings → Actions → Runners → New self-hosted runner* (Windows x64), then run the shown
   `config.cmd` on this box. Install it as a service so it survives reboots (`svc.cmd install`).
   Give it the default `self-hosted` + `windows` labels (both are auto-applied on Windows).
2. **Grant the runner's service account rights to restart the service.** `Restart-Service`
   needs Service Control Manager start/stop permission on `LifeContext`. Simplest: run the
   runner service as an account with those rights (e.g. an admin), or grant that account
   explicit start/stop on the service via `sc.exe sdset LifeContext <SDDL>`. Without this the
   restart step fails with an access-denied error.

The runner is a **separate** service from `LifeContext`, so restarting `LifeContext` does not
disturb the runner or the in-flight workflow.

### Trigger

Actions tab → **Restart LifeContext service** → **Run workflow** (branch `2.0`). The run turns
red if the service doesn't return to `Running`, or if the port (`PORT`, default `3000`) never
opens after the restart.

---

## Alternative: node-windows

If you'd rather keep everything in the Node ecosystem, **node-windows** does the same
job via an npm install script instead of an XML file. Trade-off: the service
definition lives in a JS script rather than a committable config file, and it pulls in
a dependency. WinSW's self-contained exe + XML is the leaner, more auditable setup —
which is why it's the recommendation here. Say the word if you want the node-windows
version written out instead.
