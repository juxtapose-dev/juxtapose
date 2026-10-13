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
import { acquireLock, daemonKey, daemonPaths, writeState } from './state.js';
import { startSupervisor } from './supervisor.js';
import { CHROME_VERSION } from '../pins.js';
import { chromeForTests } from '../__tests__/helpers.js';

const chrome = chromeForTests();

type Sup = Awaited<ReturnType<typeof startSupervisor>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  it('treats an empty marker as unset and CI=0 as not CI', () => {
    expect(daemonEnabled({ CI: '' })).toBe(true);
    expect(daemonEnabled({ JENKINS_URL: '' })).toBe(true);
    expect(daemonEnabled({ CI: '0' })).toBe(true);
    expect(daemonEnabled({ CI: 'true' })).toBe(false);
    expect(daemonEnabled({ JUX_NO_DAEMON: '' })).toBe(true);
  });
});

/** An in-process "daemon" so the test does not fork: the spawn hook starts a supervisor. */
function inProcessDaemon() {
  let spawned = 0;
  const sups: Promise<Sup | null>[] = [];
  const spawnDaemon = (a: SpawnArgs) => {
    spawned++;
    sups.push(
      startSupervisor({
        executablePath: a.executablePath,
        args: a.args,
        paths: daemonPaths(a.cacheDir, a.key),
        key: a.key,
        idleMinutes: a.idleMinutes,
      }).catch(() => null),
    );
  };
  return {
    spawnDaemon,
    count: () => spawned,
    stop: async () => {
      for (const s of await Promise.all(sups)) await s?.stop();
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

const keyOf = (env: NodeJS.ProcessEnv = process.env) =>
  daemonKey({ binary: chrome!.path, version: CHROME_VERSION, args: [], env });

describe.skipIf(!chrome)('connectWarmBrowser', () => {
  it('stale state file is replaced: dead pid and a missing socket', () =>
    withCache(async (cache) => {
      const key = keyOf();
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

  it('waits past the connect budget while a live holder has the lock', () =>
    withCache(async (cache) => {
      const key = keyOf();
      const paths = daemonPaths(cache, key);
      // Another launcher (this pid, so alive) holds the lock and is slow.
      const release = await acquireLock(paths);
      expect(release).not.toBeNull();
      const d = inProcessDaemon();
      try {
        const pending = connectWarmBrowser({
          executablePath: chrome!.path,
          cacheDir: cache,
          spawnDaemon: d.spawnDaemon,
          connectTimeoutMs: 200,
        });
        await sleep(600);
        // The holder's daemon comes up well after the 200 ms budget.
        d.spawnDaemon({
          executablePath: chrome!.path,
          args: [],
          cacheDir: cache,
          key,
          idleMinutes: 10,
        });
        const { browser, warm } = await pending;
        await release!();
        expect(warm).toBe(true);
        expect(d.count()).toBe(1); // the waiter never spawned its own
        await browser.close();
      } finally {
        await d.stop();
      }
    }));

  it('a different environment key gets its own daemon, never the other one', () =>
    withCache(async (cache) => {
      const d = inProcessDaemon();
      try {
        const a = await connectWarmBrowser({
          executablePath: chrome!.path,
          cacheDir: cache,
          env: { ...process.env, TZ: 'UTC' },
          spawnDaemon: d.spawnDaemon,
        });
        const b = await connectWarmBrowser({
          executablePath: chrome!.path,
          cacheDir: cache,
          env: { ...process.env, TZ: 'Asia/Tokyo' },
          spawnDaemon: d.spawnDaemon,
        });
        expect(a.warm && b.warm).toBe(true);
        expect(d.count()).toBe(2);
        await a.browser.close();
        await b.browser.close();
      } finally {
        await d.stop();
      }
    }));

  it('a daemon that dies mid-run disconnects the browser (BrowserDiedError path)', () =>
    withCache(async (cache) => {
      const d = inProcessDaemon();
      try {
        const { browser, warm } = await connectWarmBrowser({
          executablePath: chrome!.path,
          cacheDir: cache,
          spawnDaemon: d.spawnDaemon,
        });
        expect(warm).toBe(true);
        const ctx = await browser.newContext({ viewport: { width: 200, height: 200 } });
        await ctx.newPage();
        await d.stop();
        for (let i = 0; i < 40 && browser.isConnected(); i++) await sleep(25);
        expect(browser.isConnected()).toBe(false);
        await browser.close();
      } finally {
        await d.stop();
      }
    }));
});
