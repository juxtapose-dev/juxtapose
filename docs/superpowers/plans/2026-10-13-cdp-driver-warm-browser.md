# CDP Driver and Warm Browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Playwright with juxtapose's own minimal CDP driver and a pinned Chrome for Testing `chrome-headless-shell`, byte-identical to today's captures (PR 1), then keep one browser warm between invocations behind a per-user supervisor (PR 2).

**Architecture:** A `packages/core/src/browser/` module speaks raw CDP over Chrome's pipe (PR 1) or a local socket to a supervisor that owns the pipe (PR 2). `Page` becomes our own interface with the Playwright-shaped subset the adapters already use, so each adapter changes one import line. Launch flags, page initialization and the screenshot call are ports of playwright-core 1.62.0 that the spike proved produce identical bytes on both examples (15/15, 14/14) — the page init is exactly the spike's command list, nothing more. The browser is downloaded from Chrome for Testing with sha256 pins we measured, or reused from an existing ms-playwright cache. One `acquireBrowser()` in core owns the launch policy; PR 2 swaps the daemon in there without touching any caller.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.2.0), vitest, sharp (unchanged), `node:net`/`node:child_process`/`node:zlib`/`node:crypto`/`fetch` only. No new dependencies. pnpm workspaces, changesets.

**Spec:** `docs/specs/2026-10-13-cdp-driver-warm-browser-design.md`. Decisions 1–18 and the "What Playwright does for us" map (file:line into `node_modules/.pnpm/playwright-core@1.62.0/node_modules/playwright-core/lib/coreBundle.js`) are the contract. The spike that proved byte identity is at `/Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/proto.mjs` and `args.mjs`; when a task says "as the spike does", open it. The pre-flight review that shaped this revision is at `.superpowers/sdd/2026-10-13-cdp-driver-warm-browser/preflight.md`.

## Global Constraints

- Pass/fail stays `sha256(lossless WebP)`. Every task that touches capture ends by running `pnpm build && pnpm check:determinism` and, from Task 7 on, `node scripts/check-parity.mjs compare examples/storybook /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-hashes.json` — 15/15 or the task is not done.
- **Every task leaves `pnpm build`, `pnpm typecheck` and `pnpm test` green.** No task may rely on a later task to fix the build.
- The ordering in `packages/core/src/capture/capture.ts:60-214` does not change. The port replaces calls, never moves them.
- Launch flags: `PARITY_CHROMIUM_ARGS` is the verbatim playwright-core 1.62.0 list (spec §Decisions 2), followed by `DETERMINISTIC_CHROMIUM_ARGS` unchanged (`packages/core/src/capture/launch.ts:37-49`), followed by caller args. The pre-flight evaluated the plan's list against the spike's: 56/56 identical, same order.
- Page init is **exactly the spike's command list** (spec §Decisions 3): `Page.enable`, `Page.setLifecycleEventsEnabled`, `Runtime.enable`, `Network.enable`, `Emulation.setFocusEmulationEnabled`, `Emulation.setDeviceMetricsOverride`, `Page.setFontFamilies` (per-OS table), `Emulation.setEmulatedMedia` (`prefers-color-scheme: light`), plus `Log.enable` (Playwright sends it; no pixel path) and the service-worker init script on snap contexts. **Not** `Target.setAutoAttach`, **not** `Emulation.setGeolocationOverride`, **not** `Page.setInterceptFileChooserDialog`, **not** `Runtime.runIfWaitingForDebugger`: Playwright skips the last three on init when no option asks for them, and auto-attach without its handler pauses every worker and cross-origin iframe forever.
- Pinned browser: `CHROME_VERSION = '151.0.7922.34'`; sha256 per platform exactly as in spec §Decisions 6; `MS_PLAYWRIGHT_REVISION = '1234'`.
- `CaptureEnv.browser` stays `"151.0.7922.34"` (strip `HeadlessChrome/`).
- Every `send` and every `evaluate` has a Node-side timeout (`SEND_TIMEOUT_MS = 30_000` for sends, the evaluate's own `timeout` option, default 30 s); the driver auto-dismisses JavaScript dialogs; the driver kills its Chrome and removes the temp profile on `SIGINT`, `SIGTERM` and `exit`.
- No `playwright` in any shipped `package.json` or `packages/*/src` after Task 9 (`grep -rn playwright packages/*/package.json packages/*/src` prints nothing).
- **Lockfile:** no implementer runs `pnpm install`. Tasks 7–9 edit `package.json` dependency lists; the controller runs one worktree-local `pnpm install` after Task 9 (marked there) and commits `pnpm-lock.yaml`. Until then, `pnpm build/test/typecheck` keep working because the dependencies are already in `node_modules`.
- Node engines `>=22.2.0` in the root `package.json`, every `packages/*/package.json`, and the CI `node-version` (`.github/workflows/ci.yml`); the changeset says so. (`zlib.crc32` landed in 22.2; Node 20 reached end of life 2026-04-30.)
- Mask selectors and `waitForSelector` selectors are CSS; a non-CSS selector throws `jux: selector '<sel>' is not a CSS selector` before any capture. **This is a documented breaking change** in the changeset (`text=`, `>>`, `:has-text()` and the other Playwright-only forms).
- No module patching anywhere: `launchChrome` takes an injectable `spawn`; the `jux diff` no-browser probe and tests pass a fake.
- Daemon (PR 2) is off when `JUX_NO_DAEMON=1`, `--no-daemon`, or a CI environment is detected (`CI`, `JENKINS_URL`, `TEAMCITY_VERSION`, `BUILDKITE`, `GITLAB_CI`, `TF_BUILD`, `CODEBUILD_BUILD_ID`); never a `--remote-debugging-port`; keyed by an environment fingerprint (binary path, version, extra args, `TZ`, `LANG`, `LC_ALL`, `FONTCONFIG_FILE`, uid).
- Lazy imports stay: `packages/cli/src/index.ts` keeps `await import('./commands/…')`; `jux diff` loads no browser code (`scripts/check-diff.mjs` probe).
- Every user-facing install line reads `npx -p @juxtapose/cli jux browser install`.
- Comments say why and carry the number; no dead options; typed throughout. Test files share helpers through `packages/core/src/browser/__tests__/helpers.ts` (excluded from `dist` by the `tsconfig.json` change in Task 2).
- Run `pnpm format` before every commit; commit messages end with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01WpCZfVW62Xa6dH2JkGBmYL`.
- Scratch files only under `/Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/`. Never `git stash`, `git add -A`, `git reset --hard`.

## Review Focus

1. **A story whose `mask` or `--wait-for` uses Playwright syntax** (`text=Clock`, `div >> span`). Expect a thrown `jux: selector … is not a CSS selector` and the story reported as an error, never a silently unmasked baseline. Test: Task 6 (`selectors.test.ts`, "rejects Playwright-only syntax") and Task 7 (`capture.test.ts`, "a non-CSS mask fails the story before the shutter", against the real `assertCssSelector` through a page fake that records calls).
2. **A page that never fires `load`, calls `alert()`, or runs a synchronous infinite loop.** Expect `goto` to reject after its timeout with the URL in the message, the dialog to be dismissed so `evaluate` returns, a hung `evaluate` to reject at its Node-side timeout, and the pool to keep going. Test: Task 6 (`page.test.ts`, "goto rejects on timeout with the url", "an alert is dismissed and evaluate returns", "evaluate rejects at its node-side timeout").
3. **A browser that dies mid-run, or a user that hits Ctrl-C.** Expect every pending `send` to reject with `TargetClosedError`, `browser.isConnected()` false, no unhandled rejection, and on `SIGINT`/`SIGTERM`/`exit` the Chrome process gone and its `jux-chrome-*` profile removed. Test: Task 4 (`cdp.test.ts`, "transport close rejects pending") and Task 5 (`launch.test.ts`, "killing the process rejects in-flight sends and leaves no unhandled rejection", "a signal kills chrome and removes the profile", "a non-executable path rejects with the path").
4. **A stale daemon state file or a leftover socket** (machine rebooted, pid reused, `.sock` without `.json`). Expect the client to detect it within 2 s, clean up, and launch — never a hang, never `EADDRINUSE` killing the supervisor silently. Test: Task 11 (`state.test.ts`, "clearState removes a leftover socket"), Task 12 (`supervisor.test.ts`, "listens over a leftover socket file"), Task 13 (`client.test.ts`, "stale state file is replaced").
5. **Two `jux` invocations starting at once with no daemon**, and **one invocation in a different environment** (`TZ`, `LANG`). Expect exactly one supervisor for the first pair; a different fingerprint for the second, so pixels never depend on who started the daemon. Test: Task 13 (`client.test.ts`, "spawn race yields one daemon"), Task 11 (`state.test.ts`, "the key changes with TZ, LANG, LC_ALL and args").

---

# PR 1 — driver, installer, port, docs (branch `feat/cdp-driver`)

### Task 1: Pins and binary resolution

**Files:**

- Create: `packages/core/src/browser/pins.ts`
- Create: `packages/core/src/browser/resolve.ts`
- Test: `packages/core/src/browser/resolve.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `pins.ts`: `CHROME_VERSION: '151.0.7922.34'`, `MS_PLAYWRIGHT_REVISION: '1234'`, `type ChromePlatform = 'linux64' | 'mac-arm64' | 'mac-x64' | 'win64'`, `interface ChromePin { platform: ChromePlatform; url: string; sha256: string; bytes: number }`, `CHROME_PINS: Record<ChromePlatform, ChromePin>`, `chromePlatform(platform?: NodeJS.Platform, arch?: string): ChromePlatform` (throws for unsupported, naming `JUX_CHROME`).
  - `resolve.ts`: `interface ResolveOptions { flag?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string; homedir?: string; exists?: (p: string) => boolean }`, `type ChromeSource = 'flag' | 'env' | 'jux-cache' | 'ms-playwright'`, `interface ResolvedChrome { path: string; source: ChromeSource }`, `resolveChrome(opts?): ResolvedChrome | null`, `juxCacheDir(opts?): string`, `chromeInstallDir(cacheDir: string, version?: string): string`, `chromeBinaryPath(installDir: string, platform: ChromePlatform): string`, `msPlaywrightBinaryPath(opts?): string`, `INSTALL_MARKER: '.complete'`, `NO_BROWSER_MESSAGE: string`, `noBrowserMessage(opts?): string` (adds the platform explanation when `chromePlatform` throws).

- [ ] **Step 1: Write the failing test** (10 tests)

```ts
// packages/core/src/browser/resolve.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  resolveChrome,
  juxCacheDir,
  chromeInstallDir,
  chromeBinaryPath,
  msPlaywrightBinaryPath,
  noBrowserMessage,
  NO_BROWSER_MESSAGE,
} from './resolve.js';
import { CHROME_PINS, CHROME_VERSION, chromePlatform } from './pins.js';

const mac = { platform: 'darwin' as const, arch: 'arm64', homedir: '/Users/u', env: {} };
const JUX_DIR = '/Users/u/Library/Caches/jux/chrome-headless-shell/151.0.7922.34';
const juxBin = `${JUX_DIR}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const juxMarker = `${JUX_DIR}/.complete`;
const PW_DIR = '/Users/u/Library/Caches/ms-playwright/chromium_headless_shell-1234';
const pwBin = `${PW_DIR}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const pwMarker = `${PW_DIR}/INSTALLATION_COMPLETE`;
const have =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe('chromePlatform', () => {
  it('maps node platform/arch to the CfT platform key', () => {
    expect(chromePlatform('darwin', 'arm64')).toBe('mac-arm64');
    expect(chromePlatform('darwin', 'x64')).toBe('mac-x64');
    expect(chromePlatform('linux', 'x64')).toBe('linux64');
    expect(chromePlatform('win32', 'x64')).toBe('win64');
  });
  it('names the unsupported platform and the escape hatch', () => {
    // CfT publishes no linux-arm64 build of 151.0.7922.34 (spec §Decisions 6).
    expect(() => chromePlatform('linux', 'arm64')).toThrow(/linux-arm64.*JUX_CHROME/);
  });
  it('pins every platform with a 64-hex sha256 and the CfT url', () => {
    for (const pin of Object.values(CHROME_PINS)) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.url).toBe(
        `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${pin.platform}/chrome-headless-shell-${pin.platform}.zip`,
      );
    }
  });
});

describe('paths', () => {
  it('uses the OS cache directory, overridable by JUX_CACHE_DIR', () => {
    expect(juxCacheDir(mac)).toBe('/Users/u/Library/Caches/jux');
    expect(
      juxCacheDir({ ...mac, platform: 'linux', env: { XDG_CACHE_HOME: '/x' } }),
    ).toBe('/x/jux');
    expect(juxCacheDir({ ...mac, platform: 'linux', env: {} })).toBe(
      '/Users/u/.cache/jux',
    );
    // path.join is the host's; on POSIX that yields "C:\L/jux", which is what a win32 host would not do.
    expect(
      juxCacheDir({ ...mac, platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' } }),
    ).toBe(path.join('C:\\L', 'jux'));
    expect(juxCacheDir({ ...mac, env: { JUX_CACHE_DIR: '/tmp/c' } })).toBe('/tmp/c');
  });
  it('lays the install out like the zip does', () => {
    const dir = chromeInstallDir('/c', '151.0.7922.34');
    expect(dir).toBe('/c/chrome-headless-shell/151.0.7922.34');
    expect(chromeBinaryPath(dir, 'mac-arm64')).toBe(
      '/c/chrome-headless-shell/151.0.7922.34/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
    expect(chromeBinaryPath(dir, 'win64')).toBe(
      path.join(dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    );
  });
  it('knows where Playwright keeps the same build', () => {
    expect(msPlaywrightBinaryPath(mac)).toBe(pwBin);
    expect(
      msPlaywrightBinaryPath({ ...mac, env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' } }),
    ).toBe(
      '/pw/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
  });
});

describe('resolveChrome', () => {
  it('prefers flag, then env, then the jux cache, then ms-playwright', () => {
    const all = have('/f', '/e', juxBin, juxMarker, pwBin, pwMarker);
    expect(
      resolveChrome({ ...mac, flag: '/f', env: { JUX_CHROME: '/e' }, exists: all }),
    ).toEqual({ path: '/f', source: 'flag' });
    expect(resolveChrome({ ...mac, env: { JUX_CHROME: '/e' }, exists: all })).toEqual({
      path: '/e',
      source: 'env',
    });
    expect(
      resolveChrome({ ...mac, exists: have(juxBin, juxMarker, pwBin, pwMarker) }),
    ).toEqual({ path: juxBin, source: 'jux-cache' });
    expect(resolveChrome({ ...mac, exists: have(pwBin, pwMarker) })).toEqual({
      path: pwBin,
      source: 'ms-playwright',
    });
  });
  it('requires the install markers, not just the binary', () => {
    // A half-extracted install must not be used: the marker is written last.
    expect(resolveChrome({ ...mac, exists: have(juxBin) })).toBeNull();
    expect(resolveChrome({ ...mac, exists: have(pwBin) })).toBeNull();
  });
  it('a flag or env that points nowhere is an error, not a fallthrough', () => {
    expect(() =>
      resolveChrome({ ...mac, flag: '/nope', exists: have(juxBin, juxMarker) }),
    ).toThrow(/\/nope/);
    expect(() =>
      resolveChrome({
        ...mac,
        env: { JUX_CHROME: '/nope' },
        exists: have(juxBin, juxMarker),
      }),
    ).toThrow(/JUX_CHROME/);
  });
  it('returns null when nothing resolves, and the message names the fix and the platform', () => {
    expect(resolveChrome({ ...mac, exists: () => false })).toBeNull();
    expect(NO_BROWSER_MESSAGE).toMatch(/npx -p @juxtapose\/cli jux browser install/);
    expect(NO_BROWSER_MESSAGE).toMatch(/JUX_CHROME/);
    expect(noBrowserMessage({ ...mac, platform: 'linux', arch: 'arm64' })).toMatch(
      /linux-arm64/,
    );
    expect(noBrowserMessage(mac)).toBe(NO_BROWSER_MESSAGE);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/browser/resolve.test.ts`
Expected: FAIL — cannot find `./resolve.js` / `./pins.js`.

- [ ] **Step 3: Write `pins.ts`**

```ts
// packages/core/src/browser/pins.ts
//
// The browser is pinned, not "latest": Chromium 149 -> 151 changed 2 of 18
// example baselines (see capture/env.ts), so moving the version is a
// deliberate PR with a migration note, never a side effect of an install.
//
// 151.0.7922.34 is the exact build playwright-core 1.62.0 ships as
// chromium-headless-shell r1234, so upgrading from the Playwright driver to
// this one changes no bytes. Verified 2026-10-13: the binary inside CfT's
// mac-arm64 zip and the one in ~/Library/Caches/ms-playwright/
// chromium_headless_shell-1234 share sha256 7687bff7cb2db075….
//
// Chrome for Testing publishes no checksums (known-good-versions-with-
// downloads.json carries only version, revision and urls), so the sha256 of
// each zip was measured from the published files and pinned here.

export const CHROME_VERSION = '151.0.7922.34';
export const MS_PLAYWRIGHT_REVISION = '1234';

export type ChromePlatform = 'linux64' | 'mac-arm64' | 'mac-x64' | 'win64';

export interface ChromePin {
  platform: ChromePlatform;
  url: string;
  sha256: string;
  bytes: number;
}

const url = (p: ChromePlatform) =>
  `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${p}/chrome-headless-shell-${p}.zip`;

export const CHROME_PINS: Record<ChromePlatform, ChromePin> = {
  linux64: {
    platform: 'linux64',
    url: url('linux64'),
    sha256: '3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14',
    bytes: 120231126,
  },
  'mac-arm64': {
    platform: 'mac-arm64',
    url: url('mac-arm64'),
    sha256: 'cb46a336dbe3d6f1339c5039c3083e4e5dd8e4379710790e34f8f4a865e2452d',
    bytes: 99275008,
  },
  'mac-x64': {
    platform: 'mac-x64',
    url: url('mac-x64'),
    sha256: '608e2b5b1815b45e8bf59c9a381412b62df3ce36f2c182bc04e22fcf04ad53ea',
    bytes: 103580477,
  },
  win64: {
    platform: 'win64',
    url: url('win64'),
    sha256: '46cc69ef55ba29268ffe32dda4192a9d2165be42c3f4e923241153d519493aea',
    bytes: 120106945,
  },
};

/** CfT platform key for this machine. linux-arm64 has no 151.0.7922.34 build. */
export function chromePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ChromePlatform {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux64';
  if (platform === 'win32' && arch === 'x64') return 'win64';
  const key = platform === 'linux' ? `linux-${arch}` : `${platform}-${arch}`;
  throw new Error(
    `jux: Chrome for Testing publishes no chrome-headless-shell ${CHROME_VERSION} for ${key}. ` +
      `Point JUX_CHROME at a Chromium ${CHROME_VERSION.split('.')[0]} headless shell.`,
  );
}
```

- [ ] **Step 4: Write `resolve.ts`**

```ts
// packages/core/src/browser/resolve.ts
//
// Where the browser comes from, in order: --chrome, JUX_CHROME, our cache,
// Playwright's cache. The last one is not a courtesy: it is the same bytes
// (pins.ts), and most early users already have it, so the upgrade costs them
// no download.

import { existsSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import {
  CHROME_VERSION,
  MS_PLAYWRIGHT_REVISION,
  chromePlatform,
  type ChromePlatform,
} from './pins.js';

export interface ResolveOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  homedir?: string;
  exists?: (p: string) => boolean;
}

export type ChromeSource = 'flag' | 'env' | 'jux-cache' | 'ms-playwright';

export interface ResolvedChrome {
  path: string;
  source: ChromeSource;
}

export const INSTALL_MARKER = '.complete';

export const NO_BROWSER_MESSAGE =
  'jux: no browser. Run `npx -p @juxtapose/cli jux browser install`, or set JUX_CHROME=<path to a Chromium headless shell>.';

/** The no-browser message, with the platform explanation when there is no build to install. */
export function noBrowserMessage(opts: ResolveOptions = {}): string {
  try {
    chromePlatform(opts.platform ?? process.platform, opts.arch ?? process.arch);
    return NO_BROWSER_MESSAGE;
  } catch (err) {
    return (err as Error).message;
  }
}

function osCacheDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches');
  if (platform === 'win32')
    return env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return env.XDG_CACHE_HOME || path.join(home, '.cache');
}

export function juxCacheDir(opts: ResolveOptions = {}): string {
  const env = opts.env ?? process.env;
  if (env.JUX_CACHE_DIR) return env.JUX_CACHE_DIR;
  const platform = opts.platform ?? process.platform;
  return path.join(osCacheDir(platform, env, opts.homedir ?? osHomedir()), 'jux');
}

export function chromeInstallDir(
  cacheDir: string,
  version: string = CHROME_VERSION,
): string {
  return path.join(cacheDir, 'chrome-headless-shell', version);
}

/** Mirrors the zip's top-level folder so `extractZip` needs no renaming. */
export function chromeBinaryPath(installDir: string, platform: ChromePlatform): string {
  const exe =
    platform === 'win64' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  return path.join(installDir, `chrome-headless-shell-${platform}`, exe);
}

export function msPlaywrightBinaryPath(opts: ResolveOptions = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const cft = chromePlatform(platform, opts.arch ?? process.arch);
  const root =
    env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(osCacheDir(platform, env, opts.homedir ?? osHomedir()), 'ms-playwright');
  return chromeBinaryPath(
    path.join(root, `chromium_headless_shell-${MS_PLAYWRIGHT_REVISION}`),
    cft,
  );
}

export function resolveChrome(opts: ResolveOptions = {}): ResolvedChrome | null {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;

  if (opts.flag) {
    if (!exists(opts.flag)) throw new Error(`jux: --chrome ${opts.flag} does not exist.`);
    return { path: opts.flag, source: 'flag' };
  }
  if (env.JUX_CHROME) {
    if (!exists(env.JUX_CHROME))
      throw new Error(`jux: JUX_CHROME=${env.JUX_CHROME} does not exist.`);
    return { path: env.JUX_CHROME, source: 'env' };
  }

  let cft: ChromePlatform;
  try {
    cft = chromePlatform(opts.platform ?? process.platform, opts.arch ?? process.arch);
  } catch {
    return null;
  }

  const installDir = chromeInstallDir(juxCacheDir(opts));
  const ours = chromeBinaryPath(installDir, cft);
  if (exists(ours) && exists(path.join(installDir, INSTALL_MARKER)))
    return { path: ours, source: 'jux-cache' };

  const theirs = msPlaywrightBinaryPath(opts);
  // Playwright writes INSTALLATION_COMPLETE last, like our marker.
  const theirMarker = path.join(
    path.dirname(path.dirname(theirs)),
    'INSTALLATION_COMPLETE',
  );
  if (exists(theirs) && exists(theirMarker))
    return { path: theirs, source: 'ms-playwright' };

  return null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/browser/resolve.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add packages/core/src/browser/pins.ts packages/core/src/browser/resolve.ts packages/core/src/browser/resolve.test.ts
git commit -m "core: pin chrome-headless-shell 151.0.7922.34 and resolve the binary"
```

### Task 2: Zip extraction without a dependency

**Files:**

- Create: `packages/core/src/browser/zip.ts`
- Create: `packages/core/src/browser/__tests__/zip-builder.ts` (test-only zip writer, shared with Task 3)
- Modify: `packages/core/tsconfig.json` — `"exclude": ["src/**/*.test.ts", "src/**/__tests__/**"]` so test helpers never ship in `dist`
- Test: `packages/core/src/browser/zip.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `interface ZipEntry { name: string; mode: number; isDirectory: boolean; data: Buffer }`, `readZip(buf: Buffer): ZipEntry[]`, `extractZip(buf: Buffer, dir: string): Promise<string[]>` (returns written paths; refuses `..`, absolute names and symlink entries). Test helper: `buildZip(specs: { name: string; data: Buffer; mode: number; stored?: boolean; symlink?: boolean }[]): Buffer`.

- [ ] **Step 1: Write the test helper** `packages/core/src/browser/__tests__/zip-builder.ts`

```ts
// Minimal zip writer for tests: local headers + central directory + EOCD,
// deflate or stored, unix mode in the external attributes, no zip64.
import { deflateRawSync, crc32 } from 'node:zlib';

export interface ZipSpec {
  name: string;
  data: Buffer;
  mode: number;
  stored?: boolean;
  symlink?: boolean;
}

export function buildZip(specs: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const name = Buffer.from(s.name);
    const body = s.stored ? s.data : deflateRawSync(s.data);
    const method = s.stored ? 0 : 8;
    const crc = crc32(s.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(s.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(s.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const type = s.symlink ? 0o120000 : s.name.endsWith('/') ? 0o040000 : 0o100000;
    central.writeUInt32LE(((type | s.mode) >>> 0) * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
```

- [ ] **Step 2: Write the failing test** (4 tests)

```ts
// packages/core/src/browser/zip.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readZip, extractZip } from './zip.js';
import { buildZip } from './__tests__/zip-builder.js';

const zip = buildZip([
  { name: 'shell-x/', data: Buffer.alloc(0), mode: 0o755 },
  {
    name: 'shell-x/chrome-headless-shell',
    data: Buffer.from('#!/bin/sh\necho hi\n'),
    mode: 0o755,
  },
  { name: 'shell-x/ABOUT', data: Buffer.from('about'), mode: 0o644, stored: true },
  { name: 'shell-x/big.pak', data: Buffer.alloc(300_000, 7), mode: 0o644 },
]);

describe('readZip', () => {
  it('reads deflated and stored entries with their modes', () => {
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'shell-x/',
      'shell-x/chrome-headless-shell',
      'shell-x/ABOUT',
      'shell-x/big.pak',
    ]);
    expect(entries[1].data.toString()).toBe('#!/bin/sh\necho hi\n');
    expect(entries[1].mode & 0o777).toBe(0o755);
    expect(entries[2].data.toString()).toBe('about');
    expect(entries[3].data.length).toBe(300_000);
    expect(entries[0].isDirectory).toBe(true);
  });
  it('rejects a bad crc', () => {
    // Flip a byte inside the STORED entry's data: inflate is not involved, so
    // the only check that can catch it is the crc. (Flipping a deflated byte
    // fails earlier, inside zlib, with "invalid code lengths set".)
    const broken = Buffer.from(zip);
    broken[broken.indexOf(Buffer.from('about'))] ^= 0xff;
    expect(() => readZip(broken)).toThrow(/crc mismatch for shell-x\/ABOUT/);
  });
});

describe('extractZip', () => {
  it('writes files with exec bits and returns their paths', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jux-zip-'));
    try {
      const written = await extractZip(zip, dir);
      expect(written).toContain(path.join(dir, 'shell-x/chrome-headless-shell'));
      expect(
        (await stat(path.join(dir, 'shell-x/chrome-headless-shell'))).mode & 0o111,
      ).not.toBe(0);
      expect(await readFile(path.join(dir, 'shell-x/ABOUT'), 'utf8')).toBe('about');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('refuses path traversal, absolute names and symlinks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jux-zip-'));
    try {
      await expect(
        extractZip(
          buildZip([{ name: '../x', data: Buffer.from('a'), mode: 0o644 }]),
          dir,
        ),
      ).rejects.toThrow(/\.\./);
      await expect(
        extractZip(
          buildZip([{ name: '/etc/x', data: Buffer.from('a'), mode: 0o644 }]),
          dir,
        ),
      ).rejects.toThrow(/absolute/);
      await expect(
        extractZip(
          buildZip([
            { name: 'l', data: Buffer.from('target'), mode: 0o777, symlink: true },
          ]),
          dir,
        ),
      ).rejects.toThrow(/symlink/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

Verified 2026-10-13 by running this builder and reader outside the repo: the four entries read back with mode `755` and 300,000 bytes, and the stored-entry corruption throws `zip: crc mismatch for shell-x/ABOUT`.

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/browser/zip.test.ts`
Expected: FAIL — cannot find `./zip.js`.

- [ ] **Step 4: Write `zip.ts`**

```ts
// packages/core/src/browser/zip.ts
//
// A zip reader for exactly one input: Chrome for Testing's
// chrome-headless-shell-<platform>.zip. Those zips are deflate or stored, no
// zip64 (120 MB, 287 entries on linux64), no symlinks (verified with zipinfo
// on linux64 and mac-arm64, 2026-10-13). Anything else is refused rather
// than guessed at. ~100 lines beats a dependency whose other 95% we never
// call, and `unzip` is absent from minimal Linux images.
//
// zlib.crc32 needs Node 22.2 (the engines floor).

import { inflateRawSync, crc32 } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ZipEntry {
  name: string;
  /** POSIX mode from the external attributes (0 when the zip has none). */
  mode: number;
  isDirectory: boolean;
  data: Buffer;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export function readZip(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record is within the last 64 KiB (comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error('zip: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) {
      throw new Error('zip: zip64 is not supported');
    }

    if (buf.readUInt32LE(local) !== LOCAL)
      throw new Error(`zip: bad local header for ${name}`);
    const start =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip: unsupported compression method ${method} for ${name}`);
    if (data.length !== usize || crc32(data) !== crc)
      throw new Error(`zip: crc mismatch for ${name}`);
    entries.push({ name, mode: attrs >>> 16, isDirectory: name.endsWith('/'), data });
  }
  return entries;
}

export async function extractZip(buf: Buffer, dir: string): Promise<string[]> {
  const root = path.resolve(dir);
  const written: string[] = [];
  for (const e of readZip(buf)) {
    if (path.isAbsolute(e.name) || /^[a-zA-Z]:/.test(e.name))
      throw new Error(`zip: absolute entry name ${e.name}`);
    const target = path.resolve(root, e.name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`zip: entry escapes the target (..): ${e.name}`);
    }
    if ((e.mode & S_IFMT) === S_IFLNK)
      throw new Error(`zip: symlink entry refused: ${e.name}`);
    if (e.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    // Mode bits only matter on POSIX; writeFile ignores them on Windows.
    await writeFile(target, e.data, { mode: e.mode & 0o777 || 0o644 });
    written.push(target);
  }
  return written;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/browser/zip.test.ts && pnpm --filter @juxtapose/core build && ls packages/core/dist/browser`
Expected: PASS, 4 tests; `dist/browser` contains `zip.js` and no `__tests__` directory.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add packages/core/tsconfig.json packages/core/src/browser/zip.ts packages/core/src/browser/zip.test.ts packages/core/src/browser/__tests__/zip-builder.ts
git commit -m "core: minimal zip reader for the chrome-headless-shell download"
```

### Task 3: Installer

**Files:**

- Create: `packages/core/src/browser/install.ts`
- Test: `packages/core/src/browser/install.test.ts`

**Interfaces:**

- Consumes: `CHROME_PINS`, `CHROME_VERSION`, `chromePlatform`, `ChromePin` (Task 1); `chromeInstallDir`, `chromeBinaryPath`, `INSTALL_MARKER` (Task 1); `extractZip` (Task 2); `buildZip` (Task 2, tests only).
- Produces: `interface InstallOptions { cacheDir: string; platform?: ChromePlatform; fetch?: typeof fetch; env?: NodeJS.ProcessEnv; onProgress?: (received: number, total: number | null) => void; pin?: ChromePin }`, `interface InstallResult { path: string; version: string; alreadyInstalled: boolean }`, `installChrome(opts): Promise<InstallResult>`, `proxyHint(env: NodeJS.ProcessEnv): string` (empty when no proxy variable is set).

- [ ] **Step 1: Write the failing test** (4 tests)

```ts
// packages/core/src/browser/install.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installChrome, proxyHint } from './install.js';
import { CHROME_PINS } from './pins.js';
import { buildZip } from './__tests__/zip-builder.js';

const zip = buildZip([
  { name: 'chrome-headless-shell-mac-arm64/', data: Buffer.alloc(0), mode: 0o755 },
  {
    name: 'chrome-headless-shell-mac-arm64/chrome-headless-shell',
    data: Buffer.from('#!/bin/sh\n'),
    mode: 0o755,
  },
]);
const sha = createHash('sha256').update(zip).digest('hex');
const pin = { ...CHROME_PINS['mac-arm64'], sha256: sha, bytes: zip.length };

function fakeFetch(body: Buffer, status = 200): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { 'content-length': String(body.length) },
    })) as typeof fetch;
}

async function withCache(fn: (cacheDir: string) => Promise<void>) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'jux-install-'));
  try {
    await fn(cacheDir);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

describe('installChrome', () => {
  it('downloads, verifies, extracts, marks complete, and is idempotent', () =>
    withCache(async (cacheDir) => {
      const seen: number[] = [];
      const r = await installChrome({
        cacheDir,
        platform: 'mac-arm64',
        fetch: fakeFetch(zip),
        pin,
        onProgress: (n) => seen.push(n),
      });
      expect(r.alreadyInstalled).toBe(false);
      expect(r.path).toBe(
        path.join(
          cacheDir,
          'chrome-headless-shell/151.0.7922.34/chrome-headless-shell-mac-arm64/chrome-headless-shell',
        ),
      );
      expect((await stat(r.path)).mode & 0o111).not.toBe(0);
      expect(
        await readFile(
          path.join(cacheDir, 'chrome-headless-shell/151.0.7922.34/.complete'),
          'utf8',
        ),
      ).toMatch(/151\.0\.7922\.34/);
      expect(seen.at(-1)).toBe(zip.length);
      const again = await installChrome({
        cacheDir,
        platform: 'mac-arm64',
        fetch: fakeFetch(Buffer.alloc(0)),
        pin,
      });
      expect(again.alreadyInstalled).toBe(true);
    }));
  it('refuses a checksum mismatch and leaves no install behind', () =>
    withCache(async (cacheDir) => {
      await expect(
        installChrome({ cacheDir, platform: 'mac-arm64', fetch: fakeFetch(zip) }),
      ).rejects.toThrow(/sha256/);
      await expect(
        stat(path.join(cacheDir, 'chrome-headless-shell/151.0.7922.34')),
      ).rejects.toThrow();
    }));
  it('reports an HTTP failure with the url, and a network failure with the proxy hint', () =>
    withCache(async (cacheDir) => {
      await expect(
        installChrome({
          cacheDir,
          platform: 'linux64',
          fetch: fakeFetch(Buffer.alloc(0), 403),
        }),
      ).rejects.toThrow(/403.*linux64/);
      const offline = (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      await expect(
        installChrome({
          cacheDir,
          platform: 'linux64',
          fetch: offline,
          env: { HTTPS_PROXY: 'http://proxy:3128' },
        }),
      ).rejects.toThrow(/NODE_USE_ENV_PROXY=1.*JUX_CHROME/s);
      await expect(
        installChrome({ cacheDir, platform: 'linux64', fetch: offline, env: {} }),
      ).rejects.toThrow(/fetch failed.*JUX_CHROME/s);
    }));
});

describe('proxyHint', () => {
  it('is empty without proxy variables and names the variable with them', () => {
    expect(proxyHint({})).toBe('');
    expect(proxyHint({ https_proxy: 'x' })).toMatch(/https_proxy.*NODE_USE_ENV_PROXY=1/s);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/browser/install.test.ts`
Expected: FAIL — cannot find `./install.js`.

- [ ] **Step 3: Write `install.ts`**

```ts
// packages/core/src/browser/install.ts
//
// Download → sha256 → extract into a temp sibling → rename into place → write
// the marker last. The marker is what resolve.ts trusts, so an interrupted
// install can never be mistaken for a working one.
//
// Proxies: Node's global fetch ignores HTTPS_PROXY unless the process runs
// with NODE_USE_ENV_PROXY=1 (Node 24+; `node --help | grep use-env-proxy`
// says whether this Node has it). We cannot set that from inside a running
// process, so the CLI re-executes itself with it when a proxy variable is
// present (Task 9), and this module names it in the error for every other
// caller.

import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CHROME_PINS,
  CHROME_VERSION,
  chromePlatform,
  type ChromePin,
  type ChromePlatform,
} from './pins.js';
import { chromeBinaryPath, chromeInstallDir, INSTALL_MARKER } from './resolve.js';
import { extractZip } from './zip.js';

export interface InstallOptions {
  cacheDir: string;
  platform?: ChromePlatform;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  onProgress?: (received: number, total: number | null) => void;
  /** Test seam: a pin for a fixture zip. */
  pin?: ChromePin;
}

export interface InstallResult {
  path: string;
  version: string;
  alreadyInstalled: boolean;
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

export function proxyHint(env: NodeJS.ProcessEnv): string {
  const set = PROXY_VARS.find((v) => env[v]);
  if (!set) return '';
  return (
    ` ${set} is set but Node's fetch does not use it by default: re-run with NODE_USE_ENV_PROXY=1 ` +
    '(Node 24+), or download the zip yourself and set JUX_CHROME.'
  );
}

export async function installChrome(opts: InstallOptions): Promise<InstallResult> {
  const platform = opts.platform ?? chromePlatform();
  const pin = opts.pin ?? CHROME_PINS[platform];
  const env = opts.env ?? process.env;
  const installDir = chromeInstallDir(opts.cacheDir, CHROME_VERSION);
  const binary = chromeBinaryPath(installDir, platform);

  if ((await exists(path.join(installDir, INSTALL_MARKER))) && (await exists(binary))) {
    return { path: binary, version: CHROME_VERSION, alreadyInstalled: true };
  }

  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(pin.url);
  } catch (err) {
    throw new Error(
      `jux: download failed for ${pin.url}: ${(err as Error).message}.${proxyHint(env) || ' Check the network, or download the zip yourself and set JUX_CHROME.'}`,
    );
  }
  if (!res.ok || !res.body)
    throw new Error(`jux: download failed: HTTP ${res.status} for ${pin.url}`);
  const total = Number(res.headers.get('content-length')) || null;
  // Streamed into the hash and a chunk list: ~120 MB held once, not twice.
  const chunks: Buffer[] = [];
  let received = 0;
  const hash = createHash('sha256');
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    const b = Buffer.from(chunk);
    chunks.push(b);
    hash.update(b);
    received += b.length;
    opts.onProgress?.(received, total);
  }
  const digest = hash.digest('hex');
  if (digest !== pin.sha256) {
    throw new Error(
      `jux: sha256 mismatch for ${pin.url}: expected ${pin.sha256}, got ${digest}. ` +
        'The download is corrupt or the published file changed; nothing was installed.',
    );
  }

  const staging = `${installDir}.partial-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await extractZip(Buffer.concat(chunks), staging);
    await rm(installDir, { recursive: true, force: true });
    await mkdir(path.dirname(installDir), { recursive: true });
    await rename(staging, installDir);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  await writeFile(
    path.join(installDir, INSTALL_MARKER),
    JSON.stringify({
      version: CHROME_VERSION,
      platform,
      sha256: digest,
      installedAt: new Date().toISOString(),
    }) + '\n',
  );
  return { path: binary, version: CHROME_VERSION, alreadyInstalled: false };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/browser`
Expected: PASS — resolve 10, zip 4, install 4 (18 total).

- [ ] **Step 5: Commit**

```bash
pnpm format && git add packages/core/src/browser/install.ts packages/core/src/browser/install.test.ts
git commit -m "core: install chrome-headless-shell from Chrome for Testing with pinned sha256"
```

### Task 4: Transport and CDP connection

**Files:**

- Create: `packages/core/src/browser/transport.ts`
- Create: `packages/core/src/browser/cdp.ts`
- Test: `packages/core/src/browser/cdp.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `transport.ts`: `interface Transport { send(message: string): void; onMessage: ((message: string) => void) | null; onClose: ((reason?: string) => void) | null; close(): void }`, `class NullFramer { push(chunk: Buffer | string, onFrame: (s: string) => void): void }`, `abstract class FramedTransport implements Transport` (shared framer/onMessage/onClose/closed bookkeeping; subclasses implement `write(data: string)` and `destroy()`), `class PipeTransport extends FramedTransport` (`constructor(writable: NodeJS.WritableStream, readable: NodeJS.ReadableStream)`), `class SocketTransport extends FramedTransport` (`constructor(socket: net.Socket)`).
  - `cdp.ts`: `interface RawMessage { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string }; sessionId?: string }`, `class CdpError extends Error { code: number }`, `class TargetClosedError extends Error`, `class SendTimeoutError extends Error`, `SEND_TIMEOUT_MS = 30_000`, `class CdpConnection { constructor(transport: Transport); send<T = unknown>(method: string, params?: object, sessionId?: string, opts?: { timeout?: number }): Promise<T>; on(method: string, handler: (params: unknown, sessionId?: string) => void, sessionId?: string): () => void; once<P = unknown>(method: string, sessionId?: string, predicate?: (p: P) => boolean): Promise<P>` (rejects with `TargetClosedError` when the connection closes first)`; allocateId(): number; sendRaw(message: RawMessage & { id: number; method: string }): void; onRaw: ((m: RawMessage) => void) | null; readonly closed: boolean; onClose: ((reason?: string) => void) | null; close(): void }`.

`allocateId` is the **only** id source: `send` calls it, and the PR 2 supervisor calls it for every proxied client message, so a proxied id can never collide with the connection's own.

- [ ] **Step 1: Write the failing test** (9 tests)

```ts
// packages/core/src/browser/cdp.test.ts
import { describe, it, expect } from 'vitest';
import { CdpConnection, CdpError, SendTimeoutError, TargetClosedError } from './cdp.js';
import { NullFramer, type Transport } from './transport.js';

class FakeTransport implements Transport {
  sent: { id: number; method: string; params: unknown; sessionId?: string }[] = [];
  onMessage: ((m: string) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  send(m: string) {
    this.sent.push(JSON.parse(m));
  }
  close() {
    this.onClose?.('closed by test');
  }
  reply(id: number, result: unknown, sessionId?: string) {
    this.onMessage?.(JSON.stringify({ id, result, sessionId }));
  }
  fail(id: number, code: number, message: string) {
    this.onMessage?.(JSON.stringify({ id, error: { code, message } }));
  }
  event(method: string, params: unknown, sessionId?: string) {
    this.onMessage?.(JSON.stringify({ method, params, sessionId }));
  }
}

const isLifecycle = (p: unknown): p is { name: string } =>
  typeof p === 'object' && p !== null && 'name' in p;

describe('CdpConnection', () => {
  it('matches replies by id and carries sessionId', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const p = c.send<{ product: string }>('Browser.getVersion');
    const q = c.send('Page.enable', {}, 'S1');
    expect(t.sent).toEqual([
      { id: 1, method: 'Browser.getVersion', params: {} },
      { id: 2, method: 'Page.enable', params: {}, sessionId: 'S1' },
    ]);
    t.reply(2, {}, 'S1');
    t.reply(1, { product: 'HeadlessChrome/151' });
    expect((await p).product).toBe('HeadlessChrome/151');
    await q;
  });
  it('rejects with CdpError carrying the protocol code and method', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const p = c.send('Runtime.evaluate', { expression: 'x' }, 'S1');
    t.fail(1, -32000, 'Cannot find context');
    await expect(p).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CdpError &&
        e.code === -32000 &&
        /Runtime\.evaluate.*Cannot find context/.test(e.message),
    );
  });
  it('routes events by sessionId and supports once with a predicate', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const got: string[] = [];
    const off = c.on(
      'Page.lifecycleEvent',
      (p) => isLifecycle(p) && got.push('S1:' + p.name),
      'S1',
    );
    c.on('Page.lifecycleEvent', (p) => isLifecycle(p) && got.push('S2:' + p.name), 'S2');
    const load = c.once<{ name: string }>(
      'Page.lifecycleEvent',
      'S1',
      (p) => p.name === 'load',
    );
    t.event('Page.lifecycleEvent', { name: 'init' }, 'S1');
    t.event('Page.lifecycleEvent', { name: 'load' }, 'S2');
    t.event('Page.lifecycleEvent', { name: 'load' }, 'S1');
    expect((await load).name).toBe('load');
    off();
    t.event('Page.lifecycleEvent', { name: 'DOMContentLoaded' }, 'S1');
    expect(got).toEqual(['S1:init', 'S2:load', 'S1:load']);
  });
  it('transport close rejects pending sends, pending once, and future sends with TargetClosedError', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const pending = c.send('Page.navigate', { url: 'x' }, 'S1');
    const waiting = c.once('Page.lifecycleEvent', 'S1');
    let reason: string | undefined;
    c.onClose = (r) => (reason = r);
    t.close();
    await expect(pending).rejects.toBeInstanceOf(TargetClosedError);
    await expect(waiting).rejects.toBeInstanceOf(TargetClosedError);
    await expect(c.send('Browser.getVersion')).rejects.toBeInstanceOf(TargetClosedError);
    expect(c.closed).toBe(true);
    expect(reason).toBe('closed by test');
  });
  it('a send that gets no reply rejects at its node-side timeout', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    await expect(
      c.send('Runtime.evaluate', { expression: 'while(true){}' }, 'S1', { timeout: 20 }),
    ).rejects.toBeInstanceOf(SendTimeoutError);
    t.reply(1, {}); // a late reply must not throw
  });
  it('allocateId and sendRaw share one id space with send', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const p = c.send('Browser.getVersion'); // id 1
    const raw = c.allocateId(); // id 2
    c.sendRaw({ id: raw, method: 'Target.getTargets', params: {} });
    const q = c.send('Target.getBrowserContexts'); // id 3, never 2
    expect(t.sent.map((m) => m.id)).toEqual([1, 2, 3]);
    t.reply(1, { product: 'x' });
    t.reply(3, { browserContextIds: [] });
    await p;
    await q;
  });
  it('onRaw sees every parsed frame, including replies to raw ids', () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const seen: number[] = [];
    c.onRaw = (m) => m.id !== undefined && seen.push(m.id);
    c.sendRaw({ id: c.allocateId(), method: 'Target.getTargets', params: {} });
    t.reply(1, { targetInfos: [] });
    t.event('Target.targetCreated', {});
    expect(seen).toEqual([1]);
  });
  it('tolerates a message that is not json', () => {
    const t = new FakeTransport();
    new CdpConnection(t);
    expect(() => t.onMessage?.('not json')).not.toThrow();
  });
});

describe('NullFramer', () => {
  it('splits on NUL across chunk boundaries', () => {
    const f = new NullFramer();
    const out: string[] = [];
    f.push('{"a":1}\0{"b"', (s) => out.push(s));
    f.push(':2}\0', (s) => out.push(s));
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/browser/cdp.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `transport.ts`**

```ts
// packages/core/src/browser/transport.ts
//
// Two byte pipes, one framing. Chrome's --remote-debugging-pipe speaks
// NUL-terminated JSON on fds 3 (in) and 4 (out); the warm-browser supervisor
// (PR 2) speaks the same framing over a local socket so one CdpConnection
// serves both.

import type net from 'node:net';

export interface Transport {
  send(message: string): void;
  onMessage: ((message: string) => void) | null;
  onClose: ((reason?: string) => void) | null;
  close(): void;
}

export class NullFramer {
  private buffer = '';
  push(chunk: Buffer | string, onFrame: (frame: string) => void): void {
    this.buffer += chunk.toString();
    let end: number;
    while ((end = this.buffer.indexOf('\0')) >= 0) {
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      onFrame(frame);
    }
  }
}

/** Framing, close-once and callback plumbing shared by both transports. */
export abstract class FramedTransport implements Transport {
  onMessage: ((message: string) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  private readonly framer = new NullFramer();
  private closed = false;

  protected abstract write(data: string): void;
  protected abstract destroy(): void;

  protected feed(chunk: Buffer | string): void {
    this.framer.push(chunk, (f) => this.onMessage?.(f));
  }

  send(message: string): void {
    if (this.closed) return;
    this.write(message + '\0');
  }

  close(): void {
    this.destroy();
    this.emitClose('closed');
  }

  protected emitClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }
}

export class PipeTransport extends FramedTransport {
  constructor(
    private readonly writable: NodeJS.WritableStream,
    readable: NodeJS.ReadableStream,
  ) {
    super();
    readable.on('data', (chunk: Buffer) => this.feed(chunk));
    readable.on('close', () => this.emitClose('pipe closed'));
    readable.on('error', (e: Error) => this.emitClose(e.message));
    writable.on('error', (e: Error) => this.emitClose(e.message));
  }
  protected write(data: string): void {
    this.writable.write(data);
  }
  protected destroy(): void {
    // The process owns the fds; launch.ts closes them with the process.
  }
}

export class SocketTransport extends FramedTransport {
  constructor(private readonly socket: net.Socket) {
    super();
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('close', () => this.emitClose('socket closed'));
    socket.on('error', (e) => this.emitClose(e.message));
  }
  protected write(data: string): void {
    this.socket.write(data);
  }
  protected destroy(): void {
    this.socket.destroy();
  }
}
```

- [ ] **Step 4: Write `cdp.ts`**

```ts
// packages/core/src/browser/cdp.ts
//
// The whole protocol client: ids out, replies back, events routed by
// sessionId. Playwright's CRConnection does the same in ~300 lines plus
// the parts we never use.
//
// Every send has a Node-side timeout. Chrome answers Runtime.evaluate only
// when the script returns, so a story with a synchronous infinite loop would
// otherwise hang the worker and the run.

import type { Transport } from './transport.js';

export interface RawMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  sessionId?: string;
}

export const SEND_TIMEOUT_MS = 30_000;

export class CdpError extends Error {
  constructor(
    public readonly code: number,
    method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
  }
}

export class TargetClosedError extends Error {
  constructor(reason = 'browser closed') {
    super(`jux: browser connection closed (${reason})`);
    this.name = 'TargetClosedError';
  }
}

export class SendTimeoutError extends Error {
  constructor(method: string, timeout: number) {
    super(`jux: ${method} got no reply from the browser within ${timeout} ms`);
    this.name = 'SendTimeoutError';
  }
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

type Handler = (params: unknown, sessionId?: string) => void;

export class CdpConnection {
  private lastId = 0;
  private readonly pending = new Map<number, Pending>();
  /** key = `${sessionId ?? ''}\n${method}` */
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly closeWaiters = new Set<(e: Error) => void>();
  private _closed = false;
  onClose: ((reason?: string) => void) | null = null;
  /** Every parsed frame, before routing. The PR 2 supervisor proxies from here. */
  onRaw: ((m: RawMessage) => void) | null = null;

  constructor(private readonly transport: Transport) {
    transport.onMessage = (m) => this.dispatch(m);
    transport.onClose = (reason) => this.handleClose(reason);
  }

  get closed(): boolean {
    return this._closed;
  }

  allocateId(): number {
    return ++this.lastId;
  }

  sendRaw(message: RawMessage & { id: number; method: string }): void {
    if (this._closed) return;
    this.transport.send(JSON.stringify(message));
  }

  send<T = unknown>(
    method: string,
    params: object = {},
    sessionId?: string,
    opts: { timeout?: number } = {},
  ): Promise<T> {
    if (this._closed) return Promise.reject(new TargetClosedError());
    const id = this.allocateId();
    const timeout = opts.timeout ?? SEND_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SendTimeoutError(method, timeout));
      }, timeout);
      timer.unref();
      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.sendRaw(
        sessionId ? { id, method, params, sessionId } : { id, method, params },
      );
    });
  }

  on(method: string, handler: Handler, sessionId?: string): () => void {
    const key = `${sessionId ?? ''}\n${method}`;
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  once<P = unknown>(
    method: string,
    sessionId?: string,
    predicate: (p: P) => boolean = () => true,
  ): Promise<P> {
    if (this._closed) return Promise.reject(new TargetClosedError());
    return new Promise<P>((resolve, reject) => {
      const onClosed = (e: Error) => {
        off();
        reject(e);
      };
      const off = this.on(
        method,
        (params) => {
          if (!predicate(params as P)) return;
          off();
          this.closeWaiters.delete(onClosed);
          resolve(params as P);
        },
        sessionId,
      );
      this.closeWaiters.add(onClosed);
    });
  }

  close(): void {
    this.transport.close();
  }

  private dispatch(raw: string): void {
    let m: RawMessage;
    try {
      m = JSON.parse(raw) as RawMessage;
    } catch {
      return; // Chrome never sends non-JSON frames; nothing to do but ignore.
    }
    this.onRaw?.(m);
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return; // a raw (proxied) id, or a reply after its timeout
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new CdpError(m.error.code, p.method, m.error.message));
      else p.resolve(m.result);
      return;
    }
    if (m.method) {
      const set = this.handlers.get(`${m.sessionId ?? ''}\n${m.method}`);
      if (set) for (const h of [...set]) h(m.params, m.sessionId);
      // Session-less listeners see every event (the browser session's Target.* events).
      if (m.sessionId) {
        const all = this.handlers.get(`\n${m.method}`);
        if (all) for (const h of [...all]) h(m.params, m.sessionId);
      }
    }
  }

  private handleClose(reason?: string): void {
    if (this._closed) return;
    this._closed = true;
    const err = new TargetClosedError(reason);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const w of [...this.closeWaiters]) w(err);
    this.closeWaiters.clear();
    this.onClose?.(reason);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/browser/cdp.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add packages/core/src/browser/transport.ts packages/core/src/browser/cdp.ts packages/core/src/browser/cdp.test.ts
git commit -m "core: CDP connection over pipe or socket with session routing and send timeouts"
```

### Task 5: Launch flags and process management

**Files:**

- Modify: `packages/core/src/capture/launch.ts` (keep `DETERMINISTIC_CHROMIUM_ARGS` and `deterministicLaunchOptions`; add `PARITY_CHROMIUM_ARGS`, `chromeArgs`)
- Modify: `packages/core/src/capture/launch.test.ts`
- Create: `packages/core/src/browser/launch.ts`
- Create: `packages/core/src/browser/__tests__/helpers.ts` (`chromeForTests()`: `resolveChrome()` or null, shared by every integration test)
- Test: `packages/core/src/browser/launch.test.ts` (integration, skipped when no browser resolves)

**Interfaces:**

- Consumes: `CdpConnection`, `PipeTransport` (Task 4); `resolveChrome` (Task 1).
- Produces:
  - `capture/launch.ts`: `PARITY_CHROMIUM_ARGS: readonly string[]`, `chromeArgs(opts: { userDataDir: string; args?: string[]; headless?: boolean }): string[]` (parity → swiftshader → headless set → `--no-sandbox` → deterministic → caller → `--user-data-dir` → `--remote-debugging-pipe` → `--no-startup-window`).
  - `browser/launch.ts`: `type SpawnFn = typeof import('node:child_process').spawn`, `interface LaunchedChrome { connection: CdpConnection; pid: number; userDataDir: string; close(): Promise<void> }`, `launchChrome(opts: { executablePath: string; args?: string[]; headless?: boolean; spawn?: SpawnFn }): Promise<LaunchedChrome>`. Process-exit handling: a module-level registry of live launches; `SIGINT`/`SIGTERM` handlers (installed once, on the first launch) kill every registered Chrome, remove its profile and re-raise the signal; `process.on('exit')` kills synchronously with `rmSync`.
  - `__tests__/helpers.ts`: `chromeForTests(): ResolvedChrome | null`.

- [ ] **Step 1: Extend `capture/launch.test.ts`** (append; adds 1 test to the existing 6)

```ts
import { chromeArgs, PARITY_CHROMIUM_ARGS } from './launch.js';

describe('chromeArgs', () => {
  it('carries playwright-core 1.62.0 switches verbatim, then ours, then the caller', () => {
    const args = chromeArgs({ userDataDir: '/u', args: ['--foo'] });
    // The byte-identity spike ran with exactly this set (pre-flight: 56/56
    // identical, same order); a feature flag that changes raster output would
    // break every baseline, so the list is pinned.
    expect(args.slice(0, PARITY_CHROMIUM_ARGS.length)).toEqual([...PARITY_CHROMIUM_ARGS]);
    expect(PARITY_CHROMIUM_ARGS).toContain('--enable-features=CDPScreenshotNewSurface');
    expect(PARITY_CHROMIUM_ARGS).toContain('--disable-back-forward-cache');
    expect(PARITY_CHROMIUM_ARGS.find((a) => a.startsWith('--disable-features='))).toMatch(
      /PaintHolding/,
    );
    expect(args).toContain('--enable-unsafe-swiftshader');
    expect(args).toContain('--headless');
    expect(args).toContain(
      '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
    );
    expect(args).toContain('--no-sandbox');
    for (const a of DETERMINISTIC_CHROMIUM_ARGS) expect(args).toContain(a);
    expect(args.indexOf('--foo')).toBeGreaterThan(
      args.indexOf('--force-device-scale-factor=1'),
    );
    expect(args.slice(-3)).toEqual([
      '--user-data-dir=/u',
      '--remote-debugging-pipe',
      '--no-startup-window',
    ]);
    expect(args).toHaveLength(56 + 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run packages/core/src/capture/launch.test.ts` → FAIL (`chromeArgs` not exported).

- [ ] **Step 3: Add to `capture/launch.ts`** (below the existing exports; keep the file's header comment)

```ts
/**
 * playwright-core 1.62.0's `chromiumSwitches()` plus its headless additions
 * (`lib/coreBundle.js` L34630–34690, L43067–43097), copied verbatim.
 *
 * The byte-identity spike (spec, 2026-10-13) matched 29/29 example stories
 * against the Playwright pipeline with exactly this list. It was not pruned:
 * a Blink feature flag that changes rasterization — PaintHolding,
 * CDPScreenshotNewSurface — would turn every baseline red, and the gain from
 * dropping any of these is unmeasurable. Change only with a determinism run
 * per removed flag.
 */
export const PARITY_CHROMIUM_ARGS: readonly string[] = [
  '--disable-field-trial-config',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-edgeupdater',
  '--disable-extensions',
  '--disable-features=' +
    [
      'AvoidUnnecessaryBeforeUnloadCheckSync',
      'BoundaryEventDispatchTracksNodeRemoval',
      'DestroyProfileOnBrowserClose',
      'DialMediaRouteProvider',
      'GlobalMediaControls',
      'HttpsUpgrades',
      'LensOverlay',
      'MediaRouter',
      'PaintHolding',
      'ThirdPartyStoragePartitioning',
      'BlockOriginHeaderModificationOnRedirect',
      'Translate',
      'AutoDeElevate',
      'OptimizationHints',
      'msForceBrowserSignIn',
      'msEdgeUpdateLaunchServicesPreferredVersion',
    ].join(','),
  '--enable-features=CDPScreenshotNewSurface',
  '--allow-pre-commit-input',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-updater-scheduler',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-service-autorun',
  '--export-tagged-pdf',
  '--disable-search-engine-choice-screen',
  '--unsafely-disable-devtools-self-xss-warnings',
  '--edge-skip-compat-layer-relaunch',
  '--disable-infobars',
  '--disable-search-engine-choice-screen',
  '--disable-sync',
];

const HEADLESS_ARGS = [
  '--headless',
  '--hide-scrollbars',
  '--mute-audio',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
];

/** The full command line, in Playwright's order so the spike's evidence transfers. */
export function chromeArgs(opts: {
  userDataDir: string;
  args?: string[];
  headless?: boolean;
}): string[] {
  const { headless, args } = deterministicLaunchOptions({
    headless: opts.headless,
    args: opts.args,
  });
  return [
    ...PARITY_CHROMIUM_ARGS,
    '--enable-unsafe-swiftshader',
    ...(headless ? HEADLESS_ARGS : []),
    '--no-sandbox',
    ...args,
    `--user-data-dir=${opts.userDataDir}`,
    '--remote-debugging-pipe',
    '--no-startup-window',
  ];
}
```

Update the `deterministicLaunchOptions` doc comment from "Build the Playwright launch options" to "Our own flags; `chromeArgs` wraps them with the parity set".

- [ ] **Step 4: Run** `pnpm vitest run packages/core/src/capture/launch.test.ts` → PASS, 7 tests.

- [ ] **Step 5: Write the helper and the integration test**

```ts
// packages/core/src/browser/__tests__/helpers.ts
import { resolveChrome, type ResolvedChrome } from '../resolve.js';

/** The pinned browser if this machine has one; integration tests skip otherwise. */
export function chromeForTests(): ResolvedChrome | null {
  try {
    return resolveChrome();
  } catch {
    return null;
  }
}
```

```ts
// packages/core/src/browser/launch.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { spawn as realSpawn } from 'node:child_process';
import { launchChrome } from './launch.js';
import { TargetClosedError } from './cdp.js';
import { chromeForTests } from './__tests__/helpers.js';

const chrome = chromeForTests();

describe.skipIf(!chrome)('launchChrome', () => {
  it('launches over the pipe, answers getVersion, and cleans its profile up', async () => {
    const b = await launchChrome({ executablePath: chrome!.path });
    try {
      const v = await b.connection.send<{ product: string }>('Browser.getVersion');
      expect(v.product).toMatch(/^HeadlessChrome\//);
      expect(existsSync(b.userDataDir)).toBe(true);
    } finally {
      await b.close();
    }
    expect(existsSync(b.userDataDir)).toBe(false);
    expect(b.connection.closed).toBe(true);
  });
  it('killing the process rejects in-flight sends and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const b = await launchChrome({ executablePath: chrome!.path });
      const pending = b.connection.send('Target.createBrowserContext');
      process.kill(b.pid, 'SIGKILL');
      await expect(pending).rejects.toBeInstanceOf(TargetClosedError);
      await b.close(); // idempotent after a crash
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
  it('a non-executable path rejects with the path, and removes the profile', async () => {
    await expect(launchChrome({ executablePath: '/nonexistent/chrome' })).rejects.toThrow(
      /\/nonexistent\/chrome/,
    );
  });
  it('a signal kills chrome and removes the profile', async () => {
    // Drive the module's SIGTERM handler through an injected spawn that
    // records the child, then simulate the signal without ending vitest:
    // launchChrome exposes `terminateAll()` for exactly this reason.
    const { terminateAll } = await import('./launch.js');
    const b = await launchChrome({ executablePath: chrome!.path, spawn: realSpawn });
    const pid = b.pid;
    terminateAll();
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow(); // gone
    expect(existsSync(b.userDataDir)).toBe(false);
  });
});
```

- [ ] **Step 6: Run** `pnpm vitest run packages/core/src/browser/launch.test.ts` → FAIL (module missing).

- [ ] **Step 7: Write `browser/launch.ts`**

```ts
// packages/core/src/browser/launch.ts
//
// Spawn Chrome with the pipe on fds 3/4, as Playwright does (coreBundle.js
// L39607). Measured 74–91 ms to Browser.getVersion on an M-series Mac, the
// same as Playwright's launch: the cost is Chrome's, not the driver's.
//
// `spawn` is injectable so the no-browser probe (scripts/check-diff.mjs) and
// tests can assert nothing is launched without patching node:child_process.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromeArgs } from '../capture/launch.js';
import { CdpConnection } from './cdp.js';
import { PipeTransport } from './transport.js';

export type SpawnFn = typeof nodeSpawn;

export interface LaunchedChrome {
  connection: CdpConnection;
  pid: number;
  userDataDir: string;
  close(): Promise<void>;
}

const GRACEFUL_CLOSE_MS = 2000;

/** Live launches, so a signal or exit can take every Chrome and profile with it. */
const live = new Set<{ proc: ChildProcess; userDataDir: string }>();
let handlersInstalled = false;

/** Kill every live Chrome and remove its profile, synchronously. Exported for tests. */
export function terminateAll(): void {
  for (const l of live) {
    if (l.proc.exitCode === null) {
      try {
        l.proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    rmSync(l.userDataDir, { recursive: true, force: true });
  }
  live.clear();
}

function installExitHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', terminateAll);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      terminateAll();
      // Re-raise so the exit status says "killed by signal", as it would have.
      process.kill(process.pid, sig);
    });
  }
}

export async function launchChrome(opts: {
  executablePath: string;
  args?: string[];
  headless?: boolean;
  spawn?: SpawnFn;
}): Promise<LaunchedChrome> {
  const spawn = opts.spawn ?? nodeSpawn;
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'jux-chrome-'));
  const args = chromeArgs({ userDataDir, args: opts.args, headless: opts.headless });
  const proc = spawn(opts.executablePath, args, {
    // stdin/stdout ignored, stderr kept for the "missing shared library"
    // message on Linux, 3 = Chrome reads, 4 = Chrome writes.
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const entry = { proc, userDataDir };
  live.add(entry);
  installExitHandlers();

  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    if (stderr.length < 8192) stderr += d.toString();
  });

  // One promise for "the process is gone", resolved never rejected, so an
  // exit after a successful launch is not an unhandled rejection.
  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    proc.once('error', (error) => resolve({ code: null, error }));
    proc.once('exit', (code) => resolve({ code }));
  });
  void exited.then(() => live.delete(entry));

  const transport = new PipeTransport(
    proc.stdio[3] as NodeJS.WritableStream,
    proc.stdio[4] as NodeJS.ReadableStream,
  );
  const connection = new CdpConnection(transport);
  void exited.then(() => transport.close());

  // Race the handshake against an early exit (bad binary, missing .so).
  const outcome = await Promise.race([
    connection.send('Browser.getVersion').then(() => 'ready' as const),
    exited.then((e) => e),
  ]);
  if (outcome !== 'ready') {
    live.delete(entry);
    await rm(userDataDir, { recursive: true, force: true });
    const why = outcome.error
      ? `${outcome.error.message} (${opts.executablePath})`
      : `the browser at ${opts.executablePath} exited with code ${outcome.code} before it was ready.${describeStderr(stderr)}`;
    throw new Error(`jux: could not launch the browser: ${why}`);
  }

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      if (!connection.closed) {
        connection.send('Browser.close').catch(() => {});
        await Promise.race([
          exited,
          new Promise((r) => setTimeout(r, GRACEFUL_CLOSE_MS).unref()),
        ]);
      }
      if (proc.exitCode === null) proc.kill('SIGKILL');
      connection.close();
      live.delete(entry);
      await rm(userDataDir, { recursive: true, force: true });
    })());

  return { connection, pid: proc.pid!, userDataDir, close };
}

/** Linux: `error while loading shared libraries: libnss3.so` → name the apt line. */
function describeStderr(stderr: string): string {
  const m = /error while loading shared libraries: ([^:]+):/.exec(stderr);
  if (m) {
    return ` Missing system library ${m[1]}. On Ubuntu 24.04: sudo apt-get install libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2`;
  }
  return stderr.trim() ? `\n${stderr.trim().split('\n').slice(-3).join('\n')}` : '';
}
```

Note `detached` is not set: Chrome stays in our process group so a terminal Ctrl-C reaches it even before our handler runs, and the handler then removes the profile.

- [ ] **Step 8: Run** `pnpm vitest run packages/core/src/browser/launch.test.ts` → PASS, 4 tests (all skipped on a machine with no browser; on this Mac the ms-playwright cache resolves). `pnpm build && pnpm typecheck` → green.

- [ ] **Step 9: Commit**

```bash
pnpm format && git add packages/core/src/capture/launch.ts packages/core/src/capture/launch.test.ts packages/core/src/browser/launch.ts packages/core/src/browser/launch.test.ts packages/core/src/browser/__tests__/helpers.ts
git commit -m "core: launch chrome-headless-shell over the pipe with Playwright-parity flags and exit cleanup"
```

### Task 6: Page, BrowserContext, Browser and selectors

**Files:**

- Create: `packages/core/src/browser/selectors.ts`
- Create: `packages/core/src/browser/page.ts`
- Create: `packages/core/src/browser/browser.ts`
- Create: `packages/core/src/browser/index.ts`
- Test: `packages/core/src/browser/selectors.test.ts`, `packages/core/src/browser/page.test.ts` (integration, skipped without a browser)

**Interfaces:**

- Consumes: `CdpConnection`, `CdpError`, `TargetClosedError`, `SendTimeoutError` (Task 4); `launchChrome`, `SpawnFn` (Task 5); `chromeForTests` (Task 5 helper); `Viewport` from `../types.js`.
- Produces:
  - `selectors.ts`: `isCssSelector(selector: string): boolean`, `assertCssSelector(selector: string): void` (throws `jux: selector '…' is not a CSS selector`), `QUERY_ALL_SOURCE: string` (source of an in-page `function (selector) { … return Element[] }` resolving in the document and every open shadow root, each root's light DOM before its shadow trees), `queryAllExpression(selector: string, body: string, ...args: unknown[]): string` (builds `(function (els, …) { body })(queryAll(selector), …)` — the one place mark/verify/unmark/mask code is assembled).
  - `page.ts`: `class TimeoutError extends Error`, `interface Page { goto(url: string, opts?: { waitUntil?: 'load'; timeout?: number }): Promise<void>; url(): string; evaluate<R, A = undefined>(fn: string | ((arg: A) => R | Promise<R>), arg?: A, opts?: { timeout?: number }): Promise<R>; waitForFunction<A = undefined>(fn: (arg: A) => unknown, arg?: A, opts?: { timeout?: number }): Promise<void>; waitForSelector(selector: string, opts?: { timeout?: number }): Promise<void>; addStyleTag(opts: { content: string }): Promise<void>; setViewportSize(viewport: Viewport): Promise<void>; screenshot(opts?: { mask?: string[] }): Promise<Buffer>; send<T = unknown>(method: string, params?: object): Promise<T>; onMainResponse(handler: (status: number) => void): () => void; clearOrigin(origin: string): Promise<void>; close(): Promise<void> }`, `class CdpPage implements Page` with `static async create(connection, targetId, sessionId, opts: { viewport: Viewport; blockServiceWorkers: boolean; os: NodeJS.Platform })`.
  - `browser.ts`: `interface ContextOptions { viewport: Viewport; blockServiceWorkers?: boolean }`, `class BrowserContext { readonly id: string; newPage(): Promise<Page>; clearCookies(): Promise<void>; close(): Promise<void> }`, `class Browser { static async launch(opts: { executablePath: string; args?: string[]; spawn?: SpawnFn }): Promise<Browser>; static fromConnection(connection: CdpConnection, opts: { version: string; close: () => Promise<void> }): Browser; version(): string; isConnected(): boolean; newContext(opts: ContextOptions): Promise<BrowserContext>; close(): Promise<void> }`.
  - `index.ts` re-exports all of the above plus Tasks 1–5.

- [ ] **Step 1: Write `selectors.test.ts`** (4 tests)

```ts
import { describe, it, expect } from 'vitest';
import {
  isCssSelector,
  assertCssSelector,
  QUERY_ALL_SOURCE,
  queryAllExpression,
} from './selectors.js';

describe('isCssSelector', () => {
  it('accepts CSS', () => {
    for (const s of [
      '[data-testid="clock"]',
      'div > span.x:nth-child(2)',
      '#id',
      'a:not(.b)',
      'x-foo::part(bar)',
    ]) {
      expect(isCssSelector(s), s).toBe(true);
    }
  });
  it('rejects Playwright-only syntax', () => {
    const bad = [
      'text=Clock',
      'div >> span',
      'css=div',
      'xpath=//a',
      'div:has-text("x")',
      'div:visible',
      'nth=1',
      'internal:role=button',
      'div:text("x")',
      'div:nth-match(x, 1)',
      ':light(.x)',
    ];
    for (const s of bad) expect(isCssSelector(s), s).toBe(false);
  });
  it('assertCssSelector names the selector', () => {
    expect(() => assertCssSelector('text=Clock')).toThrow(
      "jux: selector 'text=Clock' is not a CSS selector",
    );
  });
  it('queryAllExpression embeds the selector and the body with json-safe args', () => {
    const expr = queryAllExpression('.a"b', 'return els.length + attr.length;', 'data-x');
    expect(expr).toContain(QUERY_ALL_SOURCE);
    expect(expr).toContain(JSON.stringify('.a"b'));
    expect(expr).toContain('"data-x"');
    expect(expr).toMatch(
      /^\(function \(els, a0\) \{ return els\.length \+ attr\.length; \}\)/,
    );
  });
});
```

The last assertion pins the arg naming: `queryAllExpression(selector, body, ...args)` names the extra arguments `a0`, `a1`, … and the body refers to them by those names. Adjust the body in that test to `'return els.length + a0.length;'` and the regex to `\{ return els\.length \+ a0\.length; \}` — that is the form the implementation below produces.

- [ ] **Step 2: Write `selectors.ts`**

```ts
// packages/core/src/browser/selectors.ts
//
// Masks, structure.ts's mask marking and waitForSelector resolve selectors
// in the page. Playwright's locator engine also accepted `text=`, `>>`,
// `:has-text()` and friends; those are refused up front so a baseline is
// never captured unmasked because a selector silently matched nothing
// (spec §Decisions 5; a documented breaking change in the changeset).
//
// Open shadow roots are pierced: each root's own matches first, then its
// shadow trees. Mask boxes are all the same opaque colour, so their order
// cannot change a pixel; closed roots are invisible to Playwright too.

const PLAYWRIGHT_ONLY = [
  /^[a-zA-Z-]+=/, // text=, css=, xpath=, id=, nth=, internal:…= (engine prefix)
  /^internal:/,
  />>/,
  /:(has-text|text|text-is|text-matches|visible|nth-match|light|above|below|left-of|right-of|near)\(/,
  /:visible\b/,
];

export function isCssSelector(selector: string): boolean {
  return !PLAYWRIGHT_ONLY.some((re) => re.test(selector));
}

export function assertCssSelector(selector: string): void {
  if (!isCssSelector(selector)) {
    throw new Error(`jux: selector '${selector}' is not a CSS selector`);
  }
}

/** In-page: every match of `selector` in the document and its open shadow roots. */
export const QUERY_ALL_SOURCE = `function (selector) {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll(selector)) out.push(el);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.shadowRoot) walk(node.shadowRoot);
      node = walker.nextNode();
    }
  };
  walk(document);
  return out;
}`;

/**
 * `(function (els, a0, a1…) { body })((queryAll)(selector), arg0, arg1…)`
 * — one builder for every "do X to all matches" evaluate, so the selector
 * and arguments are JSON-escaped in exactly one place.
 */
export function queryAllExpression(
  selector: string,
  body: string,
  ...args: unknown[]
): string {
  const names = args.map((_, i) => `a${i}`);
  const params = ['els', ...names].join(', ');
  const values = [
    `(${QUERY_ALL_SOURCE})(${JSON.stringify(selector)})`,
    ...args.map((a) => JSON.stringify(a)),
  ].join(', ');
  return `(function (${params}) { ${body} })(${values})`;
}
```

Run `pnpm vitest run packages/core/src/browser/selectors.test.ts` → PASS, 4 tests.

- [ ] **Step 3: Write `page.test.ts`** (10 tests; serves pages from a local `http` server so `load` is real)

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import sharp from 'sharp';
import { Browser, type BrowserContext } from './browser.js';
import { TimeoutError, type Page } from './page.js';
import { SendTimeoutError } from './cdp.js';
import { chromeForTests } from './__tests__/helpers.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let browser: Browser;

const PAGES: Record<string, string> = {
  '/plain':
    '<!doctype html><body style="margin:0;background:#fff"><div id="box" style="width:100px;height:50px;background:#00f"></div><input id="i" autofocus></body>',
  '/late':
    '<!doctype html><body><script>setTimeout(()=>{const d=document.createElement("div");d.id="late";d.textContent="x";document.body.appendChild(d)},150)</script></body>',
  '/shadow':
    '<!doctype html><body><x-host></x-host><script>customElements.define("x-host",class extends HTMLElement{connectedCallback(){this.attachShadow({mode:"open"}).innerHTML=\'<div class="secret" style="width:20px;height:20px;background:#0f0"></div>\'}})</script></body>',
  '/iframe':
    '<!doctype html><body><iframe src="/slow-frame"></iframe><script>window.__mainLoaded=false;addEventListener("load",()=>{window.__mainLoaded=true})</script></body>',
  '/slow-frame': '<!doctype html><body>frame</body>',
  '/alert':
    '<!doctype html><body><script>alert("hi")</script><div id="after">after</div></body>',
  '/hang': '', // never answered
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/hang') return; // keep the request open forever
    if (req.url === '/slow-frame') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGES['/slow-frame']);
      }, 300);
      return;
    }
    const body = PAGES[req.url ?? ''];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (chrome) browser = await Browser.launch({ executablePath: chrome.path });
});
afterAll(async () => {
  await browser?.close();
  server.closeAllConnections();
  server.close();
});

async function withPage(
  fn: (page: Page, ctx: BrowserContext) => Promise<void>,
  opts: { blockServiceWorkers?: boolean } = {},
) {
  const ctx = await browser.newContext({
    viewport: { width: 300, height: 200 },
    ...opts,
  });
  try {
    await fn(await ctx.newPage(), ctx);
  } finally {
    await ctx.close();
  }
}

describe.skipIf(!chrome)('CdpPage', () => {
  it('goto waits for load, evaluate round-trips JSON, url() is the final url', () =>
    withPage(async (page) => {
      await page.goto(`${base}/plain`, { waitUntil: 'load' });
      expect(page.url()).toBe(`${base}/plain`);
      expect(
        await page.evaluate(() => ({
          w: window.innerWidth,
          h: window.innerHeight,
          ready: document.readyState,
        })),
      ).toEqual({ w: 300, h: 200, ready: 'complete' });
      expect(await page.evaluate((a: { n: number }) => a.n * 2, { n: 21 })).toBe(42);
      expect(await page.evaluate('1 + 1')).toBe(2);
    }));
  it('evaluate rejects with the page error message', () =>
    withPage(async (page) => {
      await page.goto(`${base}/plain`);
      await expect(
        page.evaluate(() => {
          throw new Error('boom');
        }),
      ).rejects.toThrow(/boom/);
    }));
  it('evaluate rejects at its node-side timeout', () =>
    withPage(async (page) => {
      await page.goto(`${base}/plain`);
      await expect(
        page.evaluate('new Promise(() => {})', undefined, { timeout: 100 }),
      ).rejects.toBeInstanceOf(SendTimeoutError);
    }));
  it('an alert is dismissed and evaluate returns', () =>
    withPage(async (page) => {
      await page.goto(`${base}/alert`);
      expect(
        await page.evaluate(() => document.getElementById('after')?.textContent),
      ).toBe('after');
      expect(await page.evaluate(() => confirm('x'))).toBe(false);
    }));
  it('goto waits for the main frame load, not a child frame', () =>
    withPage(async (page) => {
      await page.goto(`${base}/iframe`);
      expect(
        await page.evaluate(
          () => (window as unknown as { __mainLoaded: boolean }).__mainLoaded,
        ),
      ).toBe(true);
    }));
  it('waitForFunction polls on rAF and waitForSelector sees late elements; both time out with TimeoutError', () =>
    withPage(async (page) => {
      await page.goto(`${base}/late`);
      await page.waitForSelector('#late', { timeout: 2000 });
      await page.waitForFunction((id: string) => !!document.getElementById(id), 'late', {
        timeout: 500,
      });
      await expect(
        page.waitForSelector('#never', { timeout: 100 }),
      ).rejects.toBeInstanceOf(TimeoutError);
      await expect(
        page.waitForFunction(() => false, undefined, { timeout: 100 }),
      ).rejects.toBeInstanceOf(TimeoutError);
      expect(() => page.waitForSelector('text=x')).toThrow(/not a CSS selector/);
    }));
  it('goto rejects on timeout with the url', () =>
    withPage(async (page) => {
      await expect(page.goto(`${base}/hang`, { timeout: 300 })).rejects.toThrow(
        new RegExp(`${base}/hang`),
      );
    }));
  it('setViewportSize changes innerWidth and screenshot is a PNG of the viewport', () =>
    withPage(async (page) => {
      await page.goto(`${base}/plain`);
      await page.setViewportSize({ width: 480, height: 400 });
      expect(await page.evaluate(() => window.innerWidth)).toBe(480);
      const meta = await sharp(await page.screenshot()).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['png', 480, 400]);
    }));
  it('a mask paints #F0F over the element, pierces open shadow roots, and leaves no trace', () =>
    withPage(async (page) => {
      await page.goto(`${base}/shadow`);
      const png = await page.screenshot({ mask: ['.secret'] });
      const { data } = await sharp(png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const px = (x: number, y: number) =>
        Array.from(data.subarray((y * 300 + x) * 4, (y * 300 + x) * 4 + 3));
      expect(px(10, 10)).toEqual([255, 0, 255]);
      expect(await page.evaluate(() => document.querySelector('x-pw-glass'))).toBeNull();
      await expect(page.screenshot({ mask: ['text=secret'] })).rejects.toThrow(
        /not a CSS selector/,
      );
    }));
  it('clearOrigin wipes localStorage; a blocked service worker never registers; onMainResponse sees the status', () =>
    withPage(
      async (page) => {
        const statuses: number[] = [];
        const off = page.onMainResponse((s) => statuses.push(s));
        await page.goto(`${base}/plain`);
        await page.evaluate(() => localStorage.setItem('k', 'v'));
        await page.clearOrigin(base);
        await page.goto(`${base}/plain`);
        expect(await page.evaluate(() => localStorage.getItem('k'))).toBeNull();
        expect(
          await page.evaluate(() => navigator.serviceWorker.register.toString()),
        ).toMatch(/blocked/);
        off();
        await page.goto(`${base}/nope`).catch(() => {});
        expect(statuses).toEqual([200, 200]);
      },
      { blockServiceWorkers: true },
    ));
});

describe.skipIf(!chrome)('Browser', () => {
  it('version() strips the product prefix so manifests stay comparable', () => {
    expect(browser.version()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 4: Run** `pnpm vitest run packages/core/src/browser/page.test.ts` → FAIL (modules missing).

- [ ] **Step 5: Write `page.ts`**

```ts
// packages/core/src/browser/page.ts
//
// One target, one flattened session. The init sequence is exactly what the
// byte-identity spike sent (spec §Decisions 3) — no more: Target.setAutoAttach
// without its handler pauses every worker and cross-origin iframe forever,
// and the geolocation/file-chooser overrides are things Playwright only
// sends when asked. The screenshot is a verbatim port of
// Screenshotter.screenshotPage (coreBundle.js L21258–21370).

import type { Viewport } from '../types.js';
import { CdpConnection, CdpError, TargetClosedError } from './cdp.js';
import { assertCssSelector, queryAllExpression } from './selectors.js';

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface Page {
  goto(url: string, opts?: { waitUntil?: 'load'; timeout?: number }): Promise<void>;
  url(): string;
  evaluate<R, A = undefined>(
    fn: string | ((arg: A) => R | Promise<R>),
    arg?: A,
    opts?: { timeout?: number },
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
  /** Raw CDP on this page's session, for DOMSnapshot. */
  send<T = unknown>(method: string, params?: object): Promise<T>;
  /** HTTP status of each main-document response; returns the unsubscribe. */
  onMainResponse(handler: (status: number) => void): () => void;
  /** Storage.clearDataForOrigin on this page's session: localStorage, IndexedDB, Cache Storage, service workers. */
  clearOrigin(origin: string): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Page.setFontFamilies tables, playwright-core 1.62.0 `platformToFontFamilies`
// (coreBundle.js L36529+), copied verbatim: linux has no forScripts; mac has
// jpan/hang/hans/hant; win has seven. Generic families resolve through these
// in headless mode; without them a story that says `font-family: sans-serif`
// renders with Chromium's built-in defaults and the bytes differ from every
// existing baseline.
const FONT_FAMILIES: Record<'linux' | 'mac' | 'win', object> = {
  linux: {
    fontFamilies: {
      standard: 'Times New Roman',
      fixed: 'Monospace',
      serif: 'Times New Roman',
      sansSerif: 'Arial',
      cursive: 'Comic Sans MS',
      fantasy: 'Impact',
    },
  },
  mac: {
    fontFamilies: {
      standard: 'Times',
      fixed: 'Courier',
      serif: 'Times',
      sansSerif: 'Helvetica',
      cursive: 'Apple Chancery',
      fantasy: 'Papyrus',
    },
    forScripts: [
      {
        script: 'jpan',
        fontFamilies: {
          standard: 'Hiragino Kaku Gothic ProN',
          fixed: 'Osaka-Mono',
          serif: 'Hiragino Mincho ProN',
          sansSerif: 'Hiragino Kaku Gothic ProN',
        },
      },
      {
        script: 'hang',
        fontFamilies: {
          standard: 'Apple SD Gothic Neo',
          serif: 'AppleMyungjo',
          sansSerif: 'Apple SD Gothic Neo',
        },
      },
      {
        script: 'hans',
        fontFamilies: {
          standard: ',PingFang SC,STHeiti',
          serif: 'Songti SC',
          sansSerif: ',PingFang SC,STHeiti',
          cursive: 'Kaiti SC',
        },
      },
      {
        script: 'hant',
        fontFamilies: {
          standard: ',PingFang TC,Heiti TC',
          serif: 'Songti TC',
          sansSerif: ',PingFang TC,Heiti TC',
          cursive: 'Kaiti TC',
        },
      },
    ],
  },
  win: {
    fontFamilies: {
      standard: 'Times New Roman',
      fixed: 'Consolas',
      serif: 'Times New Roman',
      sansSerif: 'Arial',
      cursive: 'Comic Sans MS',
      fantasy: 'Impact',
    },
    forScripts: [
      {
        script: 'cyrl',
        fontFamilies: {
          standard: 'Times New Roman',
          fixed: 'Courier New',
          serif: 'Times New Roman',
          sansSerif: 'Arial',
        },
      },
      { script: 'arab', fontFamilies: { fixed: 'Courier New', sansSerif: 'Segoe UI' } },
      {
        script: 'grek',
        fontFamilies: {
          standard: 'Times New Roman',
          fixed: 'Courier New',
          serif: 'Times New Roman',
          sansSerif: 'Arial',
        },
      },
      {
        script: 'jpan',
        fontFamilies: {
          standard: ',Meiryo,Yu Gothic',
          fixed: 'MS Gothic',
          serif: ',Yu Mincho,MS PMincho',
          sansSerif: ',Meiryo,Yu Gothic',
        },
      },
      {
        script: 'hang',
        fontFamilies: {
          standard: 'Malgun Gothic',
          fixed: 'Gulimche',
          serif: 'Batang',
          sansSerif: 'Malgun Gothic',
          cursive: 'Gungsuh',
        },
      },
      {
        script: 'hans',
        fontFamilies: {
          standard: 'Microsoft YaHei',
          fixed: 'NSimsun',
          serif: 'Simsun',
          sansSerif: 'Microsoft YaHei',
          cursive: 'KaiTi',
        },
      },
      {
        script: 'hant',
        fontFamilies: {
          standard: 'Microsoft JhengHei',
          fixed: 'MingLiU',
          serif: 'PMingLiU',
          sansSerif: 'Microsoft JhengHei',
          cursive: 'DFKai-SB',
        },
      },
    ],
  },
};

// coreBundle.js L51296, verbatim (serviceWorkers: 'block').
const BLOCK_SERVICE_WORKERS_SCRIPT = `
if (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by Playwright'); };
`;

const metricsOverride = (v: Viewport) => ({
  mobile: false,
  width: v.width,
  height: v.height,
  screenWidth: v.width,
  screenHeight: v.height,
  deviceScaleFactor: 1,
  screenOrientation: { angle: 0, type: 'landscapePrimary' },
});

const EMULATED_MEDIA = {
  media: '',
  features: [
    { name: 'prefers-color-scheme', value: 'light' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
    { name: 'forced-colors', value: 'none' },
    { name: 'prefers-contrast', value: 'no-preference' },
  ],
};

// Screenshotter._preparePageForScreenshot with caret:'hide', animations:'allow'.
const PREPARE_SCREENSHOT = `(function (hideCaret) {
  const collectRoots = (root, roots = []) => {
    roots.push(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    do {
      const node = walker.currentNode;
      const shadowRoot = node instanceof Element ? node.shadowRoot : null;
      if (shadowRoot) collectRoots(shadowRoot, roots);
    } while (walker.nextNode());
    return roots;
  };
  const roots = collectRoots(document);
  const cleanupCallbacks = [];
  if (hideCaret) {
    const elements = new Map();
    for (const root of roots) {
      root.querySelectorAll('input,textarea,[contenteditable]').forEach((element) => {
        elements.set(element, { value: element.style.getPropertyValue('caret-color'), priority: element.style.getPropertyPriority('caret-color') });
        element.style.setProperty('caret-color', 'transparent', 'important');
      });
    }
    cleanupCallbacks.push(() => { for (const [element, value] of elements) element.style.setProperty('caret-color', value.value, value.priority); });
  }
  window.__juxCleanupScreenshot = () => { for (const cb of cleanupCallbacks) cb(); delete window.__juxCleanupScreenshot; };
})(true)`;

// Playwright's mask overlay: injected highlight.css + Highlight.updateHighlight.
const HIGHLIGHT_CSS =
  ':host{font-size:13px;font-family:system-ui,Ubuntu,Droid Sans,sans-serif;color:#333;color-scheme:light}svg{position:absolute;height:0}x-pw-highlight{position:absolute;top:0;left:0;width:0;height:0}';
const MASK_BODY = `
  const glass = document.createElement('x-pw-glass');
  glass.setAttribute('popover', 'manual');
  const s = glass.style;
  s.inset = '0'; s.width = '100%'; s.height = '100%'; s.maxWidth = 'none'; s.maxHeight = 'none';
  s.padding = '0'; s.margin = '0'; s.border = 'none'; s.overflow = 'visible';
  s.pointerEvents = 'none'; s.display = 'flex'; s.backgroundColor = 'transparent';
  const shadow = glass.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(HIGHLIGHT_CSS)};
  shadow.appendChild(style);
  document.documentElement.appendChild(glass);
  glass.showPopover();
  const entries = els.map((el) => { const h = document.createElement('x-pw-highlight'); shadow.appendChild(h); return { el, h }; });
  for (const { el, h } of entries) {
    const box = el.getBoundingClientRect();
    h.style.backgroundColor = a0;
    h.style.left = box.x + 'px'; h.style.top = box.y + 'px';
    h.style.width = box.width + 'px'; h.style.height = box.height + 'px';
    h.style.display = 'block';
  }
  window.__juxUnmask = () => { glass.remove(); delete window.__juxUnmask; };
  return entries.length;`;

function serialize(arg: unknown): string {
  return arg === undefined ? 'undefined' : JSON.stringify(arg);
}

export class CdpPage implements Page {
  private currentUrl = 'about:blank';
  private viewport: Viewport;
  private closed = false;
  private crashed = false;

  private constructor(
    private readonly connection: CdpConnection,
    readonly targetId: string,
    readonly sessionId: string,
    viewport: Viewport,
  ) {
    this.viewport = viewport;
    connection.on(
      'Page.frameNavigated',
      (p) => {
        const f = (p as { frame: { url: string; parentId?: string } }).frame;
        if (!f.parentId) this.currentUrl = f.url;
      },
      sessionId,
    );
    // Playwright dismisses dialogs nobody listens for; a story that calls
    // alert() would otherwise block every later evaluate on this page.
    connection.on(
      'Page.javascriptDialogOpening',
      () => {
        void this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
      },
      sessionId,
    );
    connection.on(
      'Inspector.targetCrashed',
      () => {
        this.crashed = true;
      },
      sessionId,
    );
  }

  /** The spike's init list (spec §Decisions 3), plus Log.enable which Playwright also sends. */
  static async create(
    connection: CdpConnection,
    targetId: string,
    sessionId: string,
    opts: { viewport: Viewport; blockServiceWorkers: boolean; os: NodeJS.Platform },
  ): Promise<CdpPage> {
    const page = new CdpPage(connection, targetId, sessionId, opts.viewport);
    const fonts =
      FONT_FAMILIES[opts.os === 'darwin' ? 'mac' : opts.os === 'win32' ? 'win' : 'linux'];
    await Promise.all([
      page.send('Page.enable'),
      page.send('Page.setLifecycleEventsEnabled', { enabled: true }),
      page.send('Runtime.enable'),
      page.send('Network.enable'),
      page.send('Log.enable'),
      page.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      page.send('Emulation.setDeviceMetricsOverride', metricsOverride(opts.viewport)),
      page.send('Page.setFontFamilies', fonts),
      page.send('Emulation.setEmulatedMedia', EMULATED_MEDIA),
      ...(opts.blockServiceWorkers
        ? [
            page.send('Page.addScriptToEvaluateOnNewDocument', {
              source: BLOCK_SERVICE_WORKERS_SCRIPT,
              runImmediately: true,
            }),
          ]
        : []),
    ]);
    return page;
  }

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (this.crashed) return Promise.reject(new TargetClosedError('renderer crashed'));
    return this.connection.send<T>(method, params, this.sessionId);
  }

  url(): string {
    return this.currentUrl;
  }

  onMainResponse(handler: (status: number) => void): () => void {
    return this.connection.on(
      'Network.responseReceived',
      (p) => {
        const r = p as { type: string; frameId?: string; response: { status: number } };
        // The top frame's id is the target id in Chromium (verified 2026-10-13).
        if (r.type === 'Document' && r.frameId === this.targetId)
          handler(r.response.status);
      },
      this.sessionId,
    );
  }

  /**
   * Page.navigate, then the main frame's `load`. The timeout covers the
   * whole thing: Chrome answers Page.navigate only at commit or failure, so
   * a server that never responds never replies, and a child frame's own
   * `load` must not count (a same-process iframe fires one for itself).
   */
  async goto(
    url: string,
    opts: { waitUntil?: 'load'; timeout?: number } = {},
  ): Promise<void> {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    const loaded = this.connection.once<{ name: string; frameId: string }>(
      'Page.lifecycleEvent',
      this.sessionId,
      (p) => p.name === 'load' && p.frameId === this.targetId,
    );
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new TimeoutError(
              `jux: navigation to ${url} did not fire load within ${timeout} ms`,
            ),
          ),
        timeout,
      );
    });
    try {
      await Promise.race([
        (async () => {
          const res = await this.send<{ errorText?: string }>('Page.navigate', { url });
          if (res.errorText)
            throw new Error(`jux: navigation to ${url} failed: ${res.errorText}`);
          await loaded;
        })(),
        expired,
      ]);
    } finally {
      clearTimeout(timer);
      loaded.catch(() => {}); // a rejected once() after a timeout is not an unhandled rejection
    }
    const { frameTree } = await this.send<{ frameTree: { frame: { url: string } } }>(
      'Page.getFrameTree',
    );
    this.currentUrl = frameTree.frame.url;
  }

  async evaluate<R, A = undefined>(
    fn: string | ((arg: A) => R | Promise<R>),
    arg?: A,
    opts: { timeout?: number } = {},
  ): Promise<R> {
    const expression =
      typeof fn === 'string' ? fn : `(${fn.toString()})(${serialize(arg)})`;
    if (this.crashed) throw new TargetClosedError('renderer crashed');
    const r = await this.connection.send<{
      result: { value?: R };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
      { timeout: opts.timeout },
    );
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
      );
    }
    return r.result.value as R;
  }

  /** Playwright polls on requestAnimationFrame by default (polling: 'raf'). */
  waitForFunction<A = undefined>(
    fn: (arg: A) => unknown,
    arg?: A,
    opts: { timeout?: number } = {},
  ): Promise<void> {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    return this.evaluate<string>(
      `new Promise((resolve) => {
        const predicate = ${fn.toString()};
        const arg = ${serialize(arg)};
        const start = performance.now();
        const tick = () => {
          let value;
          try { value = predicate(arg); } catch (e) { return resolve('error:' + (e && e.message)); }
          if (value) return resolve('ok');
          if (performance.now() - start > ${timeout}) return resolve('timeout');
          requestAnimationFrame(tick);
        };
        tick();
      })`,
      undefined,
      // The in-page cap fires first; the node-side cap only matters if the page is wedged.
      { timeout: timeout + 1000 },
    ).then((outcome) => {
      if (outcome === 'timeout')
        throw new TimeoutError(`jux: waitForFunction timed out after ${timeout} ms`);
      if (outcome.startsWith('error:')) throw new Error(outcome.slice(6));
    });
  }

  waitForSelector(selector: string, opts: { timeout?: number } = {}): Promise<void> {
    assertCssSelector(selector); // throws synchronously: a non-CSS selector is a config error, not a slow page
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    return this.waitForFunction(
      (s: string) => {
        const el = document.querySelector(s) as HTMLElement | null;
        if (!el) return false;
        // Playwright's default state is 'visible': a non-empty box and not visibility:hidden.
        const r = el.getBoundingClientRect();
        return (
          r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
        );
      },
      selector,
      { timeout },
    ).catch((e) => {
      if (e instanceof TimeoutError)
        throw new TimeoutError(
          `jux: selector '${selector}' did not appear within ${timeout} ms`,
        );
      throw e;
    });
  }

  /** Frame._addStyleTag → addStyleContent, verbatim. */
  async addStyleTag(opts: { content: string }): Promise<void> {
    await this.evaluate((content: string) => {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.appendChild(document.createTextNode(content));
      document.head.appendChild(style);
      return true;
    }, opts.content);
  }

  async setViewportSize(viewport: Viewport): Promise<void> {
    if (
      viewport.width === this.viewport.width &&
      viewport.height === this.viewport.height
    )
      return;
    await this.send('Emulation.setDeviceMetricsOverride', metricsOverride(viewport));
    this.viewport = viewport;
  }

  /** Screenshotter.screenshotPage: prepare → fonts.ready → mask → getLayoutMetrics → captureScreenshot → cleanup. */
  async screenshot(opts: { mask?: string[] } = {}): Promise<Buffer> {
    const mask = opts.mask ?? [];
    for (const sel of mask) assertCssSelector(sel);
    await this.evaluate(PREPARE_SCREENSHOT);
    try {
      await this.evaluate('document.fonts.ready').catch(() => {});
      if (mask.length) {
        // One glass pane for all selectors: Playwright adds every selector's
        // matches to the same highlight list before painting.
        await this.evaluate(queryAllExpression(mask.join(', '), MASK_BODY, '#F0F'));
      }
      try {
        const { visualViewport } = await this.send<{
          visualViewport: { pageX: number; pageY: number; scale: number };
        }>('Page.getLayoutMetrics');
        const clip = {
          x: visualViewport.pageX,
          y: visualViewport.pageY,
          width: Math.ceil(this.viewport.width / visualViewport.scale),
          height: Math.ceil(this.viewport.height / visualViewport.scale),
          scale: visualViewport.scale,
        };
        const { data } = await this.send<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
          clip,
          captureBeyondViewport: false,
        });
        return Buffer.from(data, 'base64');
      } finally {
        if (mask.length)
          await this.evaluate('window.__juxUnmask && window.__juxUnmask()').catch(
            () => {},
          );
      }
    } finally {
      await this.evaluate(
        'window.__juxCleanupScreenshot && window.__juxCleanupScreenshot()',
      ).catch(() => {});
    }
  }

  async clearOrigin(origin: string): Promise<void> {
    await this.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connection
      .send('Target.closeTarget', { targetId: this.targetId })
      .catch((e) => {
        if (!(e instanceof CdpError)) throw e;
      });
  }
}
```

A note on the mask join: `mask.join(', ')` is a CSS selector list, so one `queryAll` resolves every selector; each selector was validated individually first. The spike used the same per-selector loop as Playwright and matched; a selector list yields the same element set, and overlay order cannot change pixels (one colour, opaque).

- [ ] **Step 6: Write `browser.ts`**

```ts
// packages/core/src/browser/browser.ts
//
// Browser = one CDP connection (pipe now, daemon socket in PR 2).
// BrowserContext = Target.createBrowserContext, one per pool worker, so
// concurrently rendering stories never share storage or service workers
// (pool.ts measured isolation at ~0% cost).

import type { Viewport } from '../types.js';
import { CdpConnection } from './cdp.js';
import { launchChrome, type SpawnFn } from './launch.js';
import { CdpPage, type Page } from './page.js';

export interface ContextOptions {
  viewport: Viewport;
  /** `serviceWorkers: 'block'` in Playwright terms: an init script that stubs registration. */
  blockServiceWorkers?: boolean;
}

export class BrowserContext {
  private closed = false;

  constructor(
    private readonly connection: CdpConnection,
    readonly id: string,
    private readonly opts: ContextOptions,
    private readonly os: NodeJS.Platform,
  ) {}

  async newPage(): Promise<Page> {
    const { targetId } = await this.connection.send<{ targetId: string }>(
      'Target.createTarget',
      {
        url: 'about:blank',
        browserContextId: this.id,
      },
    );
    const { sessionId } = await this.connection.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId, flatten: true },
    );
    return CdpPage.create(this.connection, targetId, sessionId, {
      viewport: this.opts.viewport,
      blockServiceWorkers: this.opts.blockServiceWorkers === true,
      os: this.os,
    });
  }

  /** Storage.clearCookies, as Playwright's clearCookies (coreBundle.js L38394). */
  async clearCookies(): Promise<void> {
    await this.connection.send('Storage.clearCookies', { browserContextId: this.id });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connection
      .send('Target.disposeBrowserContext', { browserContextId: this.id })
      .catch(() => {});
  }
}

export class Browser {
  private constructor(
    private readonly connection: CdpConnection,
    private readonly productVersion: string,
    private readonly closeFn: () => Promise<void>,
    private readonly os: NodeJS.Platform,
  ) {}

  static async launch(opts: {
    executablePath: string;
    args?: string[];
    spawn?: SpawnFn;
  }): Promise<Browser> {
    const launched = await launchChrome(opts);
    const { product } = await launched.connection.send<{ product: string }>(
      'Browser.getVersion',
    );
    return new Browser(
      launched.connection,
      stripProduct(product),
      launched.close,
      process.platform,
    );
  }

  /** PR 2: a connection owned by someone else (the daemon). */
  static fromConnection(
    connection: CdpConnection,
    opts: { version: string; close: () => Promise<void> },
  ): Browser {
    return new Browser(
      connection,
      stripProduct(opts.version),
      opts.close,
      process.platform,
    );
  }

  /** `151.0.7922.34` — the string Playwright's `browser.version()` returned, so CaptureEnv compares equal. */
  version(): string {
    return this.productVersion;
  }

  isConnected(): boolean {
    return !this.connection.closed;
  }

  async newContext(opts: ContextOptions): Promise<BrowserContext> {
    const { browserContextId } = await this.connection.send<{ browserContextId: string }>(
      'Target.createBrowserContext',
      {
        disposeOnDetach: true,
      },
    );
    return new BrowserContext(this.connection, browserContextId, opts, this.os);
  }

  async close(): Promise<void> {
    await this.closeFn();
  }
}

function stripProduct(product: string): string {
  return product.replace(/^[A-Za-z]+\//, '');
}
```

- [ ] **Step 7: Write `browser/index.ts`**

```ts
export { Browser, BrowserContext, type ContextOptions } from './browser.js';
export { CdpPage, TimeoutError, type Page } from './page.js';
export {
  CdpConnection,
  CdpError,
  SendTimeoutError,
  TargetClosedError,
  SEND_TIMEOUT_MS,
  type RawMessage,
} from './cdp.js';
export {
  PipeTransport,
  SocketTransport,
  FramedTransport,
  NullFramer,
  type Transport,
} from './transport.js';
export {
  launchChrome,
  terminateAll,
  type LaunchedChrome,
  type SpawnFn,
} from './launch.js';
export {
  resolveChrome,
  juxCacheDir,
  chromeInstallDir,
  chromeBinaryPath,
  msPlaywrightBinaryPath,
  noBrowserMessage,
  NO_BROWSER_MESSAGE,
  INSTALL_MARKER,
  type ResolvedChrome,
  type ResolveOptions,
  type ChromeSource,
} from './resolve.js';
export {
  installChrome,
  proxyHint,
  type InstallOptions,
  type InstallResult,
} from './install.js';
export {
  CHROME_VERSION,
  CHROME_PINS,
  MS_PLAYWRIGHT_REVISION,
  chromePlatform,
  type ChromePlatform,
  type ChromePin,
} from './pins.js';
export {
  isCssSelector,
  assertCssSelector,
  QUERY_ALL_SOURCE,
  queryAllExpression,
} from './selectors.js';
```

- [ ] **Step 8: Run** `pnpm vitest run packages/core/src/browser && pnpm build && pnpm typecheck` → PASS: page 10 + browser 1, selectors 4, plus the earlier 31 (resolve 10, zip 4, install 4, cdp 9, launch 4) = 50 in `src/browser`; build and typecheck green.

- [ ] **Step 9: Commit**

```bash
pnpm format && git add packages/core/src/browser
git commit -m "core: Page, BrowserContext and Browser over CDP with the spike's init and a verbatim screenshot"
```

### Task 7: Port core's capture pipeline, the seam, and every launch site

**Files:**

- Create: `packages/core/src/browser/acquire.ts` (`acquireBrowser` — the one launch policy)
- Modify: `packages/core/src/platform.ts:5`, `packages/core/src/url-platform.ts:10`, `packages/core/src/platforms/urls.ts:12` (`import type { Page } from './browser/page.js'` / `'../browser/page.js'`)
- Modify: `packages/core/src/capture/capture.ts:6,151-153,159-161,180-184` (import; mask guard before `showStory`; `page.screenshot({ mask })`; `setTimeout` delay)
- Modify: `packages/core/src/capture/settle.ts:10,138-144` (import; `waitForSelector` validates the selector synchronously, then swallows the timeout)
- Modify: `packages/core/src/capture/structure.ts:14,496-571` (import; mark/verify/unmark via `queryAllExpression`; `page.send('DOMSnapshot.captureSnapshot', …)`)
- Modify: `packages/core/src/capture/pool.ts:5,78-82` (`import type { Browser } from '../browser/browser.js'`; `newContext({ viewport })`)
- Modify: `packages/core/src/capture/snap.ts:8,15-32,55-104,121-146` (`browser: Browser` injected; `status` via `page.onMainResponse`; `resetBetweenPages` via `context.clearCookies()` + `page.clearOrigin(origin)`)
- Modify: `packages/core/src/capture/env.ts:13`, `packages/core/src/run/run.ts:8` (Browser type import)
- Modify: `packages/core/src/index.ts` (export `Page`, `Browser`, `BrowserContext`, `TimeoutError`, `acquireBrowser`, `resolveChrome`, `installChrome`, `juxCacheDir`, `noBrowserMessage`, `NO_BROWSER_MESSAGE`, `CHROME_VERSION`, `chromeArgs`, `PARITY_CHROMIUM_ARGS`, `assertCssSelector`)
- Modify: `packages/core/package.json` (remove `peerDependencies`/`peerDependenciesMeta`; keywords `playwright` → `cdp`; add `"engines": { "node": ">=22.2.0" }`)
- Modify (minimal launch-site port, so build and typecheck stay green): `packages/cli/src/commands/run.ts:5,110-112,162`, `packages/cli/src/commands/init.ts:13,79,187`, `packages/cli/src/commands/snap.ts:132-140,310-313`, `packages/server/src/source.ts:6,318-320` — each replaces `chromium.launch(deterministicLaunchOptions())` with `acquireBrowser()` and `snapPages({ …, browser })`. `jux browser`, `--chrome` and the docs are Task 9.
- Modify tests: `packages/core/src/capture/env.test.ts:1`, `packages/core/src/platforms/urls.test.ts:1`, `packages/core/src/run/run-structural.test.ts:5` (type imports only — their fakes satisfy the narrower interface; verify by running them), `packages/core/src/capture/structure-capture.test.ts` (fake rewritten: `evaluate` + `send` instead of `locator` + `newCDPSession`)
- Test: `packages/core/src/capture/capture.test.ts` (new)
- Create: `scripts/check-parity.mjs`

**Interfaces:**

- Consumes: `Browser`, `BrowserContext`, `Page`, `TimeoutError`, `assertCssSelector`, `queryAllExpression`, `resolveChrome`, `noBrowserMessage`, `SpawnFn` (Tasks 1–6).
- Produces: `acquireBrowser(opts?: { chrome?: string; env?: NodeJS.ProcessEnv; spawn?: SpawnFn; noDaemon?: boolean }): Promise<Browser>` (PR 1: resolve → `Browser.launch`; throws `Error(noBrowserMessage())` when nothing resolves; PR 2 adds the daemon here and nowhere else); `SnapPagesOptions.browser: Browser` and `SnapOptions.browser: Browser` (callers acquire; `snapPages` does not close it); `PoolOptions.browser: Browser`; `RunOptions.browser: Browser`; `captureEnv(browser: Browser)`.

- [ ] **Step 1: Write `acquire.ts`**

```ts
// packages/core/src/browser/acquire.ts
//
// The one place that decides where a Browser comes from. Every command and
// the review server call this; PR 2 adds the warm daemon here and nowhere
// else, so no caller changes when the policy does.

import { Browser } from './browser.js';
import type { SpawnFn } from './launch.js';
import { noBrowserMessage, resolveChrome } from './resolve.js';

export interface AcquireOptions {
  /** `--chrome <path>`; wins over JUX_CHROME and the caches. */
  chrome?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  /** PR 2: `--no-daemon`. Accepted now so callers need no change later. */
  noDaemon?: boolean;
}

export async function acquireBrowser(opts: AcquireOptions = {}): Promise<Browser> {
  const env = opts.env ?? process.env;
  const resolved = resolveChrome({ flag: opts.chrome, env });
  if (!resolved) throw new Error(noBrowserMessage());
  return Browser.launch({ executablePath: resolved.path, spawn: opts.spawn });
}
```

- [ ] **Step 2: Write `capture.test.ts`** (2 tests). The fake records calls and never throws itself; the assertion is that core's own guard fires before the page is touched.

```ts
// packages/core/src/capture/capture.test.ts
import { describe, it, expect } from 'vitest';
import { captureStory } from './capture.js';
import type { Page } from '../browser/page.js';
import type { Platform } from '../platform.js';
import type { StoryManifest } from '../types.js';

function recordingPage(): Page & { calls: string[] } {
  const calls: string[] = [];
  const rec =
    <T>(name: string, value: T) =>
    async () => {
      calls.push(name);
      return value;
    };
  return {
    calls,
    goto: rec('goto', undefined),
    url: () => 'about:blank',
    evaluate: rec('evaluate', undefined as never),
    waitForFunction: rec('waitForFunction', undefined),
    waitForSelector: rec('waitForSelector', undefined),
    addStyleTag: rec('addStyleTag', undefined),
    setViewportSize: rec('setViewportSize', undefined),
    screenshot: rec('screenshot', Buffer.alloc(0)),
    send: rec('send', {} as never),
    onMainResponse: () => () => {},
    clearOrigin: rec('clearOrigin', undefined),
    close: rec('close', undefined),
  };
}
const platform: Platform = {
  name: 'fake',
  detect: async () => true,
  enumerate: async () => [],
  showStory: async (page) => {
    await page.goto('x');
  },
  previewUrl: () => '',
  settle: async () => {},
  configDirs: [],
  storyFileGlobs: [],
};
const story = (params: StoryManifest['params']): StoryManifest => ({
  storyId: 's',
  title: 's',
  name: 's',
  componentPath: '',
  params,
});

describe('captureStory', () => {
  it('a non-CSS mask fails the story before the page is touched', async () => {
    const page = recordingPage();
    await expect(
      captureStory(
        page,
        story({ mask: ['text=x'] }),
        { platform, baseUrl: 'x', structure: false },
        { width: 10, height: 10 },
      ),
    ).rejects.toThrow("jux: selector 'text=x' is not a CSS selector");
    expect(page.calls).toEqual([]);
  });
  it('a non-CSS waitForSelector fails the story the same way', async () => {
    const page = recordingPage();
    await expect(
      captureStory(
        page,
        story({ waitForSelector: 'div >> span' }),
        { platform, baseUrl: 'x', structure: false },
        { width: 10, height: 10 },
      ),
    ).rejects.toThrow(/not a CSS selector/);
    expect(page.calls).toEqual([]);
  });
});
```

- [ ] **Step 3: Run** `pnpm vitest run packages/core/src/capture/capture.test.ts` → FAIL (`captureStory` takes a Playwright page; no guard).

- [ ] **Step 4: Port `capture.ts`.** Change the import; at the top of `captureStory`, right after `const ctx = { story, params, timeoutMs };`, add:

```ts
// Selector syntax is validated before the page is touched: a Playwright-only
// selector (`text=`, `>>`) would otherwise match nothing and the story would
// be captured unmasked, or wait its whole timeout, and the baseline would
// record the wrong thing. Live params are re-checked below.
assertSelectors(params);
```

and after `Object.assign(params, live);` add `assertSelectors(params);`. Define at the bottom of the file:

```ts
function assertSelectors(params: StoryParams): void {
  for (const sel of params.mask ?? []) assertCssSelector(sel);
  if (params.waitForSelector) assertCssSelector(params.waitForSelector);
}
```

with `import { assertCssSelector } from '../browser/selectors.js';`. Replace the screenshot call with:

```ts
// A selector matching nothing is not an error — a story that conditionally
// renders the element shouldn't fail on the branch where it's absent.
const png = await page.screenshot(params.mask?.length ? { mask: params.mask } : {});
```

and `page.waitForTimeout(params.delay)` with `await new Promise<void>((r) => setTimeout(r, params.delay));`. Keep every other line and comment.

- [ ] **Step 5: Port `settle.ts`** `waitForSelector`:

```ts
export async function waitForSelector(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  // Timing out is swallowed (capture what rendered); a non-CSS selector is a
  // configuration error and throws synchronously from the page before the wait.
  await page.waitForSelector(selector, { timeout: timeoutMs }).catch(() => {});
}
```

(`CdpPage.waitForSelector` throws synchronously for a non-CSS selector, before returning the promise, so the `.catch` does not swallow it. Keep the exported signature.)

- [ ] **Step 6: Port `structure.ts`** (lines 496–571). Replace the locator calls with:

```ts
const mark = (sel: string) =>
  page.evaluate<number>(
    queryAllExpression(
      sel,
      "for (const el of els) el.setAttribute(a0, '1'); return els.length;",
      MASK_ATTR,
    ),
  );
const verify = (sel: string) =>
  page.evaluate<{ total: number; marked: number }>(
    queryAllExpression(
      sel,
      'return { total: els.length, marked: els.filter((e) => e.hasAttribute(a0)).length };',
      MASK_ATTR,
    ),
  );
const unmark = () =>
  page
    .evaluate(
      queryAllExpression(
        `[${MASK_ATTR}]`,
        'for (const el of els) el.removeAttribute(a0);',
        MASK_ATTR,
      ),
    )
    .catch(() => {});
```

Use `mark`/`verify`/`unmark` where the three `locator(...).evaluateAll(...)` calls were, and replace the `newCDPSession`/`detach` block with `const raw = (await page.send('DOMSnapshot.captureSnapshot', { computedStyles: [...STRUCTURE_PROPS, 'visibility'], includeDOMRects: true, includePaintOrder: true })) as unknown as CdpSnapshot;`. Update the doc comment: "Mask selectors are resolved with the same CSS-over-open-shadow-roots query the screenshot masks with; Playwright-only syntax is rejected in captureStory before anything runs."

- [ ] **Step 7: Rewrite the fake in `structure-capture.test.ts`** so the existing assertions keep their meaning:

```ts
import type { Page } from '../browser/page.js';

function fakePage(opts: {
  send?: () => Promise<unknown>;
  evaluateAll?: (sel: string, call: number) => Promise<unknown>;
}) {
  const calls: { sel: string; args: unknown[] }[] = [];
  const send = vi.fn(opts.send ?? (async () => fixture.raw));
  // Each mark/verify/unmark evaluate carries its selector as the first
  // JSON-encoded argument of the queryAll call; recover it for the assertions.
  const evaluate = vi.fn(async (expr: string) => {
    const m = /\)\)\((".*?")\)/.exec(expr);
    const sel = m ? (JSON.parse(m[1]) as string) : '';
    calls.push({ sel, args: [MASK_ATTR] });
    return opts.evaluateAll ? opts.evaluateAll(sel, calls.length) : true;
  });
  const page = { evaluate, send } as unknown as Page;
  return { page, calls, send };
}
```

Then: the test "returns a normalized snapshot and detaches the session" becomes "returns a normalized snapshot" (`expect(send).toHaveBeenCalledWith('DOMSnapshot.captureSnapshot', expect.objectContaining({ includeDOMRects: true }))`); "masks are marked via locators" becomes "masks are marked via queryAll"; every other test keeps its assertions. Run `pnpm vitest run packages/core/src/capture/structure-capture.test.ts` → PASS, same count as before the port (7).

- [ ] **Step 8: Port `snap.ts`**

```ts
import type { Browser, BrowserContext } from '../browser/browser.js';
import type { Page } from '../browser/page.js';
// …
export interface SnapPagesOptions {
  urls: string[];
  viewport?: Viewport;
  params?: StoryParams;
  /** Acquired by the caller (acquireBrowser); not closed here. */
  browser: Browser;
}
export interface SnapOptions {
  url: string;
  viewport?: Viewport;
  params?: StoryParams;
  browser: Browser;
}

export async function snapPages(
  opts: SnapPagesOptions,
): Promise<{ env: CaptureEnv; pages: SnapPageResult[] }> {
  const viewport = opts.viewport ?? DEFAULT_SNAP_VIEWPORT;
  const context = await opts.browser.newContext({ viewport, blockServiceWorkers: true });
  try {
    const page = await context.newPage();
    let status: number | null = null;
    const off = page.onMainResponse((s) => (status = s));
    const pages: SnapPageResult[] = [];
    for (const [k, url] of opts.urls.entries()) {
      status = null;
      const id = `snap-${k}`;
      const platform = createUrlPlatform([
        { id, url, ...(opts.params ? { params: opts.params } : {}) },
      ]);
      try {
        const [story] = await platform.enumerate({ projectRoot: process.cwd() });
        const snapshot = await captureStory(
          page,
          story,
          { platform, baseUrl: url },
          viewport,
        );
        if (!snapshot) throw new Error('page declared skip');
        pages.push({ url, snapshot, status });
      } catch (err) {
        pages.push({
          url,
          status,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await resetBetweenPages(context, page, url);
    }
    off();
    return { env: captureEnv(opts.browser), pages };
  } finally {
    await context.close().catch(() => {});
  }
}

async function resetBetweenPages(
  context: BrowserContext,
  page: Page,
  requestedUrl: string,
): Promise<void> {
  await context.clearCookies().catch(() => {});
  const origins = new Set<string>();
  for (const u of [requestedUrl, page.url()]) {
    try {
      const o = new URL(u);
      if (o.protocol === 'http:' || o.protocol === 'https:') origins.add(o.origin);
    } catch {
      // about:blank, chrome-error:// — no origin to clear.
    }
  }
  for (const origin of origins) await page.clearOrigin(origin).catch(() => {});
}

export async function snapPage(opts: SnapOptions): Promise<SnapResult> {
  const { env, pages } = await snapPages({
    urls: [opts.url],
    browser: opts.browser,
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(opts.params ? { params: opts.params } : {}),
  });
  const [r] = pages;
  if (!r.snapshot) throw new Error(r.error ?? 'jux: could not capture');
  return { snapshot: r.snapshot, env, status: r.status };
}
```

Keep the two comment blocks (the one above `snapPages` loses its "one browser" sentence: "one context and one page, in order"; the one above `resetBetweenPages` loses the `cdp.detach` sentence and says the origin wipe goes through the page's session, as before).

- [ ] **Step 9: Port `pool.ts`, `env.ts`, `run.ts`, `platform.ts`, `url-platform.ts`, `platforms/urls.ts`** — import lines only, plus `newContext({ viewport: opts.viewport })` in the pool with the comment "deviceScaleFactor is pinned to 1 by the driver and `--force-device-scale-factor=1`".

- [ ] **Step 10: Minimal launch-site port** so the workspace builds:

`packages/cli/src/commands/run.ts`: replace `import { chromium } from 'playwright';` with `import { acquireBrowser } from '@juxtapose/core';` (merge into the existing core import) and lines 110–112 with:

```ts
let browser;
try {
  browser = await p.time('launch', () => acquireBrowser());
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  await server?.close();
  return EXIT.failure;
}
```

`packages/cli/src/commands/init.ts`: same replacement at line 79 (return `EXIT.failure` after the message; close `server` first). `packages/cli/src/commands/snap.ts`: before the `snapPages` call, `const browser = await acquireBrowser();` inside the same `try` (its `catch` already prints `could not launch the browser` + `captureHint` and returns `EXIT.failure`), pass `browser` into `snapPages`, and `await browser.close()` in a `finally`. `captureHint` line 311 becomes `if (/jux: no browser|could not launch the browser|does not exist/.test(message)) return '. Run \`npx -p @juxtapose/cli jux browser install\`, or set JUX_CHROME=<path>, then retry.';`. `packages/server/src/source.ts`: `import { acquireBrowser, type Browser } from '@juxtapose/core';`and`ensureBrowser`→`this.browser = await acquireBrowser();`.

- [ ] **Step 11: `index.ts` exports and `package.json`** as listed in Files. Then:

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

Expected: all green. `packages/cli` and `packages/server` still list `playwright` in `package.json` (removed in Task 9) but no longer import it.

- [ ] **Step 12: Write `scripts/check-parity.mjs`**

```js
#!/usr/bin/env node
// Record or compare per-story sha256 of a `jux run --all` on an example.
//   node scripts/check-parity.mjs record  examples/storybook out.json
//   node scripts/check-parity.mjs compare examples/storybook ref.json
// `record` on main (Playwright) then `compare` on this branch is the upgrade
// gate: every hash must match, or every user baseline turns red on upgrade.
// Exit 0 only when every recorded story matches.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const run = promisify(execFile);
const [mode, exampleDir, file] = process.argv.slice(2);
if (!['record', 'compare'].includes(mode) || !exampleDir || !file) {
  process.stderr.write(
    'usage: check-parity.mjs record|compare <exampleDir> <hashes.json>\n',
  );
  process.exit(2);
}
const dir = path.resolve(exampleDir);
const cli = path.resolve('packages/cli/dist/index.js');
await run('node', [cli, 'run', '--all'], { cwd: dir }).catch((e) => {
  if (!e.stdout) throw e; // a non-zero exit is normal when stories are new
});
const runs = path.join(dir, '.juxtapose', 'runs');
const latest = (await readdir(runs)).sort().at(-1);
const images = path.join(runs, latest, 'images');
const hashes = {};
for (const f of (await readdir(images)).sort()) {
  if (!f.endsWith('-current.webp')) continue;
  hashes[f.replace(/-current\.webp$/, '')] = createHash('sha256')
    .update(await readFile(path.join(images, f)))
    .digest('hex');
}
if (mode === 'record') {
  await writeFile(file, JSON.stringify(hashes, null, 1) + '\n');
  console.log(`recorded ${Object.keys(hashes).length} stories to ${file}`);
  process.exit(0);
}
const ref = JSON.parse(await readFile(file, 'utf8'));
let ok = 0;
const ids = Object.keys(ref);
for (const id of ids) {
  const same = ref[id] === hashes[id];
  if (same) ok++;
  console.log(
    `${same ? 'MATCH' : 'DIFF '} ${id} ${ref[id].slice(0, 12)} ${hashes[id]?.slice(0, 12) ?? '-'}`,
  );
}
console.log(`parity: ${ok}/${ids.length}`);
process.exit(ok === ids.length && ids.length > 0 ? 0 : 1);
```

- [ ] **Step 13: Run the gate** (the CLI now captures through the driver; main's hashes were recorded by the spike on this machine):

```bash
node scripts/check-parity.mjs compare examples/storybook /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-hashes.json      # parity: 15/15
node scripts/check-parity.mjs compare examples/ladle /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-ladle-hashes.json     # parity: 14/14
pnpm check:determinism                                                                                                 # OK, 3 runs
```

- [ ] **Step 14: Commit**

```bash
pnpm format && git add packages/core packages/cli/src packages/server/src scripts/check-parity.mjs
git commit -m "core: capture through the CDP driver; Page is our own seam; acquireBrowser owns launch"
```

### Task 8: Port the adapters

**Files:**

- Modify: `packages/adapter-storybook/src/index.ts:9` (delete the `playwright` import; add `Page` to the `@juxtapose/core` type import at lines 11–17)
- Modify: `packages/adapter-ladle/src/index.ts:9` (same; its core type import is at lines 11–17 too)
- Modify: `packages/adapter-storybook/package.json:32-34,40-44`, `packages/adapter-ladle/package.json:32-34,40-44` (remove `peerDependencies.playwright` and `peerDependenciesMeta`; add `"engines": { "node": ">=22.2.0" }`)
- Create: `packages/adapter-storybook/src/index.test.ts`, `packages/adapter-ladle/src/index.test.ts` (neither exists today)

**Interfaces:**

- Consumes: `Page`, `TimeoutError` from `@juxtapose/core` (Task 7).
- Produces: nothing new. `switchStory`/`readLiveParams` keep calling `page.evaluate(fn, arg)` with one argument, and `waitForRenderPhase`/`waitForLayoutClass` keep `page.waitForFunction(fn, arg, { timeout })`.

- [ ] **Step 1: Write the adapter tests** (1 test each)

```ts
// packages/adapter-storybook/src/index.test.ts
import { describe, it, expect } from 'vitest';
import { TimeoutError, type Page } from '@juxtapose/core';
import { StorybookPlatform } from './index.js';

/** A page whose every wait times out, as a story that never renders would. */
function timingOutPage(): Page {
  const timeout = async () => {
    throw new TimeoutError('jux: timed out');
  };
  return {
    goto: async () => {},
    url: () => '',
    evaluate: async () => undefined as never,
    waitForFunction: timeout,
    waitForSelector: timeout,
    addStyleTag: async () => {},
    setViewportSize: async () => {},
    screenshot: async () => Buffer.alloc(0),
    send: async () => ({}) as never,
    onMainResponse: () => () => {},
    clearOrigin: async () => {},
    close: async () => {},
  };
}

describe('StorybookPlatform.settle', () => {
  it('resolves when the render signal times out (a slow story is a diff, not an abort)', async () => {
    const platform = new StorybookPlatform();
    const ctx = {
      story: { storyId: 'a', title: 'a', name: 'a', componentPath: '', params: {} },
      params: {},
      timeoutMs: 1,
    };
    await expect(platform.settle(timingOutPage(), ctx)).resolves.toBeUndefined();
  });
});
```

The Ladle test is the same file with `LadlePlatform` from `./index.js` and `describe('LadlePlatform.settle', …)`. Use the class name each adapter actually exports (`grep -n "^export class" packages/adapter-*/src/index.ts`).

- [ ] **Step 2: Run** `pnpm vitest run packages/adapter-storybook packages/adapter-ladle` → FAIL (type error: the adapters still import `Page` from `playwright`, which has no `onMainResponse`; vitest reports the TS mismatch as a runtime failure only if the fake is incompatible — the real failure is `pnpm typecheck`, run it too).

- [ ] **Step 3: Change the two import lines and the two package.json files.** `pnpm build && pnpm typecheck && pnpm vitest run packages/adapter-storybook packages/adapter-ladle` → PASS (1 + 1). `grep -n playwright packages/adapter-*/src packages/adapter-*/package.json` → empty.

- [ ] **Step 4: Commit**

```bash
pnpm format && git add packages/adapter-storybook packages/adapter-ladle
git commit -m "adapters: take Page from @juxtapose/core; drop the playwright peer"
```

### Task 9: `jux browser`, `--chrome`, proxy re-exec, the CLI and server package manifests

**Files:**

- Create: `packages/cli/src/commands/browser.ts` (`jux browser install|path|status`)
- Modify: `packages/cli/src/index.ts:76-146` (add `case 'browser'`, `COMMANDS` list, help text; parse `--chrome <path>` for `snap`, `run`, `init` and pass it through each command's flags)
- Modify: `packages/cli/src/commands/run.ts`, `init.ts`, `snap.ts` (`acquireBrowser({ chrome: flags.chrome })`; `init` runs the installer when nothing resolves)
- Modify: `packages/cli/package.json` (remove `playwright` dep and keyword; `engines`), `packages/server/package.json` (remove `playwright` dep; `engines`), `packages/storybook/package.json` (`engines`), `packages/storybook/src/Panel.tsx:12`, `packages/storybook/src/sidebar.ts:12` (comment text only: "reaches sharp and the browser driver")
- Modify: `scripts/check-snap.mjs:98-108`
- Test: `packages/cli/src/commands/browser.test.ts`

**Interfaces:**

- Consumes: `acquireBrowser`, `resolveChrome`, `installChrome`, `juxCacheDir`, `noBrowserMessage`, `CHROME_VERSION`, `proxyHint` from `@juxtapose/core`; `EXIT.clean/review/usage/failure` from `packages/cli/src/exit-codes.ts`.
- Produces: `browserCommand(argv: string[], json: boolean): Promise<number>`; `installWithProxyReexec(opts: { env: NodeJS.ProcessEnv; argv: string[]; json: boolean }): Promise<number>` (when a proxy variable is set, this Node supports `--use-env-proxy`, and `NODE_USE_ENV_PROXY` is not already set, re-run `process.execPath --use-env-proxy <argv>` and return its code; otherwise install in-process).

- [ ] **Step 1: Write `browser.test.ts`** (3 tests)

```ts
// packages/cli/src/commands/browser.test.ts
import { describe, it, expect } from 'vitest';
import { browserCommand, shouldReexecForProxy } from './browser.js';

describe('jux browser', () => {
  it('status with nothing installed exits 3 and names the install command', async () => {
    const out: string[] = [];
    const code = await browserCommand(['status'], false, {
      env: { JUX_CACHE_DIR: '/nonexistent', PLAYWRIGHT_BROWSERS_PATH: '/nonexistent' },
      write: (s) => out.push(s),
    });
    expect(code).toBe(3);
    expect(out.join('')).toMatch(/npx -p @juxtapose\/cli jux browser install/);
  });
  it('an unknown subcommand is a usage error', async () => {
    expect(
      await browserCommand(['frobnicate'], false, { env: {}, write: () => {} }),
    ).toBe(2);
  });
  it('re-execs for a proxy only when a proxy variable is set, the flag exists, and it is not already on', () => {
    const flags = new Set(['--use-env-proxy']);
    expect(shouldReexecForProxy({ HTTPS_PROXY: 'x' }, flags)).toBe(true);
    expect(shouldReexecForProxy({}, flags)).toBe(false);
    expect(
      shouldReexecForProxy({ HTTPS_PROXY: 'x', NODE_USE_ENV_PROXY: '1' }, flags),
    ).toBe(false);
    expect(shouldReexecForProxy({ HTTPS_PROXY: 'x' }, new Set())).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Write `commands/browser.ts`**

```ts
// `jux browser install|path|status` — the browser is a pinned download, not
// a Playwright side effect.
import { spawnSync } from 'node:child_process';
import {
  CHROME_VERSION,
  installChrome,
  juxCacheDir,
  noBrowserMessage,
  resolveChrome,
} from '@juxtapose/core';
import { EXIT } from '../exit-codes.js';

export interface BrowserCommandIo {
  env: NodeJS.ProcessEnv;
  write: (s: string) => void;
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

/** Node's fetch ignores proxy variables unless the process starts with --use-env-proxy. */
export function shouldReexecForProxy(
  env: NodeJS.ProcessEnv,
  allowedFlags: Set<string> = process.allowedNodeEnvironmentFlags,
): boolean {
  if (!PROXY_VARS.some((v) => env[v])) return false;
  if (env.NODE_USE_ENV_PROXY) return false;
  return allowedFlags.has('--use-env-proxy');
}

export async function browserCommand(
  argv: string[],
  json: boolean,
  io: BrowserCommandIo = { env: process.env, write: (s) => process.stdout.write(s) },
): Promise<number> {
  const sub = argv[0] ?? 'status';

  if (sub === 'install') {
    if (shouldReexecForProxy(io.env)) {
      const r = spawnSync(
        process.execPath,
        ['--use-env-proxy', ...process.argv.slice(1)],
        { stdio: 'inherit', env: { ...io.env, NODE_USE_ENV_PROXY: '1' } },
      );
      return r.status ?? EXIT.failure;
    }
    let last = -1;
    const r = await installChrome({
      cacheDir: juxCacheDir({ env: io.env }),
      env: io.env,
      onProgress: (n, total) => {
        if (json || !total) return;
        const pct = Math.floor((n / total) * 10) * 10;
        if (pct !== last) {
          last = pct;
          process.stderr.write(
            `\r  downloading chrome-headless-shell ${CHROME_VERSION} ${pct}%`,
          );
        }
      },
    });
    if (!json && last >= 0) process.stderr.write('\n');
    io.write(
      json
        ? JSON.stringify({
            version: r.version,
            path: r.path,
            alreadyInstalled: r.alreadyInstalled,
          }) + '\n'
        : `jux: ${r.alreadyInstalled ? 'already installed' : 'installed'} ${r.version} at ${r.path}\n`,
    );
    return EXIT.clean;
  }

  if (sub === 'path' || sub === 'status') {
    const r = resolveChrome({ env: io.env });
    if (!r) {
      io.write(
        json
          ? JSON.stringify({ browser: null, pinned: CHROME_VERSION }) + '\n'
          : `${noBrowserMessage()}\n`,
      );
      return EXIT.failure;
    }
    if (sub === 'path') io.write(r.path + '\n');
    else
      io.write(
        json
          ? JSON.stringify({
              browser: r.path,
              source: r.source,
              pinned: CHROME_VERSION,
            }) + '\n'
          : `jux: ${r.path} (${r.source}, pinned ${CHROME_VERSION})\n`,
      );
    return EXIT.clean;
  }

  io.write(`jux: unknown browser subcommand '${sub}'. Use install, path or status.\n`);
  return EXIT.usage;
}
```

- [ ] **Step 4: Wire the commands.** In `index.ts`: `case 'browser': { const { browserCommand } = await import('./commands/browser.js'); return browserCommand(argv.slice(1), flags.json); }`, add `'browser'` to `COMMANDS`, parse `--chrome` (string) alongside the existing flags and pass it as `flags.chrome` into `run`, `init` and `snap`; help lines:

```
  jux browser install            download the pinned chrome-headless-shell (once, ~100 MB)
  jux browser status             which browser jux will use, and where it came from
  --chrome <path>                use this Chromium binary (or JUX_CHROME=<path>)
```

`run.ts`/`snap.ts`: `acquireBrowser({ chrome: flags.chrome })`. `init.ts`: when `resolveChrome({ flag: flags.chrome })` is null, `say(\`Downloading chrome-headless-shell ${CHROME_VERSION} (~100 MB, once)…\`)`and`await installChrome({ cacheDir: juxCacheDir() })`before`acquireBrowser`.

- [ ] **Step 5: `scripts/check-snap.mjs`**: the no-browser case sets `JUX_CACHE_DIR: '/nonexistent', PLAYWRIGHT_BROWSERS_PATH: '/nonexistent', JUX_CHROME: ''` and asserts `/npx -p @juxtapose\/cli jux browser install/`.

- [ ] **Step 6: Run everything**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/check-snap.mjs
grep -rn playwright packages/*/package.json packages/*/src   # expect: nothing
node packages/cli/dist/index.js browser status                # expect: the ms-playwright path on this Mac
node scripts/check-parity.mjs compare examples/storybook /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-hashes.json       # parity: 15/15
node scripts/check-parity.mjs compare examples/ladle /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-ladle-hashes.json      # parity: 14/14
```

Also run `JUX_CACHE_DIR=/Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/cache node packages/cli/dist/index.js browser install` once, then with `JUX_CACHE_DIR=… PLAYWRIGHT_BROWSERS_PATH=/nonexistent` re-run `browser status` → `jux-cache`, and the storybook parity compare → still 15/15 (a fresh CfT download renders the same bytes as the Playwright cache).

- [ ] **Step 7: Commit**

```bash
pnpm format && git add packages/cli packages/server packages/storybook scripts/check-snap.mjs
git commit -m "cli: jux browser install|path|status, --chrome, proxy re-exec; drop the playwright dependency"
```

> **Controller checkpoint (after Task 9, before Task 10):** the controller runs `pnpm install` once in this worktree to drop `playwright` from `pnpm-lock.yaml`, verifies `pnpm install --frozen-lockfile` passes, and commits the lockfile (`chore: lockfile without playwright`). No implementer runs `pnpm install`.

### Task 10: Scripts, docs, CI, engines, changeset, measurements

**Files:**

- Modify: `scripts/capture-diff-fixtures.mjs:14`, `scripts/capture-structure-fixture.mjs:10` (drive `Browser` from `packages/core/dist/browser/index.js`; the structure script serves its page over a local `http` server and `goto`s it — there is no `setContent` — so the fixture is produced through `Page` exactly as production captures are)
- Replace: `scripts/structural-corpus/no-playwright.mjs` → `scripts/structural-corpus/no-browser.mjs`; modify `scripts/check-diff.mjs:16,50-62,154`
- Modify: `README.md` (install section; a "Browser" section), `packages/cli/README.md:12-13` (`npx jux …` → `npx -p @juxtapose/cli jux …`; install line), `CONTRIBUTING.md:12` (`pnpm --filter @juxtapose/cli exec playwright install chromium` → `node packages/cli/dist/index.js browser install`), `plugins/claude-code/skills/visual-check/SKILL.md:44`, `ARCHITECTURE.md` (layout: `core/browser/`; "Playwright" → "the CDP driver"), `CLAUDE.md` layout block (`browser/    CDP driver, launcher, installer — a port of what Playwright did for us; see the 2026-10-13 spec before touching init or screenshot`)
- Modify: `.github/workflows/ci.yml:57,64,135,142` (`node-version: 22` stays — the latest 22.x is ≥ 22.2; replace both `playwright install` steps with `run: node packages/cli/dist/index.js browser install` preceded by `actions/cache@v4` keyed `chrome-headless-shell-151.0.7922.34-${{ runner.os }}` on `~/.cache/jux`)
- Modify: `package.json` (`engines.node` → `>=22.2.0`); confirm every `packages/*/package.json` says the same (Tasks 7–9 set core, both adapters, cli, server, storybook)
- Create: `.changeset/cdp-driver.md`

- [ ] **Step 1: Fixture scripts.** Port both. The structure script:

```js
// scripts/capture-structure-fixture.mjs (the capture part)
import { createServer } from 'node:http';
const { Browser, acquireBrowser } = await import('../packages/core/dist/index.js');
const html = readFileSync(
  new URL('./structural-corpus/basic.html', import.meta.url),
  'utf8',
); // the page the old script passed to setContent
const server = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await acquireBrowser();
const context = await browser.newContext({ viewport });
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
// … the existing DOMSnapshot call becomes page.send('DOMSnapshot.captureSnapshot', {...}) …
await browser.close();
server.close();
```

(Write the page the old script inlined into `scripts/structural-corpus/basic.html` if it is not already a file.) Then run each script into `/Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/fixtures-<name>/` and `diff -r` against the committed fixture directory. Expected: no output for the diff fixtures (they were captured with `deterministicLaunchOptions` already). For the structure fixture the old script launched Chromium with Playwright's **default** flags, not ours, so byte identity is not expected; the normalized structure (`elements`, `structureHash`) must be identical — assert with `node -e` comparing the two JSON files' `structureHash`. If the hash differs, stop: that is a driver bug, not a fixture refresh.

- [ ] **Step 2: Probe.** `scripts/structural-corpus/no-browser.mjs` is a module resolve hook (same mechanism as the current `no-playwright.mjs`, same in-thread `module.register` style it uses today) that throws when `jux diff` loads any of: `playwright`, `playwright-core`, `node:child_process`, `child_process`, or a module path containing `/browser/launch.js`:

```js
// Loader hook: `jux diff` must never load a browser driver or the process
// spawner. Not a monkey-patch — a module that is never loaded cannot spawn.
const BLOCKED = [
  /^playwright(-core)?(\/|$)/,
  /^(node:)?child_process$/,
  /\/browser\/launch\.js$/,
];
export function resolve(specifier, context, next) {
  if (BLOCKED.some((re) => re.test(specifier))) {
    throw new Error(`no-browser probe: '${specifier}' was loaded`);
  }
  return next(specifier, context);
}
```

`check-diff.mjs`: keep its three assertions, reword "playwright" → "browser"; the positive check ("the probe itself fires for a command that does load the driver") runs `jux snap` under the hook and expects exit 3 with `/no-browser probe/`. Run `node scripts/check-diff.mjs` → all checks pass.

- [ ] **Step 3: Docs and CI** as listed. README "Browser" section text:

````
## Browser

jux drives a pinned `chrome-headless-shell` 151.0.7922.34 from Chrome for
Testing — the same build Playwright 1.62 ships, so baselines captured with
earlier jux versions still match.

```bash
npx -p @juxtapose/cli jux browser install   # once, ~100 MB
```

It lands in `~/Library/Caches/jux` (macOS), `~/.cache/jux` (Linux) or
`%LOCALAPPDATA%\jux` (Windows); `JUX_CACHE_DIR` overrides. If Playwright's
cache already holds the same build, jux uses it and downloads nothing.
`JUX_CHROME=<path>` or `--chrome <path>` uses your own Chromium instead; the
version is recorded in each run's `env`, so a mismatch is reported rather
than silently red. Behind a proxy, set `HTTPS_PROXY` as usual — the installer
re-runs itself with Node's `--use-env-proxy`. Linux needs Chromium's shared
libraries — on Ubuntu 24.04: `sudo apt-get install libasound2t64
libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64
libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0
libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3
libxkbcommon0 libxrandr2`. linux-arm64 has no published build of this
version; use `JUX_CHROME`.

Mask and `--wait-for` selectors are CSS. Playwright-only forms (`text=`,
`>>`, `:has-text()`) are rejected with an error rather than silently matching
nothing.
````

- [ ] **Step 4: Measurements for the PR description** (from the repo root, built CLI):

```bash
# jux snap, 10 runs, cold-launch path (PR 1 has no daemon)
node /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/serve.mjs examples/storybook/storybook-static 4799 &
for i in $(seq 10); do /usr/bin/time -p node packages/cli/dist/index.js snap "http://127.0.0.1:4799/iframe.html?id=button--primary&viewMode=story" --as t$i 2>&1 | grep real; done
# jux run, 3 runs each example; main measured 2026-10-13 on this Mac: storybook 1409–1723 ms, ladle 1539 ms
for i in 1 2 3; do (cd examples/storybook && /usr/bin/time -p node ../../packages/cli/dist/index.js run --all 2>&1 | grep real); done
for i in 1 2 3; do (cd examples/ladle && /usr/bin/time -p node ../../packages/cli/dist/index.js run --all 2>&1 | grep real); done
```

Expected: snap p50 ≤ 500 ms (spike fresh pipe: 439–487 wall; today 630–690); run ≤ main − 100 ms. Record the printed numbers verbatim in the PR.

- [ ] **Step 5: Changeset**

```md
---
'@juxtapose/core': minor
'@juxtapose/adapter-storybook': minor
'@juxtapose/adapter-ladle': minor
'@juxtapose/cli': minor
'@juxtapose/server': minor
'@juxtapose/storybook': minor
---

Capture through juxtapose's own CDP driver instead of Playwright. Baselines are byte-identical (verified on both example workbenches). `npx playwright install chromium` becomes `npx -p @juxtapose/cli jux browser install`, or `JUX_CHROME=<path>`.

**Breaking:** mask and `--wait-for` selectors must be CSS — Playwright-only syntax (`text=`, `>>`, `:has-text()`, `:visible`, `nth=`) now fails the story with `jux: selector '…' is not a CSS selector` instead of silently matching nothing. Node ≥ 22.2.0 is required. The `playwright` peer dependency is gone.
```

- [ ] **Step 6: Final gate and commit**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && node scripts/check-snap.mjs && node scripts/check-diff.mjs && pnpm check:determinism
grep -rn playwright packages/*/package.json packages/*/src    # nothing
grep -rn '"node": ">=22.2.0"' package.json packages/*/package.json | wc -l   # 7
pnpm format && git add -u && git add .changeset/cdp-driver.md scripts/structural-corpus/no-browser.mjs
git commit -m "docs, ci, scripts: jux browser install replaces playwright install"
```

Open PR 1 from `feat/cdp-driver` with the parity table, the determinism output and the Step 4 numbers.

# PR 2 — warm browser (branch `feat/warm-browser` off PR 1)

Spike evidence (spec §Measured baseline, §Decisions 13–16): a browser that
had served twelve earlier invocations produced 15/15 and 14/14 identical
bytes; one headless shell stays alive across client disconnects while a CDP
client holds the pipe; warm p50 was 257 ms in-process vs 370 fresh.

### Task 11: Daemon state, environment fingerprint, paths and the spawn lock

**Files:**

- Create: `packages/core/src/browser/daemon/state.ts`
- Test: `packages/core/src/browser/daemon/state.test.ts`

**Interfaces:**

- Consumes: `juxCacheDir` (Task 1).
- Produces: `interface DaemonState { pid: number; socket: string; binary: string; version: string; key: string; startedAt: string; idleMinutes: number }`, `interface Fingerprint { binary: string; version: string; args: string[]; env: NodeJS.ProcessEnv; uid?: number }`, `daemonKey(fp: Fingerprint): string` (first 16 hex of sha256 over binary, version, args, `TZ`, `LANG`, `LC_ALL`, `FONTCONFIG_FILE`, uid), `daemonPaths(cacheDir: string, key: string): { dir: string; state: string; socket: string; lock: string }` (socket is `\\.\pipe\jux-browser-<key>` on win32), `readState(paths): Promise<DaemonState | null>`, `writeState(paths, state): Promise<void>` (dir `0700` — created or `chmod`ed —, file `0600`, write-then-rename), `clearState(paths): Promise<void>` (removes the state file **and** a leftover socket file), `acquireLock(paths): Promise<(() => Promise<void>) | null>` (`O_EXCL`; a lock older than 30 s is stale and taken over), `pidAlive(pid: number): boolean`.

- [ ] **Step 1: Write the failing test** (5 tests)

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat, writeFile, utimes, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  daemonKey,
  daemonPaths,
  readState,
  writeState,
  clearState,
  acquireLock,
  pidAlive,
} from './state.js';

const fp = {
  binary: '/b',
  version: '151.0.7922.34',
  args: [],
  env: { TZ: 'UTC', LANG: 'en_US.UTF-8' },
  uid: 1,
};
const state = {
  pid: process.pid,
  socket: '/s',
  binary: '/b',
  version: '151.0.7922.34',
  key: 'k',
  startedAt: '2026-10-13T00:00:00Z',
  idleMinutes: 10,
};

async function withCache(
  fn: (paths: ReturnType<typeof daemonPaths>, cache: string) => Promise<void>,
) {
  const cache = await mkdtemp(path.join(tmpdir(), 'jux-daemon-'));
  try {
    await fn(daemonPaths(cache, 'abc'), cache);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

describe('daemon state', () => {
  it('the key changes with the binary, version, uid, TZ, LANG, LC_ALL and args', () => {
    const k = daemonKey(fp);
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(daemonKey({ ...fp, binary: '/c' })).not.toBe(k);
    expect(daemonKey({ ...fp, version: '152' })).not.toBe(k);
    expect(daemonKey({ ...fp, uid: 2 })).not.toBe(k);
    expect(daemonKey({ ...fp, env: { ...fp.env, TZ: 'Europe/Paris' } })).not.toBe(k);
    expect(daemonKey({ ...fp, env: { ...fp.env, LANG: 'de_DE.UTF-8' } })).not.toBe(k);
    expect(daemonKey({ ...fp, env: { ...fp.env, LC_ALL: 'C' } })).not.toBe(k);
    expect(daemonKey({ ...fp, args: ['--foo'] })).not.toBe(k);
    // Unrelated variables do not fork daemons.
    expect(daemonKey({ ...fp, env: { ...fp.env, PATH: '/x' } })).toBe(k);
  });
  it('writes 0600 inside a 0700 dir (fixing a wider existing dir) and reads it back; garbage reads as null', () =>
    withCache(async (paths) => {
      await mkdir(paths.dir, { recursive: true });
      await chmod(paths.dir, 0o755);
      await writeState(paths, state);
      if (process.platform !== 'win32') {
        expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
        expect((await stat(paths.state)).mode & 0o777).toBe(0o600);
      }
      expect(await readState(paths)).toEqual(state);
      await writeFile(paths.state, '{nope');
      expect(await readState(paths)).toBeNull();
    }));
  it('clearState removes the state file and a leftover socket file', () =>
    withCache(async (paths) => {
      await writeState(paths, state);
      if (process.platform !== 'win32') await writeFile(paths.socket, '');
      await clearState(paths);
      expect(await readState(paths)).toBeNull();
      if (process.platform !== 'win32')
        await expect(stat(paths.socket)).rejects.toThrow();
    }));
  it('lock is exclusive, released, and stale after 30 s', () =>
    withCache(async (paths) => {
      const release = await acquireLock(paths);
      expect(release).not.toBeNull();
      expect(await acquireLock(paths)).toBeNull();
      await release!();
      const again = await acquireLock(paths);
      expect(again).not.toBeNull();
      const old = new Date(Date.now() - 31_000);
      await utimes(paths.lock, old, old);
      expect(await acquireLock(paths)).not.toBeNull();
    }));
  it('pidAlive', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 - 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/core/src/browser/daemon/state.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write `state.ts`**

```ts
// packages/core/src/browser/daemon/state.ts
//
// One small JSON file says where the warm browser is. Its permissions are
// the access control: the socket it names is reachable only through a 0700
// directory (spec §Security). A process that cannot read the file cannot
// find the socket; a process that can is the same user.
//
// The key is an environment fingerprint, not just the binary: TZ, LANG and
// LC_ALL change what a page renders (dates, number formats, font fallback),
// so two invocations with different ones must not share a browser, or the
// pixels would depend on which one started it.

import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';

export interface DaemonState {
  pid: number;
  socket: string;
  binary: string;
  version: string;
  key: string;
  startedAt: string;
  idleMinutes: number;
}

export interface Fingerprint {
  binary: string;
  version: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  uid?: number;
}

export interface DaemonPaths {
  dir: string;
  state: string;
  socket: string;
  lock: string;
}

const LOCK_STALE_MS = 30_000;
const RENDER_ENV = ['TZ', 'LANG', 'LC_ALL', 'FONTCONFIG_FILE'] as const;

export function daemonKey(fp: Fingerprint): string {
  const uid = fp.uid ?? safeUid();
  const env = RENDER_ENV.map((k) => `${k}=${fp.env[k] ?? ''}`).join('\n');
  return createHash('sha256')
    .update([fp.binary, fp.version, fp.args.join(' '), env, String(uid)].join('\n\n'))
    .digest('hex')
    .slice(0, 16);
}

export function daemonPaths(cacheDir: string, key: string): DaemonPaths {
  const dir = path.join(cacheDir, 'browser');
  return {
    dir,
    state: path.join(dir, `${key}.json`),
    // Unix sockets have a ~104-byte path limit; the cache dir is short enough
    // on every supported OS default, and JUX_CACHE_DIR users own that choice.
    socket:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\jux-browser-${key}`
        : path.join(dir, `${key}.sock`),
    lock: path.join(dir, `${key}.lock`),
  };
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to a directory it creates; an existing wider one is tightened.
  if (process.platform !== 'win32') await chmod(dir, 0o700);
}

export async function readState(paths: DaemonPaths): Promise<DaemonState | null> {
  try {
    const s = JSON.parse(await readFile(paths.state, 'utf8')) as DaemonState;
    return typeof s.pid === 'number' && typeof s.socket === 'string' ? s : null;
  } catch {
    return null;
  }
}

export async function writeState(paths: DaemonPaths, state: DaemonState): Promise<void> {
  await ensureDir(paths.dir);
  const tmp = `${paths.state}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state) + '\n', { mode: 0o600 });
  await rename(tmp, paths.state);
}

export async function clearState(paths: DaemonPaths): Promise<void> {
  await rm(paths.state, { force: true });
  if (process.platform !== 'win32') await rm(paths.socket, { force: true });
}

/** O_EXCL lock for "who launches". Returns a release function, or null if held. */
export async function acquireLock(
  paths: DaemonPaths,
): Promise<(() => Promise<void>) | null> {
  await ensureDir(paths.dir);
  try {
    const age = Date.now() - (await stat(paths.lock)).mtimeMs;
    if (age > LOCK_STALE_MS) await unlink(paths.lock).catch(() => {});
  } catch {
    // no lock file
  }
  try {
    const fh = await open(paths.lock, 'wx', 0o600);
    await fh.writeFile(String(process.pid));
    await fh.close();
    return async () => {
      await unlink(paths.lock).catch(() => {});
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function safeUid(): number {
  try {
    return userInfo().uid;
  } catch {
    return -1;
  }
}
```

- [ ] **Step 4: Run** → PASS, 5 tests. **Step 5: Commit**

```bash
pnpm format && git add packages/core/src/browser/daemon
git commit -m "core: daemon state file keyed by an environment fingerprint, paths and spawn lock"
```

### Task 12: Supervisor

**Files:**

- Create: `packages/core/src/browser/daemon/supervisor.ts`
- Create: `packages/core/src/browser/daemon/supervisor-main.ts` (the detached entry)
- Test: `packages/core/src/browser/daemon/supervisor.test.ts` (integration, skipped without a browser)

**Interfaces:**

- Consumes: `launchChrome` (Task 5), `CdpConnection.allocateId/sendRaw/onRaw`, `RawMessage`, `NullFramer` (Task 4), `daemonPaths`, `writeState`, `clearState` (Task 11), `CHROME_VERSION`.
- Produces: `startSupervisor(opts: { executablePath: string; args?: string[]; paths: DaemonPaths; key: string; idleMinutes: number; onExit?: () => void }): Promise<{ state: DaemonState; stop(): Promise<void> }>`. Wire protocol on the socket: the client's first frame is `{"jux":"hello","version":"<CHROME_VERSION>"}`; the supervisor answers with an event frame `{"method":"jux.ready","params":{"product":"HeadlessChrome/151…"}}` or `{"method":"jux.refused","params":{"reason":"…"}}` then ends the socket; after `ready`, frames are raw CDP both ways. Message ids are rewritten per client with `connection.allocateId()` (one id space with the supervisor's own sends); events are forwarded to the client that owns the `sessionId` (tracked from its `Target.attachToTarget` replies **and** from `Target.attachedToTarget` events whose parent session it owns) or to every ready client when session-less. Contexts a client created (`Target.createBrowserContext` replies) are disposed when its socket closes; `Target.disposeBrowserContext` **requests** remove the id from its set.

- [ ] **Step 1: Write the integration test** (4 tests)

```ts
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSupervisor } from './supervisor.js';
import { daemonPaths, readState } from './state.js';
import { CdpConnection } from '../cdp.js';
import { SocketTransport } from '../transport.js';
import { CHROME_VERSION } from '../pins.js';
import { chromeForTests } from '../__tests__/helpers.js';

const chrome = chromeForTests();

async function connect(
  socketPath: string,
  version = CHROME_VERSION,
): Promise<{ c: CdpConnection; outcome: 'ready' | 'refused' }> {
  const sock = net.connect(socketPath);
  await new Promise<void>((r, e) => {
    sock.once('connect', r);
    sock.once('error', e);
  });
  const t = new SocketTransport(sock);
  const c = new CdpConnection(t);
  const outcome = Promise.race([
    c.once('jux.ready').then(() => 'ready' as const),
    c.once('jux.refused').then(() => 'refused' as const),
  ]);
  t.send(JSON.stringify({ jux: 'hello', version }));
  return { c, outcome: await outcome };
}

async function withSupervisor(
  fn: (ctx: {
    paths: ReturnType<typeof daemonPaths>;
    sup: Awaited<ReturnType<typeof startSupervisor>>;
  }) => Promise<void>,
  idleMinutes = 10,
  prepare?: (paths: ReturnType<typeof daemonPaths>) => Promise<void>,
) {
  const cache = await mkdtemp(path.join(tmpdir(), 'jux-sup-'));
  const paths = daemonPaths(cache, 'test');
  await prepare?.(paths);
  let exited = false;
  const sup = await startSupervisor({
    executablePath: chrome!.path,
    paths,
    key: 'test',
    idleMinutes,
    onExit: () => (exited = true),
  });
  try {
    await fn({ paths, sup });
  } finally {
    await sup.stop();
    await rm(cache, { recursive: true, force: true });
  }
  return exited;
}

describe.skipIf(!chrome)('supervisor', () => {
  it('serves two clients, isolates sessions, and disposes a dead client’s contexts', () =>
    withSupervisor(async ({ paths }) => {
      expect((await readState(paths))?.pid).toBe(process.pid);
      const a = (await connect(paths.socket)).c;
      const b = (await connect(paths.socket)).c;
      const [va, vb] = await Promise.all([
        a.send<{ product: string }>('Browser.getVersion'),
        b.send<{ product: string }>('Browser.getVersion'),
      ]);
      expect(va.product).toBe(vb.product);
      const { browserContextId } = await a.send<{ browserContextId: string }>(
        'Target.createBrowserContext',
        { disposeOnDetach: true },
      );
      const { targetId } = await a.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
        browserContextId,
      });
      const { sessionId } = await a.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      let bSaw = 0;
      b.on('Runtime.executionContextCreated', () => bSaw++);
      let aSaw = 0;
      a.on('Runtime.executionContextCreated', () => aSaw++, sessionId);
      await a.send('Runtime.enable', {}, sessionId);
      const r = await a.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: '6*7', returnByValue: true },
        sessionId,
      );
      expect(r.result.value).toBe(42);
      expect(aSaw).toBeGreaterThan(0);
      expect(bSaw).toBe(0);
      a.close();
      // After a drops, its context is gone from the browser.
      for (let i = 0; i < 20; i++) {
        const { browserContextIds } = await b.send<{ browserContextIds: string[] }>(
          'Target.getBrowserContexts',
        );
        if (!browserContextIds.includes(browserContextId)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const { browserContextIds } = await b.send<{ browserContextIds: string[] }>(
        'Target.getBrowserContexts',
      );
      expect(browserContextIds).not.toContain(browserContextId);
      b.close();
    }));
  it('a context the client disposed itself is not disposed twice (no error on drop)', () =>
    withSupervisor(async ({ paths }) => {
      const a = (await connect(paths.socket)).c;
      const { browserContextId } = await a.send<{ browserContextId: string }>(
        'Target.createBrowserContext',
      );
      await a.send('Target.disposeBrowserContext', { browserContextId });
      a.close();
      const b = (await connect(paths.socket)).c;
      expect(
        (await b.send<{ browserContextIds: string[] }>('Target.getBrowserContexts'))
          .browserContextIds,
      ).not.toContain(browserContextId);
      b.close();
    }));
  it('rejects a client with another pinned version', () =>
    withSupervisor(async ({ paths }) => {
      const { outcome } = await connect(paths.socket, '0.0.0.0');
      expect(outcome).toBe('refused');
    }));
  it('listens over a leftover socket file, and exits when idle', async () => {
    const exited = await withSupervisor(
      async ({ paths }) => {
        expect((await connect(paths.socket)).outcome).toBe('ready');
        await new Promise((r) => setTimeout(r, 900)); // idle 0.005 min = 300 ms after the client drops
      },
      0.005,
      async (paths) => {
        await writeFile(paths.socket, '').catch(() => {}); // a crashed daemon's leftover
      },
    );
    expect(exited).toBe(true);
  });
});
```

(In the last test the client connection is closed by `withSupervisor`'s `sup.stop()`; to make the idle timer fire first, close it explicitly: `const { c } = await connect(…); c.close();` before the 900 ms wait.)

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Write `supervisor.ts`**

```ts
// packages/core/src/browser/daemon/supervisor.ts
//
// Owns the pipe to one chrome-headless-shell and multiplexes local clients
// onto it. Chrome stays alive with zero targets as long as this process
// holds the pipe (verified 2026-10-13: ten client connect/disconnect cycles
// against one browser). Each client gets ids from the connection's single
// allocator and only the events for sessions it attached; when a client's
// socket closes, the browser contexts it created are disposed, which is
// what Chrome's own disposeOnDetach would do if the client had held the
// pipe itself.

import net from 'node:net';
import { rm } from 'node:fs/promises';
import { CHROME_VERSION } from '../pins.js';
import { launchChrome, type LaunchedChrome } from '../launch.js';
import { NullFramer } from '../transport.js';
import type { RawMessage } from '../cdp.js';
import { clearState, writeState, type DaemonPaths, type DaemonState } from './state.js';

interface Client {
  socket: net.Socket;
  framer: NullFramer;
  ready: boolean;
  sessions: Set<string>;
  contexts: Set<string>;
}

interface Owner {
  client: Client;
  clientId: number;
  method: string;
  params: Record<string, unknown>;
}

export interface Supervisor {
  state: DaemonState;
  stop(): Promise<void>;
}

export async function startSupervisor(opts: {
  executablePath: string;
  args?: string[];
  paths: DaemonPaths;
  key: string;
  idleMinutes: number;
  onExit?: () => void;
}): Promise<Supervisor> {
  const chrome: LaunchedChrome = await launchChrome({
    executablePath: opts.executablePath,
    args: opts.args,
  });
  const { product } = await chrome.connection.send<{ product: string }>(
    'Browser.getVersion',
  );
  const clients = new Set<Client>();
  const owners = new Map<number, Owner>();
  let idleTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const rawSend = (c: Client, obj: object) => {
    if (!c.socket.destroyed) c.socket.write(JSON.stringify(obj) + '\0');
  };

  chrome.connection.onRaw = (m: RawMessage) => {
    if (m.id !== undefined) {
      const o = owners.get(m.id);
      if (!o) return; // the supervisor's own send; CdpConnection resolves it
      owners.delete(m.id);
      const result = (m.result ?? {}) as {
        sessionId?: string;
        browserContextId?: string;
      };
      if (o.method === 'Target.attachToTarget' && result.sessionId)
        o.client.sessions.add(result.sessionId);
      if (o.method === 'Target.createBrowserContext' && result.browserContextId)
        o.client.contexts.add(result.browserContextId);
      rawSend(o.client, { ...m, id: o.clientId });
      return;
    }
    if (!m.method) return;
    if (m.sessionId) {
      for (const c of clients) if (c.sessions.has(m.sessionId)) rawSend(c, m);
      // A child target auto-attached under a client's session belongs to that client.
      if (m.method === 'Target.attachedToTarget') {
        const p = m.params as { sessionId: string };
        for (const c of clients)
          if (c.sessions.has(m.sessionId)) c.sessions.add(p.sessionId);
      }
      return;
    }
    // Session-less events (Target.* on the browser session) go to every ready client.
    for (const c of clients) if (c.ready) rawSend(c, m);
  };

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (clients.size > 0) return;
    idleTimer = setTimeout(() => void stop('idle'), opts.idleMinutes * 60_000);
    idleTimer.unref();
  };

  const dropClient = async (c: Client) => {
    if (!clients.delete(c)) return;
    for (const id of c.contexts) {
      await chrome.connection
        .send('Target.disposeBrowserContext', { browserContextId: id })
        .catch(() => {});
    }
    scheduleIdle();
  };

  const onFrame = (c: Client, frame: string) => {
    let m: RawMessage & { jux?: string; version?: string };
    try {
      m = JSON.parse(frame);
    } catch {
      return;
    }
    if (!c.ready) {
      if (m.jux !== 'hello') return c.socket.destroy();
      if (m.version !== CHROME_VERSION) {
        rawSend(c, {
          method: 'jux.refused',
          params: { reason: `version ${m.version} != ${CHROME_VERSION}` },
        });
        return c.socket.end();
      }
      c.ready = true;
      rawSend(c, { method: 'jux.ready', params: { product } });
      return;
    }
    if (m.id === undefined || !m.method) return;
    const params = (m.params ?? {}) as Record<string, unknown>;
    if (
      m.method === 'Target.disposeBrowserContext' &&
      typeof params.browserContextId === 'string'
    ) {
      c.contexts.delete(params.browserContextId); // the client is disposing it; do not dispose again on drop
    }
    const id = chrome.connection.allocateId();
    owners.set(id, { client: c, clientId: m.id, method: m.method, params });
    chrome.connection.sendRaw({
      id,
      method: m.method,
      params,
      ...(m.sessionId ? { sessionId: m.sessionId } : {}),
    });
  };

  const server = net.createServer((socket) => {
    const c: Client = {
      socket,
      framer: new NullFramer(),
      ready: false,
      sessions: new Set(),
      contexts: new Set(),
    };
    clients.add(c);
    if (idleTimer) clearTimeout(idleTimer);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => c.framer.push(chunk, (frame) => onFrame(c, frame)));
    socket.on('close', () => void dropClient(c));
    socket.on('error', () => socket.destroy());
  });

  // A crashed daemon leaves its socket file behind; listen() would fail with
  // EADDRINUSE and every later client would wait 2 s then launch privately.
  if (process.platform !== 'win32') await rm(opts.paths.socket, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.paths.socket, resolve);
  });
  if (process.platform !== 'win32')
    await import('node:fs/promises').then((fs) => fs.chmod(opts.paths.socket, 0o600));

  const state: DaemonState = {
    pid: process.pid,
    socket: opts.paths.socket,
    binary: opts.executablePath,
    version: CHROME_VERSION,
    key: opts.key,
    startedAt: new Date().toISOString(),
    idleMinutes: opts.idleMinutes,
  };
  await writeState(opts.paths, state);
  scheduleIdle();

  chrome.connection.onClose = () => void stop('browser exited');

  async function stop(_reason: string): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const c of clients) c.socket.destroy();
    clients.clear();
    await new Promise<void>((r) => server.close(() => r()));
    await clearState(opts.paths);
    await chrome.close();
    opts.onExit?.();
  }

  return { state, stop: () => stop('stopped') };
}
```

- [ ] **Step 4: Write `supervisor-main.ts`** (the detached process entry)

```ts
// Entry for the detached daemon: `node supervisor-main.js '<json>'` where
// json is { executablePath, args, cacheDir, key, idleMinutes }. Stdio is
// detached by the launcher; this process lives until idle, `jux browser
// stop`, or the browser dies.
import { startSupervisor } from './supervisor.js';
import { daemonPaths } from './state.js';

const args = JSON.parse(process.argv[2]) as {
  executablePath: string;
  args: string[];
  cacheDir: string;
  key: string;
  idleMinutes: number;
};
const paths = daemonPaths(args.cacheDir, args.key);
const sup = await startSupervisor({ ...args, paths, onExit: () => process.exit(0) });
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void sup.stop());
```

- [ ] **Step 5: Run** `pnpm vitest run packages/core/src/browser/daemon && pnpm build && pnpm typecheck` → PASS (state 5 + supervisor 4). **Step 6: Commit**

```bash
pnpm format && git add packages/core/src/browser
git commit -m "core: warm-browser supervisor multiplexing clients over a local socket"
```

### Task 13: Client: connect, launch, fall back; `acquireBrowser` learns the daemon

**Files:**

- Create: `packages/core/src/browser/daemon/client.ts`
- Modify: `packages/core/src/browser/acquire.ts` (daemon first when enabled)
- Test: `packages/core/src/browser/daemon/client.test.ts`, `packages/core/src/browser/acquire.test.ts`

**Interfaces:**

- Consumes: `Browser.fromConnection`, `Browser.launch` (Task 6), `SocketTransport`, `CdpConnection` (Task 4), state helpers (Task 11), `supervisor-main.js` path (Task 12), `CHROME_VERSION`.
- Produces: `interface WarmOptions { executablePath: string; args?: string[]; cacheDir: string; env?: NodeJS.ProcessEnv; idleMinutes?: number; spawnDaemon?: (args: SpawnArgs) => void; connectTimeoutMs?: number }`, `interface SpawnArgs { executablePath: string; args: string[]; cacheDir: string; key: string; idleMinutes: number }`, `CI_ENV_VARS: readonly string[]`, `daemonEnabled(env: NodeJS.ProcessEnv, flagNoDaemon?: boolean): boolean`, `connectWarmBrowser(opts): Promise<{ browser: Browser; warm: boolean }>`, `daemonStatus(opts): Promise<DaemonState | null>`, `stopDaemon(opts): Promise<boolean>`. `acquireBrowser` gains the daemon branch; its signature is unchanged (`noDaemon` was reserved in Task 7).

- [ ] **Step 1: Write the tests** (client 4, acquire 1)

```ts
// packages/core/src/browser/daemon/client.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  connectWarmBrowser,
  daemonEnabled,
  daemonStatus,
  type SpawnArgs,
} from './client.js';
import { daemonKey, daemonPaths, writeState } from './state.js';
import { startSupervisor } from './supervisor.js';
import { CHROME_VERSION } from '../pins.js';
import { chromeForTests } from '../__tests__/helpers.js';

const chrome = chromeForTests();

describe('daemonEnabled', () => {
  it('is off with JUX_NO_DAEMON, the flag, or any CI marker', () => {
    expect(daemonEnabled({})).toBe(true);
    expect(daemonEnabled({ JUX_NO_DAEMON: '1' })).toBe(false);
    expect(daemonEnabled({}, true)).toBe(false);
    for (const v of [
      'CI',
      'JENKINS_URL',
      'TEAMCITY_VERSION',
      'BUILDKITE',
      'GITLAB_CI',
      'TF_BUILD',
      'CODEBUILD_BUILD_ID',
    ]) {
      expect(daemonEnabled({ [v]: '1' }), v).toBe(false);
    }
    expect(daemonEnabled({ CI: 'false' })).toBe(true);
  });
});

/** An in-process "daemon" so the test does not fork: the spawn hook starts a supervisor. */
function inProcessDaemon() {
  let spawned = 0;
  let sup: Awaited<ReturnType<typeof startSupervisor>> | null = null;
  const spawnDaemon = (a: SpawnArgs) => {
    spawned++;
    void startSupervisor({
      executablePath: a.executablePath,
      args: a.args,
      paths: daemonPaths(a.cacheDir, a.key),
      key: a.key,
      idleMinutes: a.idleMinutes,
    }).then((s) => (sup = s));
  };
  return {
    spawnDaemon,
    count: () => spawned,
    stop: async () => {
      await (sup as Awaited<ReturnType<typeof startSupervisor>> | null)?.stop();
    },
  };
}

async function withCache(fn: (cache: string) => Promise<void>) {
  const cache = await mkdtemp(path.join(tmpdir(), 'jux-client-'));
  try {
    await fn(cache);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

describe.skipIf(!chrome)('connectWarmBrowser', () => {
  it('stale state file is replaced: dead pid and a missing socket', () =>
    withCache(async (cache) => {
      const key = daemonKey({
        binary: chrome!.path,
        version: CHROME_VERSION,
        args: [],
        env: process.env,
      });
      const paths = daemonPaths(cache, key);
      await writeState(paths, {
        pid: 2 ** 22 - 1,
        socket: path.join(cache, 'gone.sock'),
        binary: chrome!.path,
        version: CHROME_VERSION,
        key,
        startedAt: '',
        idleMinutes: 10,
      });
      const d = inProcessDaemon();
      try {
        const t0 = Date.now();
        const { browser, warm } = await connectWarmBrowser({
          executablePath: chrome!.path,
          cacheDir: cache,
          spawnDaemon: d.spawnDaemon,
        });
        expect(Date.now() - t0).toBeLessThan(2500);
        expect(warm).toBe(true);
        expect(d.count()).toBe(1);
        expect(browser.version()).toBe(CHROME_VERSION);
        expect(
          (await daemonStatus({ executablePath: chrome!.path, cacheDir: cache }))?.pid,
        ).toBe(process.pid);
        await browser.close(); // closes this client's connection only
        const second = await connectWarmBrowser({
          executablePath: chrome!.path,
          cacheDir: cache,
          spawnDaemon: d.spawnDaemon,
        });
        expect(d.count()).toBe(1); // reused
        expect(second.warm).toBe(true);
        await second.browser.close();
      } finally {
        await d.stop();
      }
      expect(
        await daemonStatus({ executablePath: chrome!.path, cacheDir: cache }),
      ).toBeNull();
    }));
  it('spawn race yields one daemon', () =>
    withCache(async (cache) => {
      const d = inProcessDaemon();
      try {
        const all = await Promise.all(
          [1, 2, 3].map(() =>
            connectWarmBrowser({
              executablePath: chrome!.path,
              cacheDir: cache,
              spawnDaemon: d.spawnDaemon,
            }),
          ),
        );
        expect(d.count()).toBe(1);
        expect(all.every((b) => b.warm)).toBe(true);
        for (const b of all) await b.browser.close();
      } finally {
        await d.stop();
      }
    }));
  it('falls back to a private launch when the daemon cannot be spawned', () =>
    withCache(async (cache) => {
      const { browser, warm } = await connectWarmBrowser({
        executablePath: chrome!.path,
        cacheDir: cache,
        spawnDaemon: () => {
          throw new Error('no fork here');
        },
        connectTimeoutMs: 300,
      });
      expect(warm).toBe(false);
      expect(browser.isConnected()).toBe(true);
      await browser.close();
    }));
});
```

```ts
// packages/core/src/browser/acquire.test.ts
import { describe, it, expect } from 'vitest';
import { acquireBrowser } from './acquire.js';
import { chromeForTests } from './__tests__/helpers.js';

const chrome = chromeForTests();

describe.skipIf(!chrome)('acquireBrowser', () => {
  it('never touches the daemon in CI or with noDaemon', async () => {
    const boom = () => {
      throw new Error('daemon path used');
    };
    const a = await acquireBrowser({
      env: { ...process.env, CI: 'true' },
      connectWarm: boom,
    });
    expect(a.isConnected()).toBe(true);
    await a.close();
    const b = await acquireBrowser({
      env: { ...process.env, CI: '' },
      noDaemon: true,
      connectWarm: boom,
    });
    await b.close();
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing; `connectWarm` not an option).

- [ ] **Step 3: Write `client.ts`**

```ts
// packages/core/src/browser/daemon/client.ts
//
// Try the warm browser; never let it cost correctness or a hang. Every
// failure here — no daemon, stale file, refused hello, spawn race lost and
// the winner slow — ends in the same private launch PR 1 ships, within the
// connect budget (2 s).

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '../browser.js';
import { CdpConnection } from '../cdp.js';
import { CHROME_VERSION } from '../pins.js';
import { SocketTransport } from '../transport.js';
import {
  acquireLock,
  clearState,
  daemonKey,
  daemonPaths,
  pidAlive,
  readState,
  type DaemonPaths,
  type DaemonState,
} from './state.js';

export interface SpawnArgs {
  executablePath: string;
  args: string[];
  cacheDir: string;
  key: string;
  idleMinutes: number;
}

export interface WarmOptions {
  executablePath: string;
  args?: string[];
  cacheDir: string;
  env?: NodeJS.ProcessEnv;
  idleMinutes?: number;
  spawnDaemon?: (args: SpawnArgs) => void;
  connectTimeoutMs?: number;
}

const DEFAULT_IDLE_MINUTES = 10;
const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
const PROBE_TIMEOUT_MS = 500;

/** `CI` is the convention; these are the systems that do not set it. */
export const CI_ENV_VARS = [
  'CI',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'BUILDKITE',
  'GITLAB_CI',
  'TF_BUILD',
  'CODEBUILD_BUILD_ID',
] as const;

export function daemonEnabled(env: NodeJS.ProcessEnv, flagNoDaemon = false): boolean {
  if (flagNoDaemon) return false;
  if (env.JUX_NO_DAEMON === '1') return false;
  for (const v of CI_ENV_VARS) {
    const value = env[v];
    if (value && value !== 'false' && value !== '0') return false;
  }
  return true;
}

function keyFor(opts: WarmOptions): string {
  return daemonKey({
    binary: opts.executablePath,
    version: CHROME_VERSION,
    args: opts.args ?? [],
    env: opts.env ?? process.env,
  });
}

function pathsFor(opts: WarmOptions): DaemonPaths {
  return daemonPaths(opts.cacheDir, keyFor(opts));
}

/** One connect + hello; null on refusal, error or no answer within `timeoutMs`. */
function tryConnect(
  socketPath: string,
  timeoutMs: number,
): Promise<{ connection: CdpConnection; product: string } | null> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, timeoutMs);
    sock.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    sock.once('connect', () => {
      const t = new SocketTransport(sock);
      const c = new CdpConnection(t);
      c.once<{ product: string }>('jux.ready').then(
        (p) => {
          clearTimeout(timer);
          resolve({ connection: c, product: p.product });
        },
        () => resolve(null),
      );
      c.once('jux.refused').then(
        () => {
          clearTimeout(timer);
          c.close();
          resolve(null);
        },
        () => {},
      );
      t.send(JSON.stringify({ jux: 'hello', version: CHROME_VERSION }));
    });
  });
}

function defaultSpawn(args: SpawnArgs): void {
  const entry = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'supervisor-main.js',
  );
  const child = spawn(process.execPath, [entry, JSON.stringify(args)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function privateLaunch(
  opts: WarmOptions,
): Promise<{ browser: Browser; warm: false }> {
  return {
    browser: await Browser.launch({
      executablePath: opts.executablePath,
      args: opts.args,
    }),
    warm: false,
  };
}

export async function connectWarmBrowser(
  opts: WarmOptions,
): Promise<{ browser: Browser; warm: boolean }> {
  const paths = pathsFor(opts);
  const deadline = Date.now() + (opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  const wrap = (c: { connection: CdpConnection; product: string }) => ({
    browser: Browser.fromConnection(c.connection, {
      version: c.product,
      close: async () => c.connection.close(),
    }),
    warm: true,
  });

  const existing = await readState(paths);
  if (existing) {
    // A short probe: a live daemon answers in milliseconds; a dead one must
    // not eat the whole budget before we get to launch our own.
    const c =
      existing.binary === opts.executablePath && pidAlive(existing.pid)
        ? await tryConnect(existing.socket, PROBE_TIMEOUT_MS)
        : null;
    if (c) return wrap(c);
    await clearState(paths); // stale: dead pid, other binary, or a socket that does not answer
  }

  const release = await acquireLock(paths);
  if (release) {
    try {
      (opts.spawnDaemon ?? defaultSpawn)({
        executablePath: opts.executablePath,
        args: opts.args ?? [],
        cacheDir: opts.cacheDir,
        key: keyFor(opts),
        idleMinutes: opts.idleMinutes ?? DEFAULT_IDLE_MINUTES,
      });
    } catch {
      await release();
      return privateLaunch(opts);
    }
  }
  // Winner or loser: poll for the state file until the deadline.
  try {
    while (Date.now() < deadline) {
      const s = await readState(paths);
      if (s && pidAlive(s.pid)) {
        const c = await tryConnect(
          s.socket,
          Math.min(PROBE_TIMEOUT_MS, Math.max(100, deadline - Date.now())),
        );
        if (c) return wrap(c);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    if (release) await release();
  }
  return privateLaunch(opts);
}

export async function daemonStatus(
  opts: Pick<WarmOptions, 'executablePath' | 'cacheDir' | 'args' | 'env'>,
): Promise<DaemonState | null> {
  const paths = pathsFor(opts);
  const s = await readState(paths);
  if (!s) return null;
  if (!pidAlive(s.pid)) {
    await clearState(paths);
    return null;
  }
  return s;
}

/** SIGTERM the supervisor (it closes Chrome and clears its state); true if one was running. */
export async function stopDaemon(
  opts: Pick<WarmOptions, 'executablePath' | 'cacheDir' | 'args' | 'env'>,
): Promise<boolean> {
  const s = await daemonStatus(opts);
  if (!s) return false;
  try {
    process.kill(s.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  for (let i = 0; i < 40 && pidAlive(s.pid); i++)
    await new Promise((r) => setTimeout(r, 50));
  await clearState(pathsFor(opts));
  return true;
}
```

`stopDaemon` is exercised end to end by `jux browser stop` in Task 14 (the in-process test daemon shares vitest's pid, so it is not unit-tested here).

- [ ] **Step 4: Teach `acquire.ts` the daemon**

```ts
import { connectWarmBrowser, daemonEnabled } from './daemon/client.js';
import { juxCacheDir } from './resolve.js';

export interface AcquireOptions {
  chrome?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  noDaemon?: boolean;
  /** Test seam. */
  connectWarm?: typeof connectWarmBrowser;
}

export async function acquireBrowser(opts: AcquireOptions = {}): Promise<Browser> {
  const env = opts.env ?? process.env;
  const resolved = resolveChrome({ flag: opts.chrome, env });
  if (!resolved) throw new Error(noBrowserMessage());
  if (!daemonEnabled(env, opts.noDaemon))
    return Browser.launch({ executablePath: resolved.path, spawn: opts.spawn });
  const idleMinutes = Number(env.JUX_BROWSER_IDLE_MINUTES) || undefined;
  const { browser } = await (opts.connectWarm ?? connectWarmBrowser)({
    executablePath: resolved.path,
    cacheDir: juxCacheDir({ env }),
    env,
    idleMinutes,
  });
  return browser;
}
```

- [ ] **Step 5: Run** `pnpm vitest run packages/core/src/browser && pnpm build && pnpm typecheck` → PASS (client 4, acquire 1, plus the rest). **Step 6: Export** `connectWarmBrowser, daemonEnabled, daemonStatus, stopDaemon, CI_ENV_VARS, type WarmOptions, type SpawnArgs` from `browser/index.ts` and `core/src/index.ts`. **Step 7: Commit**

```bash
pnpm format && git add packages/core/src
git commit -m "core: warm-browser client with stale-state recovery and private-launch fallback; acquireBrowser prefers it"
```

### Task 14: `jux browser start|stop|status`, `--no-daemon`, docs, determinism with the daemon

**Files:**

- Modify: `packages/cli/src/commands/browser.ts` (`start`, `stop`; `status` shows the daemon line)
- Modify: `packages/cli/src/index.ts` (`--no-daemon` flag for `snap`, `run`, `init` → `acquireBrowser({ chrome, noDaemon })`; help text)
- `packages/server/src/source.ts` is unchanged: a long-lived server is its own warm browser and keeps using `acquireBrowser()` (which, outside CI, now shares the daemon — fine, its contexts are its own).
- Modify: `README.md` (Browser section: warm browser paragraph), `CLAUDE.md` (one line under "Determinism failures": the daemon must stay byte-identical; `check:determinism` runs both ways), `.github/workflows/ci.yml` (a second determinism step: `run: env -u CI pnpm check:determinism -- --daemon`)
- Modify: `scripts/check-determinism.mjs` (parse a `--daemon` flag out of `argv` before the positionals; with it, after the first run require `jux browser status --json` to report `daemon.pid`)
- Create: `.changeset/warm-browser.md` (minor: core, cli)
- Test: `packages/cli/src/commands/browser.test.ts` (extend by 1)

- [ ] **Step 1: Extend `browser.test.ts`**

```ts
it('stop with no daemon running says so and exits clean', async () => {
  const out: string[] = [];
  const code = await browserCommand(['stop'], false, {
    env: { ...process.env, JUX_CACHE_DIR: '/nonexistent/x' },
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  expect(out.join('')).toMatch(/no warm browser/);
});
```

- [ ] **Step 2: Extend `browserCommand`** (inside the function, before the unknown-subcommand line)

```ts
if (sub === 'start' || sub === 'stop') {
  const r = resolveChrome({ env: io.env });
  if (sub === 'stop') {
    const stopped = r
      ? await stopDaemon({
          executablePath: r.path,
          cacheDir: juxCacheDir({ env: io.env }),
          env: io.env,
        })
      : false;
    io.write(
      json
        ? JSON.stringify({ stopped }) + '\n'
        : `jux: ${stopped ? 'stopped the warm browser' : 'no warm browser running'}\n`,
    );
    return EXIT.clean;
  }
  if (!r) {
    io.write(`${noBrowserMessage()}\n`);
    return EXIT.failure;
  }
  const { browser, warm } = await connectWarmBrowser({
    executablePath: r.path,
    cacheDir: juxCacheDir({ env: io.env }),
    env: io.env,
  });
  await browser.close();
  io.write(
    json
      ? JSON.stringify({ warm }) + '\n'
      : `jux: warm browser ${warm ? 'running' : 'could not start; captures will launch privately'}\n`,
  );
  return warm ? EXIT.clean : EXIT.failure;
}
```

and in `status`, after the resolved line: `const d = await daemonStatus({ executablePath: r.path, cacheDir: juxCacheDir({ env: io.env }), env: io.env });` printed as `daemon: { pid, startedAt, idleMinutes } | null` in JSON and `  warm browser: pid <pid>, started <startedAt>, idle exit after <idleMinutes> min` / `  warm browser: not running` in text. Imports: `connectWarmBrowser, daemonStatus, stopDaemon` from `@juxtapose/core`. Help lines:

```
  jux browser start|stop         keep one browser warm between runs (on by default; JUX_NO_DAEMON=1,
                                 --no-daemon, or any CI variable turns it off)
```

- [ ] **Step 3: `check-determinism.mjs`**: at the top, `const daemon = process.argv.includes('--daemon'); const positional = process.argv.slice(2).filter((a) => a !== '--daemon');` and use `positional[0]`/`positional[1]` for the example dir and run count. After run 1, when `daemon`: `const status = JSON.parse((await run('node', [cli, 'browser', 'status', '--json'], { cwd: exampleDir })).stdout); if (!status.daemon?.pid) fail('expected the warm browser to be running after run 1');`.

- [ ] **Step 4: Run** `pnpm build && pnpm typecheck && pnpm test && node scripts/check-snap.mjs` → green.

- [ ] **Step 5: Determinism and parity with the daemon**

```bash
node packages/cli/dist/index.js browser stop
env -u CI pnpm check:determinism -- --daemon      # first run spawns the daemon; expect OK, 3 runs
node packages/cli/dist/index.js browser status    # expect a warm browser line with a pid
node scripts/check-parity.mjs compare examples/storybook /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-hashes.json       # warm: 15/15
node scripts/check-parity.mjs compare examples/ladle /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-ladle-hashes.json      # warm: 14/14
JUX_NO_DAEMON=1 node scripts/check-parity.mjs compare examples/storybook /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-hashes.json  # cold: 15/15
node packages/cli/dist/index.js browser stop      # expect "stopped the warm browser"; `pgrep -f jux-chrome` empty
```

- [ ] **Step 6: Measure `jux snap` warm p50** (10 runs after one warm-up; the spike's wall was 305–327 ms):

```bash
node /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/serve.mjs examples/storybook/storybook-static 4799 &
node packages/cli/dist/index.js snap "http://127.0.0.1:4799/iframe.html?id=button--primary&viewMode=story" --as warmup >/dev/null
for i in $(seq 10); do /usr/bin/time -p node packages/cli/dist/index.js snap "http://127.0.0.1:4799/iframe.html?id=button--primary&viewMode=story" --as w$i 2>&1 | grep real; done
```

Expected p50 ≤ 330 ms. Also time `jux run --all` on both examples 3× warm; record in the PR with the PR 1 and main numbers side by side.

- [ ] **Step 7: Docs, changeset, commit**

```md
---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

Keep one browser warm between `jux snap` and `jux run` invocations (per user, per environment, idle exit after 10 minutes). Off in CI and with `JUX_NO_DAEMON=1` or `--no-daemon`. Captures are byte-identical warm and cold. `jux browser start|stop|status` manage it.
```

```bash
pnpm format && git add -u && git add .changeset/warm-browser.md
git commit -m "cli: warm browser by default outside CI; jux browser start|stop|status"
```

Open PR 2 against PR 1's branch with the Step 5 and 6 outputs.

---

## Self-review

- Spec coverage: decisions 1–5 → Tasks 5–7; 6–10 → Tasks 1–3, 9, 10; 11 → Task 6 (`stripProduct`); 12 → Task 10 (engines 22.2); 13–18 → Tasks 11–14; seam → Tasks 7–8; migration/docs/CI → Task 10; security → Tasks 11–13; run concurrency → unchanged `pool.ts` over Task 6's `Browser`; verification bar → Task 7 Step 13, Task 9 Step 6, Task 10 Steps 4–6, Task 14 Steps 5–6.
- Pre-flight defects: 1 (T1 test paths/markers/count) → Task 1; 2 (crc test) → Task 2, run and verified; 3 (fixture in dist, double buffering, proxy) → Tasks 2–3; 4 (transport duplication, `once` on close, `unknown` params) → Task 4; 5 (unhandled early rejection, `proc.on('error')`) → Task 5; 6 (build red T7–T9) → Task 7 Step 10; 7 (goto hang, mask stride, clearOrigin session) → Task 6; 8 (snap never warm) → Task 7 `acquireBrowser` + injected `browser`; 9 (EXIT names, undefined helper, run.ts error path) → Tasks 7, 9; 10 (module patching) → Tasks 5, 10; 11 (leftover socket) → Tasks 11–12; 12 (id collision, context tracking, child sessions) → Tasks 4, 12; 13 (stopDaemon kills vitest, probe budget) → Task 13; 14 (pseudo-code, skipIf, `--daemon`) → Task 14; 15 (page init extras, goto frameId) → Task 6; 16 (lockfile) → controller checkpoint after Task 9; 17 (tautological test, structure fake) → Task 7; 18 (adapter tests don't exist) → Task 8; 19 (non-CSS breaking change, fixture via `setContent`) → Tasks 10, 7.
- Type consistency: `Page.onMainResponse` and `Page.clearOrigin` are defined in Task 6 and used by Task 7's `snap.ts` and the fakes in Tasks 7 and 8; `CdpConnection.allocateId/sendRaw/onRaw/RawMessage` are defined in Task 4 and consumed by Task 12; `Browser.fromConnection` (Task 6) is what Task 13 consumes; `acquireBrowser`'s `noDaemon` is reserved in Task 7 and implemented in Task 13; `connectWarmBrowser`'s `warm` flag is what Task 14's `start` reports; `EXIT.clean/review/usage/failure` are the names in `packages/cli/src/exit-codes.ts`.
- Review Focus 1–5 each name their task and test above.
