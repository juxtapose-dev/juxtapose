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
  it('is a no-op when Playwright already has the binary, unless forced', () =>
    withCache(async (cacheDir) => {
      const root = path.join(cacheDir, 'pw');
      const dir = path.join(root, 'chromium_headless_shell-1234');
      await mkdir(path.join(dir, 'chrome-headless-shell-mac-arm64'), { recursive: true });
      const bin = path.join(dir, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
      await writeFile(bin, '');
      await writeFile(path.join(dir, 'INSTALLATION_COMPLETE'), '');
      const env = { PLAYWRIGHT_BROWSERS_PATH: root, JUX_CHROME: '/nonexistent' };
      const noFetch = (async () => {
        throw new Error('network used');
      }) as unknown as typeof fetch;
      const r = await installChrome({
        cacheDir: path.join(cacheDir, 'jux'),
        platform: 'mac-arm64',
        fetch: noFetch,
        env,
      });
      expect(r).toMatchObject({
        alreadyInstalled: true,
        source: 'ms-playwright',
        path: bin,
      });
      await expect(
        installChrome({
          cacheDir: path.join(cacheDir, 'jux'),
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
  it('re-execs only on Node 24+ with a proxy variable and no flag yet', () => {
    expect(proxyReexecArgs(proxy, '24.1.0', [])).toEqual(['--use-env-proxy']);
    expect(proxyReexecArgs(proxy, '22.12.0', [])).toBeNull();
    expect(proxyReexecArgs({}, '24.1.0', [])).toBeNull();
    expect(proxyReexecArgs(proxy, '24.1.0', ['--use-env-proxy'])).toBeNull();
    expect(
      proxyReexecArgs({ ...proxy, NODE_USE_ENV_PROXY: '1' }, '24.1.0', []),
    ).toBeNull();
  });
});
