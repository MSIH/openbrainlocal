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

## Alternative: node-windows

If you'd rather keep everything in the Node ecosystem, **node-windows** does the same
job via an npm install script instead of an XML file. Trade-off: the service
definition lives in a JS script rather than a committable config file, and it pulls in
a dependency. WinSW's self-contained exe + XML is the leaner, more auditable setup —
which is why it's the recommendation here. Say the word if you want the node-windows
version written out instead.
