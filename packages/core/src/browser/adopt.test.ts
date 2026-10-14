import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adoptPlaywrightBrowser, resolveOrAdoptChrome } from './adopt.js';
import { acquireBrowser } from './acquire.js';
import { CHROME_VERSION, chromePlatform } from './pins.js';
import {
  chromeBinaryPath,
  chromeInstallDir,
  msPlaywrightBinaryPath,
  noBrowserMessage,
  resolveChrome,
} from './resolve.js';

// #141: jux ran from Playwright's cache, so deleting that directory broke every launch.
const supported = (() => {
  try {
    chromePlatform();
    return process.platform !== 'win32';
  } catch {
    return false;
  }
})();

interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
  pwDir: string;
  juxBin: string;
}

async function withFixture(
  fn: (f: Fixture) => Promise<void>,
  opts: { playwright?: boolean; version?: string } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-adopt-'));
  const env: NodeJS.ProcessEnv = {
    JUX_CACHE_DIR: path.join(root, 'jux'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'pw'),
    JUX_NO_DAEMON: '1',
  };
  const theirBin = msPlaywrightBinaryPath({ env });
  const pwDir = path.dirname(path.dirname(theirBin));
  if (opts.playwright !== false) {
    await mkdir(path.dirname(theirBin), { recursive: true });
    await writeFile(
      theirBin,
      `#!/bin/sh\necho "HeadlessChrome ${opts.version ?? CHROME_VERSION}"\n`,
      { mode: 0o755 },
    );
    await writeFile(path.join(pwDir, 'INSTALLATION_COMPLETE'), '');
  }
  const juxBin = chromeBinaryPath(
    chromeInstallDir(path.join(root, 'jux')),
    chromePlatform(),
  );
  try {
    await fn({ root, env, pwDir, juxBin });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const gone = (p: string) =>
  stat(p).then(
    () => false,
    () => true,
  );

describe.skipIf(!supported)('adopting the Playwright build (#141)', () => {
  it('copies it into the jux cache and runs from there, leaving Playwright untouched', () =>
    withFixture(async ({ env, pwDir, juxBin }) => {
      expect(resolveChrome({ env })).toBeNull();
      const before = await readFile(msPlaywrightBinaryPath({ env }), 'utf8');
      const r = await resolveOrAdoptChrome({ env });
      expect(r).toEqual({ path: juxBin, source: 'jux-cache' });
      expect(r!.path).not.toContain(pwDir);
      expect(await readFile(msPlaywrightBinaryPath({ env }), 'utf8')).toBe(before);
      expect(await gone(path.join(pwDir, 'INSTALLATION_COMPLETE'))).toBe(false);
      // Idempotent: the second resolve is the plain cache hit.
      expect(resolveChrome({ env })).toEqual({ path: juxBin, source: 'jux-cache' });
    }));

  it('still launches after the Playwright directory is deleted', () =>
    withFixture(async ({ env, pwDir, juxBin }) => {
      await resolveOrAdoptChrome({ env });
      await rm(pwDir, { recursive: true, force: true });
      expect(await gone(pwDir)).toBe(true);
      expect(resolveChrome({ env })).toEqual({ path: juxBin, source: 'jux-cache' });
      expect(await resolveOrAdoptChrome({ env })).toEqual({
        path: juxBin,
        source: 'jux-cache',
      });
    }));

  it('acquireBrowser takes the same path: it adopts, and the error names the fix when nothing exists', async () => {
    await withFixture(
      async ({ env }) => {
        await expect(acquireBrowser({ env })).rejects.toThrow(
          /jux: no browser at .*jux browser install/s,
        );
        expect(noBrowserMessage({ env })).toContain(
          path.join(env.JUX_CACHE_DIR!, 'chrome-headless-shell', CHROME_VERSION),
        );
      },
      { playwright: false },
    );
  });

  it('refuses a Playwright build that is not the pinned version, and cleans up', () =>
    withFixture(
      async ({ env, root }) => {
        expect(await adoptPlaywrightBrowser({ env })).toBeNull();
        expect(resolveChrome({ env })).toBeNull();
        const { readdir } = await import('node:fs/promises');
        const left = await readdir(path.join(root, 'jux', 'chrome-headless-shell')).catch(
          () => [],
        );
        expect(left).toEqual([]);
      },
      { version: '1.2.3' },
    ));

  it('ignores a Playwright dir with no INSTALLATION_COMPLETE marker', () =>
    withFixture(async ({ env, pwDir }) => {
      await rm(path.join(pwDir, 'INSTALLATION_COMPLETE'));
      expect(await adoptPlaywrightBrowser({ env })).toBeNull();
    }));

  it('JUX_CHROME still wins and nothing is copied', () =>
    withFixture(async ({ env, root }) => {
      const mine = path.join(root, 'mine');
      await writeFile(mine, '#!/bin/sh\n', { mode: 0o755 });
      const r = await resolveOrAdoptChrome({ env: { ...env, JUX_CHROME: mine } });
      expect(r).toEqual({ path: mine, source: 'env' });
      expect(await gone(path.join(root, 'jux'))).toBe(true);
    }));
});
