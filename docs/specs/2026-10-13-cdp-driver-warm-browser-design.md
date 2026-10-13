# CDP driver and warm browser — design

Status: draft for review · 2026-10-13 · branch `feat/cdp-driver` off main `373ff1b`

## Goal

The fastest `jux snap` and `jux run` that keep the one invariant: pass/fail is
`sha256(lossless WebP)`, so every capture must be byte-identical to the one
Playwright produces today — otherwise every user baseline turns red on upgrade.

Two deliverables, two PRs:

1. **PR 1 — driver + installer + port.** Replace Playwright with a minimal
   Chrome DevTools Protocol driver in `@juxtapose/core`, acquire
   `chrome-headless-shell` from Chrome for Testing ourselves, port every
   package, and remove `playwright` from every shipped `package.json`.
2. **PR 2 — warm browser.** A per-user supervisor keeps one headless shell
   alive between invocations; each invocation gets its own browser context.

## Measured baseline (this Mac, M-series, warm disk cache)

| Item                                                         | ms                                     |
| ------------------------------------------------------------ | -------------------------------------- |
| bare `node -e 0`                                             | 29                                     |
| `import('playwright')`                                       | 125–140                                |
| `import('sharp')`                                            | 32                                     |
| Chromium launch to `Browser.getVersion` (pipe)               | 74–91 (first run of a batch up to 190) |
| context + page + overrides (CDP, 8 commands)                 | 30–40                                  |
| settle waits per story (150 ms DOM-quiet + 2 rAF + idle)     | ~200                                   |
| `jux snap` today (Playwright), one Storybook story, wall     | 630–690 (7 runs; first 962)            |
| `jux run --all` today, Storybook example, 15 stories, conc 4 | 1,409–1,723 (3 runs)                   |

Prototype (`/Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/proto.mjs`, raw CDP, same
flags, same settle, same freeze CSS, same screenshot parameters, repo's sharp):

| Prototype, one story, in-process `total`      | p50 | min | wall incl. node + sharp import |
| --------------------------------------------- | --- | --- | ------------------------------ |
| fresh launch over pipe                        | 370 | 352 | 439–487                        |
| warm browser over WebSocket (connect 9–11 ms) | 257 | 247 | 305–327                        |

Per-story capture cost inside the pipeline is ~200 ms for both (settle-bound);
the fresh/warm delta is launch + first-context cost, ~115 ms. The
remaining ~250 ms is settle (150 ms DOM idle, ~16–32 ms rAF, idle callback,
load). That is the floor without changing the settle pipeline, which this
design does not touch.

## Byte-identity evidence (the gate)

Method: build `examples/storybook` and `examples/ladle`, capture every story
with the current Playwright pipeline (`jux run --all`, concurrency 4,
viewport 800×600 from each example's config), record `sha256` of each
`-current.webp`; run the prototype against the same static build and compare.

| Example   | Stories captured | Match (fresh, pipe) | Prototype runs byte-stable | Warm (daemon, ws) | Fresh over ws transport |
| --------- | ---------------- | ------------------- | -------------------------- | ----------------- | ----------------------- |
| storybook | 15 (2 skipped)   | **15/15**           | 4/4 runs identical         | **15/15** ×2      | **15/15**               |
| ladle     | 14 (2 skipped)   | **14/14**           | 3/3 runs identical         | **14/14**         | —                       |

Playwright itself was also re-run twice: 15/15 self-identical, so the
reference is stable. The matched set covers the cases that matter: masks
(`masking--timestamp`, the pink overlay), a per-story viewport
(`determinism--narrow-viewport`, 480×400 applied via live params after a
first render at 800×600), fonts (`typography`), a mounting fetch
(`awaits-network`), an animation the freeze CSS stops (`infinite-spinner`),
and `animations: 'play'` + `skip` (never captured, correctly).

What it took to get there, in order of discovery:

1. Viewport comes from `juxtapose.config.json` (800×600), not a default — the
   first prototype pass matched only the 480×400 story. Everything at the
   default size differed. The lesson generalizes: the capture must set
   `Emulation.setDeviceMetricsOverride` with exactly Playwright's shape
   (`mobile:false, screenWidth/Height = viewport, deviceScaleFactor:1,
screenOrientation landscapePrimary`).
2. Everything else matched on the first try once the launch flags, the page
   initialization and the screenshot call were copied from playwright-core
   1.62.0 (file:line map below). No pixel difference was ever observed from
   pipe vs WebSocket transport, from a warm vs fresh browser, or from the
   prototype's utility-world-free evaluation (we evaluate in the main world;
   Playwright's screenshot prep runs in its utility world — same DOM, same
   pixels).

Residual, not retired by the spike: the examples have no story with
`waitForSelector`, `delay`, `captureAfterPlay`, a Playwright-only mask
selector (`text=`, `>>`, `:has-text`), a closed shadow root, or an `<input>`
with a visible caret. The first three are timing-only (no pixel path);
Playwright-only selectors stop working (see Compatibility); caret hiding is
ported verbatim.

## What Playwright does for us today (playwright-core 1.62.0, `lib/coreBundle.js`)

Everything below is reproduced by the driver; line numbers are in the bundle.

**Launch** (`Chromium._innerDefaultArgs`, L43067–43097; `defaultArgs`
L43058–43066; switches L34630–34690):

- `chromiumSwitches()` — 36 flags incl. `--disable-features=<16 features>`,
  `--enable-features=CDPScreenshotNewSurface`, `--force-color-profile=srgb`,
  `--disable-back-forward-cache`, `--disable-sync`; then
  `--enable-unsafe-swiftshader`; headless adds `--headless`,
  `--hide-scrollbars`, `--mute-audio`,
  `--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4`;
  `--no-sandbox` unless `chromiumSandbox: true`; then our
  `DETERMINISTIC_CHROMIUM_ARGS` (`packages/core/src/capture/launch.ts:37-49`).
- `--user-data-dir=<mkdtemp playwright_chromiumdev_profile-…>`
  (L39508), `--remote-debugging-pipe`, `--no-startup-window` (L43058–43066).
  Transport is the pipe on fds 3/4, `\0`-delimited JSON (L39607, L39170–39196).
- Executable: `chromium-headless-shell` when headless (`getExecutableName`
  L43099–43107), from `~/Library/Caches/ms-playwright` (mac),
  `$XDG_CACHE_HOME|~/.cache/ms-playwright` (linux), `%LOCALAPPDATA%\ms-playwright`
  (win), overridable by `PLAYWRIGHT_BROWSERS_PATH` (L32815–32835). Download URL
  is **Chrome for Testing's own zip** (`cftUrl("mac-arm64/chrome-headless-shell-mac-arm64.zip")`,
  L32499–32532) — verified: the cached
  `chromium_headless_shell-1234/…/chrome-headless-shell` binary has the same
  sha256 (`7687bff7cb2db075…`) as the one inside CfT's 151.0.7922.34 mac-arm64 zip.
- The repo's Playwright 1.62.0 pins revision **1234 = 151.0.7922.34**
  (`browsers.json`). The `chromium_headless_shell-1248` directory in the
  cache is 156.0.8078.4 from another install and is **not** what jux runs
  today; the spike used 1234.

**Context** (`Target.createBrowserContext {disposeOnDetach:true}` L38131;
`Browser.setDownloadBehavior` on init; `validateBrowserContextOptions`
defaults viewport 1280×720 when none — we always pass one).

**Page init** (`FrameSession._initialize`, L37339–37431): `Page.enable`, `Page.getFrameTree`, `Log.enable`, `Page.setLifecycleEventsEnabled`, `Runtime.enable`, `Page.addScriptToEvaluateOnNewDocument` (utility world), `Network.enable` (L35824), `Target.setAutoAttach {flatten:true, waitForDebuggerOnStart:true}` **with a handler** (L37547–37591) that resumes workers and initializes out-of-process iframes — the driver does not send auto-attach at all, since without the handler every worker and cross-origin iframe stays paused, `Emulation.setFocusEmulationEnabled {enabled:true}`,
`Emulation.setDeviceMetricsOverride` (`_updateViewport` L37735–37760),
**`Page.setFontFamilies` with a per-OS table** (`platformToFontFamilies`,
mac/linux/win incl. `forScripts`; applied whenever not headful),
`Emulation.setEmulatedMedia {media:'', features:[prefers-color-scheme:light,
prefers-reduced-motion:no-preference, forced-colors:none,
prefers-contrast:no-preference]}` (`emulatedMedia()` L22120–22129,
`_updateEmulateMedia` L37772–37787), `Runtime.runIfWaitingForDebugger`. `Emulation.setGeolocationOverride` (L37709–37712) and `Page.setInterceptFileChooserDialog` (L37800–37805) are skipped on init when no option asks for them, as are locale/timezone/UA overrides (we never ask). Dialogs: `Page.javascriptDialogOpening` is handled (L37643–37653) and, with no `dialog` listener, dismissed; the driver does the same with `Page.handleJavaScriptDialog {accept:false}`.
`serviceWorkers:'block'` is an init script that replaces
`navigator.serviceWorker.register` (L51294–51297).

**Screenshot** (`Screenshotter.screenshotPage` L21258–21280,
`_preparePageForScreenshot` L21309–21328, `_screenshot` L21347–21370,
`CRPage.takeScreenshot` L37183–37200, `inPagePrepareForScreenshots`
L21080–21175):

- `caret: 'hide'` default → inline `caret-color: transparent !important` on
  every `input,textarea,[contenteditable]` across open shadow roots, restored
  after. `animations: 'allow'` default → nothing. `scale: 'device'` default.
  Chromium does not toggle a stylesheet to sync animations (L37274).
- `await document.fonts.ready`.
- Masks: `_maskElements` → injected `addMaskedElements(elements, '#F0F')`: a
  `<x-pw-glass popover="manual">` appended to `documentElement` with inline
  style `inset:0; width/height:100%; …; pointer-events:none; display:flex;
background:transparent`, a shadow root with the highlight stylesheet
  (`x-pw-highlight{position:absolute;top:0;left:0;width:0;height:0}`), one
  `<x-pw-highlight>` per match at `getBoundingClientRect()` with
  `background-color:#F0F`, `showPopover()`. Removed after the capture.
- `Page.getLayoutMetrics` → clip `{x: visualViewport.pageX, y: pageY,
width: ceil(vw/scale), height: ceil(vh/scale), scale}` →
  `Page.captureScreenshot {format:'png', clip, captureBeyondViewport:false}`.
  `fromSurface` is not passed. The PNG is encoded by Chromium; we never
  re-encode it before sharp.
- `addStyleTag({content})` = `<style type="text/css">` with a text node,
  appended to `head` (L23384–23420). `evaluate` serializes arguments as JSON
  (`Runtime.callFunctionOn`/`evaluate`, `returnByValue`). `waitForFunction`
  polls on `requestAnimationFrame` by default; `waitForSelector` waits for
  `visible` by default. `page.goto(url, {waitUntil:'load'})` resolves on the
  main frame's `load` lifecycle event (L37459–37466).
- `clearCookies` = `Storage.clearCookies {browserContextId}` (L38394);
  `newCDPSession` is a flattened `Target.attachToTarget`; our
  `Storage.clearDataForOrigin` already goes through it.

## Decisions

1. **Own CDP driver, no Puppeteer.** Puppeteer would remove ~125 ms of import
   only to add back ~90 ms of its own and keep a 1 MB dependency for the ~15
   CDP methods we use. The driver is ~700 lines across six files and the spike
   is already most of it. Rejected: `chrome-remote-interface` (adds a
   dependency for a 60-line transport); keeping Playwright behind a flag (two
   drivers means two sets of pixels to keep identical).
2. **Keep Playwright's full switch list verbatim**, as `PARITY_CHROMIUM_ARGS`
   with the Playwright version it was copied from in the comment, after it
   our `DETERMINISTIC_CHROMIUM_ARGS`. A pruned list was not tested and the
   gain is nothing measurable; the risk is a feature flag that changes raster
   output. Revisit only with a determinism run per removed flag.
3. **Page initialization is exactly the spike's command list**: `Page.enable`, `Page.setLifecycleEventsEnabled`, `Runtime.enable`, `Network.enable`, `Emulation.setFocusEmulationEnabled`, `Emulation.setDeviceMetricsOverride`, `Page.setFontFamilies` per OS (this is what makes "the same font stack" true across machines for generic families), `Emulation.setEmulatedMedia` (`prefers-color-scheme: light`), plus `Log.enable` (Playwright sends it, no pixel path) and the service-worker init script on snap contexts. Nothing else: `Target.setAutoAttach` without Playwright's attach handler pauses every worker and cross-origin iframe forever, and the geolocation and file-chooser overrides are things Playwright only sends when asked. Rejected: "only what seems pixel-relevant" — we could not have predicted the font table; and "everything Playwright's init can send" — the pre-flight found three commands the spike never sent.
4. **The adapter seam gets our own `Page` type.** `packages/core/src/browser/page.ts`
   exports `interface Page` with the Playwright-shaped subset the adapters use
   (`goto`, `evaluate`, `waitForFunction`, `waitForSelector`, `url`), so each
   adapter's diff is one import line. Rejected: keeping `import type { Page }
from 'playwright'` (keeps a peer dep that users must install for types);
   a new generic "Driver" abstraction (YAGNI — the seam is the DOM, not the driver).
5. **Masks resolve with CSS selectors over the document and open shadow roots**,
   in document order, and draw Playwright's overlay. Playwright-only selector
   syntax (`text=`, `>>`, `:has-text`, `:visible`, `nth=`) is dropped; a mask
   that uses it throws `jux: mask selector '…' is not CSS` so a baseline is
   never silently captured unmasked. `structure.ts` marks with the same resolver.
6. **Browser acquisition: pinned Chrome for Testing `chrome-headless-shell`
   151.0.7922.34**, the exact build Playwright 1.62.0 runs today, so an
   upgrade changes nothing in the pixels. CfT publishes no checksums
   (`known-good-versions-with-downloads.json` carries `version`, `revision`,
   `downloads[].{platform,url}` only), so **we pin sha256 per platform**,
   measured 2026-10-13 from the published zips:

   | platform  | zip bytes   | sha256                                                             |
   | --------- | ----------- | ------------------------------------------------------------------ |
   | linux64   | 120,231,126 | `3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14` |
   | mac-arm64 | 99,275,008  | `cb46a336dbe3d6f1339c5039c3083e4e5dd8e4379710790e34f8f4a865e2452d` |
   | mac-x64   | 103,580,477 | `608e2b5b1815b45e8bf59c9a381412b62df3ce36f2c182bc04e22fcf04ad53ea` |
   | win64     | 120,106,945 | `46cc69ef55ba29268ffe32dda4192a9d2165be42c3f4e923241153d519493aea` |

   Availability: 151.0.7922.34 is published for `linux64`, `mac-arm64`,
   `mac-x64`, `win32`, `win64`; **not** `linux-arm64` (CfT started shipping
   linux-arm64 later; 156.0.8078.4 has it). linux-arm64 users bring their own
   binary (`JUX_CHROME`) until the pin moves. URL shape:
   `https://storage.googleapis.com/chrome-for-testing-public/<version>/<platform>/chrome-headless-shell-<platform>.zip`.

7. **Cache dir** `<cache>/jux/chrome-headless-shell/<version>/` where
   `<cache>` is `~/Library/Caches` (mac), `$XDG_CACHE_HOME` or `~/.cache`
   (linux), `%LOCALAPPDATA%` (win); override with `JUX_CACHE_DIR`. A
   `.complete` marker written last. **Reuse of the ms-playwright cache**: if
   `<ms-playwright>/chromium_headless_shell-1234/chrome-headless-shell-<platform>/chrome-headless-shell`
   exists with its `INSTALLATION_COMPLETE` marker, use it (same bytes,
   verified). The revision↔version pair is a constant beside the pin.
8. **Unzip without a dependency**: a 120-line reader of the zip central
   directory using `zlib.inflateRawSync` (method 8) and stored entries
   (method 0), restoring POSIX mode bits from the external attributes. The
   zips contain no symlinks (verified with `zipinfo` on linux64 and mac-arm64:
   287 and 18 regular entries, 0 links); a symlink entry is refused rather
   than followed. Rejected: shelling out to `unzip`/`tar` (absent on minimal
   Linux images; `tar` on Windows is bsdtar and fine, but one path is simpler);
   `yauzl`/`adm-zip` (a dependency for one function).
9. **Linux system deps**: the linux64 zip ships `deb.deps`; `jux browser
install` prints the apt line from it when the binary fails to start with a
   missing shared library (`error while loading shared libraries: X`), and the
   README carries the Ubuntu 24.04 list from playwright-core's registry
   (`libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64
libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4
libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6
libxfixes3 libxkbcommon0 libxrandr2`). We do not run `apt` ourselves.
10. **Bring your own binary**: `JUX_CHROME=<path>` or `--chrome <path>` on
    `snap`, `run`, `init`. Resolution order: flag → env → jux cache →
    ms-playwright cache → error that names `npx -p @juxtapose/cli jux browser install`. A BYO binary
    is recorded in `CaptureEnv.browser` like any other (the version comes from
    `Browser.getVersion`), so an environment change is still explained.
11. **`CaptureEnv.browser` keeps its meaning**: `Browser.getVersion().product`
    is `HeadlessChrome/151.0.7922.34`; Playwright reports `151.0.7922.34`. We
    strip the prefix so existing manifests' `env` compares equal.
12. **Node ≥ 22.2.0.** Node 20 reached end of life 2026-04-30; CI already runs 22. The driver uses only `node:net`, `node:child_process`, `node:zlib` (`zlib.crc32`, added in 22.2 — the floor), `node:crypto`, `fetch`. The changeset says so. (The global `WebSocket` is available from 22 and was used by the spike's daemon client; the shipped daemon does not need it — see 13.)
13. **Warm browser = a supervisor over a local socket, not a debugging port.**
    Chrome is launched by a detached `jux` supervisor process over the pipe
    (never `--remote-debugging-port`), and the supervisor listens on a Unix
    domain socket (`<cache>/jux/browser/<hash>.sock`, dir `0700`, socket
    `0600`) or a Windows named pipe (`\\.\pipe\jux-browser-<hash>`), speaking
    CDP JSON with the same `\0` framing as Chrome's pipe. Why not the port:
    `--remote-debugging-port` on 127.0.0.1 is reachable by every local
    process of every user and its only secret is the GUID in the ws path;
    the socket is protected by file permissions, Chrome never listens on TCP,
    and the supervisor sees each client's connection, so it can dispose the
    browser contexts a crashed client left behind (Chrome's `disposeOnDetach`
    would only fire when the supervisor itself detaches). Cost: one hop per
    message; the spike's ws path (Chrome's own server) measured 9–11 ms
    connect and 257 ms p50 per snap, so the proxy's budget is ≤ 5 ms more.
    Rejected: port + token (Chrome has no token support; the GUID path is
    not a secret by design); daemon written in Chrome itself (cannot run
    Node). `<hash>` = sha256 of an **environment fingerprint**: binary path, version, extra launch args, `TZ`, `LANG`, `LC_ALL`, `FONTCONFIG_FILE` and uid. A BYO binary and the pinned one never share a supervisor, and two invocations whose locale or timezone differ — which changes what a page renders — never share one either, so pixels never depend on who started it.
14. **Liveness**: a headless shell with `--no-startup-window` stays up with
    zero targets as long as a CDP client holds the pipe (verified: ten client
    connect/disconnect cycles against one browser, both with a held
    connection and with a keep-alive `about:blank` target); the supervisor
    holds the pipe. Idle exit after `JUX_BROWSER_IDLE_MINUTES` (default 10)
    with no client connected: `Browser.close`, unlink socket and state file.
15. **Opt-out and CI**: `JUX_NO_DAEMON=1`, `--no-daemon`, or a CI environment → private launch over the pipe, exactly PR 1's path. CI is detected by `CI` (any value but `false`/`0`) or any of `JENKINS_URL`, `TEAMCITY_VERSION`, `BUILDKITE`, `GITLAB_CI`, `TF_BUILD`, `CODEBUILD_BUILD_ID` — the systems that do not set `CI`. The daemon is never started implicitly in CI, where it would outlive the job.
16. **Determinism of warm captures is the spike's result, not a hope**:
    15/15 and 14/14 against a browser that had already served 12 earlier
    invocations. Each invocation creates its own `BrowserContext`
    (`Target.createBrowserContext`) per pool worker, exactly as today, and
    disposes it at the end; nothing is shared across invocations but the
    process and its font/GPU-less raster state. `check:determinism` runs once
    with the daemon on and once off in CI.

17. **Hostile pages do not hang a run.** Every CDP send has a Node-side timeout (30 s; `evaluate` takes its own), JavaScript dialogs are dismissed automatically, and `Inspector.targetCrashed` marks the page so later calls fail fast. These are the inputs no example exercises; each has an integration test in the plan.
18. **No orphans.** Chrome is spawned in our process group (not detached); `SIGINT`, `SIGTERM` and `exit` kill every live Chrome and remove its `jux-chrome-*` profile, then re-raise the signal. The supervisor (PR 2) is the one detached process, and `jux browser stop` ends it.

## Proxies

Node's `fetch` ignores `HTTPS_PROXY` unless the process starts with `--use-env-proxy` (Node 24+; `node --help | grep use-env-proxy` says whether a given Node has it). `jux browser install` re-executes itself with that flag when a proxy variable is set and the flag exists; otherwise the download error names `NODE_USE_ENV_PROXY=1` and `JUX_CHROME` as the ways out.

## Module layout (PR 1)

```
packages/core/src/browser/
  cdp.ts          CdpConnection: transport-agnostic (pipe | socket), id → promise,
                  sessionId routing, `send(method, params, sessionId)`,
                  `on(method, sessionId, handler)`, `once(...)`; `Transport`
                  interface {send(json), onMessage, close}
  transport.ts    PipeTransport (fds 3/4), SocketTransport (net.Socket, `\0` frames)
  launch.ts       launchChrome(opts): spawn with userDataDir mkdtemp, parity +
                  deterministic args (moves/extends capture/launch.ts), graceful
                  Browser.close then SIGKILL after 2 s, temp dir removal
  browser.ts      Browser: version(), newContext(opts), close(), isConnected(),
                  BrowserContext: newPage(), clearCookies(), close()
  page.ts         Page interface + CdpPage: the spike's init sequence, dialog
                  auto-dismiss, node-side timeouts, clearOrigin(origin), onMainResponse,
                  goto, evaluate, waitForFunction (rAF), waitForSelector,
                  addStyleTag, setViewportSize, screenshot({mask}), url(),
                  send() for raw CDP (structure.ts, snap.ts)
  selectors.ts    querySelectorAll over document + open shadow roots (document
                  order), isCssSelector guard — used by masks and structure.ts
  acquire.ts      acquireBrowser(): the one launch policy (resolve → launch;
                  PR 2 adds the daemon here and nowhere else)
  resolve.ts      resolveChrome({flag, env}) → {path, source}
  install.ts      installChrome({version, platform, cacheDir, fetch}): download,
                  sha256 verify, extract, mode bits, .complete marker
  zip.ts          extractZip(buffer, dir): central directory + inflateRaw
  pins.ts         CHROME_VERSION, CHROME_PINS {platform → sha256, url},
                  MS_PLAYWRIGHT_REVISION
packages/cli/src/commands/browser.ts   jux browser install|path|status|stop
```

PR 2 adds `packages/core/src/browser/daemon/{supervisor.ts, client.ts, state.ts}`
and `jux browser start|stop|status`.

## The seam

`packages/core/src/platform.ts` imports `type { Page } from './browser/page.js'`
instead of `'playwright'`. `Page` is:

```ts
export interface Page {
  goto(url: string, opts?: { waitUntil?: 'load' }): Promise<void>;
  url(): string;
  evaluate<R, A = undefined>(
    fn: string | ((arg: A) => R | Promise<R>),
    arg?: A,
  ): Promise<R>;
  waitForFunction<A = undefined>(
    fn: (arg: A) => unknown,
    arg?: A,
    opts?: { timeout?: number },
  ): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<void>;
  addStyleTag(opts: { content: string }): Promise<void>;
  setViewportSize(viewport: Viewport): Promise<void>;
  screenshot(opts?: { mask?: string[] }): Promise<Buffer>;
  send<T = unknown>(method: string, params?: object): Promise<T>;
  onMainResponse(handler: (status: number) => void): () => void;
  clearOrigin(origin: string): Promise<void>;
  close(): Promise<void>;
}
```

`evaluate` and `waitForFunction` also take `{ timeout }`; `goto`'s timeout covers `Page.navigate` and the **main frame's** `load` (filtered on `frameId === targetId`, which Chromium guarantees for the top frame — verified 2026-10-13; a same-process child iframe fires its own `load`). `clearOrigin` sends `Storage.clearDataForOrigin` on the page's session, as today's `snap.ts` does; the browser-session form has no `browserContextId` and would clear the default context. `snapPages` and `runCapture` take an injected `Browser` from `acquireBrowser()`; they never launch.

Differences from Playwright's `Page` that adapters can see: `evaluate` takes
one argument (both adapters already pass one object); `waitForFunction`
rejects with `TimeoutError` on timeout (adapters already `.catch`);
`screenshot.mask` is `string[]` not `Locator[]` (core-internal); `send`
replaces `context().newCDPSession(page)`. `@juxtapose/core` exports `Page`,
`Browser`, `BrowserContext`, `acquireBrowser`, `resolveChrome`, `installChrome`.

## Migration and compatibility

- **Baselines**: unchanged bytes, unchanged `env.browser` string, so no
  manifest changes. The upgrade note says so and shows the determinism table.
- **Install**: `npx playwright install chromium` → `npx -p @juxtapose/cli jux browser install` (every user-facing line: README, `packages/cli/README.md`, CONTRIBUTING, the skill, the error text). `jux init` runs it when no browser resolves (prompt-free; downloads ~100 MB with a progress line). Error text when nothing resolves: `jux: no browser. Run \`npx -p @juxtapose/cli jux browser install\`, or set JUX_CHROME=<path to a Chromium headless shell>.`(exit 3), or the platform explanation on linux-arm64.`scripts/check-snap.mjs`asserts this text and uses`JUX_CACHE_DIR=/nonexistent`+`PLAYWRIGHT_BROWSERS_PATH=/nonexistent`.
- **Playwright users who already have the cache** pay nothing: the
  ms-playwright 1234 build is reused.
- **Breaking** (all three named in the changeset): Playwright-only selectors in `mask` **and** `waitForSelector`/`--wait-for` now fail the story with `jux: selector '…' is not a CSS selector` instead of silently matching nothing; `peerDependencies.playwright` removed from core and both adapters (a user's own Playwright is irrelevant now); Node ≥ 22.2.0.
- **Docs**: README (install, browsers, `JUX_CHROME`, daemon section in PR 2),
  `plugins/claude-code/skills/visual-check/SKILL.md:44`, `packages/*/README.md`
  where install is mentioned, `.github/workflows/ci.yml:64,142` → `jux browser
install` (cache key on the pinned version), `ARCHITECTURE.md` layout.
- **Scripts**: `scripts/capture-diff-fixtures.mjs`,
  `scripts/capture-structure-fixture.mjs`, `scripts/structural-corpus/*.mjs`
  move to the driver (the structure fixture page is served over local HTTP and captured through `Page`, as production does — there is no `setContent`); the `no-playwright.mjs` probe becomes a no-browser probe: a module-resolve hook that fails `jux diff` if it loads `playwright`, `node:child_process` or `browser/launch.js`. No module is patched; `launchChrome` takes an injectable `spawn` for tests instead.
- **Lockfile**: the controller runs one `pnpm install` after the package manifests change (plan: after Task 9); implementers never do.
- **Changesets**: minor for every package (`@juxtapose/core`,
  `adapter-storybook`, `adapter-ladle`, `cli`, `server`, `storybook`).

## Security

- PR 1: the browser runs with `--no-sandbox` as Playwright does (it is the
  parity list); the pipe is inherited fds, not a port.
- PR 2: see decision 13. State file `<cache>/jux/browser/<hash>.json`
  (`0600`): `{ pid, socket, binary, version, startedAt, idleMinutes }`.
  Clients verify `pid` is alive and the socket connects before trusting it;
  a stale file is unlinked and the daemon relaunched. Spawn races: the client
  that wins `open(lock, O_EXCL)` launches; others poll the state file for
  2 s, then fall back to a private launch. A leftover `.sock` without a `.json` is removed before the supervisor listens. Node exposes no peer-credential
  API on a Unix socket, so the access control is the directory (`0700`) and
  socket (`0600`) modes on POSIX; on Windows a named pipe created by
  `net.createServer` is owned by the creating user. Downloads: HTTPS to
  `storage.googleapis.com` only, sha256 verified before extraction, extracted
  into a temp dir then renamed into place; zip entries with `..` or absolute
  paths are refused.

## Run concurrency

`capturePool` keeps its shape (`packages/core/src/capture/pool.ts:71-113`):
N workers, each `browser.newContext()` → `Target.createBrowserContext`,
`newPage()` → `Target.createTarget` + `Target.attachToTarget {flatten:true}`.
All sessions share one `CdpConnection`; messages carry `sessionId`, replies
are matched by `id`, events are routed by `sessionId` to the owning page.
That is exactly Playwright's wiring. Workers never share a page. With the
daemon, N contexts belong to one client connection; parallel `jux`
invocations each have their own; Chrome schedules renderers. The supervisor
does not serialize anything.

## Verification bar

1. `pnpm check:determinism` green (storybook example, 3 runs), daemon off and on.
2. Byte-identical hashes on both examples versus the Playwright pipeline
   (the table above, reproduced by `scripts/check-parity.mjs` which captures
   with the shipped driver and compares against hashes recorded from main on
   the same machine).
3. `jux snap` warm p50 measured and printed in the PR (10 runs); target
   ≤ 330 ms wall on this Mac (spike: 305–327).
4. `jux run --all` on both examples timed against main (3 runs each); target
   ≤ main − 100 ms.
5. `grep -r playwright packages/*/package.json packages/*/src` is empty;
   `pnpm -r why playwright` reports nothing in shipped packages.
6. `pnpm test`, `pnpm typecheck`, `pnpm lint`, `scripts/check-snap.mjs`,
   `scripts/check-diff.mjs` green.

## Out of scope

Reducing the settle waits; warm story switching (issue #32); Firefox/WebKit;
a hosted browser; moving the pin (a separate, deliberate PR with a baseline
migration note, since 151 → N changes pixels).
