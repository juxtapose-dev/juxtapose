import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectWarmBrowser,
  daemonEnabled,
  daemonStatus,
  spawnSupervisor,
  stopDaemon,
  type SpawnArgs,
} from './client.js';
import {
  acquireLock,
  daemonKey,
  daemonPaths,
  ensureDaemonDirs,
  pidAlive,
  readState,
  writeState,
  type DaemonPaths,
} from './state.js';
import { startSupervisor } from './supervisor.js';
import { CHROME_VERSION } from '../pins.js';
import { chromeForTests } from '../__tests__/helpers.js';

const chrome = chromeForTests();

type Sup = Awaited<ReturnType<typeof startSupervisor>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const builtMain = path.join(here, '../../../dist/browser/daemon/supervisor-main.js');
const built = existsSync(builtMain);

afterEach(() => {
  vi.restoreAllMocks();
});

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
  it('JUX_NO_DAEMON takes any truthy spelling; GitHub Actions and BUILD_ID are CI', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE'])
      expect(daemonEnabled({ JUX_NO_DAEMON: v }), v).toBe(false);
    for (const v of ['0', 'false'])
      expect(daemonEnabled({ JUX_NO_DAEMON: v }), v).toBe(true);
    expect(daemonEnabled({ GITHUB_ACTIONS: 'true' })).toBe(false);
    expect(daemonEnabled({ BUILD_ID: '42' })).toBe(false);
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

/** A state file for `pid` that is otherwise ours: right key, binary, version. */
async function plantState(paths: DaemonPaths, pid: number, socket = paths.socket) {
  await writeState(paths, {
    pid,
    socket,
    binary: chrome!.path,
    version: CHROME_VERSION,
    key: path.basename(paths.state, '.json'),
    startedAt: new Date().toISOString(),
    idleMinutes: 10,
  });
}

/** A listener that counts connections; jux never says hello to it. */
async function listener(at: string) {
  let connections = 0;
  const server = net.createServer((s) => {
    connections++;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(at, r));
  return {
    connections: () => connections,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function captureDebug() {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    if (String(chunk).includes('warm browser unavailable')) lines.push(String(chunk));
    else orig(chunk);
    return true;
  }) as typeof process.stderr.write);
  return lines;
}

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

  it(
    'a live holder that never finishes is waited on for the budget plus 3 s, not 30 s',
    () =>
      withCache(async (cache) => {
        const paths = daemonPaths(cache, keyOf());
        const release = await acquireLock(paths); // a Ctrl-Z'd jux, alive forever
        const d = inProcessDaemon();
        try {
          const t0 = Date.now();
          const { browser, warm } = await connectWarmBrowser({
            executablePath: chrome!.path,
            cacheDir: cache,
            spawnDaemon: d.spawnDaemon,
            connectTimeoutMs: 200,
          });
          const waited = Date.now() - t0;
          expect(warm).toBe(false);
          expect(d.count()).toBe(0);
          expect(waited).toBeGreaterThanOrEqual(3000);
          expect(waited).toBeLessThan(8000);
          await browser.close();
        } finally {
          await release!();
          await d.stop();
        }
      }),
    15_000,
  );

  it('Ruling 24: a state naming a socket elsewhere is never connected to; it is stale', () =>
    withCache(async (cache) => {
      const paths = daemonPaths(cache, keyOf());
      const evil = path.join(cache, 'evil.sock');
      const server = await listener(evil);
      await plantState(paths, process.pid, evil); // live pid, foreign socket
      const connect = vi.spyOn(net, 'connect');
      const d = inProcessDaemon();
      try {
        const { browser, warm } = await connectWarmBrowser({
          executablePath: chrome!.path,
          cacheDir: cache,
          spawnDaemon: d.spawnDaemon,
        });
        expect(connect.mock.calls.some((c) => c[0] === evil)).toBe(false);
        expect(server.connections()).toBe(0);
        expect(warm).toBe(true); // replaced by our own daemon
        expect(d.count()).toBe(1);
        await browser.close();
      } finally {
        await d.stop();
        await server.close();
      }
    }));

  it('Ruling 24: a socket with mode 0666 is refused (private launch, debug line)', () =>
    withCache(async (cache) => {
      const paths = daemonPaths(cache, keyOf());
      await ensureDaemonDirs(paths);
      const server = await listener(paths.socket);
      await chmod(paths.socket, 0o666);
      await plantState(paths, process.pid);
      const lines = captureDebug();
      const d = inProcessDaemon();
      try {
        const { browser, warm } = await connectWarmBrowser({
          executablePath: chrome!.path,
          cacheDir: cache,
          env: { ...process.env, JUX_DEBUG: '1' },
          spawnDaemon: d.spawnDaemon,
          connectTimeoutMs: 300,
        });
        expect(warm).toBe(false);
        expect(server.connections()).toBe(0);
        expect(d.count()).toBe(0);
        expect(lines.join('')).toMatch(/not a private socket/);
        await browser.close();
      } finally {
        await d.stop();
        await server.close();
      }
    }));

  it('Ruling 24: a regular file in place of the socket is refused', () =>
    withCache(async (cache) => {
      const paths = daemonPaths(cache, keyOf());
      await ensureDaemonDirs(paths);
      await writeFile(paths.socket, '', { mode: 0o600 });
      await plantState(paths, process.pid);
      const connect = vi.spyOn(net, 'connect');
      const d = inProcessDaemon();
      try {
        const { browser, warm } = await connectWarmBrowser({
          executablePath: chrome!.path,
          cacheDir: cache,
          spawnDaemon: d.spawnDaemon,
          connectTimeoutMs: 300,
        });
        expect(warm).toBe(false);
        expect(connect.mock.calls.some((c) => c[0] === paths.socket)).toBe(false);
        expect(d.count()).toBe(0);
        await browser.close();
      } finally {
        await d.stop();
      }
    }));

  it.skipIf(!built)(
    'a stopped daemon is kept while its heartbeat is fresh, and replaced (SIGKILL) once it is stale',
    () =>
      withCache(async (cache) => {
        const key = keyOf();
        const paths = daemonPaths(cache, key);
        const child: ChildProcess = spawnSupervisor(
          {
            executablePath: chrome!.path,
            args: [],
            cacheDir: cache,
            key,
            idleMinutes: 10,
          },
          process.env,
          builtMain,
        );
        const exited = new Promise<NodeJS.Signals | null>((r) =>
          child.once('exit', (_c, sig) => r(sig)),
        );
        const d = inProcessDaemon();
        let chromePid = 0;
        try {
          for (let i = 0; i < 100 && (await readState(paths))?.pid !== child.pid; i++)
            await sleep(50);
          chromePid = Number(
            execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim(),
          );
          child.kill('SIGSTOP');

          // Fresh heartbeat: maybe just busy. Never killed; this run goes private.
          const kept = await connectWarmBrowser({
            executablePath: chrome!.path,
            cacheDir: cache,
            spawnDaemon: d.spawnDaemon,
          });
          expect(kept.warm).toBe(false);
          expect(d.count()).toBe(0);
          expect(pidAlive(child.pid!)).toBe(true);
          await kept.browser.close();

          // A stopped process cannot refresh: age the heartbeat past 10 s.
          const old = new Date(Date.now() - 20_000);
          await utimes(paths.state, old, old);
          const { browser, warm } = await connectWarmBrowser({
            executablePath: chrome!.path,
            cacheDir: cache,
            spawnDaemon: d.spawnDaemon,
          });
          expect(warm).toBe(true);
          expect(d.count()).toBe(1);
          expect(await exited).toBe('SIGKILL');
          await browser.close();
          // Its Chrome loses the pipe and goes with it.
          for (let i = 0; i < 40 && pidAlive(chromePid); i++) await sleep(50);
          expect(pidAlive(chromePid)).toBe(false);
        } finally {
          child.kill('SIGKILL');
          if (chromePid && pidAlive(chromePid)) process.kill(chromePid, 'SIGKILL');
          await d.stop();
        }
      }),
    30_000,
  );

  it.skipIf(!built)(
    'the spawned daemon renders with the caller’s env (TZ)',
    () =>
      withCache(async (cache) => {
        const env = { ...process.env, TZ: 'Pacific/Honolulu' };
        const opts = { executablePath: chrome!.path, cacheDir: cache, env };
        try {
          const { browser, warm } = await connectWarmBrowser({
            ...opts,
            spawnDaemon: (a, e) => void spawnSupervisor(a, e, builtMain),
            connectTimeoutMs: 5000,
          });
          expect(warm).toBe(true);
          const ctx = await browser.newContext({ viewport: { width: 100, height: 100 } });
          const page = await ctx.newPage();
          expect(
            await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
          ).toBe('Pacific/Honolulu');
          await browser.close();
        } finally {
          expect(await stopDaemon(opts)).toBe(true);
        }
      }),
    20_000,
  );

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
