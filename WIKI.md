# horizon — Usage Wiki

A 3-file scanner-less DNS-rebinding attack against a single hardcoded target.
Replaces the 13-file `atemporalzensingularity/html/` build for the AWS-metadata
exfil flow. Reference fork at `../atemporalzensingularity/` is left untouched.

## Hard constraints from the Go binary

These are baked into `singularity-server` and **cannot be changed** without
rebuilding from source (`nccsingularity/singularity.go`):

- **`./html/` directory name** — hardcoded at `singularity.go:838`:
  `http.FileServer(http.Dir("./html"))`. Must exist relative to wherever
  you launch the binary.
- **`./html/payloads/` subdirectory** — hardcoded at `singularity.go:641`:
  `concatenateJS("html/payloads")`. The server walks this dir, concatenates
  every `.js` file alphabetically, and inlines them as one `<script>` block
  in `/soopayload.html`. Implications:
  - You don't manage `<script>` tags for payloads. Drop a file, it loads.
  - **Every payload loads on every attack.** `CONFIG.attackPayload` only
    decides which `Registry[name].attack()` gets *invoked* — all payloads
    are still parsed and registered.
  - Load order is alphabetical (`aws-metadata-exfil.js` →
    `hook-and-control.js`). Don't rely on it.
- **`payload.js` filename** — hardcoded in the `/soopayload.html` template
  at `singularity.go:601` as `<script src="payload.js">`. Don't rename.
- **`begin('/')`** — the template body has `onload="begin('/')"`. The url
  passed to `Rebinder.init` is always `/`. This build's `joinUrl()` in
  `payload.js` handles the slash normalization, so `CONFIG.targetPath` can
  start with `/` or not — both work.
- **Symlink to the binary is relative** (`../atemporalzensingularity/...`).
  Keep `horizon/` and `atemporalzensingularity/` as siblings,
  or change the symlink to absolute if you reorganize.

## Layout

```
horizon/
├── singularity-server          → symlink to ../atemporalzensingularity/singularity-server
├── README.md                     this file
└── html/
    ├── amaze.html                attacker entry page (config + manager logic)
    ├── payload.js              attack-frame logic (rebind loop, exfil dispatch)
    └── payloads/
        ├── aws-metadata-exfil.js   exfil rebound response to a webhook
        └── hook-and-control.js     open a WS back-channel for live browsing
```

The Go binary's `/soopayload.html` template is what loads `payload.js` — its
filename is fixed by the server build, do not rename.

## Where to edit what

| You want to change…                | Edit this file                       | Field / location                  |
|-----------------------------------|--------------------------------------|-----------------------------------|
| **What path to fetch after rebind**| `html/amaze.html`                      | `CONFIG.targetPath`               |
| Target IP                         | `html/amaze.html`                      | `CONFIG.targetHostIPAddress`      |
| Target port                       | `html/amaze.html`                      | `CONFIG.targetPort`               |
| Attacker server IP                | `html/amaze.html`                      | `CONFIG.attackHostIPAddress`      |
| Attacker domain                   | `html/amaze.html`                      | `CONFIG.attackHostDomain`         |
| Rebinding strategy                | `html/amaze.html`                      | `CONFIG.rebindingStrategy`        |
| Rebind retry interval             | `html/amaze.html`                      | `CONFIG.interval`                 |
| iframe vs fetch attack method     | `html/amaze.html`                      | `CONFIG.attackMethod`             |
| Which payload script to dispatch  | `html/amaze.html`                      | `CONFIG.attackPayload`            |
| Where exfil data is POSTed        | `html/payloads/aws-metadata-exfil.js`| `EXFILTRATION_URL`                |
| Switch to live WS browsing        | `html/amaze.html`                      | `CONFIG.attackPayload = 'Hook and Control'` |
| Add a brand-new payload type      | new file in `html/payloads/`         | register into `Registry["Name"]`  |

> **Single source of truth for the target path.** In the upstream code,
> `amaze.html`'s `app.begin("/latest/meta-data")` argument was silently
> discarded — the real path was hardcoded twice (and inconsistently!) inside
> `payload.js`. This build threads `targetPath` through the existing
> postMessage config channel, so editing it in **one** place in `amaze.html`
> updates both the iframe-method and fetch-method code paths. Slash
> normalization is handled by `joinUrl()` in `payload.js`, so `'/foo'`,
> `'foo'`, and `'foo/'` all behave the same.

## Running it

On your attacker host (Linux x86_64 — the binary is symlinked from the
atemporalzen fork):

```sh
cd horizon
./singularity-server \
    -HTTPServerPort 80 \
    -ResponseIPAddr xx.xx.xx.xx \
    -dangerouslyAllowDynamicHTTPServers
```

(Adjust flags to match how you normally invoke the fork; the symlinked
binary takes the same flags as `atemporalzensingularity/singularity-server`.)

Then visit `http://sub.dynamic.your.domain/amaze.html` from the victim browser
(or have the headless browser navigate there). Watch the attack frame in
DevTools console; on success the rebound response shows up in
`onRebindSuccess` in `amaze.html` and is POSTed to `EXFILTRATION_URL` by the
payload.

## Rebinding strategies cheat sheet

| Code | Name                          | Best for                                  | Set `interval` to |
|------|-------------------------------|-------------------------------------------|-------------------|
| `ma` | Multiple A (multi-answer)     | **Loopback only** (0.0.0.0, 127.0.0.1)    | `'1'`             |
| `fs` | FromQueryFirstThenSecond      | General; conservative                     | `'20'`            |
| `rr` | Round-robin                   | General                                   | `'20'`            |
| `rd` | Random                        | General                                   | `'20'`            |

For `169.254.169.254` (AWS IMDS) you cannot use `ma` — link-local is not
loopback. Use `fs`, `rr`, or `rd` with `interval: '20'`.

### Strategy gotchas (read this before switching to `ma`)

`fs` is the **default** in this build because `ma` has a sharp edge that
bites you exactly when you're testing locally:

**The `ma` loopback-pinning trap.** When the target is a loopback address
(`127.0.0.1`, `0.0.0.0`) AND a service is already listening on the target
port at attack time, `ma` fails non-deterministically. Here's why:

1. `ma` returns BOTH attacker IP and target IP in a single DNS response.
2. Chrome's destination address selection (RFC 6724) **prefers loopback
   addresses over public IPs**. So Chrome tries `127.0.0.1` first.
3. If a service is listening (e.g. `python3 -m http.server 80`), TCP
   succeeds, the server returns whatever it returns (often a 404 for
   `/soopayload.html`), and **Chrome considers the request done**.
4. The `ma` "fall back to the other IP" behavior only triggers on
   TCP-level failures (connection refused, timeout). An HTTP 404 is a
   successful TCP exchange — Chrome stays pinned to `127.0.0.1`.
5. The attack frame never loads from the attacker, `payload.js` never
   runs, no rebind happens. You see endless `404 (File not found)` in
   the console (Python's distinctive 404 wording is the giveaway —
   Singularity's Go server says `404 page not found`).

**Symptoms:** every request to `/soopayload.html` returns
`404 (File not found)`, no `start` postMessage ever fires, attack hangs.

**Why this run might "work" sometimes:** if Chrome has a warm connection
to the attacker IP from loading `amaze.html` itself, the connection pool
may reuse it before loopback preference kicks in. This is timing-
dependent and not reliable. Don't trust a one-off success with `ma` +
loopback target.

**When to use `ma` anyway:** the target is loopback AND nothing is
listening on the target port at attack frame load time. You start the
target service AFTER seeing the `start` message in the console, and the
rebind catches it on a later cycle. Useful when you need the ~3-second
rebind speed `ma` provides.

**For everything else, use `fs` with `interval: '20'`** — deterministic,
returns one IP at a time, works regardless of what's running where.

## delayDOMLoad

Used to keep headless browsers (puppeteer/playwright with
`waitUntil: 'load'`) from exiting before the rebind window closes.

**Mechanism:** `amaze.html` includes a hidden iframe pointed at
`/delaydomload`, a Singularity server endpoint that hangs the connection
forever. The iframe never fires its `load` event, so the parent document's
`load` event never fires, so the headless browser blocks until its own
navigation timeout. By then we've usually already rebound and exfiltrated.

**Toggle:** `CONFIG.delayDOMLoad = true | false` in `amaze.html`. When `false`,
the iframe element is removed at runtime and the browser exits normally.

**To verify it works** against your server build:

```sh
curl -v --max-time 5 http://<attacker-host>/delaydomload
```

Expected: `curl` times out after 5s with no response body. If you instead
get a 404 or instant response, the endpoint isn't wired in your binary
build, and `delayDOMLoad: true` is a no-op (harmless but useless). The
endpoint exists in upstream nccgroup/singularity (`DelayDOMLoadHandler` in
`singularity.go`) so any reasonably recent build should have it.

## Enabling LNA bypass

Chrome's Local Network Access (LNA) restriction increasingly blocks
public-origin pages from issuing requests to RFC1918 / loopback /
link-local targets — including AWS IMDS at `169.254.169.254`. The
nccgroup/singularity experimental branch
(`Experimental/LNA-from-Non-Secure-Contexts`) adds a bypass that uses
Chrome's **Origin Trial** for "Local Network Access from Non-Secure
Contexts."

Two pieces are needed:

### 1. Server-side: Origin-Trial response header

The experimental branch adds a `-OriginTrialToken PORT:TOKEN` flag to
`singularity-server`. When set, every HTTP response from that port carries:

```
Origin-Trial: <your-token>
```

**Your current symlinked binary does NOT have this flag** — it predates the
experimental branch. To enable LNA bypass you have two options:

- **(a)** Rebuild `singularity-server` from
  `https://github.com/nccgroup/singularity/tree/Experimental/LNA-from-Non-Secure-Contexts`
  and replace the symlink target.
- **(b)** Cherry-pick the two LNA commits
  (`ef2da99a` "initial support" and `4301f9da` "fix parsing of cmd line
  arguments") onto your atemporalzen fork and rebuild.

### 2. Token registration

Register your attacker domain (e.g. `dynamic.your.domain`) in Chrome's Origin
Trials portal for the **"Local Network Access from Non-Secure Contexts"**
trial. You'll get a long opaque token. Then start the server:

```sh
./singularity-server \
    -HTTPServerPort 80 \
    -OriginTrialToken 80:<your-very-long-token-here> \
    -ResponseIPAddr xx.xx.xx.xx
```

### 3. Client-side: already done

Both iframes that need it already carry `allow="local-network-access *"`:
- The outer attack frame, in `addFrameToDOM` in `amaze.html`
- The inner childFrame (which is what actually hits the rebound target in
  the iframe-method flow), in `payload.js`'s `startReloadChildFrame` case

These attributes are harmless if the server-side token isn't set yet, so
you can roll out client and server independently.

## What was stripped from the upstream/fork

| Removed                                          | Why                                     |
|--------------------------------------------------|------------------------------------------|
| `manager.html`, `manager.js`                     | Dashboard UI; not used for kr1 flow     |
| `manager-config.json`                            | Replaced by `CONFIG` literal in amaze.html |
| `scan.js`, `scan-manager.js`, `scan-manager.html`| Network scanner; we target one host     |
| `autoattack.html`, `m1.html`, `singularity.html` | Other entry pages                       |
| `index.html`                                     | Landing page                            |
| `flushdnscache.js`                               | Inlined as Blob URL Worker in payload.js|
| `manager-khara.js`                               | Inlined into amaze.html, dead code stripped|
| `populateManagerConfig`, `requestPort`, `getHTTPServersConfig`, `putData`, `toggle` | Manager dashboard UI helpers |
| `App.attackTarget`, `isUnixy`, `Payload` factory, `getManagerConfiguration` | Scanner-driven attack path |
| `webSocketHook`, `base64ArrayBuffer`, `atobUTF8`/`btoaUTF8`, `getCookies`, `buildCookie`, `responseOKOrFail`, `timeout` | Moved into `payloads/hook-and-control.js` (self-contained) instead of polluting the dispatcher |
| `amaze.html` scanner callbacks (`scanFoundNewTargetCb`, `scanDoneCb`, `getLocalIpAddressesThenScan`, `addrSpec`, `portSpec`) | Scanner-driven flow |
| `aws-metadata-exfil.js` `isService` + abort timer | Never called after dashboard removal |

**Line count:** ~1,275 lines across 5 files → ~430 lines across 3 files
(plus this wiki). About 66% reduction with no behavioral loss for the
kr1 → AWS IMDS flow.

## Adding a new payload script

1. Create `html/payloads/my-payload.js`:
   ```js
   const MyPayload = () => ({
       attack(headers, cookie, body) {
           // do whatever you want with the rebound response
       },
   });
   Registry["My Payload"] = MyPayload();
   ```
2. In `amaze.html`, set `CONFIG.attackPayload = 'My Payload'` (must match the
   Registry key exactly).
3. Make sure `/soopayload.html` (the Go template) loads your payload script
   alongside `payload.js`. In stock singularity this is driven by the
   payload name posted via the `payload` cmd; if your build uses a static
   `<script>` tag list, add yours there.

## Troubleshooting

- **"DNS rebinding did not happen yet" forever** — strategy/target mismatch.
  `ma` only works for loopback. For `169.254.169.254` use `fs`/`rr`/`rd`
  with `interval: '20'`.
- **`Refused to connect to <private IP>` in console** — Chrome LNA blocking
  you. Set up the Origin-Trial token (see above). Until then, test with a
  Chrome version old enough that LNA isn't enforced, or use Firefox.
- **Headless browser exits before rebind** — make sure
  `CONFIG.delayDOMLoad = true` AND verify `/delaydomload` actually hangs
  with the `curl` test above.
- **Stale files served after editing** — the Go server sets no-cache
  headers, but Chrome's HTTP cache can still bite. Test in incognito or
  hard-reload (Cmd-Shift-R). This was the cause of the "delete broke
  things" red herring during the previous minimization pass.
- **`Registry is not defined` in payload script** — your payload script
  loaded before `payload.js`. The script tag order in `/soopayload.html`
  must put `payload.js` first.
