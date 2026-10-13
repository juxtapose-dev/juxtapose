# CDP Driver and Warm Browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Playwright with juxtapose's own minimal CDP driver and a pinned Chrome for Testing `chrome-headless-shell`, byte-identical to today's captures (PR 1), then keep one browser warm between invocations behind a per-user supervisor (PR 2).

**Architecture:** A `packages/core/src/browser/` module speaks raw CDP over Chrome's pipe (PR 1) or a local socket to a supervisor that owns the pipe (PR 2). `Page` becomes our own interface with the Playwright-shaped subset the adapters already use, so each adapter changes one import line. Launch flags, page initialization and the screenshot call are verbatim ports of playwright-core 1.62.0, which the spike proved produce identical bytes on both examples (15/15, 14/14). The browser is downloaded from Chrome for Testing with sha256 pins we measured, or reused from an existing ms-playwright cache.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), vitest, sharp (unchanged), `node:net`/`node:child_process`/`node:zlib`/`node:crypto`/`fetch` only. No new dependencies. pnpm workspaces, changesets.

**Spec:** `docs/specs/2026-10-13-cdp-driver-warm-browser-design.md`. Decisions 1–16 and the "What Playwright does for us" map (file:line into `node_modules/.pnpm/playwright-core@1.62.0/node_modules/playwright-core/lib/coreBundle.js`) are the contract. The spike that proved byte identity is at `/Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/proto.mjs` and `args.mjs`; when a task says "as the spike does", open it.

## Global Constraints

- Pass/fail stays `sha256(lossless WebP)`. Every task that touches capture ends by running `pnpm build && pnpm check:determinism` and, from Task 7 on, `node scripts/check-parity.mjs compare examples/storybook /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-hashes.json` — 15/15 or the task is not done.
- The ordering in `packages/core/src/capture/capture.ts:60-214` does not change. The port replaces calls, never moves them.
- Launch flags: `PARITY_CHROMIUM_ARGS` is the verbatim playwright-core 1.62.0 list (spec §Decisions 2), followed by `DETERMINISTIC_CHROMIUM_ARGS` unchanged (`packages/core/src/capture/launch.ts:37-49`), followed by caller args.
- Page init is the verbatim sequence from spec §"Page init", including `Page.setFontFamilies` per OS and `Emulation.setEmulatedMedia` with `prefers-color-scheme: light`.
- Pinned browser: `CHROME_VERSION = '151.0.7922.34'`; sha256 per platform exactly as in spec §Decisions 6; `MS_PLAYWRIGHT_REVISION = '1234'`.
- `CaptureEnv.browser` stays `"151.0.7922.34"` (strip `HeadlessChrome/`).
- No `playwright` in any shipped `package.json` or `packages/*/src` after Task 10 (`grep -rn playwright packages/*/package.json packages/*/src` prints nothing).
- Node engines `>=22.0.0` in every package and the root.
- Mask selectors are CSS; a non-CSS selector throws `jux: mask selector '<sel>' is not a CSS selector` before any capture.
- Daemon (PR 2) is off when `JUX_NO_DAEMON=1`, `--no-daemon`, or `CI=true`; never a `--remote-debugging-port`.
- Lazy imports stay: `packages/cli/src/index.ts` keeps `await import('./commands/…')`; `jux diff` loads no browser code (`scripts/check-diff.mjs` probe).
- Comments say why and carry the number; no dead options; typed throughout.
- Run `pnpm format` before every commit; commit messages end with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01WpCZfVW62Xa6dH2JkGBmYL`.
- Scratch files only under `/Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/`. Never `git stash`, `git add -A`, `git reset --hard`.

## Review Focus

1. **A story whose `mask` uses Playwright syntax** (`text=Clock`, `div >> span`). Expect a thrown `jux: mask selector … is not a CSS selector` and the story reported as an error, never a silently unmasked baseline. Test: Task 6 (`selectors.test.ts`, "rejects Playwright-only syntax") and Task 7 (`capture.test.ts`, "a non-CSS mask fails the story, not the run").
2. **A page that never fires `load`** (a hanging request, `about:blank` redirect to a stalled host). Expect `goto` to reject after the capture timeout with the URL in the message and the pool to keep going. Test: Task 6 (`page.test.ts`, "goto rejects on timeout with the url").
3. **A browser that dies mid-run** (OOM, `kill -9` of the shell). Expect every pending `send` to reject with `TargetClosedError`, `browser.isConnected()` false, and `jux run` to report the remaining stories as errors with one line naming the cause, not a hang. Test: Task 4 (`cdp.test.ts`, "transport close rejects pending") and Task 5 (`launch.test.ts`, "killing the process rejects in-flight sends").
4. **A stale daemon state file** (machine rebooted, `pid` reused by another process, socket gone). Expect the client to detect it within 2 s, unlink it, and launch — never a hang and never a connection to a foreign process. Test: Task 13 (`client.test.ts`, "stale state file is replaced").
5. **Two `jux` invocations starting at once with no daemon** (a watch mode and a CLI run). Expect exactly one supervisor; the loser waits ≤ 2 s for the state file and otherwise launches privately. Test: Task 13 (`client.test.ts`, "spawn race yields one daemon").

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
  - `pins.ts`: `CHROME_VERSION: '151.0.7922.34'`, `MS_PLAYWRIGHT_REVISION: '1234'`, `type ChromePlatform = 'linux64' | 'mac-arm64' | 'mac-x64' | 'win64'`, `interface ChromePin { platform: ChromePlatform; url: string; sha256: string; bytes: number }`, `CHROME_PINS: Record<ChromePlatform, ChromePin>`, `chromePlatform(platform?: NodeJS.Platform, arch?: string): ChromePlatform` (throws for unsupported).
  - `resolve.ts`: `interface ResolveOptions { flag?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string; homedir?: string; exists?: (p: string) => boolean }`, `type ChromeSource = 'flag' | 'env' | 'jux-cache' | 'ms-playwright'`, `interface ResolvedChrome { path: string; source: ChromeSource }`, `resolveChrome(opts?): ResolvedChrome | null`, `juxCacheDir(opts?): string`, `chromeInstallDir(cacheDir: string, version?: string): string`, `chromeBinaryPath(installDir: string, platform: ChromePlatform): string`, `msPlaywrightBinaryPath(opts?): string`, `NO_BROWSER_MESSAGE: string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/browser/resolve.test.ts
import { describe, it, expect } from 'vitest';
import {
  resolveChrome,
  juxCacheDir,
  chromeInstallDir,
  chromeBinaryPath,
  msPlaywrightBinaryPath,
  NO_BROWSER_MESSAGE,
} from './resolve.js';
import { CHROME_PINS, CHROME_VERSION, chromePlatform } from './pins.js';

const mac = { platform: 'darwin' as const, arch: 'arm64', homedir: '/Users/u', env: {} };

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
    expect(
      juxCacheDir({ ...mac, platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' } }),
    ).toBe('C:\\L\\jux');
    expect(juxCacheDir({ ...mac, env: { JUX_CACHE_DIR: '/tmp/c' } })).toBe('/tmp/c');
  });
  it('lays the install out like the zip does', () => {
    const dir = chromeInstallDir('/c', '151.0.7922.34');
    expect(dir).toBe('/c/chrome-headless-shell/151.0.7922.34');
    expect(chromeBinaryPath(dir, 'mac-arm64')).toBe(
      '/c/chrome-headless-shell/151.0.7922.34/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
    expect(chromeBinaryPath(dir, 'win64')).toMatch(
      /chrome-headless-shell-win64\/chrome-headless-shell\.exe$/,
    );
  });
  it('knows where Playwright keeps the same build', () => {
    expect(msPlaywrightBinaryPath(mac)).toBe(
      '/Users/u/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
    expect(
      msPlaywrightBinaryPath({ ...mac, env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' } }),
    ).toBe(
      '/pw/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
  });
});

describe('resolveChrome', () => {
  const juxBin =
    '/Users/u/Library/Caches/jux/chrome-headless-shell/151.0.7922.34/chrome-headless-shell-mac-arm64/chrome-headless-shell';
  const pwBin =
    '/Users/u/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
  const have =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);

  it('prefers flag, then env, then the jux cache, then ms-playwright', () => {
    expect(
      resolveChrome({
        ...mac,
        flag: '/f',
        env: { JUX_CHROME: '/e' },
        exists: have('/f', '/e', juxBin, pwBin),
      }),
    ).toEqual({ path: '/f', source: 'flag' });
    expect(
      resolveChrome({
        ...mac,
        env: { JUX_CHROME: '/e' },
        exists: have('/e', juxBin, pwBin),
      }),
    ).toEqual({ path: '/e', source: 'env' });
    expect(resolveChrome({ ...mac, exists: have(juxBin, pwBin) })).toEqual({
      path: juxBin,
      source: 'jux-cache',
    });
    expect(resolveChrome({ ...mac, exists: have(pwBin) })).toEqual({
      path: pwBin,
      source: 'ms-playwright',
    });
  });
  it('requires the install markers, not just the binary', () => {
    // A half-extracted install must not be used: the marker is written last.
    expect(resolveChrome({ ...mac, exists: have(juxBin) })).toBeNull();
  });
  it('a flag or env that points nowhere is an error, not a fallthrough', () => {
    expect(() => resolveChrome({ ...mac, flag: '/nope', exists: have(juxBin) })).toThrow(
      /\/nope/,
    );
    expect(() =>
      resolveChrome({ ...mac, env: { JUX_CHROME: '/nope' }, exists: have(juxBin) }),
    ).toThrow(/JUX_CHROME/);
  });
  it('returns null when nothing resolves, and the message names the fix', () => {
    expect(resolveChrome({ ...mac, exists: () => false })).toBeNull();
    expect(NO_BROWSER_MESSAGE).toMatch(/jux browser install/);
    expect(NO_BROWSER_MESSAGE).toMatch(/JUX_CHROME/);
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
  'jux: no browser. Run `jux browser install`, or set JUX_CHROME=<path to a Chromium headless shell>.';

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
Expected: PASS (13 tests). Note the ms-playwright marker test: `have(pwBin)` alone must fail the marker check — add `'/Users/u/Library/Caches/ms-playwright/chromium_headless_shell-1234/INSTALLATION_COMPLETE'` to the `have(...)` lists in the two cases that expect `ms-playwright`, and `'/Users/u/Library/Caches/jux/chrome-headless-shell/151.0.7922.34/.complete'` to the ones expecting `jux-cache`.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add packages/core/src/browser/pins.ts packages/core/src/browser/resolve.ts packages/core/src/browser/resolve.test.ts
git commit -m "core: pin chrome-headless-shell 151.0.7922.34 and resolve the binary"
```

### Task 2: Zip extraction without a dependency

**Files:**

- Create: `packages/core/src/browser/zip.ts`
- Test: `packages/core/src/browser/zip.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `interface ZipEntry { name: string; mode: number; isDirectory: boolean; data: Buffer }`, `readZip(buf: Buffer): ZipEntry[]`, `extractZip(buf: Buffer, dir: string): Promise<string[]>` (returns written paths; refuses `..`, absolute names and symlink entries).

- [ ] **Step 1: Write the failing test** (builds a real zip by hand — the format is small enough)

```ts
// packages/core/src/browser/zip.test.ts
import { describe, it, expect } from 'vitest';
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readZip, extractZip } from './zip.js';

interface Spec {
  name: string;
  data: Buffer;
  mode: number;
  stored?: boolean;
  symlink?: boolean;
}

/** Minimal zip writer: local headers + central directory + EOCD, no zip64. */
function buildZip(specs: Spec[]): Buffer {
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
    central.writeUInt32LE(((type | s.mode) >>> 0) * 0x10000, 38); // external attrs: unix mode in the high 16 bits
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
    const broken = Buffer.from(zip);
    broken[30 + 'shell-x/'.length + 30 + 'shell-x/chrome-headless-shell'.length + 2] ^=
      0xff;
    expect(() => readZip(broken)).toThrow(/crc/i);
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

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/browser/zip.test.ts`
Expected: FAIL — cannot find `./zip.js`.

- [ ] **Step 3: Write `zip.ts`**

```ts
// packages/core/src/browser/zip.ts
//
// A zip reader for exactly one input: Chrome for Testing's
// chrome-headless-shell-<platform>.zip. Those zips are deflate or stored, no
// zip64 (120 MB, 287 entries on linux64), no symlinks (verified with zipinfo
// on linux64 and mac-arm64, 2026-10-13). Anything else is refused rather
// than guessed at. ~100 lines beats a dependency whose other 95% we never
// call, and `unzip` is absent from minimal Linux images.

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
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff)
      throw new Error('zip: zip64 is not supported');

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
    const mode = attrs >>> 16;
    entries.push({ name, mode, isDirectory: name.endsWith('/'), data });
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
    if (target !== root && !target.startsWith(root + path.sep))
      throw new Error(`zip: entry escapes the target (..): ${e.name}`);
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/browser/zip.test.ts`
Expected: PASS (4 tests). If the crc test's byte offset misses the body, change the corruption to `broken[broken.length - 22 - 60] ^= 0xff` (inside the last central header's name) and expect `/central|crc/`.

- [ ] **Step 5: Commit**

```bash
pnpm format && git add packages/core/src/browser/zip.ts packages/core/src/browser/zip.test.ts
git commit -m "core: minimal zip reader for the chrome-headless-shell download"
```

### Task 3: Installer

**Files:**

- Create: `packages/core/src/browser/install.ts`
- Test: `packages/core/src/browser/install.test.ts`

**Interfaces:**

- Consumes: `CHROME_PINS`, `CHROME_VERSION`, `chromePlatform` (Task 1); `chromeInstallDir`, `chromeBinaryPath`, `INSTALL_MARKER` (Task 1); `extractZip` (Task 2).
- Produces: `interface InstallOptions { cacheDir: string; platform?: ChromePlatform; fetch?: typeof fetch; onProgress?: (received: number, total: number | null) => void }`, `interface InstallResult { path: string; version: string; alreadyInstalled: boolean }`, `installChrome(opts): Promise<InstallResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/browser/install.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installChrome } from './install.js';
import { CHROME_PINS } from './pins.js';

// Reuse the hand-built zip from zip.test.ts by importing its builder; move
// buildZip into packages/core/src/browser/__fixtures__/zip-builder.ts in this
// task and import it from both tests.
import { buildZip } from './__fixtures__/zip-builder.js';

const zip = buildZip([
  { name: 'chrome-headless-shell-mac-arm64/', data: Buffer.alloc(0), mode: 0o755 },
  {
    name: 'chrome-headless-shell-mac-arm64/chrome-headless-shell',
    data: Buffer.from('#!/bin/sh\n'),
    mode: 0o755,
  },
]);
const sha = createHash('sha256').update(zip).digest('hex');

function fakeFetch(body: Buffer, status = 200): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { 'content-length': String(body.length) },
    })) as typeof fetch;
}

describe('installChrome', () => {
  it('downloads, verifies, extracts, marks complete, and is idempotent', async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'jux-install-'));
    const pin = { ...CHROME_PINS['mac-arm64'], sha256: sha, bytes: zip.length };
    try {
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
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
  it('refuses a checksum mismatch and leaves no install behind', async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'jux-install-'));
    try {
      await expect(
        installChrome({ cacheDir, platform: 'mac-arm64', fetch: fakeFetch(zip) }),
      ).rejects.toThrow(/sha256/);
      await expect(
        stat(path.join(cacheDir, 'chrome-headless-shell/151.0.7922.34')),
      ).rejects.toThrow();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
  it('reports an HTTP failure with the url', async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'jux-install-'));
    try {
      await expect(
        installChrome({
          cacheDir,
          platform: 'linux64',
          fetch: fakeFetch(Buffer.alloc(0), 403),
        }),
      ).rejects.toThrow(/403.*linux64/);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
```

Also add `pin?: ChromePin` to `InstallOptions` (test override; defaults to `CHROME_PINS[platform]`).

- [ ] **Step 2: Move `buildZip` to `packages/core/src/browser/__fixtures__/zip-builder.ts`** (export it; `zip.test.ts` imports it), run `pnpm vitest run packages/core/src/browser` — zip tests still PASS, install tests FAIL on the missing module.

- [ ] **Step 3: Write `install.ts`**

```ts
// packages/core/src/browser/install.ts
//
// Download → sha256 → extract into a temp sibling → rename into place → write
// the marker last. The marker is what resolve.ts trusts, so an interrupted
// install can never be mistaken for a working one.

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
  onProgress?: (received: number, total: number | null) => void;
  /** Test seam: a pin for a fixture zip. */
  pin?: ChromePin;
}

export interface InstallResult {
  path: string;
  version: string;
  alreadyInstalled: boolean;
}

export async function installChrome(opts: InstallOptions): Promise<InstallResult> {
  const platform = opts.platform ?? chromePlatform();
  const pin = opts.pin ?? CHROME_PINS[platform];
  const installDir = chromeInstallDir(opts.cacheDir, CHROME_VERSION);
  const binary = chromeBinaryPath(installDir, platform);

  if ((await exists(path.join(installDir, INSTALL_MARKER))) && (await exists(binary))) {
    return { path: binary, version: CHROME_VERSION, alreadyInstalled: true };
  }

  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(pin.url);
  if (!res.ok || !res.body)
    throw new Error(`jux: download failed: HTTP ${res.status} for ${pin.url}`);
  const total = Number(res.headers.get('content-length')) || null;
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
Expected: PASS (zip 4, install 3, resolve 13).

- [ ] **Step 5: Commit**

```bash
pnpm format && git add packages/core/src/browser
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
  - `transport.ts`: `interface Transport { send(message: string): void; onMessage: ((message: string) => void) | null; onClose: ((reason?: string) => void) | null; close(): void }`, `class PipeTransport implements Transport` (`constructor(writable: NodeJS.WritableStream, readable: NodeJS.ReadableStream)`), `class SocketTransport implements Transport` (`constructor(socket: net.Socket)`), `class NullFramer { push(chunk: Buffer | string, onFrame: (s: string) => void): void }`.
  - `cdp.ts`: `class CdpError extends Error { code: number }`, `class TargetClosedError extends Error`, `class CdpConnection { constructor(transport: Transport); send<T = unknown>(method: string, params?: object, sessionId?: string): Promise<T>; on(method: string, handler: (params: any, sessionId?: string) => void, sessionId?: string): () => void; once<P = any>(method: string, sessionId?: string, predicate?: (p: P) => boolean): Promise<P>; readonly closed: boolean; onClose: ((reason?: string) => void) | null; close(): void }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/browser/cdp.test.ts
import { describe, it, expect } from 'vitest';
import { CdpConnection, CdpError, TargetClosedError } from './cdp.js';
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
      (p: { name: string }) => got.push('S1:' + p.name),
      'S1',
    );
    c.on('Page.lifecycleEvent', (p: { name: string }) => got.push('S2:' + p.name), 'S2');
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
  it('transport close rejects pending sends and future sends with TargetClosedError', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const pending = c.send('Page.navigate', { url: 'x' }, 'S1');
    let reason: string | undefined;
    c.onClose = (r) => (reason = r);
    t.close();
    await expect(pending).rejects.toBeInstanceOf(TargetClosedError);
    await expect(c.send('Browser.getVersion')).rejects.toBeInstanceOf(TargetClosedError);
    expect(c.closed).toBe(true);
    expect(reason).toBe('closed by test');
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

export class PipeTransport implements Transport {
  onMessage: ((message: string) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  private readonly framer = new NullFramer();
  private closed = false;

  constructor(
    private readonly writable: NodeJS.WritableStream,
    readable: NodeJS.ReadableStream,
  ) {
    readable.on('data', (chunk: Buffer) =>
      this.framer.push(chunk, (f) => this.onMessage?.(f)),
    );
    readable.on('close', () => this.emitClose('pipe closed'));
    readable.on('error', (e: Error) => this.emitClose(e.message));
    writable.on('error', (e: Error) => this.emitClose(e.message));
  }
  send(message: string): void {
    if (this.closed) return;
    this.writable.write(message + '\0');
  }
  close(): void {
    this.emitClose('closed');
  }
  private emitClose(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }
}

export class SocketTransport implements Transport {
  onMessage: ((message: string) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  private readonly framer = new NullFramer();
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) =>
      this.framer.push(chunk, (f) => this.onMessage?.(f)),
    );
    socket.on('close', () => this.emitClose('socket closed'));
    socket.on('error', (e) => this.emitClose(e.message));
  }
  send(message: string): void {
    if (this.closed) return;
    this.socket.write(message + '\0');
  }
  close(): void {
    this.socket.destroy();
    this.emitClose('closed');
  }
  private emitClose(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
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

import type { Transport } from './transport.js';

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

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

type Handler = (params: unknown, sessionId?: string) => void;

export class CdpConnection {
  private lastId = 0;
  private readonly pending = new Map<number, Pending>();
  /** key = `${sessionId ?? ''}\n${method}` */
  private readonly handlers = new Map<string, Set<Handler>>();
  private _closed = false;
  onClose: ((reason?: string) => void) | null = null;

  constructor(private readonly transport: Transport) {
    transport.onMessage = (m) => this.dispatch(m);
    transport.onClose = (reason) => this.handleClose(reason);
  }

  get closed(): boolean {
    return this._closed;
  }

  send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this._closed) return Promise.reject(new TargetClosedError());
    const id = ++this.lastId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
      this.transport.send(
        JSON.stringify(
          sessionId ? { id, method, params, sessionId } : { id, method, params },
        ),
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
    return new Promise<P>((resolve) => {
      const off = this.on(
        method,
        (params) => {
          if (!predicate(params as P)) return;
          off();
          resolve(params as P);
        },
        sessionId,
      );
    });
  }

  close(): void {
    this.transport.close();
  }

  private dispatch(raw: string): void {
    let m: {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
      params?: unknown;
      sessionId?: string;
    };
    try {
      m = JSON.parse(raw);
    } catch {
      return; // Not ours to crash on; Chrome never sends non-JSON frames.
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new CdpError(m.error.code, p.method, m.error.message));
      else p.resolve(m.result);
      return;
    }
    if (m.method) {
      const set = this.handlers.get(`${m.sessionId ?? ''}\n${m.method}`);
      if (set) for (const h of [...set]) h(m.params, m.sessionId);
      // Session-less listeners see every event (the browser session, the daemon proxy).
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
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.onClose?.(reason);
  }
}
```

Note for the routing test: the session-less fan-out means `c.on('Page.lifecycleEvent', h)` with no sessionId also receives S1/S2 events; the test registers only session-scoped handlers, so `got` is exactly as asserted.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/browser/cdp.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
pnpm format && git add packages/core/src/browser/transport.ts packages/core/src/browser/cdp.ts packages/core/src/browser/cdp.test.ts
git commit -m "core: CDP connection over pipe or socket with session routing"
```

### Task 5: Launch flags and process management

**Files:**

- Modify: `packages/core/src/capture/launch.ts` (keep `DETERMINISTIC_CHROMIUM_ARGS` and `deterministicLaunchOptions`; add `PARITY_CHROMIUM_ARGS`, `chromeArgs`)
- Modify: `packages/core/src/capture/launch.test.ts`
- Create: `packages/core/src/browser/launch.ts`
- Test: `packages/core/src/browser/launch.test.ts` (integration, skipped when no browser resolves)

**Interfaces:**

- Consumes: `CdpConnection`, `PipeTransport` (Task 4); `resolveChrome` (Task 1).
- Produces:
  - `capture/launch.ts`: `PARITY_CHROMIUM_ARGS: readonly string[]`, `chromeArgs(opts: { userDataDir: string; args?: string[]; headless?: boolean }): string[]` (parity → headless set → `--no-sandbox` → deterministic → caller → `--user-data-dir` → `--remote-debugging-pipe` → `--no-startup-window`).
  - `browser/launch.ts`: `interface LaunchedChrome { connection: CdpConnection; pid: number; userDataDir: string; close(): Promise<void> }`, `launchChrome(opts: { executablePath: string; args?: string[]; headless?: boolean }): Promise<LaunchedChrome>`.

- [ ] **Step 1: Extend `launch.test.ts`** (append to the existing describe)

```ts
import { chromeArgs, PARITY_CHROMIUM_ARGS } from './launch.js';

describe('chromeArgs', () => {
  it('carries playwright-core 1.62.0 switches verbatim, then ours, then the caller', () => {
    const args = chromeArgs({ userDataDir: '/u', args: ['--foo'] });
    // The byte-identity spike ran with exactly this set; a feature flag that
    // changes raster output would break every baseline, so the list is pinned.
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

- [ ] **Step 4: Run** `pnpm vitest run packages/core/src/capture/launch.test.ts` → PASS.

- [ ] **Step 5: Write the integration test** (`packages/core/src/browser/launch.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { launchChrome } from './launch.js';
import { resolveChrome } from './resolve.js';
import { TargetClosedError } from './cdp.js';

const chrome = (() => {
  try {
    return resolveChrome();
  } catch {
    return null;
  }
})();

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
  it('killing the process rejects in-flight sends', async () => {
    const b = await launchChrome({ executablePath: chrome!.path });
    const pending = b.connection.send('Target.createBrowserContext');
    process.kill(b.pid, 'SIGKILL');
    await expect(pending).rejects.toBeInstanceOf(TargetClosedError);
    await b.close(); // idempotent after a crash
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

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromeArgs } from '../capture/launch.js';
import { CdpConnection } from './cdp.js';
import { PipeTransport } from './transport.js';

export interface LaunchedChrome {
  connection: CdpConnection;
  pid: number;
  userDataDir: string;
  close(): Promise<void>;
}

const GRACEFUL_CLOSE_MS = 2000;

export async function launchChrome(opts: {
  executablePath: string;
  args?: string[];
  headless?: boolean;
}): Promise<LaunchedChrome> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'jux-chrome-'));
  const args = chromeArgs({ userDataDir, args: opts.args, headless: opts.headless });
  let proc: ChildProcess;
  try {
    proc = spawn(opts.executablePath, args, {
      // stdin/stdout ignored, stderr kept for the "missing shared library"
      // message on Linux, 3 = Chrome reads, 4 = Chrome writes.
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    await rm(userDataDir, { recursive: true, force: true });
    throw err;
  }
  let stderr = '';
  proc.stderr!.on('data', (d: Buffer) => {
    if (stderr.length < 8192) stderr += d.toString();
  });

  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  const transport = new PipeTransport(
    proc.stdio[3] as NodeJS.WritableStream,
    proc.stdio[4] as NodeJS.ReadableStream,
  );
  const connection = new CdpConnection(transport);

  const early = new Promise<never>((_, reject) =>
    proc.once('exit', (code) =>
      reject(
        new Error(
          `jux: the browser exited with code ${code} before it was ready.${describeStderr(stderr)}`,
        ),
      ),
    ),
  );
  try {
    await Promise.race([connection.send('Browser.getVersion'), early]);
  } catch (err) {
    await rm(userDataDir, { recursive: true, force: true });
    throw err;
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

- [ ] **Step 8: Run** `pnpm vitest run packages/core/src/browser/launch.test.ts` → PASS (2 tests; prints "skipped" on a machine with no browser — on this Mac the ms-playwright cache resolves).

- [ ] **Step 9: Commit**

```bash
pnpm format && git add packages/core/src/capture/launch.ts packages/core/src/capture/launch.test.ts packages/core/src/browser/launch.ts packages/core/src/browser/launch.test.ts
git commit -m "core: launch chrome-headless-shell over the pipe with Playwright-parity flags"
```

### Task 6: Page, BrowserContext, Browser and selectors

**Files:**

- Create: `packages/core/src/browser/selectors.ts`
- Create: `packages/core/src/browser/page.ts`
- Create: `packages/core/src/browser/browser.ts`
- Create: `packages/core/src/browser/index.ts`
- Test: `packages/core/src/browser/selectors.test.ts`, `packages/core/src/browser/page.test.ts` (integration, skipped without a browser)

**Interfaces:**

- Consumes: `CdpConnection`, `CdpError`, `TargetClosedError` (Task 4); `launchChrome` (Task 5); `Viewport` from `../types.js`.
- Produces:
  - `selectors.ts`: `isCssSelector(selector: string): boolean`, `QUERY_ALL_SOURCE: string` (source of an in-page `function (selector) { … return Element[] }` resolving across open shadow roots, document order), `assertCssSelector(selector: string): void` (throws `jux: mask selector '…' is not a CSS selector`).
  - `page.ts`: `class TimeoutError extends Error`, `interface Page { goto(url: string, opts?: { waitUntil?: 'load'; timeout?: number }): Promise<void>; url(): string; evaluate<R, A = undefined>(fn: string | ((arg: A) => R | Promise<R>), arg?: A): Promise<R>; waitForFunction<A = undefined>(fn: (arg: A) => unknown, arg?: A, opts?: { timeout?: number }): Promise<void>; waitForSelector(selector: string, opts?: { timeout?: number }): Promise<void>; addStyleTag(opts: { content: string }): Promise<void>; setViewportSize(viewport: Viewport): Promise<void>; screenshot(opts?: { mask?: string[] }): Promise<Buffer>; send<T = unknown>(method: string, params?: object): Promise<T>; close(): Promise<void> }`, `class CdpPage implements Page` with `static async create(connection, targetId, sessionId, opts: { viewport: Viewport; blockServiceWorkers: boolean; os: NodeJS.Platform })`.
  - `browser.ts`: `interface ContextOptions { viewport: Viewport; blockServiceWorkers?: boolean }`, `class BrowserContext { readonly id: string; newPage(): Promise<Page>; clearCookies(): Promise<void>; clearOrigin(origin: string): Promise<void>; close(): Promise<void> }`, `class Browser { static async launch(opts: { executablePath: string; args?: string[] }): Promise<Browser>; static fromConnection(connection: CdpConnection, opts: { version: string; close: () => Promise<void> }): Browser; version(): string; isConnected(): boolean; newContext(opts: ContextOptions): Promise<BrowserContext>; close(): Promise<void> }`.
  - `index.ts` re-exports all of the above plus Tasks 1–5.

- [ ] **Step 1: Write `selectors.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { isCssSelector, assertCssSelector, QUERY_ALL_SOURCE } from './selectors.js';

describe('isCssSelector', () => {
  it('accepts CSS', () => {
    for (const s of [
      '[data-testid="clock"]',
      'div > span.x:nth-child(2)',
      '#id',
      'a:not(.b)',
      'x-foo::part(bar)',
    ])
      expect(isCssSelector(s)).toBe(true);
  });
  it('rejects Playwright-only syntax', () => {
    for (const s of [
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
    ])
      expect(isCssSelector(s), s).toBe(false);
  });
  it('assertCssSelector names the selector', () => {
    expect(() => assertCssSelector('text=Clock')).toThrow(
      "jux: mask selector 'text=Clock' is not a CSS selector",
    );
  });
  it('QUERY_ALL_SOURCE is a self-contained function', () => {
    expect(QUERY_ALL_SOURCE).toMatch(/^function/);
    expect(QUERY_ALL_SOURCE).toMatch(/shadowRoot/);
  });
});
```

- [ ] **Step 2: Write `selectors.ts`**

```ts
// packages/core/src/browser/selectors.ts
//
// Masks (and structure.ts's mask marking) resolve selectors in the page.
// Playwright's locator engine also accepted `text=`, `>>`, `:has-text()` and
// friends; those are refused up front so a baseline is never captured
// unmasked because a selector silently matched nothing (spec §Decisions 5).
// Open shadow roots are pierced in document order, as Playwright's css
// engine does; closed roots are invisible to both.

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
    throw new Error(`jux: mask selector '${selector}' is not a CSS selector`);
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
```

Run `pnpm vitest run packages/core/src/browser/selectors.test.ts` → PASS.

- [ ] **Step 3: Write `page.test.ts`** (integration; serves pages from a local `http` server so `load` is real)

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import sharp from 'sharp';
import { Browser } from './browser.js';
import { resolveChrome } from './resolve.js';
import { TimeoutError } from './page.js';

const chrome = (() => {
  try {
    return resolveChrome();
  } catch {
    return null;
  }
})();
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
  '/hang': '', // never answered
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[req.url ?? ''];
    if (req.url === '/hang') return; // keep the request open forever
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

describe.skipIf(!chrome)('CdpPage', () => {
  it('goto waits for load, evaluate round-trips JSON, url() is the final url', async () => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 200 } });
    const page = await ctx.newPage();
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
    await ctx.close();
  });
  it('evaluate rejects with the page error message', async () => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 200 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/plain`);
    await expect(
      page.evaluate(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
    await ctx.close();
  });
  it('waitForFunction polls on rAF and waitForSelector sees late elements; both time out with TimeoutError', async () => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 200 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/late`);
    await page.waitForSelector('#late', { timeout: 2000 });
    await page.waitForFunction((id: string) => !!document.getElementById(id), 'late', {
      timeout: 500,
    });
    await expect(page.waitForSelector('#never', { timeout: 100 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
    await expect(
      page.waitForFunction(() => false, undefined, { timeout: 100 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    await ctx.close();
  });
  it('goto rejects on timeout with the url', async () => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 200 } });
    const page = await ctx.newPage();
    await expect(page.goto(`${base}/hang`, { timeout: 300 })).rejects.toThrow(
      new RegExp(`${base}/hang`),
    );
    await ctx.close();
  });
  it('setViewportSize changes innerWidth and screenshot is a PNG of the viewport', async () => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 200 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/plain`);
    await page.setViewportSize({ width: 480, height: 400 });
    expect(await page.evaluate(() => window.innerWidth)).toBe(480);
    const png = await page.screenshot();
    const meta = await sharp(png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 480, 400]);
    await ctx.close();
  });
  it('a mask paints #F0F over the element, pierces open shadow roots, and leaves no trace', async () => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 200 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/shadow`);
    const png = await page.screenshot({ mask: ['.secret'] });
    const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [
      data[(y * 300 + x) * 3],
      data[(y * 300 + x) * 3 + 1],
      data[(y * 300 + x) * 3 + 2],
    ];
    expect(px(10, 10)).toEqual([255, 0, 255]);
    expect(await page.evaluate(() => document.querySelector('x-pw-glass'))).toBeNull();
    await expect(page.screenshot({ mask: ['text=secret'] })).rejects.toThrow(
      /not a CSS selector/,
    );
    await ctx.close();
  });
  it('clearOrigin wipes localStorage; a blocked service worker never registers', async () => {
    const ctx = await browser.newContext({
      viewport: { width: 300, height: 200 },
      blockServiceWorkers: true,
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/plain`);
    await page.evaluate(() => localStorage.setItem('k', 'v'));
    await ctx.clearOrigin(base);
    await page.goto(`${base}/plain`);
    expect(await page.evaluate(() => localStorage.getItem('k'))).toBeNull();
    expect(
      await page.evaluate(() => navigator.serviceWorker.register.toString()),
    ).toMatch(/blocked/);
    await ctx.close();
  });
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
// One target, one flattened session. The init sequence and the screenshot
// are verbatim ports of playwright-core 1.62.0 (spec §"What Playwright does
// for us", with coreBundle.js line numbers); the spike proved that is what
// makes the bytes identical, so nothing here is "simplified".

import type { Viewport } from '../types.js';
import { CdpConnection, CdpError } from './cdp.js';
import { assertCssSelector, QUERY_ALL_SOURCE } from './selectors.js';

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
  /** Raw CDP on this page's session, for DOMSnapshot and Storage calls. */
  send<T = unknown>(method: string, params?: object): Promise<T>;
  close(): Promise<void>;
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

// Page.setFontFamilies tables, playwright-core 1.62.0 `platformToFontFamilies`.
// Generic families resolve through these in headless mode; without them a
// story that says `font-family: sans-serif` renders with Chromium's built-in
// defaults and the bytes differ from every existing baseline.
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
// The three tables are copied from coreBundle.js `platformToFontFamilies`
// (linux: no forScripts; mac: jpan/hang/hans/hant; win: the seven above).

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
const MASK_SOURCE = `(function (selectors, color, queryAll) {
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
  const entries = [];
  for (const sel of selectors) for (const el of queryAll(sel)) { const h = document.createElement('x-pw-highlight'); shadow.appendChild(h); entries.push({ el, h }); }
  for (const { el, h } of entries) {
    const box = el.getBoundingClientRect();
    h.style.backgroundColor = color;
    h.style.left = box.x + 'px'; h.style.top = box.y + 'px';
    h.style.width = box.width + 'px'; h.style.height = box.height + 'px';
    h.style.display = 'block';
  }
  window.__juxUnmask = () => { glass.remove(); delete window.__juxUnmask; };
  return entries.length;
})`;

function serialize(arg: unknown): string {
  return arg === undefined ? 'undefined' : JSON.stringify(arg);
}

export class CdpPage implements Page {
  private currentUrl = 'about:blank';
  private viewport: Viewport;
  private closed = false;

  private constructor(
    private readonly connection: CdpConnection,
    readonly targetId: string,
    readonly sessionId: string,
    viewport: Viewport,
  ) {
    this.viewport = viewport;
    connection.on(
      'Page.frameNavigated',
      (p: unknown) => {
        const f = (p as { frame: { url: string; parentId?: string } }).frame;
        if (!f.parentId) this.currentUrl = f.url;
      },
      sessionId,
    );
  }

  /** FrameSession._initialize, coreBundle.js L37370–37430, minus what needs options we never pass. */
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
      page.send('Log.enable'),
      page.send('Runtime.enable'),
      page.send('Network.enable'),
      page.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      }),
      page.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      page.send('Emulation.setDeviceMetricsOverride', metricsOverride(opts.viewport)),
      page.send('Page.setFontFamilies', fonts),
      page.send('Emulation.setEmulatedMedia', EMULATED_MEDIA),
      page.send('Emulation.setGeolocationOverride', {}),
      page.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {}),
      ...(opts.blockServiceWorkers
        ? [
            page.send('Page.addScriptToEvaluateOnNewDocument', {
              source: BLOCK_SERVICE_WORKERS_SCRIPT,
              runImmediately: true,
            }),
          ]
        : []),
    ]);
    await page.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    return page;
  }

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    return this.connection.send<T>(method, params, this.sessionId);
  }

  url(): string {
    return this.currentUrl;
  }

  async goto(
    url: string,
    opts: { waitUntil?: 'load'; timeout?: number } = {},
  ): Promise<void> {
    const timeout = opts.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    const loaded = this.connection.once<{ name: string; frameId: string }>(
      'Page.lifecycleEvent',
      this.sessionId,
      (p) => p.name === 'load',
    );
    const res = await this.send<{ errorText?: string; loaderId?: string }>(
      'Page.navigate',
      { url },
    );
    if (res.errorText)
      throw new Error(`jux: navigation to ${url} failed: ${res.errorText}`);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        loaded,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new TimeoutError(
                  `jux: navigation to ${url} did not fire load within ${timeout} ms`,
                ),
              ),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    this.currentUrl = url;
    // frameNavigated may have updated it to the final url already; keep that.
    const { frameTree } = await this.send<{ frameTree: { frame: { url: string } } }>(
      'Page.getFrameTree',
    );
    this.currentUrl = frameTree.frame.url;
  }

  async evaluate<R, A = undefined>(
    fn: string | ((arg: A) => R | Promise<R>),
    arg?: A,
  ): Promise<R> {
    const expression =
      typeof fn === 'string' ? fn : `(${fn.toString()})(${serialize(arg)})`;
    const r = await this.send<{
      result: { value?: R };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
    const timeout = opts.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
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
    ).then((outcome) => {
      if (outcome === 'timeout')
        throw new TimeoutError(`jux: waitForFunction timed out after ${timeout} ms`);
      if (outcome.startsWith('error:')) throw new Error(outcome.slice(6));
    });
  }

  waitForSelector(selector: string, opts: { timeout?: number } = {}): Promise<void> {
    assertCssSelector(selector);
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
      opts,
    ).catch((e) => {
      if (e instanceof TimeoutError)
        throw new TimeoutError(
          `jux: selector '${selector}' did not appear within ${opts.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS} ms`,
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
      if (mask.length)
        await this.evaluate(
          `${MASK_SOURCE}(${JSON.stringify(mask)}, "#F0F", ${QUERY_ALL_SOURCE})`,
        );
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
import { launchChrome } from './launch.js';
import { CdpPage, type Page } from './page.js';

export interface ContextOptions {
  viewport: Viewport;
  /** `serviceWorkers: 'block'` in Playwright terms: an init script that stubs registration. */
  blockServiceWorkers?: boolean;
}

export class BrowserContext {
  private readonly pages = new Set<CdpPage>();
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
    const page = await CdpPage.create(this.connection, targetId, sessionId, {
      viewport: this.opts.viewport,
      blockServiceWorkers: this.opts.blockServiceWorkers === true,
      os: this.os,
    });
    this.pages.add(page);
    return page;
  }

  /** Storage.clearCookies, as Playwright's clearCookies (coreBundle.js L38394). */
  async clearCookies(): Promise<void> {
    await this.connection.send('Storage.clearCookies', { browserContextId: this.id });
  }

  /** Everything origin-scoped: localStorage, IndexedDB, Cache Storage, service workers. */
  async clearOrigin(origin: string): Promise<void> {
    await this.connection.send('Storage.clearDataForOrigin', {
      origin,
      storageTypes: 'all',
      browserContextId: this.id,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connection
      .send('Target.disposeBrowserContext', { browserContextId: this.id })
      .catch(() => {});
    this.pages.clear();
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
export { CdpConnection, CdpError, TargetClosedError } from './cdp.js';
export {
  PipeTransport,
  SocketTransport,
  NullFramer,
  type Transport,
} from './transport.js';
export { launchChrome, type LaunchedChrome } from './launch.js';
export {
  resolveChrome,
  juxCacheDir,
  chromeInstallDir,
  chromeBinaryPath,
  msPlaywrightBinaryPath,
  NO_BROWSER_MESSAGE,
  type ResolvedChrome,
  type ResolveOptions,
  type ChromeSource,
} from './resolve.js';
export { installChrome, type InstallOptions, type InstallResult } from './install.js';
export {
  CHROME_VERSION,
  CHROME_PINS,
  MS_PLAYWRIGHT_REVISION,
  chromePlatform,
  type ChromePlatform,
  type ChromePin,
} from './pins.js';
export { isCssSelector, assertCssSelector, QUERY_ALL_SOURCE } from './selectors.js';
```

- [ ] **Step 8: Run** `pnpm vitest run packages/core/src/browser` → PASS (page 8, selectors 4, plus earlier). If the mask pixel test reads `[255,0,255]` off by one channel, check the `raw()` channel count (`meta.channels`); use `.removeAlpha()` before `.raw()`.

- [ ] **Step 9: Commit**

```bash
pnpm format && git add packages/core/src/browser
git commit -m "core: Page, BrowserContext and Browser over CDP with a verbatim Playwright init and screenshot"
```

### Task 7: Port core's capture pipeline and the seam

**Files:**

- Modify: `packages/core/src/platform.ts:5` (`import type { Page } from './browser/page.js'`)
- Modify: `packages/core/src/url-platform.ts:10`, `packages/core/src/platforms/urls.ts:12` (same import)
- Modify: `packages/core/src/capture/capture.ts:6,180-184` (import; `page.screenshot({ mask: params.mask })`; `page.waitForTimeout(params.delay)` → `await new Promise((r) => setTimeout(r, params.delay))`)
- Modify: `packages/core/src/capture/settle.ts:10,143` (import; `waitForSelector` keeps its `.catch(() => {})`)
- Modify: `packages/core/src/capture/structure.ts:14,496-571` (import; mask marking via `page.evaluate` with `QUERY_ALL_SOURCE`; `page.send('DOMSnapshot.captureSnapshot', …)` instead of `newCDPSession`)
- Modify: `packages/core/src/capture/pool.ts:5,78-82` (`import type { Browser } from '../browser/browser.js'`; `newContext({ viewport })` — drop `deviceScaleFactor` (always 1 in the driver))
- Modify: `packages/core/src/capture/snap.ts:8,55-104,121-146` (launch via `Browser.launch({ executablePath })` with a new `chrome: string` option on `SnapPagesOptions`/`SnapOptions`; `status` from `Network.responseReceived` on the main frame; `resetBetweenPages` via `context.clearCookies()` + `context.clearOrigin(origin)`)
- Modify: `packages/core/src/capture/env.ts:13`, `packages/core/src/run/run.ts:8` (Browser type import)
- Modify: `packages/core/src/index.ts` (export `Page`, `Browser`, `BrowserContext`, `TimeoutError`, `resolveChrome`, `installChrome`, `NO_BROWSER_MESSAGE`, `CHROME_VERSION`, `juxCacheDir`, `chromeArgs`, `PARITY_CHROMIUM_ARGS`)
- Modify: `packages/core/package.json` (remove `peerDependencies`/`peerDependenciesMeta` playwright; keywords `playwright` → `cdp`; `engines.node >=22.0.0`)
- Modify tests: `packages/core/src/capture/env.test.ts:1`, `packages/core/src/capture/structure-capture.test.ts:3`, `packages/core/src/platforms/urls.test.ts:1`, `packages/core/src/run/run-structural.test.ts:5` (type imports only; the fakes already satisfy the narrower interface)
- Test: `packages/core/src/capture/capture.test.ts` (new: a non-CSS mask fails the story, not the run)
- Create: `scripts/check-parity.mjs`

**Interfaces:**

- Consumes: `Browser`, `BrowserContext`, `Page`, `TimeoutError`, `assertCssSelector`, `QUERY_ALL_SOURCE` (Task 6).
- Produces: `SnapPagesOptions.chrome: string` and `SnapOptions.chrome: string` (required: core never resolves the binary — the CLI does, so `--chrome` and the daemon stay CLI concerns); `PoolOptions.browser: Browser` (ours); `RunCaptureOptions.browser: Browser` (ours); `captureEnv(browser: Browser)`.

- [ ] **Step 1: Write `capture.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { captureStory } from './capture.js';
import type { Page } from '../browser/page.js';
import type { Platform } from '../platform.js';

// A page that records calls and renders nothing: enough to prove the
// selector guard fires before any screenshot and surfaces as the story's
// error (the pool catches per story; one bad mask must not abort a run).
function fakePage(): Page & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    goto: async () => {
      calls.push('goto');
    },
    url: () => 'about:blank',
    evaluate: async () => undefined as never,
    waitForFunction: async () => {},
    waitForSelector: async () => {},
    addStyleTag: async () => {
      calls.push('style');
    },
    setViewportSize: async () => {
      calls.push('viewport');
    },
    screenshot: async (o) => {
      calls.push('shot:' + JSON.stringify(o));
      if (o?.mask?.some((s) => s.startsWith('text=')))
        throw new Error("jux: mask selector 'text=x' is not a CSS selector");
      return Buffer.alloc(0);
    },
    send: async () => ({}) as never,
    close: async () => {},
  };
}
const platform: Platform = {
  name: 'fake',
  detect: async () => true,
  enumerate: async () => [],
  showStory: async () => {},
  previewUrl: () => '',
  settle: async () => {},
  configDirs: [],
  storyFileGlobs: [],
};

describe('captureStory', () => {
  it('a non-CSS mask fails the story, not the run', async () => {
    const page = fakePage();
    await expect(
      captureStory(
        page,
        {
          storyId: 's',
          title: 's',
          name: 's',
          componentPath: '',
          params: { mask: ['text=x'] },
        },
        { platform, baseUrl: 'x', structure: false },
        { width: 10, height: 10 },
      ),
    ).rejects.toThrow(/not a CSS selector/);
    expect(page.calls.filter((c) => c.startsWith('shot'))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/core/src/capture/capture.test.ts` → FAIL (type/shape mismatch: `screenshot` still takes locators; `sharp(Buffer.alloc(0))` would throw — the guard must fire first).

- [ ] **Step 3: Port `capture.ts`**: change the import, replace the screenshot call with

```ts
// A selector matching nothing is not an error — a story that conditionally
// renders the element shouldn't fail on the branch where it's absent. A
// selector that is not CSS is: it would silently capture unmasked.
const png = await page.screenshot(params.mask?.length ? { mask: params.mask } : {});
```

and the delay with `await new Promise<void>((r) => setTimeout(r, params.delay))`. Keep every other line and comment.

- [ ] **Step 4: Port `structure.ts`** (lines 496–571). Replace `page.locator(sel).evaluateAll(...)` with `page.evaluate(\`(${QUERY_ALL_SOURCE})(${JSON.stringify(sel)}).map(...)\`)`-style calls:

```ts
const mark = (sel: string) =>
  page.evaluate<number>(
    `(function (sel, attr, queryAll) { const els = queryAll(sel); for (const el of els) el.setAttribute(attr, '1'); return els.length; })(${JSON.stringify(sel)}, ${JSON.stringify(MASK_ATTR)}, ${QUERY_ALL_SOURCE})`,
  );
const verify = (sel: string) =>
  page.evaluate<{ total: number; marked: number }>(
    `(function (sel, attr, queryAll) { const els = queryAll(sel); return { total: els.length, marked: els.filter((e) => e.hasAttribute(attr)).length }; })(${JSON.stringify(sel)}, ${JSON.stringify(MASK_ATTR)}, ${QUERY_ALL_SOURCE})`,
  );
const unmark = () =>
  page
    .evaluate(
      `(function (attr, queryAll) { for (const el of queryAll('[' + attr + ']')) el.removeAttribute(attr); })(${JSON.stringify(MASK_ATTR)}, ${QUERY_ALL_SOURCE})`,
    )
    .catch(() => {});
```

and `const raw = (await page.send('DOMSnapshot.captureSnapshot', {...})) as unknown as CdpSnapshot;` with no `cdp.detach()`. Update the doc comment: "resolved with the same CSS-over-open-shadow-roots query the screenshot masks with; Playwright-only syntax is rejected before capture".

- [ ] **Step 5: Port `snap.ts`**

```ts
import type { Browser, BrowserContext } from '../browser/browser.js';
import type { Page } from '../browser/page.js';
// …
export interface SnapPagesOptions { urls: string[]; viewport?: Viewport; params?: StoryParams; /** Resolved by the caller (CLI): --chrome, JUX_CHROME, caches. */ chrome: string; }
export interface SnapOptions { url: string; viewport?: Viewport; params?: StoryParams; chrome: string; }
// in snapPages:
  const { Browser } = await import('../browser/browser.js');
  const browser: Browser = await Browser.launch({ executablePath: opts.chrome });
  try {
    const context = await browser.newContext({ viewport, blockServiceWorkers: true });
    const page = await context.newPage();
    let status: number | null = null;
    // Network.responseReceived for the main document: type 'Document', top frame.
    const off = (page as import('../browser/page.js').CdpPage) && (await import('../browser/cdp.js'), undefined);
```

Replace the `page.on('response', …)` block with a listener on the page session: add to `Page` a method `onMainResponse(handler: (status: number) => void): () => void` implemented in `CdpPage` via `connection.on('Network.responseReceived', (p) => { if (p.type === 'Document' && p.frameId === mainFrameId) handler(p.response.status) }, sessionId)` where `mainFrameId` is read from `Page.getFrameTree` in `create`. Add it to the `Page` interface and to the fake in `capture.test.ts` (`onMainResponse: () => () => {}`). Then `resetBetweenPages`:

```ts
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
      /* about:blank, chrome-error:// */
    }
  }
  for (const origin of origins) await context.clearOrigin(origin).catch(() => {});
}
```

Keep the comment block above it; drop the `cdp.detach` sentence.

- [ ] **Step 6: Port `pool.ts`, `env.ts`, `run.ts`, `platform.ts`, `url-platform.ts`, `platforms/urls.ts`, `settle.ts`** — import lines only, plus `newContext({ viewport: opts.viewport })` in the pool (comment: "deviceScaleFactor is pinned to 1 by the driver and `--force-device-scale-factor=1`"). `settle.ts`'s `waitForSelector` keeps `.catch(() => {})` (it now swallows `TimeoutError` and the non-CSS error alike — add a comment: a non-CSS `waitForSelector` is a configuration error worth surfacing; call `assertCssSelector(selector)` before the wait so it throws).

- [ ] **Step 7: `index.ts` exports and `package.json`** as listed in Files. Run `pnpm build && pnpm typecheck && pnpm test` → all green (the four type-only test imports updated).

- [ ] **Step 8: Write `scripts/check-parity.mjs`**

```js
#!/usr/bin/env node
// Record or compare per-story sha256 of a `jux run --all` on an example.
//   node scripts/check-parity.mjs record  examples/storybook out.json
//   node scripts/check-parity.mjs compare examples/storybook ref.json
// `record` on main (Playwright) then `compare` on this branch is the upgrade
// gate: every hash must match, or every user baseline turns red on upgrade.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const run = promisify(execFile);
const [mode, exampleDir, file] = process.argv.slice(2);
const dir = path.resolve(exampleDir);
const cli = path.resolve('packages/cli/dist/index.js');
await run('node', [cli, 'run', '--all'], {
  cwd: dir,
  env: { ...process.env, JUX_NO_DAEMON: process.env.JUX_NO_DAEMON ?? '' },
}).catch((e) => {
  if (!e.stdout) throw e;
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
    `${same ? 'MATCH' : 'DIFF '} ${id} ${ref[id]?.slice(0, 12)} ${hashes[id]?.slice(0, 12) ?? '-'}`,
  );
}
console.log(`parity: ${ok}/${ids.length}`);
process.exit(ok === ids.length && ids.length > 0 ? 0 : 1);
```

- [ ] **Step 9: Run the gate.** This machine already has main's hashes recorded by the spike at `/Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-hashes.json` (storybook, 15 stories) and `pw-ladle-hashes.json` (ladle, 14). The CLI still launches via Playwright until Task 9, so run the driver path through core directly: write `/Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/task7-run.mjs` that serves `examples/storybook/storybook-static`, calls `runCapture` from `packages/core/dist` with `Browser.launch({ executablePath: resolveChrome().path })`, `concurrency: 4`, `viewport: {800,600}`, and writes `-current.webp` per story; then compare with `node scripts/check-parity.mjs`'s compare logic (import its hashing). Expected: `parity: 15/15` and `14/14`. Then `pnpm check:determinism` → `determinism: OK — 15 stories byte-identical across 3 runs` (still via Playwright at this point; the driver determinism run happens in Task 9).

- [ ] **Step 10: Commit**

```bash
pnpm format && git add packages/core scripts/check-parity.mjs
git commit -m "core: capture through the CDP driver; Page is our own seam"
```

### Task 8: Port the adapters

**Files:**

- Modify: `packages/adapter-storybook/src/index.ts:9` → `import type { Page } from '@juxtapose/core';` (merge into the existing `@juxtapose/core` type import at lines 10–16)
- Modify: `packages/adapter-ladle/src/index.ts:9` → same
- Modify: `packages/adapter-storybook/package.json:32-34,40-44`, `packages/adapter-ladle/package.json:32-34,40-44` (remove `peerDependencies.playwright` and `peerDependenciesMeta`; `engines.node >=22.0.0`)
- Test: `packages/adapter-storybook/src/index.test.ts`, `packages/adapter-ladle/src/index.test.ts` (existing; if either imports `playwright` types, switch them; add the assertion below)

**Interfaces:**

- Consumes: `Page` from `@juxtapose/core` (Task 7).
- Produces: nothing new. `switchStory`/`readLiveParams` keep calling `page.evaluate(fn, arg)` with one argument, and `waitForRenderPhase`/`waitForLayoutClass` keep `page.waitForFunction(fn, arg, { timeout })`.

- [ ] **Step 1: Add a test that the adapter's settle swallows the driver's timeout** (to each adapter's existing test file)

```ts
import { TimeoutError } from '@juxtapose/core';
it('settle resolves when the render signal times out', async () => {
  const page = {
    waitForFunction: async () => {
      throw new TimeoutError('jux: waitForFunction timed out after 1 ms');
    },
    waitForSelector: async () => {
      throw new TimeoutError('jux: selector did not appear');
    },
    evaluate: async () => undefined,
    goto: async () => {},
    url: () => '',
    addStyleTag: async () => {},
    setViewportSize: async () => {},
    screenshot: async () => Buffer.alloc(0),
    send: async () => ({}),
    onMainResponse: () => () => {},
    close: async () => {},
  } as unknown as Page;
  await expect(
    platform.settle(page, {
      story: { storyId: 'a', title: 'a', name: 'a', componentPath: '', params: {} },
      params: {},
      timeoutMs: 1,
    }),
  ).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/adapter-storybook packages/adapter-ladle` → FAIL (`TimeoutError` not exported until Task 7's export lands in `dist`; run `pnpm --filter @juxtapose/core build` first, then the type error on `Page` shows).

- [ ] **Step 3: Change the two import lines and the two package.json files.** `pnpm build && pnpm typecheck && pnpm vitest run packages/adapter-storybook packages/adapter-ladle` → PASS. `grep -n playwright packages/adapter-*/src packages/adapter-*/package.json` → empty.

- [ ] **Step 4: Commit**

```bash
pnpm format && git add packages/adapter-storybook packages/adapter-ladle
git commit -m "adapters: take Page from @juxtapose/core; drop the playwright peer"
```

### Task 9: Port the CLI and the server; `jux browser`

**Files:**

- Create: `packages/cli/src/browser.ts` (`openBrowser`)
- Create: `packages/cli/src/commands/browser.ts` (`jux browser install|path|status`)
- Modify: `packages/cli/src/index.ts:115-146` (add `case 'browser'`, `COMMANDS` list, help text; add `--chrome <path>` to the shared flag parsing for `snap`, `run`, `init`)
- Modify: `packages/cli/src/commands/run.ts:5,110-112,162` (`openBrowser(ctx)`), `packages/cli/src/commands/init.ts:13,79,187` (same; run the installer when nothing resolves), `packages/cli/src/commands/snap.ts:132-140,310-313` (`chrome: (await resolveOrInstallHint(...)).path`; the hint text)
- Modify: `packages/server/src/source.ts:6,318-320` (`Browser.launch({ executablePath: resolveChrome()?.path ?? throw })`)
- Modify: `packages/cli/package.json` (remove `playwright` dep; keyword), `packages/server/package.json` (same), `packages/storybook/src/Panel.tsx:12`, `packages/storybook/src/sidebar.ts:12` (comment text only: "reaches sharp and the browser driver")
- Modify: `scripts/check-snap.mjs:98-108`
- Test: `packages/cli/src/browser.test.ts`

**Interfaces:**

- Consumes: `Browser`, `resolveChrome`, `installChrome`, `juxCacheDir`, `NO_BROWSER_MESSAGE`, `CHROME_VERSION` from `@juxtapose/core`.
- Produces: `openBrowser(opts: { chrome?: string }): Promise<Browser>` (throws `Error(NO_BROWSER_MESSAGE)` → exit 3 via the existing `captureHint`/exit mapping); `browserCommand(argv: string[], json: boolean): Promise<number>`.

- [ ] **Step 1: Write `browser.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { openBrowser } from './browser.js';

describe('openBrowser', () => {
  it('names the fix when nothing resolves', async () => {
    await expect(
      openBrowser({
        chrome: undefined,
        env: { JUX_CACHE_DIR: '/nonexistent', PLAYWRIGHT_BROWSERS_PATH: '/nonexistent' },
      }),
    ).rejects.toThrow(/jux browser install.*JUX_CHROME/s);
  });
});
```

- [ ] **Step 2: Write `packages/cli/src/browser.ts`**

```ts
// Where every command gets its browser. One place, so `--chrome`, JUX_CHROME,
// the caches and (PR 2) the warm daemon are decided once.
import { Browser, NO_BROWSER_MESSAGE, resolveChrome } from '@juxtapose/core';

export interface OpenBrowserOptions {
  chrome?: string;
  env?: NodeJS.ProcessEnv;
}

export async function openBrowser(opts: OpenBrowserOptions = {}): Promise<Browser> {
  const resolved = resolveChrome({ flag: opts.chrome, env: opts.env ?? process.env });
  if (!resolved) throw new Error(NO_BROWSER_MESSAGE);
  return Browser.launch({ executablePath: resolved.path });
}
```

- [ ] **Step 3: Write `commands/browser.ts`**

```ts
// `jux browser install|path|status` — the browser is a pinned download, not
// a Playwright side effect.
import {
  CHROME_VERSION,
  installChrome,
  juxCacheDir,
  resolveChrome,
} from '@juxtapose/core';
import { EXIT } from '../exit-codes.js';

export async function browserCommand(argv: string[], json: boolean): Promise<number> {
  const sub = argv[0] ?? 'status';
  if (sub === 'install') {
    let last = -1;
    const r = await installChrome({
      cacheDir: juxCacheDir(),
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
    const out = {
      version: r.version,
      path: r.path,
      alreadyInstalled: r.alreadyInstalled,
    };
    process.stdout.write(
      json
        ? JSON.stringify(out) + '\n'
        : `jux: ${r.alreadyInstalled ? 'already installed' : 'installed'} ${r.version} at ${r.path}\n`,
    );
    return EXIT.OK;
  }
  if (sub === 'path' || sub === 'status') {
    const r = resolveChrome();
    if (!r) {
      process.stdout.write(
        json
          ? JSON.stringify({ browser: null, pinned: CHROME_VERSION }) + '\n'
          : `jux: no browser installed (pinned ${CHROME_VERSION}). Run \`jux browser install\`.\n`,
      );
      return EXIT.TOOL;
    }
    process.stdout.write(
      json
        ? JSON.stringify({ browser: r.path, source: r.source, pinned: CHROME_VERSION }) +
            '\n'
        : sub === 'path'
          ? r.path + '\n'
          : `jux: ${r.path} (${r.source}, pinned ${CHROME_VERSION})\n`,
    );
    return EXIT.OK;
  }
  process.stderr.write(
    `jux: unknown browser subcommand '${sub}'. Use install, path or status.\n`,
  );
  return EXIT.USAGE;
}
```

(Use the exit-code names as they exist in `packages/cli/src/exit-codes.ts`; 0/2/3 as the toolchain spec sets.)

- [ ] **Step 4: Wire the commands.** In `index.ts` add `case 'browser'` (lazy import), `--chrome` to the parsed flags passed into `run`/`snap`/`init` contexts, and help lines:

```
  jux browser install            download the pinned chrome-headless-shell (one-off)
  jux browser status             which browser jux will use
  --chrome <path>                use this Chromium binary (or JUX_CHROME=<path>)
```

In `run.ts` replace lines 110–112 with `const browser = await p.time('launch', () => openBrowser({ chrome: flags.chrome }));` and drop the playwright import. Same in `init.ts`, except: when `resolveChrome()` is null, call `installChrome({ cacheDir: juxCacheDir(), onProgress })` first (say `Downloading chrome-headless-shell ${CHROME_VERSION} (~100 MB, once)…`). In `snap.ts`, resolve once before `snapPages({ …, chrome })` and change `captureHint`:

```ts
if (/no browser|does not exist|ENOENT.*chrome-headless-shell/i.test(message))
  return '. Run `jux browser install`, or set JUX_CHROME=<path>, then retry.';
```

In `server/source.ts` `ensureBrowser`: `const r = resolveChrome(); if (!r) throw new Error(NO_BROWSER_MESSAGE); this.browser = await Browser.launch({ executablePath: r.path });`.

- [ ] **Step 5: `scripts/check-snap.mjs`**: the no-browser case sets `JUX_CACHE_DIR: '/nonexistent', PLAYWRIGHT_BROWSERS_PATH: '/nonexistent', JUX_CHROME: ''` and asserts `/jux browser install/`.

- [ ] **Step 6: Run everything**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
node scripts/check-snap.mjs
grep -rn playwright packages/*/package.json packages/*/src   # expect: nothing
node packages/cli/dist/index.js browser status                # expect: the ms-playwright path on this Mac
cd examples/storybook && node ../../packages/cli/dist/index.js run --all; cd ../..
node scripts/check-parity.mjs compare examples/storybook /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-hashes.json       # expect parity: 15/15
node scripts/check-parity.mjs compare examples/ladle /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-ladle-hashes.json      # expect parity: 14/14
pnpm check:determinism                                                                                                  # expect OK, 3 runs
```

Also run `jux browser install` once with `JUX_CACHE_DIR=/Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/cache` and then `JUX_CACHE_DIR=… PLAYWRIGHT_BROWSERS_PATH=/nonexistent jux browser status` → `jux-cache`; re-run the parity compare with that env → still 15/15 (a fresh CfT download renders the same bytes as the Playwright cache).

- [ ] **Step 7: Commit**

```bash
pnpm format && git add packages/cli packages/server packages/storybook scripts/check-snap.mjs
git commit -m "cli, server: capture through the CDP driver; add jux browser install"
```

### Task 10: Scripts, docs, CI, changesets, measurements

**Files:**

- Modify: `scripts/capture-diff-fixtures.mjs:14`, `scripts/capture-structure-fixture.mjs:10` (`const { Browser, resolveChrome } = await import('../packages/core/dist/index.js')`; regenerate nothing — fixtures must stay byte-identical; run each script into a temp dir and `diff -r` against the committed fixtures as the proof)
- Modify: `scripts/structural-corpus/no-playwright.mjs` → rename to `no-browser.mjs`: refuse `node:child_process` `spawn` of anything ending in `chrome-headless-shell` and any import of `playwright`; `scripts/check-diff.mjs:16,50-62,154` to use it
- Modify: `README.md` (install section: `jux browser install`; a "Browser" section: pinned version, `JUX_CHROME`/`--chrome`, cache locations, ms-playwright reuse, Linux apt line, linux-arm64 note), `packages/cli/README.md` (same install line), `plugins/claude-code/skills/visual-check/SKILL.md:44` (`jux browser install`), `ARCHITECTURE.md` (layout: `core/browser/`; "Playwright" → "the CDP driver"), `CLAUDE.md` layout block (`browser/    CDP driver, launcher, installer — a verbatim port of what Playwright did for us; see the 2026-10-13 spec before touching init or screenshot`)
- Modify: `.github/workflows/ci.yml:64,142` → `run: node packages/cli/dist/index.js browser install` with an `actions/cache@v4` step keyed `chrome-headless-shell-151.0.7922.34-${{ runner.os }}` on `~/.cache/jux`
- Modify: `package.json` and every `packages/*/package.json` `engines.node` → `>=22.0.0`
- Create: `.changeset/cdp-driver.md` (minor: core, adapter-storybook, adapter-ladle, cli, server, storybook)
- Create: `docs/superpowers/plans/2026-10-13-cdp-driver-pr1-measurements.md` is NOT created — measurements go in the PR description.

- [ ] **Step 1: Fixture scripts.** Port, then for each: run into `/Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/fixtures-<name>/` and `diff -r` against the committed fixture directory. Expected: no output (identical). If a fixture differs, stop: that is a driver bug, not a fixture refresh.

- [ ] **Step 2: Probe.** `scripts/structural-corpus/no-browser.mjs`:

```js
// Loader hook: `jux diff` must never start a browser or load a driver.
import { register } from 'node:module';
import child from 'node:child_process';
const spawn = child.spawn;
child.spawn = function (cmd, ...rest) {
  if (/chrome-headless-shell|chromium/i.test(String(cmd)))
    throw new Error(`no-browser probe: spawn(${cmd})`);
  return spawn.call(this, cmd, ...rest);
};
register(new URL('./no-browser-hook.mjs', import.meta.url));
```

with `no-browser-hook.mjs` keeping the old resolve hook, pattern `/^playwright(-core)?(\/|$)/`. `check-diff.mjs`: keep the three assertions, reword to "no browser". Run `node scripts/check-diff.mjs` → all checks pass.

- [ ] **Step 3: Docs and CI** as listed. README "Browser" section text:

```
## Browser

jux drives a pinned `chrome-headless-shell` 151.0.7922.34 from Chrome for
Testing — the same build Playwright 1.62 ships, so baselines captured with
earlier jux versions still match. `jux browser install` downloads it once
(~100 MB) into `~/Library/Caches/jux` (macOS), `~/.cache/jux` (Linux) or
`%LOCALAPPDATA%\jux` (Windows); `JUX_CACHE_DIR` overrides. If Playwright's
cache already holds the same build, jux uses it and downloads nothing.
`JUX_CHROME=<path>` or `--chrome <path>` uses your own Chromium instead; the
version is recorded in each run's `env`, so a mismatch is reported rather
than silently red. Linux needs Chromium's shared libraries — on Ubuntu 24.04:
`sudo apt-get install <list from spec §Decisions 9>`. linux-arm64 has no
published build of this version; use `JUX_CHROME`.
```

- [ ] **Step 4: Measurements for the PR description** (run from the repo root, all with the built CLI):

```bash
# jux snap, 10 runs, cold-launch path (PR 1 has no daemon)
node /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/serve.mjs examples/storybook/storybook-static 4799 &
for i in $(seq 10); do /usr/bin/time -p node packages/cli/dist/index.js snap "http://127.0.0.1:4799/iframe.html?id=button--primary&viewMode=story" --as t$i 2>&1 | grep real; done
# jux run, 3 runs each example; compare against main's numbers: storybook 1409–1723 ms, ladle 1539 ms (2026-10-13, this Mac)
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

Capture through juxtapose's own CDP driver instead of Playwright. Baselines are byte-identical (verified on both examples); `npx playwright install chromium` becomes `jux browser install`, or `JUX_CHROME=<path>`. Mask selectors must be CSS (Playwright-only syntax such as `text=` now errors). Node 22+.
```

- [ ] **Step 6: Final gate and commit**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && node scripts/check-snap.mjs && node scripts/check-diff.mjs && pnpm check:determinism
grep -rn playwright packages/*/package.json packages/*/src    # nothing
pnpm format && git add -u && git add .changeset/cdp-driver.md scripts/structural-corpus/no-browser.mjs scripts/structural-corpus/no-browser-hook.mjs
git commit -m "docs, ci, scripts: jux browser install replaces playwright install"
```

Open PR 1 from `feat/cdp-driver` with the parity table, the determinism output and the Step 4 numbers.

# PR 2 — warm browser (branch `feat/warm-browser` off PR 1)

Spike evidence (spec §Measured baseline, §Decisions 13–16): a browser that
had served twelve earlier invocations produced 15/15 and 14/14 identical
bytes; one headless shell stays alive across client disconnects while a CDP
client holds the pipe; warm p50 was 257 ms in-process vs 370 fresh.

### Task 11: Daemon state, paths and the spawn lock

**Files:**

- Create: `packages/core/src/browser/daemon/state.ts`
- Test: `packages/core/src/browser/daemon/state.test.ts`

**Interfaces:**

- Consumes: `juxCacheDir` (Task 1).
- Produces: `interface DaemonState { pid: number; socket: string; binary: string; version: string; startedAt: string; idleMinutes: number }`, `daemonKey(binary: string, version: string, uid?: number): string` (first 16 hex of sha256), `daemonPaths(cacheDir: string, key: string): { dir: string; state: string; socket: string; lock: string }` (socket is `\\.\pipe\jux-browser-<key>` on win32), `readState(paths): Promise<DaemonState | null>` (null on missing/invalid), `writeState(paths, state): Promise<void>` (dir `0700`, file `0600`, write-then-rename), `clearState(paths): Promise<void>`, `acquireLock(paths): Promise<(() => Promise<void>) | null>` (`O_EXCL`; a lock older than 30 s is stale and taken over), `pidAlive(pid: number): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat, writeFile, utimes } from 'node:fs/promises';
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

const state = {
  pid: process.pid,
  socket: '/s',
  binary: '/b',
  version: '151.0.7922.34',
  startedAt: '2026-10-13T00:00:00Z',
  idleMinutes: 10,
};

describe('daemon state', () => {
  it('keys on binary, version and uid', () => {
    expect(daemonKey('/b', '151', 1)).toMatch(/^[0-9a-f]{16}$/);
    expect(daemonKey('/b', '151', 1)).not.toBe(daemonKey('/c', '151', 1));
    expect(daemonKey('/b', '151', 1)).not.toBe(daemonKey('/b', '151', 2));
  });
  it('writes 0600 inside a 0700 dir and reads it back; garbage reads as null', async () => {
    const cache = await mkdtemp(path.join(tmpdir(), 'jux-daemon-'));
    try {
      const paths = daemonPaths(cache, 'abc');
      await writeState(paths, state);
      if (process.platform !== 'win32') {
        expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
        expect((await stat(paths.state)).mode & 0o777).toBe(0o600);
      }
      expect(await readState(paths)).toEqual(state);
      await writeFile(paths.state, '{nope');
      expect(await readState(paths)).toBeNull();
      await clearState(paths);
      expect(await readState(paths)).toBeNull();
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
  it('lock is exclusive, released, and stale after 30 s', async () => {
    const cache = await mkdtemp(path.join(tmpdir(), 'jux-daemon-'));
    try {
      const paths = daemonPaths(cache, 'abc');
      const release = await acquireLock(paths);
      expect(release).not.toBeNull();
      expect(await acquireLock(paths)).toBeNull();
      await release!();
      const again = await acquireLock(paths);
      expect(again).not.toBeNull();
      const old = new Date(Date.now() - 31_000);
      await utimes(paths.lock, old, old);
      expect(await acquireLock(paths)).not.toBeNull();
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
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

import { createHash } from 'node:crypto';
import {
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
  startedAt: string;
  idleMinutes: number;
}

export interface DaemonPaths {
  dir: string;
  state: string;
  socket: string;
  lock: string;
}

const LOCK_STALE_MS = 30_000;

export function daemonKey(
  binary: string,
  version: string,
  uid: number = safeUid(),
): string {
  return createHash('sha256')
    .update(`${binary}\n${version}\n${uid}`)
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

export async function readState(paths: DaemonPaths): Promise<DaemonState | null> {
  try {
    const s = JSON.parse(await readFile(paths.state, 'utf8')) as DaemonState;
    return typeof s.pid === 'number' && typeof s.socket === 'string' ? s : null;
  } catch {
    return null;
  }
}

export async function writeState(paths: DaemonPaths, state: DaemonState): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
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
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
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

- [ ] **Step 4: Run** → PASS (4 tests). **Step 5: Commit**

```bash
pnpm format && git add packages/core/src/browser/daemon
git commit -m "core: daemon state file, paths and spawn lock"
```

### Task 12: Supervisor

**Files:**

- Create: `packages/core/src/browser/daemon/supervisor.ts`
- Create: `packages/core/src/browser/daemon/supervisor-main.ts` (the detached entry: `node supervisor-main.js <stateJsonArgs>`)
- Test: `packages/core/src/browser/daemon/supervisor.test.ts` (integration, skipped without a browser)

**Interfaces:**

- Consumes: `launchChrome` (Task 5), `CdpConnection`, `NullFramer` (Task 4), `daemonPaths`, `writeState`, `clearState` (Task 11).
- Produces: `startSupervisor(opts: { executablePath: string; paths: DaemonPaths; idleMinutes: number; onExit?: () => void }): Promise<{ state: DaemonState; stop(): Promise<void> }>`. Wire protocol on the socket: the client's first frame is `{"jux":"hello","version":"<CHROME_VERSION>"}`; the supervisor answers `{"jux":"ready","product":"HeadlessChrome/151…"}`; after that, frames are raw CDP both ways. Message ids are rewritten per client (client id → global id) so two clients never collide; events are forwarded to the client that owns the `sessionId` (tracked from its `Target.attachToTarget` replies) or to every client when session-less. Contexts created by a client (`Target.createBrowserContext` replies) are disposed when that client's socket closes.

- [ ] **Step 1: Write the integration test**

```ts
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSupervisor } from './supervisor.js';
import { daemonPaths, readState } from './state.js';
import { resolveChrome } from '../resolve.js';
import { CdpConnection } from '../cdp.js';
import { SocketTransport } from '../transport.js';
import { CHROME_VERSION } from '../pins.js';

const chrome = (() => {
  try {
    return resolveChrome();
  } catch {
    return null;
  }
})();

async function client(socketPath: string): Promise<CdpConnection> {
  const sock = net.connect(socketPath);
  await new Promise<void>((r, e) => {
    sock.once('connect', r);
    sock.once('error', e);
  });
  const t = new SocketTransport(sock);
  const c = new CdpConnection(t);
  const ready = c.once<{ jux: string }>('jux.ready');
  t.send(JSON.stringify({ jux: 'hello', version: CHROME_VERSION }));
  await ready;
  return c;
}

describe.skipIf(!chrome)('supervisor', () => {
  it('serves two clients, isolates ids and sessions, and disposes a dead client’s contexts', async () => {
    const cache = await mkdtemp(path.join(tmpdir(), 'jux-sup-'));
    const paths = daemonPaths(cache, 'test');
    const sup = await startSupervisor({
      executablePath: chrome!.path,
      paths,
      idleMinutes: 10,
    });
    try {
      expect((await readState(paths))?.pid).toBe(process.pid);
      const a = await client(paths.socket);
      const b = await client(paths.socket);
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
      const r = await a.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: '6*7', returnByValue: true },
        sessionId,
      );
      expect(r.result.value).toBe(42);
      // b never attached to a's session: an event for it must not reach b.
      let bSaw = 0;
      b.on('Runtime.executionContextCreated', () => bSaw++);
      await a.send('Runtime.enable', {}, sessionId);
      a.close();
      // After a drops, its context is gone from the browser.
      await new Promise((r) => setTimeout(r, 200));
      const { browserContextIds } = await b.send<{ browserContextIds: string[] }>(
        'Target.getBrowserContexts',
      );
      expect(browserContextIds).not.toContain(browserContextId);
      expect(bSaw).toBe(0);
      b.close();
    } finally {
      await sup.stop();
      await rm(cache, { recursive: true, force: true });
    }
    expect(await readState(paths)).toBeNull();
  });
  it('rejects a client with another pinned version', async () => {
    const cache = await mkdtemp(path.join(tmpdir(), 'jux-sup-'));
    const paths = daemonPaths(cache, 'test');
    const sup = await startSupervisor({
      executablePath: chrome!.path,
      paths,
      idleMinutes: 10,
    });
    try {
      const sock = net.connect(paths.socket);
      await new Promise<void>((r) => sock.once('connect', r));
      const t = new SocketTransport(sock);
      const c = new CdpConnection(t);
      const refused = c.once<{ jux: string; reason: string }>('jux.refused');
      t.send(JSON.stringify({ jux: 'hello', version: '0.0.0.0' }));
      expect((await refused).reason).toMatch(/version/);
    } finally {
      await sup.stop();
      await rm(cache, { recursive: true, force: true });
    }
  });
  it('exits when idle', async () => {
    const cache = await mkdtemp(path.join(tmpdir(), 'jux-sup-'));
    const paths = daemonPaths(cache, 'test');
    let exited = false;
    const sup = await startSupervisor({
      executablePath: chrome!.path,
      paths,
      idleMinutes: 0.005,
      onExit: () => (exited = true),
    }); // 300 ms
    await new Promise((r) => setTimeout(r, 900));
    expect(exited).toBe(true);
    expect(await readState(paths)).toBeNull();
    await sup.stop();
    await rm(cache, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Write `supervisor.ts`**

```ts
// packages/core/src/browser/daemon/supervisor.ts
//
// Owns the pipe to one chrome-headless-shell and multiplexes local clients
// onto it. Chrome stays alive with zero targets as long as this process
// holds the pipe (verified 2026-10-13: ten client connect/disconnect cycles
// against one browser). Each client gets a private id space and only the
// events for sessions it attached; when a client's socket closes, the
// browser contexts it created are disposed, which is what Chrome's own
// disposeOnDetach would do if the client had held the pipe itself.

import net from 'node:net';
import { CHROME_VERSION } from '../pins.js';
import { launchChrome, type LaunchedChrome } from '../launch.js';
import { NullFramer } from '../transport.js';
import { clearState, writeState, type DaemonPaths, type DaemonState } from './state.js';

interface Client {
  socket: net.Socket;
  framer: NullFramer;
  ready: boolean;
  sessions: Set<string>;
  contexts: Set<string>;
  /** global id → client id */
  ids: Map<number, number>;
}

export interface Supervisor {
  state: DaemonState;
  stop(): Promise<void>;
}

export async function startSupervisor(opts: {
  executablePath: string;
  paths: DaemonPaths;
  idleMinutes: number;
  onExit?: () => void;
}): Promise<Supervisor> {
  const chrome: LaunchedChrome = await launchChrome({
    executablePath: opts.executablePath,
  });
  const { product } = await chrome.connection.send<{ product: string }>(
    'Browser.getVersion',
  );
  const clients = new Set<Client>();
  let nextId = 0;
  const owners = new Map<number, { client: Client; clientId: number; method: string }>();
  let idleTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const rawSend = (c: Client, obj: object) => {
    if (!c.socket.destroyed) c.socket.write(JSON.stringify(obj) + '\0');
  };

  // Replies and events from Chrome go through the single underlying transport.
  // CdpConnection already parsed them for its own callers; we need the raw
  // frames too, so listen on the transport-level hook exposed for this.
  chrome.connection.onRaw = (m) => {
    if (m.id !== undefined) {
      const o = owners.get(m.id);
      if (!o) return;
      owners.delete(m.id);
      if (o.method === 'Target.attachToTarget' && m.result?.sessionId)
        o.client.sessions.add(m.result.sessionId);
      if (o.method === 'Target.createBrowserContext' && m.result?.browserContextId)
        o.client.contexts.add(m.result.browserContextId);
      if (o.method === 'Target.disposeBrowserContext')
        o.client.contexts.delete(
          (m.params as { browserContextId?: string })?.browserContextId ?? '',
        );
      rawSend(o.client, { ...m, id: o.clientId });
      return;
    }
    if (m.method) {
      if (m.sessionId) {
        for (const c of clients) if (c.sessions.has(m.sessionId)) rawSend(c, m);
      } else {
        // Session-less events (Target.* on the browser session) go to every ready client.
        for (const c of clients) if (c.ready) rawSend(c, m);
      }
    }
  };

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (clients.size > 0) return;
    idleTimer = setTimeout(() => void stop('idle'), opts.idleMinutes * 60_000);
    idleTimer.unref();
  };

  const dropClient = async (c: Client) => {
    clients.delete(c);
    for (const id of c.contexts)
      await chrome.connection
        .send('Target.disposeBrowserContext', { browserContextId: id })
        .catch(() => {});
    scheduleIdle();
  };

  const server = net.createServer((socket) => {
    const c: Client = {
      socket,
      framer: new NullFramer(),
      ready: false,
      sessions: new Set(),
      contexts: new Set(),
      ids: new Map(),
    };
    clients.add(c);
    if (idleTimer) clearTimeout(idleTimer);
    socket.setNoDelay(true);
    socket.on('data', (chunk) =>
      c.framer.push(chunk, (frame) => {
        let m: {
          id?: number;
          method?: string;
          params?: object;
          sessionId?: string;
          jux?: string;
          version?: string;
        };
        try {
          m = JSON.parse(frame);
        } catch {
          return;
        }
        if (!c.ready) {
          if (m.jux !== 'hello') return socket.destroy();
          if (m.version !== CHROME_VERSION) {
            rawSend(c, {
              method: 'jux.refused',
              params: {
                jux: 'refused',
                reason: `version ${m.version} != ${CHROME_VERSION}`,
              },
            });
            return socket.end();
          }
          c.ready = true;
          rawSend(c, { method: 'jux.ready', params: { jux: 'ready', product } });
          return;
        }
        if (m.id === undefined || !m.method) return;
        const id = ++nextId;
        owners.set(id, { client: c, clientId: m.id, method: m.method });
        chrome.connection.sendRaw({
          id,
          method: m.method,
          params: m.params ?? {},
          ...(m.sessionId ? { sessionId: m.sessionId } : {}),
        });
      }),
    );
    socket.on('close', () => void dropClient(c));
    socket.on('error', () => socket.destroy());
  });

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
    await new Promise<void>((r) => server.close(() => r()));
    await clearState(opts.paths);
    await chrome.close();
    opts.onExit?.();
  }

  return { state, stop: () => stop('stopped') };
}
```

This needs two small additions to `CdpConnection` (Task 4's file): `onRaw: ((m: RawMessage) => void) | null` called from `dispatch` with the parsed object before id/event handling, and `sendRaw(obj: { id: number; method: string; params: object; sessionId?: string }): void` that writes an already-numbered message and bumps `lastId` past `obj.id` so the connection's own ids never collide (`this.lastId = Math.max(this.lastId, obj.id)`). Add a unit test to `cdp.test.ts`: "sendRaw ids and send ids never collide".

- [ ] **Step 4: Write `supervisor-main.ts`** (the detached process entry)

```ts
// Entry for the detached daemon: `node supervisor-main.js '<json>'` where
// json is { executablePath, cacheDir, key, idleMinutes }. Stdio is detached
// by the launcher; this process lives until idle, `jux browser stop`, or the
// browser dies.
import { startSupervisor } from './supervisor.js';
import { daemonPaths } from './state.js';

const args = JSON.parse(process.argv[2]) as {
  executablePath: string;
  cacheDir: string;
  key: string;
  idleMinutes: number;
};
const paths = daemonPaths(args.cacheDir, args.key);
const sup = await startSupervisor({ ...args, paths, onExit: () => process.exit(0) });
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void sup.stop());
```

- [ ] **Step 5: Run** `pnpm vitest run packages/core/src/browser/daemon packages/core/src/browser/cdp.test.ts` → PASS (3 + the new cdp test). **Step 6: Commit**

```bash
pnpm format && git add packages/core/src/browser
git commit -m "core: warm-browser supervisor multiplexing clients over a local socket"
```

### Task 13: Client: connect, launch, fall back

**Files:**

- Create: `packages/core/src/browser/daemon/client.ts`
- Test: `packages/core/src/browser/daemon/client.test.ts`

**Interfaces:**

- Consumes: `Browser.fromConnection` (Task 6), `SocketTransport`, `CdpConnection` (Task 4), state helpers (Task 11), `supervisor-main.js` path (Task 12), `CHROME_VERSION`.
- Produces: `interface WarmOptions { executablePath: string; cacheDir: string; env?: NodeJS.ProcessEnv; idleMinutes?: number; spawnDaemon?: (args: { executablePath: string; cacheDir: string; key: string; idleMinutes: number }) => void; connectTimeoutMs?: number }`, `daemonEnabled(env: NodeJS.ProcessEnv, flagNoDaemon?: boolean): boolean` (false when `JUX_NO_DAEMON=1`, `CI=true`/`'1'`, or the flag), `connectWarmBrowser(opts): Promise<{ browser: Browser; warm: boolean }>` (`warm:false` means it fell back to a private `Browser.launch`), `stopDaemon(opts): Promise<boolean>`, `daemonStatus(opts): Promise<DaemonState | null>` (null when stale; a stale file is removed).

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectWarmBrowser, daemonEnabled, daemonStatus, stopDaemon } from './client.js';
import { daemonKey, daemonPaths, writeState } from './state.js';
import { startSupervisor } from './supervisor.js';
import { resolveChrome } from '../resolve.js';
import { CHROME_VERSION } from '../pins.js';

const chrome = (() => {
  try {
    return resolveChrome();
  } catch {
    return null;
  }
})();

describe('daemonEnabled', () => {
  it('is off in CI, with JUX_NO_DAEMON, or the flag', () => {
    expect(daemonEnabled({})).toBe(true);
    expect(daemonEnabled({ CI: 'true' })).toBe(false);
    expect(daemonEnabled({ CI: '1' })).toBe(false);
    expect(daemonEnabled({ JUX_NO_DAEMON: '1' })).toBe(false);
    expect(daemonEnabled({}, true)).toBe(false);
  });
});

describe.skipIf(!chrome)('connectWarmBrowser', () => {
  it('stale state file is replaced: dead pid, missing socket', async () => {
    const cache = await mkdtemp(path.join(tmpdir(), 'jux-client-'));
    const key = daemonKey(chrome!.path, CHROME_VERSION);
    const paths = daemonPaths(cache, key);
    await writeState(paths, {
      pid: 2 ** 22 - 1,
      socket: path.join(cache, 'gone.sock'),
      binary: chrome!.path,
      version: CHROME_VERSION,
      startedAt: '',
      idleMinutes: 10,
    });
    let spawned = 0;
    // In-process "daemon" so the test does not fork: the spawn hook starts a supervisor.
    let sup: Awaited<ReturnType<typeof startSupervisor>> | null = null;
    const spawnDaemon = (a: {
      executablePath: string;
      cacheDir: string;
      key: string;
      idleMinutes: number;
    }) => {
      spawned++;
      void startSupervisor({
        executablePath: a.executablePath,
        paths: daemonPaths(a.cacheDir, a.key),
        idleMinutes: a.idleMinutes,
      }).then((s) => (sup = s));
    };
    try {
      const t0 = Date.now();
      const { browser, warm } = await connectWarmBrowser({
        executablePath: chrome!.path,
        cacheDir: cache,
        spawnDaemon,
      });
      expect(Date.now() - t0).toBeLessThan(2500);
      expect(warm).toBe(true);
      expect(spawned).toBe(1);
      expect(browser.version()).toBe(CHROME_VERSION);
      expect(
        (await daemonStatus({ executablePath: chrome!.path, cacheDir: cache }))?.pid,
      ).toBe(process.pid);
      await browser.close(); // closes the client connection only
      const second = await connectWarmBrowser({
        executablePath: chrome!.path,
        cacheDir: cache,
        spawnDaemon,
      });
      expect(spawned).toBe(1); // reused
      await second.browser.close();
      expect(await stopDaemon({ executablePath: chrome!.path, cacheDir: cache })).toBe(
        true,
      );
    } finally {
      await sup?.stop();
      await rm(cache, { recursive: true, force: true });
    }
  });
  it('spawn race yields one daemon', async () => {
    const cache = await mkdtemp(path.join(tmpdir(), 'jux-client-'));
    let spawned = 0;
    let sup: Awaited<ReturnType<typeof startSupervisor>> | null = null;
    const spawnDaemon = (a: {
      executablePath: string;
      cacheDir: string;
      key: string;
      idleMinutes: number;
    }) => {
      spawned++;
      void startSupervisor({
        executablePath: a.executablePath,
        paths: daemonPaths(a.cacheDir, a.key),
        idleMinutes: a.idleMinutes,
      }).then((s) => (sup = s));
    };
    try {
      const both = await Promise.all(
        [1, 2, 3].map(() =>
          connectWarmBrowser({
            executablePath: chrome!.path,
            cacheDir: cache,
            spawnDaemon,
          }),
        ),
      );
      expect(spawned).toBe(1);
      expect(both.every((b) => b.warm)).toBe(true);
      for (const b of both) await b.browser.close();
    } finally {
      await sup?.stop();
      await rm(cache, { recursive: true, force: true });
    }
  });
  it('falls back to a private launch when the daemon cannot be spawned', async () => {
    const cache = await mkdtemp(path.join(tmpdir(), 'jux-client-'));
    try {
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
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Write `client.ts`**

```ts
// packages/core/src/browser/daemon/client.ts
//
// Try the warm browser; never let it cost correctness or a hang. Every
// failure here — no daemon, stale file, refused hello, spawn race lost and
// the winner slow — ends in the same private launch PR 1 ships, within 2 s.

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

export interface WarmOptions {
  executablePath: string;
  cacheDir: string;
  env?: NodeJS.ProcessEnv;
  idleMinutes?: number;
  spawnDaemon?: (args: SpawnArgs) => void;
  connectTimeoutMs?: number;
}

export interface SpawnArgs {
  executablePath: string;
  cacheDir: string;
  key: string;
  idleMinutes: number;
}

const DEFAULT_IDLE_MINUTES = 10;
const DEFAULT_CONNECT_TIMEOUT_MS = 2000;

export function daemonEnabled(env: NodeJS.ProcessEnv, flagNoDaemon = false): boolean {
  if (flagNoDaemon) return false;
  if (env.JUX_NO_DAEMON === '1') return false;
  if (env.CI === 'true' || env.CI === '1') return false;
  return true;
}

function pathsFor(opts: WarmOptions): DaemonPaths {
  return daemonPaths(opts.cacheDir, daemonKey(opts.executablePath, CHROME_VERSION));
}

async function tryConnect(
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
      c.once<{ product: string }>('jux.ready').then((p) => {
        clearTimeout(timer);
        resolve({ connection: c, product: p.product });
      });
      c.once('jux.refused').then(() => {
        clearTimeout(timer);
        c.close();
        resolve(null);
      });
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

export async function connectWarmBrowser(
  opts: WarmOptions,
): Promise<{ browser: Browser; warm: boolean }> {
  const paths = pathsFor(opts);
  const timeout = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  const wrap = (c: { connection: CdpConnection; product: string }) => ({
    browser: Browser.fromConnection(c.connection, {
      version: c.product,
      close: async () => c.connection.close(),
    }),
    warm: true,
  });

  const existing = await readState(paths);
  if (existing) {
    if (existing.binary === opts.executablePath && pidAlive(existing.pid)) {
      const c = await tryConnect(existing.socket, timeout);
      if (c) return wrap(c);
    }
    await clearState(paths); // stale: dead pid, other binary, or a socket that does not answer
  }

  const release = await acquireLock(paths);
  if (release) {
    try {
      (opts.spawnDaemon ?? defaultSpawn)({
        executablePath: opts.executablePath,
        cacheDir: opts.cacheDir,
        key: daemonKey(opts.executablePath, CHROME_VERSION),
        idleMinutes: opts.idleMinutes ?? DEFAULT_IDLE_MINUTES,
      });
    } catch {
      await release();
      return {
        browser: await Browser.launch({ executablePath: opts.executablePath }),
        warm: false,
      };
    }
  }
  // Winner or loser: poll for the state file until the deadline.
  try {
    while (Date.now() < deadline) {
      const s = await readState(paths);
      if (s && pidAlive(s.pid)) {
        const c = await tryConnect(s.socket, Math.max(100, deadline - Date.now()));
        if (c) return wrap(c);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    if (release) await release();
  }
  return {
    browser: await Browser.launch({ executablePath: opts.executablePath }),
    warm: false,
  };
}

export async function daemonStatus(
  opts: Pick<WarmOptions, 'executablePath' | 'cacheDir'>,
): Promise<DaemonState | null> {
  const paths = pathsFor(opts as WarmOptions);
  const s = await readState(paths);
  if (!s) return null;
  if (!pidAlive(s.pid)) {
    await clearState(paths);
    return null;
  }
  return s;
}

export async function stopDaemon(
  opts: Pick<WarmOptions, 'executablePath' | 'cacheDir'>,
): Promise<boolean> {
  const s = await daemonStatus(opts);
  if (!s) return false;
  try {
    process.kill(s.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 40 && pidAlive(s.pid); i++)
    await new Promise((r) => setTimeout(r, 50));
  await clearState(pathsFor(opts as WarmOptions));
  return true;
}
```

Note for the in-process test supervisor: `stopDaemon` sends SIGTERM to `process.pid` — in the test that is vitest itself. Make the test's `stopDaemon` expectation use `sup.stop()` and assert `daemonStatus` is null afterwards instead; keep `stopDaemon` covered by the CLI run in Task 14.

- [ ] **Step 4: Run** `pnpm vitest run packages/core/src/browser/daemon` → PASS. **Step 5: Export** from `browser/index.ts`: `connectWarmBrowser, daemonEnabled, daemonStatus, stopDaemon, type WarmOptions` and from `core/src/index.ts`. **Step 6: Commit**

```bash
pnpm format && git add packages/core/src
git commit -m "core: warm-browser client with stale-state recovery and private-launch fallback"
```

### Task 14: `jux browser start|stop|status`, CLI wiring, docs, determinism with the daemon

**Files:**

- Modify: `packages/cli/src/browser.ts` (`openBrowser` tries the daemon when `daemonEnabled(env, opts.noDaemon)`)
- Modify: `packages/cli/src/commands/browser.ts` (`start`, `stop`, `status` shows the daemon line)
- Modify: `packages/cli/src/index.ts` (`--no-daemon` flag for `snap`, `run`, `init`; help text)
- Modify: `packages/server/src/source.ts:318-320` (the server keeps its own browser across runs already; it does not use the daemon — a long-lived server is its own warm browser)
- Modify: `README.md` (Browser section: warm browser paragraph), `CLAUDE.md` (one line under "Determinism failures": the daemon must stay byte-identical; `check:determinism` runs both ways), `.github/workflows/ci.yml` (a second `check:determinism` step with `JUX_NO_DAEMON=` unset and `CI` unset: `env: { CI: '' }` is not enough on GitHub — run it as `env -u CI pnpm check:determinism`)
- Modify: `scripts/check-determinism.mjs` (accept `--daemon` to assert the daemon was used: read `jux browser status --json` after the first run and require `daemon.pid`)
- Create: `.changeset/warm-browser.md` (minor: core, cli)
- Test: `packages/cli/src/browser.test.ts` (extend)

- [ ] **Step 1: Extend `browser.test.ts`**

```ts
it('honours --no-daemon and CI', async () => {
  // openBrowser must not touch the daemon code path at all in these cases:
  // inject a connectWarm that throws if called.
  const chrome = resolveChrome();
  if (!chrome) return;
  const b = await openBrowser({
    env: { CI: 'true' },
    connectWarm: () => {
      throw new Error('daemon used in CI');
    },
  });
  expect(b.isConnected()).toBe(true);
  await b.close();
  const c = await openBrowser({
    noDaemon: true,
    connectWarm: () => {
      throw new Error('daemon used with --no-daemon');
    },
  });
  await c.close();
});
```

- [ ] **Step 2: `openBrowser`**

```ts
export interface OpenBrowserOptions {
  chrome?: string;
  env?: NodeJS.ProcessEnv;
  noDaemon?: boolean;
  /** Test seam. */
  connectWarm?: typeof connectWarmBrowser;
}

export async function openBrowser(opts: OpenBrowserOptions = {}): Promise<Browser> {
  const env = opts.env ?? process.env;
  const resolved = resolveChrome({ flag: opts.chrome, env });
  if (!resolved) throw new Error(NO_BROWSER_MESSAGE);
  if (!daemonEnabled(env, opts.noDaemon))
    return Browser.launch({ executablePath: resolved.path });
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

`browserCommand` gains:

```ts
  if (sub === 'start') { const r = resolveChrome(); if (!r) { …NO_BROWSER_MESSAGE, EXIT.TOOL }; const { browser, warm } = await connectWarmBrowser({ executablePath: r.path, cacheDir: juxCacheDir() }); await browser.close(); out `jux: warm browser ${warm ? 'running' : 'could not start; captures will launch privately'}`; return warm ? EXIT.OK : EXIT.TOOL; }
  if (sub === 'stop') { const stopped = await stopDaemon({ executablePath: r.path, cacheDir: juxCacheDir() }); out `jux: ${stopped ? 'stopped' : 'no warm browser running'}`; return EXIT.OK; }
  // status adds: daemon: { pid, startedAt, idleMinutes } | null
```

Help lines: `jux browser start|stop  keep one browser warm between runs (default on; JUX_NO_DAEMON=1 or --no-daemon to skip; off when CI=true)`.

- [ ] **Step 3: Run** `pnpm build && pnpm typecheck && pnpm test && node scripts/check-snap.mjs` → green.

- [ ] **Step 4: Determinism and parity with the daemon**

```bash
node packages/cli/dist/index.js browser stop
env -u CI pnpm check:determinism                 # first run spawns the daemon; expect OK, 3 runs
node packages/cli/dist/index.js browser status   # expect a daemon pid
node scripts/check-parity.mjs compare examples/storybook /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-hashes.json       # warm: 15/15
node scripts/check-parity.mjs compare examples/ladle /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-ladle-hashes.json      # warm: 14/14
JUX_NO_DAEMON=1 node scripts/check-parity.mjs compare examples/storybook /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/pw-hashes.json  # cold: 15/15
```

- [ ] **Step 5: Measure `jux snap` warm p50** (10 runs after one warm-up; the spike's wall was 305–327 ms):

```bash
node /Users/jer/.claude/jobs/6ff71ac8/tmp/cdp/serve.mjs examples/storybook/storybook-static 4799 &
node packages/cli/dist/index.js snap "http://127.0.0.1:4799/iframe.html?id=button--primary&viewMode=story" --as warmup >/dev/null
for i in $(seq 10); do /usr/bin/time -p node packages/cli/dist/index.js snap "http://127.0.0.1:4799/iframe.html?id=button--primary&viewMode=story" --as w$i 2>&1 | grep real; done
```

Expected p50 ≤ 330 ms. Also time `jux run --all` on both examples 3× warm; record in the PR with the PR 1 and main numbers side by side.

- [ ] **Step 6: Docs, changeset, commit**

```bash
pnpm format && git add -u && git add .changeset/warm-browser.md
git commit -m "cli: warm browser by default outside CI; jux browser start|stop|status"
```

Open PR 2 against PR 1's branch with the Step 4 and 5 outputs.

---

## Self-review (done while writing)

- Spec coverage: decisions 1–5 → Tasks 5–7; 6–10 → Tasks 1–3, 9, 10; 11 → Task 6 (`stripProduct`); 12 → Task 10 (engines); 13–16 → Tasks 11–14; seam → Task 7–8; migration/docs/CI → Task 10; security → Tasks 11–13; run concurrency → unchanged `pool.ts` over Task 6's `Browser`; verification bar → Task 9 Step 6, Task 10 Step 4–6, Task 14 Steps 4–5.
- Type consistency: `Page.onMainResponse` is introduced in Task 7 Step 5 and added to the fakes in Task 7 Step 1 and Task 8 Step 1; `CdpConnection.onRaw`/`sendRaw` are introduced in Task 12 Step 3 with a test added to Task 4's file; `Browser.fromConnection` (Task 6) is what Task 13 consumes; `connectWarmBrowser`'s `warm` flag is what Task 14's `start` reports.
- Review Focus 1–5 each name their task and test above.
