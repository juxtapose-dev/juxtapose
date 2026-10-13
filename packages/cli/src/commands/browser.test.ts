import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InstallOptions } from '@juxtapose/core';
import {
  browserCommand,
  installWithProxy,
  reexecForProxy,
  type BrowserCommandIo,
} from './browser.js';

function harness(over: Partial<BrowserCommandIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Partial<BrowserCommandIo> = {
    env: {
      JUX_CACHE_DIR: '/nonexistent',
      PLAYWRIGHT_BROWSERS_PATH: '/nonexistent',
    },
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    ...over,
  };
  return { io, out: () => out.join(''), err: () => err.join('') };
}

describe('jux browser', () => {
  it('status with nothing installed exits 3 and names the install command once', async () => {
    const h = harness();
    expect(await browserCommand(['status'], false, h.io)).toBe(3);
    const text = h.out() + h.err();
    expect(text).toMatch(/npx -p @juxtapose\/cli jux browser install/);
    expect(text.match(/jux browser install/g)).toHaveLength(1);
  });

  it('status --json with nothing installed is parseable and exits 3', async () => {
    const h = harness();
    expect(await browserCommand(['status'], true, h.io)).toBe(3);
    expect(JSON.parse(h.out()).path).toBeNull();
  });

  it('an unknown subcommand is a usage error', async () => {
    const h = harness();
    expect(await browserCommand(['frobnicate'], false, h.io)).toBe(2);
    expect(h.err()).toMatch(/unknown subcommand 'frobnicate'/);
  });

  it('install passes --force and the cache dir through, and reports the result', async () => {
    let seen: InstallOptions | undefined;
    const h = harness({
      install: async (o) => {
        seen = o;
        return { path: '/x/chrome', version: '151', alreadyInstalled: false };
      },
    });
    expect(await browserCommand(['install', '--force'], true, h.io)).toBe(0);
    expect(seen?.force).toBe(true);
    expect(seen?.cacheDir).toBe(path.resolve('/nonexistent'));
    expect(JSON.parse(h.out())).toMatchObject({ installed: true, path: '/x/chrome' });
  });

  it('install says where an existing browser is, and does not download', async () => {
    const h = harness({
      install: async () => ({
        path: '/x/chrome',
        version: '151',
        alreadyInstalled: true,
        source: 'jux-cache',
      }),
    });
    expect(await browserCommand(['install'], false, h.io)).toBe(0);
    expect(h.out()).toMatch(/already installed at \/x\/chrome/);
  });

  it('install failure exits 3 with the message on stderr', async () => {
    const h = harness({
      install: async () => {
        throw new Error('jux: download failed');
      },
    });
    expect(await browserCommand(['install'], false, h.io)).toBe(3);
    expect(h.err()).toMatch(/download failed/);
  });

  it('--chrome names the browser jux uses and skips the download; a bad path exits 3', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jux-bt-'));
    try {
      const bin = path.join(dir, 'chrome');
      writeFileSync(bin, '');
      const ok = harness({
        install: async () => {
          throw new Error('must not download');
        },
      });
      expect(await browserCommand(['install', '--chrome', bin], false, ok.io)).toBe(0);
      expect(ok.out()).toMatch(/nothing to install/);
      const bad = harness();
      expect(
        await browserCommand(
          ['install', '--chrome', path.join(dir, 'nope')],
          false,
          bad.io,
        ),
      ).toBe(3);
      expect(bad.err()).toMatch(/does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-execs for a proxy only when a proxy variable is set, the flag exists, and it is not already on', () => {
    const calls: string[][] = [];
    const base = {
      argv: ['/cli/index.js', 'browser', 'install'],
      nodeFlags: new Set(['--use-env-proxy']),
      spawn: (_c: string, a: string[]) => {
        calls.push(a);
        return { status: 7 } as never;
      },
    };
    expect(reexecForProxy({ ...base, env: { HTTPS_PROXY: 'x' } })).toBe(7);
    expect(calls[0]).toEqual(['--use-env-proxy', '/cli/index.js', 'browser', 'install']);
    expect(reexecForProxy({ ...base, env: {} })).toBeNull();
    expect(
      reexecForProxy({ ...base, env: { HTTPS_PROXY: 'x', NODE_USE_ENV_PROXY: '1' } }),
    ).toBeNull();
    expect(
      reexecForProxy({ ...base, env: { HTTPS_PROXY: 'x' }, nodeFlags: new Set() }),
    ).toBeNull();
  });

  it('rejects unknown flags with exit 2, naming the flag', async () => {
    for (const bad of ['--bogus', '--forcee']) {
      const h = harness();
      expect(await browserCommand(['install', bad], false, h.io)).toBe(2);
      expect(h.err()).toContain(bad);
    }
  });

  it('-h and --help print the browser help and exit 0', async () => {
    for (const flag of ['-h', '--help']) {
      const h = harness();
      expect(await browserCommand([flag], false, h.io)).toBe(0);
      expect(h.out()).toMatch(/jux browser install/);
      expect(h.out()).toMatch(/--force/);
    }
    const h = harness();
    expect(await browserCommand(['install', '-h'], false, h.io)).toBe(0);
  });

  it('install --json, status --json and path --json share one shape', async () => {
    const keys = ['path', 'pinned', 'source', 'version'];
    const installed = harness({
      install: async () => ({
        path: '/x/chrome',
        version: '151',
        alreadyInstalled: true,
        source: 'jux-cache',
      }),
    });
    await browserCommand(['install'], true, installed.io);
    expect(Object.keys(JSON.parse(installed.out())).sort()).toEqual(
      [...keys, 'installed'].sort(),
    );
    const dir = mkdtempSync(path.join(tmpdir(), 'jux-bt-'));
    try {
      const bin = path.join(dir, 'chrome');
      writeFileSync(bin, '');
      for (const sub of ['status', 'path']) {
        const h = harness({ env: { JUX_CHROME: bin } });
        expect(await browserCommand([sub], true, h.io)).toBe(0);
        const j = JSON.parse(h.out());
        expect(Object.keys(j).sort()).toEqual(keys);
        expect(j.path).toBe(bin);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const sub of ['status', 'path']) {
      const h = harness();
      expect(await browserCommand([sub], true, h.io)).toBe(3);
      const j = JSON.parse(h.out());
      expect(Object.keys(j).sort()).toEqual(keys);
      expect(j.path).toBeNull();
    }
  });

  it('always writes one stderr line before a download, even with --json', async () => {
    const h = harness({
      install: async () => ({
        path: '/x/chrome',
        version: '151',
        alreadyInstalled: false,
      }),
    });
    await browserCommand(['install'], true, h.io);
    expect(h.err()).toMatch(
      /^jux: downloading Chrome for Testing \S+ \(~\d+ MB\) to .+…\n$/,
    );
  });

  it('installWithProxy re-execs through the proxy path and reports the child code', async () => {
    const calls: string[][] = [];
    const h = harness({
      env: { HTTPS_PROXY: 'x' },
      nodeFlags: new Set(['--use-env-proxy']),
      argv: ['/cli/index.js', 'browser', 'install'],
      spawn: (_c, a) => {
        calls.push(a);
        return { status: 0 } as never;
      },
      install: async () => {
        throw new Error('must not install in-process');
      },
    });
    const r = await installWithProxy(h.io as BrowserCommandIo, {
      force: false,
      json: false,
    });
    expect(r).toEqual({ code: 0 });
    expect(calls[0][0]).toBe('--use-env-proxy');
  });
});
