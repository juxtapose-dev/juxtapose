import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installChrome, proxyHint, proxyReexecArgs } from './install.js';
import { CHROME_PINS, CHROME_VERSION } from './pins.js';
import { buildZip } from './__tests__/zip-builder.js';

function zipOf(script: string): Buffer {
  return buildZip([
    { name: 'chrome-headless-shell-mac-arm64/', data: Buffer.alloc(0), mode: 0o755 },
    {
      name: 'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      data: Buffer.from(script),
      mode: 0o755,
    },
  ]);
}
const pinFor = (z: Buffer) => ({
  ...CHROME_PINS['mac-arm64'],
  sha256: createHash('sha256').update(z).digest('hex'),
  bytes: z.length,
});
const zip = zipOf(`#!/bin/sh\necho "HeadlessChrome ${CHROME_VERSION}"\n`);
const pin = pinFor(zip);
// Never let the developer's own ms-playwright cache turn an install into a no-op.
const isolated = (dir: string): NodeJS.ProcessEnv => ({
  PLAYWRIGHT_BROWSERS_PATH: path.join(dir, 'no-playwright'),
});

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
        env: isolated(cacheDir),
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
        await stat(path.join(cacheDir, 'chrome-headless-shell/151.0.7922.34/.complete')),
      ).toBeTruthy();
      expect(seen.at(-1)).toBe(zip.length);
      const again = await installChrome({
        cacheDir,
        platform: 'mac-arm64',
        fetch: fakeFetch(Buffer.alloc(0)),
        pin,
        env: isolated(cacheDir),
      });
      expect(again.source).toBe('jux-cache');
      expect(again.alreadyInstalled).toBe(true);
    }));
  it('refuses a checksum mismatch and leaves no install behind', () =>
    withCache(async (cacheDir) => {
      await expect(
        installChrome({
          cacheDir,
          platform: 'mac-arm64',
          fetch: fakeFetch(zip),
          env: isolated(cacheDir),
        }),
      ).rejects.toThrow(/sha256.*expected.*got/s);
      await expect(
        stat(path.join(cacheDir, 'chrome-headless-shell/151.0.7922.34')),
      ).rejects.toThrow();
    }));
  it('refuses a byte-length mismatch even when the hash matches', () =>
    withCache(async (cacheDir) => {
      await expect(
        installChrome({
          cacheDir,
          platform: 'mac-arm64',
          fetch: fakeFetch(zip),
          pin: { ...pin, bytes: zip.length + 1 },
          env: isolated(cacheDir),
        }),
      ).rejects.toThrow(new RegExp(`${zip.length + 1} bytes.*${zip.length} bytes`, 's'));
    }));
  it('rejects and removes an install whose binary does not print the pinned version', () =>
    withCache(async (cacheDir) => {
      const bad = zipOf('#!/bin/sh\necho "HeadlessChrome 1.2.3"\n');
      await expect(
        installChrome({
          cacheDir,
          platform: 'mac-arm64',
          fetch: fakeFetch(bad),
          pin: pinFor(bad),
          env: isolated(cacheDir),
        }),
      ).rejects.toThrow(/--version.*printed.*1\.2\.3/s);
      await expect(
        stat(path.join(cacheDir, 'chrome-headless-shell/151.0.7922.34')),
      ).rejects.toThrow();
    }));
  it('copies a matching Playwright build into the jux cache instead of downloading, unless forced', () =>
    withCache(async (cacheDir) => {
      const root = path.join(cacheDir, 'pw');
      const dir = path.join(root, 'chromium_headless_shell-1234');
      await mkdir(path.join(dir, 'chrome-headless-shell-mac-arm64'), { recursive: true });
      const theirs = path.join(
        dir,
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      );
      await writeFile(theirs, `#!/bin/sh\necho "HeadlessChrome ${CHROME_VERSION}"\n`, {
        mode: 0o755,
      });
      await writeFile(path.join(dir, 'INSTALLATION_COMPLETE'), '');
      const env = { PLAYWRIGHT_BROWSERS_PATH: root, JUX_CHROME: '/nonexistent' };
      const noFetch = (async () => {
        throw new Error('network used');
      }) as unknown as typeof fetch;
      const jux = path.join(cacheDir, 'jux');
      const r = await installChrome({
        cacheDir: jux,
        platform: 'mac-arm64',
        fetch: noFetch,
        env,
      });
      expect(r).toMatchObject({ alreadyInstalled: true, source: 'jux-cache' });
      expect(r.path.startsWith(jux)).toBe(true);
      await expect(
        installChrome({
          cacheDir: jux,
          platform: 'mac-arm64',
          fetch: noFetch,
          env,
          force: true,
        }),
      ).rejects.toThrow(/network used/);
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
          nodeFlags: new Set(['--use-env-proxy']),
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

describe('proxyReexecArgs', () => {
  const proxy = { HTTPS_PROXY: 'http://p:1' };
  const has = new Set(['--use-env-proxy']);
  it('re-execs only when the flag is supported, a proxy variable is set and the flag is not yet on', () => {
    expect(proxyReexecArgs(proxy, has, [])).toEqual(['--use-env-proxy']);
    expect(proxyReexecArgs(proxy, new Set(), [])).toBeNull();
    expect(proxyReexecArgs({}, has, [])).toBeNull();
    expect(proxyReexecArgs(proxy, has, ['--use-env-proxy'])).toBeNull();
    expect(proxyReexecArgs({ ...proxy, NODE_USE_ENV_PROXY: '1' }, has, [])).toBeNull();
  });
  it('the hint names NODE_USE_ENV_PROXY=1 only when the flag is supported', () => {
    expect(proxyHint(proxy, has)).toMatch(/NODE_USE_ENV_PROXY=1/);
    const old = proxyHint(proxy, new Set());
    expect(old).toMatch(/JUX_CHROME/);
    expect(old).not.toMatch(/NODE_USE_ENV_PROXY/);
  });
});

describe('installChrome failure modes', () => {
  const NEXT =
    /Retry with `npx -p @juxtapose\/cli jux browser install`, or download .*\.zip yourself and set JUX_CHROME/s;
  const base = (cacheDir: string) => ({
    cacheDir,
    platform: 'mac-arm64' as const,
    env: isolated(cacheDir),
  });
  it('every download error ends with a next step', () =>
    withCache(async (cacheDir) => {
      await expect(
        installChrome({ ...base(cacheDir), fetch: fakeFetch(Buffer.alloc(0), 403) }),
      ).rejects.toThrow(NEXT);
      const dies = (async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(4));
              c.error(new Error('socket hang up'));
            },
          }),
        )) as typeof fetch;
      await expect(installChrome({ ...base(cacheDir), fetch: dies })).rejects.toThrow(
        NEXT,
      );
      await expect(
        installChrome({ ...base(cacheDir), fetch: fakeFetch(zip) }),
      ).rejects.toThrow(NEXT);
    }));
  it('a stream longer than the pin is a length mismatch, not a sha256 one', () =>
    withCache(async (cacheDir) => {
      const err = await installChrome({
        ...base(cacheDir),
        fetch: fakeFetch(zip),
        pin: { ...pin, bytes: zip.length - 1 },
      }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/length mismatch/);
      expect((err as Error).message).not.toMatch(/sha256 mismatch/);
      expect((err as Error).message).toMatch(NEXT);
    }));
  it('a matching hash with the wrong declared length is a length mismatch', () =>
    withCache(async (cacheDir) => {
      await expect(
        installChrome({
          ...base(cacheDir),
          fetch: fakeFetch(zip),
          pin: { ...pin, bytes: zip.length + 1 },
        }),
      ).rejects.toThrow(/length mismatch/);
    }));
  it('verification fails when the swap left no marker', () =>
    withCache(async (cacheDir) => {
      await expect(
        installChrome({
          ...base(cacheDir),
          fetch: fakeFetch(zip),
          pin,
          installZip: async () => [],
        }),
      ).rejects.toThrow(/marker is missing/);
    }));
  it('verification fails when the zip had no binary', () =>
    withCache(async (cacheDir) => {
      const empty = buildZip([
        {
          name: 'chrome-headless-shell-mac-arm64/README',
          data: Buffer.from('x'),
          mode: 0o644,
        },
      ]);
      await expect(
        installChrome({ ...base(cacheDir), fetch: fakeFetch(empty), pin: pinFor(empty) }),
      ).rejects.toThrow(/chrome-headless-shell is missing/);
    }));
  it('a binary without the marker is not an install', () =>
    withCache(async (cacheDir) => {
      const dir = path.join(cacheDir, 'chrome-headless-shell', CHROME_VERSION);
      const bin = path.join(
        dir,
        'chrome-headless-shell-mac-arm64',
        'chrome-headless-shell',
      );
      await mkdir(path.dirname(bin), { recursive: true });
      await writeFile(bin, '#!/bin/sh\n');
      let calls = 0;
      const counting = (async () => {
        calls++;
        return new Response(zip);
      }) as typeof fetch;
      const r = await installChrome({ ...base(cacheDir), fetch: counting, pin });
      expect(calls).toBe(1);
      expect(r.alreadyInstalled).toBe(false);
    }));
});
