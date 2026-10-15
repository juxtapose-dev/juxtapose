import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIdentity,
  clearStaleState,
  connectWarmBrowser,
  daemonEnabled,
  daemonIdleMinutes,
  daemonKeyFor,
  daemonStatus,
  juxIdentity,
  listDaemons,
  spawnSupervisor,
  stopAllDaemons,
  stopDaemon,
  type CommandReader,
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

describe('daemonIdleMinutes', () => {
  it('accepts finite minutes in [1, 35000] and nothing else', () => {
    const idle = (v: string | undefined) =>
      daemonIdleMinutes({ JUX_BROWSER_IDLE_MINUTES: v });
    expect(idle('1')).toBe(1);
    expect(idle('35000')).toBe(35000);
    expect(idle('2.5')).toBe(2.5);
    for (const v of ['Infinity', '1e9', '35001', '0', '0.5', '-1', 'abc', '', undefined])
      expect(idle(v), String(v)).toBeUndefined();
  });
});

describe('daemon key', () => {
  it('covers the full Chrome command line, the jux build and the binary on disk', () =>
    withCache(async (dir) => {
      const bin = path.join(dir, 'chrome');
      await writeFile(bin, 'v1');
      const base = { executablePath: bin, env: {} };
      const k = daemonKeyFor(base, 'jux-a');
      expect(daemonKeyFor(base, 'jux-a')).toBe(k);
      expect(daemonKeyFor({ ...base, env: { JUX_CDP_JSON: '1' } }, 'jux-a')).not.toBe(k);
      expect(daemonKeyFor({ ...base, env: { JUX_CDP_JSON: '0' } }, 'jux-a')).toBe(k);
      // Extra args and a different jux version or supervisor build: new socket.
      expect(
        daemonKeyFor({ ...base, args: ['--user-agent=jux-arg-probe'] }, 'jux-a'),
      ).not.toBe(k);
      expect(daemonKeyFor(base, 'jux-b')).not.toBe(k);
      // An in-place update of the binary (same path): size and mtime change.
      await writeFile(bin, 'v2-longer');
      expect(daemonKeyFor(base, 'jux-a')).not.toBe(k);
    }));

  it('includes HOME and XDG_CONFIG_HOME (fontconfig reads both)', () => {
    const fp = { binary: '/c', version: 'v', args: [], uid: 1 };
    const k = daemonKey({ ...fp, env: {} });
    expect(daemonKey({ ...fp, env: { HOME: '/tmp/h' } })).not.toBe(k);
    expect(daemonKey({ ...fp, env: { XDG_CONFIG_HOME: '/tmp/x' } })).not.toBe(k);
  });

  it('the build identity follows relative imports from the entry', () =>
    withCache(async (dir) => {
      const entry = path.join(dir, 'supervisor-main.js');
      await writeFile(entry, "import { x } from './sub/dep.js';\n");
      await writeFile(path.join(dir, 'unrelated.js'), 'a');
      await mkdir(path.join(dir, 'sub'));
      await writeFile(path.join(dir, 'sub', 'dep.js'), "export * from '../leaf.js';\n");
      await writeFile(path.join(dir, 'leaf.js'), 'export const x = 1;\n');
      const a = buildIdentity(entry);
      await writeFile(path.join(dir, 'unrelated.js'), 'b');
      expect(buildIdentity(entry)).toBe(a);
      await writeFile(path.join(dir, 'leaf.js'), 'export const x = 2;\n');
      expect(buildIdentity(entry)).not.toBe(a);
    }));
});

describe('juxIdentity', () => {
  it('follows a rebuild of the supervisor closure within one process', () =>
    withCache(async (dir) => {
      // A Storybook addon or review server stays up across `pnpm build`; it
      // must key the supervisor it spawns from disk, not the one it loaded.
      const entry = path.join(dir, 'supervisor-main.js');
      await writeFile(entry, "import './dep.js';\n");
      await writeFile(path.join(dir, 'dep.js'), 'export const x = 1;\n');
      const a = juxIdentity(entry);
      expect(juxIdentity(entry)).toBe(a);
      await writeFile(path.join(dir, 'dep.js'), 'export const x = 22;\n');
      expect(juxIdentity(entry)).not.toBe(a);
    }));
});

describe('spawnSupervisor', () => {
  it('drops NODE_OPTIONS, keeps the render env, and runs in the state dir', () =>
    withCache(async (dir) => {
      const entry = path.join(dir, 'entry.mjs');
      const out = path.join(dir, 'out.json');
      await writeFile(
        entry,
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ opts: process.env.NODE_OPTIONS ?? null, tz: process.env.TZ, cwd: process.cwd() }));\n`,
      );
      const stateDir = path.join(dir, 'state');
      await mkdir(stateDir);
      const child = spawnSupervisor(
        { executablePath: '/c', args: [], stateDir, key: 'k', idleMinutes: 1 },
        { ...process.env, NODE_OPTIONS: '--cpu-prof', TZ: 'Asia/Tokyo' },
        entry,
      );
      await new Promise((r) => child.once('exit', r));
      const got = JSON.parse(await readFile(out, 'utf8'));
      expect(got).toEqual({
        opts: null,
        tz: 'Asia/Tokyo',
        cwd: await realpath(stateDir),
      });
    }));
});

describe('clearStaleState', () => {
  const state = (paths: DaemonPaths, pid: number, startedAt: string) =>
    writeState(paths, {
      pid,
      socket: paths.socket,
      binary: '/c',
      version: CHROME_VERSION,
      key: 'k',
      startedAt,
      idleMinutes: 10,
    });

  it('removes only the daemon it was asked about, and never a live socket', () =>
    withCache(async (cache) => {
      const paths = daemonPaths(cache, 'k');
      await state(paths, 111, 'old');
      const old = (await readState(paths))!;
      // A successor replaced the state since it was read: both files are its.
      await state(paths, 222, 'new');
      const server = await listener(paths.socket);
      try {
        await clearStaleState(paths, old);
        expect((await readState(paths))?.pid).toBe(222);
        expect(existsSync(paths.socket)).toBe(true);
        // The same daemon, but something answers on the socket: the state goes
        // (it named a dead daemon), the listener's socket stays.
        await clearStaleState(paths, (await readState(paths))!);
        expect(await readState(paths)).toBeNull();
        expect(existsSync(paths.socket)).toBe(true);
      } finally {
        await server.close();
      }
    }));
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
        paths: daemonPaths(a.stateDir, a.key),
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
  daemonKeyFor({ executablePath: chrome!.path, env });

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
        // A loaded CI runner took over 2 s to start Chrome (2026-10-13), so
        // the default budget fell back to a private launch. This test is about
        // replacing stale state, so give the spawn room; the ceiling still
        // proves it never waited out the 30 s stale-lock age.
        const { browser, warm } = await connectWarmBrowser({
          executablePath: chrome!.path,
          stateDir: cache,
          spawnDaemon: d.spawnDaemon,
          connectTimeoutMs: 15_000,
        });
        expect(Date.now() - t0).toBeLessThan(15_000);
        expect(warm).toBe(true);
        expect(d.count()).toBe(1);
        expect(browser.version()).toBe(CHROME_VERSION);
        expect(
          (await daemonStatus({ executablePath: chrome!.path, stateDir: cache }))?.pid,
        ).toBe(process.pid);
        await browser.close(); // closes this client's connection only
        const second = await connectWarmBrowser({
          executablePath: chrome!.path,
          stateDir: cache,
          spawnDaemon: d.spawnDaemon,
        });
        expect(d.count()).toBe(1); // reused
        expect(second.warm).toBe(true);
        await second.browser.close();
      } finally {
        await d.stop();
      }
      expect(
        await daemonStatus({ executablePath: chrome!.path, stateDir: cache }),
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
              stateDir: cache,
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
        stateDir: cache,
        spawnDaemon: () => {
          throw new Error('no fork here');
        },
        connectTimeoutMs: 300,
      });
      expect(warm).toBe(false);
      expect(browser.isConnected()).toBe(true);
      await browser.close();
    }));

  it('preserves an explicit JSON transport override on private fallback', () =>
    withCache(async (cache) => {
      const { browser, warm } = await connectWarmBrowser({
        executablePath: chrome!.path,
        stateDir: cache,
        env: { ...process.env, JUX_CDP_JSON: '1', JUX_NO_DAEMON: '1' },
        args: ['--enable-automation'],
      });
      try {
        expect(warm).toBe(false);
        const ctx = await browser.newContext({ viewport: { width: 100, height: 100 } });
        const page = await ctx.newPage();
        const { arguments: args } = await page.send('Browser.getBrowserCommandLine');
        expect(args).toContain('--remote-debugging-pipe');
        expect(args).not.toContain('--remote-debugging-pipe=cbor');
      } finally {
        await browser.close();
      }
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
          stateDir: cache,
          spawnDaemon: d.spawnDaemon,
          connectTimeoutMs: 200,
        });
        await sleep(600);
        // The holder's daemon comes up well after the 200 ms budget.
        d.spawnDaemon({
          executablePath: chrome!.path,
          args: [],
          stateDir: cache,
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
            stateDir: cache,
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
          stateDir: cache,
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
          stateDir: cache,
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
          stateDir: cache,
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
            stateDir: cache,
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
            stateDir: cache,
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
            stateDir: cache,
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
        const opts = { executablePath: chrome!.path, stateDir: cache, env };
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
          expect(await stopDaemon(opts)).toEqual({ outcome: 'stopped' });
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
          stateDir: cache,
          env: { ...process.env, TZ: 'UTC' },
          spawnDaemon: d.spawnDaemon,
        });
        const b = await connectWarmBrowser({
          executablePath: chrome!.path,
          stateDir: cache,
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

  it('a different Chrome arg list gets its own daemon, never the other one', () =>
    withCache(async (cache) => {
      const spawnedWith: string[][] = [];
      const d = inProcessDaemon();
      const spawnDaemon = (a: SpawnArgs) => {
        spawnedWith.push(a.args);
        d.spawnDaemon(a);
      };
      try {
        const a = await connectWarmBrowser({
          executablePath: chrome!.path,
          stateDir: cache,
          spawnDaemon,
        });
        const b = await connectWarmBrowser({
          executablePath: chrome!.path,
          stateDir: cache,
          args: ['--user-agent=jux-arg-probe'],
          spawnDaemon,
        });
        expect(a.warm && b.warm).toBe(true);
        expect(spawnedWith).toEqual([[], ['--user-agent=jux-arg-probe']]);
        const page = await (
          await b.browser.newContext({ viewport: { width: 100, height: 100 } })
        ).newPage();
        // Not --lang: Linux Chrome takes its locale from LANG and ignores the flag.
        expect(await page.evaluate(() => navigator.userAgent)).toBe('jux-arg-probe');
        await a.browser.close();
        await b.browser.close();
      } finally {
        await d.stop();
      }
    }));

  it('a relative state dir and binary are made absolute before keying and spawning', () =>
    withCache(async (cache) => {
      // The supervisor runs with its cwd in the state dir: a relative one
      // nested itself (<dir>/<dir>/browser), every run fell back, and each
      // left an orphan supervisor (PR #102 re-review N2).
      const spawned: SpawnArgs[] = [];
      const d = inProcessDaemon();
      const spawnDaemon = (a: SpawnArgs) => {
        spawned.push(a);
        d.spawnDaemon(a);
      };
      const rel = {
        executablePath: path.relative(process.cwd(), chrome!.path),
        stateDir: path.relative(process.cwd(), cache),
        spawnDaemon,
      };
      try {
        const a = await connectWarmBrowser(rel);
        const b = await connectWarmBrowser(rel);
        expect(a.warm && b.warm).toBe(true);
        expect(spawned).toHaveLength(1);
        expect(spawned[0]!.stateDir).toBe(cache);
        expect(spawned[0]!.executablePath).toBe(chrome!.path);
        expect(spawned[0]!.key).toBe(keyOf());
        expect(await daemonStatus(rel)).not.toBeNull();
        await a.browser.close();
        await b.browser.close();
      } finally {
        await d.stop();
      }
    }));

  it.skipIf(!built)(
    'a supervisor still starting keeps the spawn lock: a later client waits for it instead of spawning another',
    () =>
      withCache(async (cache) => {
        // A cold Chrome (first launch after a download, a loaded CI box)
        // outlasting the client's budget, shortened here to 300 ms. The
        // supervisor does not start until the test opens the gate, so no
        // wall-clock race decides whether it is "still starting".
        const slow = path.join(cache, 'slow-supervisor-main.mjs');
        const gate = path.join(cache, 'start-gate');
        await writeFile(
          slow,
          [
            `import { existsSync } from 'node:fs';`,
            `while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 10));`,
            `await import(${JSON.stringify(builtMain)});`,
            '',
          ].join('\n'),
        );
        let spawned = 0;
        const opts = {
          executablePath: chrome!.path,
          stateDir: cache,
          connectTimeoutMs: 300,
          spawnDaemon: (a: SpawnArgs, e: NodeJS.ProcessEnv) => {
            spawned++;
            return spawnSupervisor(a, e, slow);
          },
        };
        const lock = daemonPaths(cache, keyOf()).lock;
        try {
          const a = await connectWarmBrowser(opts);
          expect(a.warm).toBe(false); // gave up before its daemon was up
          await a.browser.close();
          // A's 300 ms are over and the supervisor is held at the gate; before
          // the fix A's lock was gone here.
          expect(existsSync(lock)).toBe(true);
          // B's budget is generous: what it proves is that it waits on the
          // lock rather than spawning, however slow Chrome is to start once
          // the gate opens. Without the lock it would spawn at once.
          const pending = connectWarmBrowser({ ...opts, connectTimeoutMs: 20_000 });
          await sleep(200); // B is polling; had it spawned, `spawned` is 2
          await writeFile(gate, '');
          const b = await pending;
          expect(b.warm).toBe(true);
          expect(spawned).toBe(1);
          await b.browser.close();
          // Up and listening: the supervisor drops the lock it was handed just
          // after it writes its state, so a client can see it a beat early.
          for (let i = 0; i < 200 && existsSync(lock); i++) await sleep(25);
          expect(existsSync(lock)).toBe(false);
        } finally {
          await writeFile(gate, '').catch(() => {});
          await stopDaemon(opts);
        }
      }),
    30_000,
  );

  it('stop never removes the files of a live daemon it judged "not ours"', () =>
    withCache(async (cache) => {
      const paths = daemonPaths(cache, keyOf());
      const d = inProcessDaemon();
      const victim = spawn('sleep', ['60'], { stdio: 'ignore' });
      try {
        const { browser } = await connectWarmBrowser({
          executablePath: chrome!.path,
          stateDir: cache,
          spawnDaemon: d.spawnDaemon,
        });
        await browser.close();
        // A state naming another live pid in front of a daemon that answers:
        // what a wrapper entry without "supervisor-main" in argv looks like.
        await plantState(paths, victim.pid!);
        const r = await stopDaemon({
          executablePath: chrome!.path,
          stateDir: cache,
          readCommand: async () => 'node /x/wrapper.js',
        });
        expect(r).toMatchObject({ outcome: 'unverified', pid: victim.pid });
        expect(pidAlive(victim.pid!)).toBe(true);
        expect((await readState(paths))?.pid).toBe(victim.pid);
        expect(existsSync(paths.socket)).toBe(true);
      } finally {
        victim.kill('SIGKILL');
        await d.stop();
      }
    }));

  it('a daemon that dies mid-run disconnects the browser (BrowserDiedError path)', () =>
    withCache(async (cache) => {
      const d = inProcessDaemon();
      try {
        const { browser, warm } = await connectWarmBrowser({
          executablePath: chrome!.path,
          stateDir: cache,
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
  it('a wedged daemon whose command line cannot be read is not signalled or replaced', () =>
    withCache(async (cache) => {
      const paths = daemonPaths(cache, keyOf());
      await ensureDaemonDirs(paths);
      const socks: net.Socket[] = [];
      const server = net.createServer((c) => socks.push(c)); // accepts, never says hello
      await new Promise<void>((r) => server.listen(paths.socket, r));
      await chmod(paths.socket, 0o600);
      const victim = spawn('sleep', ['60'], { stdio: 'ignore' });
      await plantState(paths, victim.pid!);
      const old = new Date(Date.now() - 60_000);
      await utimes(paths.state, old, old);
      const d = inProcessDaemon();
      try {
        const { browser, warm } = await connectWarmBrowser({
          executablePath: chrome!.path,
          stateDir: cache,
          spawnDaemon: d.spawnDaemon,
          readCommand: async () => null,
        });
        expect(warm).toBe(false);
        expect(d.count()).toBe(0);
        expect(pidAlive(victim.pid!)).toBe(true);
        expect(await readState(paths)).not.toBeNull();
        await browser.close();
      } finally {
        victim.kill('SIGKILL');
        await d.stop();
        for (const c of socks) c.destroy();
        await new Promise<void>((r) => server.close(() => r()));
      }
    }));

  it(
    'a foreign socket and no state: gives up after the child exits 0, says so, falls back',
    () =>
      withCache(async (cache) => {
        const paths = daemonPaths(cache, keyOf());
        await ensureDaemonDirs(paths);
        const server = await listener(paths.socket);
        await chmod(paths.socket, 0o600);
        const written: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        vi.spyOn(process.stderr, 'write').mockImplementation(((
          c: string | Uint8Array,
        ) => {
          if (String(c).startsWith('jux: something else')) written.push(String(c));
          else orig(c);
          return true;
        }) as typeof process.stderr.write);
        try {
          const t0 = Date.now();
          const { browser, warm } = await connectWarmBrowser({
            executablePath: chrome!.path,
            stateDir: cache,
            // A supervisor that loses the race to whatever holds the socket exits 0.
            spawnDaemon: () => spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }),
            connectTimeoutMs: 5000,
          });
          const waited = Date.now() - t0;
          expect(warm).toBe(false);
          expect(waited).toBeLessThan(2500);
          expect(written).toEqual([
            `jux: something else is listening on ${paths.socket}; using a private browser. Remove it or set JUX_STATE_DIR.\n`,
          ]);
          await browser.close();
        } finally {
          await server.close();
        }
      }),
    20_000,
  );
});

describe('process verification and stop', () => {
  const key = daemonKeyFor({ executablePath: '/fake/chrome' });
  const opts = (cache: string, readCommand: CommandReader) => ({
    executablePath: '/fake/chrome',
    stateDir: cache,
    readCommand,
  });
  async function withLiveState(
    fn: (cache: string, paths: DaemonPaths, pid: number) => Promise<void>,
  ) {
    await withCache(async (cache) => {
      const paths = daemonPaths(cache, key);
      await ensureDaemonDirs(paths);
      const child = spawn('sleep', ['60'], { stdio: 'ignore' });
      await writeState(paths, {
        pid: child.pid!,
        socket: paths.socket,
        binary: '/fake/chrome',
        version: CHROME_VERSION,
        key,
        startedAt: new Date().toISOString(),
        idleMinutes: 10,
      });
      try {
        await fn(cache, paths, child.pid!);
      } finally {
        child.kill('SIGKILL');
      }
    });
  }

  it('ours (/proc or ps said supervisor-main for this key): SIGTERM, state cleared', () =>
    withLiveState(async (cache, paths, pid) => {
      const r = await stopDaemon(
        opts(cache, async () => `node /x/supervisor-main.js {"key":"${key}"}`),
      );
      expect(r).toEqual({ outcome: 'stopped' });
      for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(50);
      expect(pidAlive(pid)).toBe(false);
      expect(await readState(paths)).toBeNull();
    }));

  it('not ours (a reused pid): not signalled, state cleared, "none"', () =>
    withLiveState(async (cache, paths, pid) => {
      const r = await stopDaemon(opts(cache, async () => 'vim notes.txt'));
      expect(r).toEqual({ outcome: 'none' });
      expect(pidAlive(pid)).toBe(true);
      expect(await readState(paths)).toBeNull();
    }));

  it('status is "not running" for a live pid with nothing on the socket (a reused pid)', () =>
    withLiveState(async (cache, paths) => {
      expect(await daemonStatus(opts(cache, async () => null))).toBeNull();
      expect(await readState(paths)).toBeNull();
    }));

  it('cannot verify (no /proc, ps ENOENT): nothing signalled, state and socket kept', () =>
    withLiveState(async (cache, paths, pid) => {
      const server = await listener(paths.socket);
      try {
        const r = await stopDaemon(opts(cache, async () => null));
        expect(r).toMatchObject({ outcome: 'unverified', pid });
        expect(pidAlive(pid)).toBe(true);
        expect(await readState(paths)).not.toBeNull();
        expect(existsSync(paths.socket)).toBe(true);
      } finally {
        await server.close();
      }
    }));

  it(
    'a pid still alive after SIGTERM is "running", not "stopped"; its files stay',
    () =>
      withCache(async (cache) => {
        // The supervisor handles SIGTERM, so while it is stopped (SIGSTOP) or
        // still closing Chrome the signal does not end it; `stop --json` used to
        // say stopped:true anyway. A child that handles SIGTERM and stays stands in.
        const paths = daemonPaths(cache, key);
        await ensureDaemonDirs(paths);
        const child = spawn(
          process.execPath,
          ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
          { stdio: 'ignore' },
        );
        await sleep(300); // its handler is installed before the signal lands
        await writeState(paths, {
          pid: child.pid!,
          socket: paths.socket,
          binary: '/fake/chrome',
          version: CHROME_VERSION,
          key,
          startedAt: new Date().toISOString(),
          idleMinutes: 10,
        });
        try {
          const r = await stopDaemon(
            opts(cache, async () => `node /x/supervisor-main.js {"key":"${key}"}`),
          );
          expect(r).toMatchObject({ outcome: 'running', pid: child.pid });
          expect(pidAlive(child.pid!)).toBe(true);
          expect(await readState(paths)).not.toBeNull();
        } finally {
          child.kill('SIGKILL');
        }
      }),
    10_000,
  );

  it('a live daemon slow to answer hello is running, not gone (status waits 2 s)', () =>
    withLiveState(async (cache, paths, pid) => {
      // Accepts and answers hello after 800 ms: past the old 500 ms probe.
      const server = net.createServer((sock) => {
        sock.once('data', () =>
          setTimeout(() => {
            sock.write(
              JSON.stringify({ method: 'jux.ready', params: { product: 'x' } }) + '\0',
            );
          }, 800),
        );
      });
      await new Promise<void>((r) => server.listen(paths.socket, r));
      await chmod(paths.socket, 0o600);
      try {
        expect((await daemonStatus(opts(cache, async () => null)))?.pid).toBe(pid);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }));

  it(
    'a live daemon that never answers is running only if its pid is verifiably ours',
    () =>
      withLiveState(async (cache, paths, pid) => {
        const socks: net.Socket[] = [];
        const server = net.createServer((c) => socks.push(c));
        await new Promise<void>((r) => server.listen(paths.socket, r));
        await chmod(paths.socket, 0o600);
        try {
          expect(await daemonStatus(opts(cache, async () => null))).toBeNull();
          const ours = async () => `node /x/supervisor-main.js {"key":"${key}"}`;
          expect((await daemonStatus(opts(cache, ours)))?.pid).toBe(pid);
          expect(await readState(paths)).not.toBeNull();
        } finally {
          for (const c of socks) c.destroy();
          await new Promise<void>((r) => server.close(() => r()));
        }
      }),
    10_000,
  );

  it(
    'list and stop-all reach a daemon under an older key; an unverified one is left alone',
    () =>
      withCache(async (cache) => {
        // After an upgrade or rebuild the key changes, and `stop` computed only
        // the new one: the old daemon ran until it idled out.
        const plant = async (k: string) => {
          const paths = daemonPaths(cache, k);
          await ensureDaemonDirs(paths);
          const child = spawn('sleep', ['60'], { stdio: 'ignore' });
          await writeState(paths, {
            pid: child.pid!,
            socket: paths.socket,
            binary: '/old/chrome',
            version: 'old',
            key: k,
            startedAt: new Date().toISOString(),
            idleMinutes: 10,
          });
          const socks: net.Socket[] = [];
          const server = net.createServer((c) => socks.push(c));
          await new Promise<void>((r) => server.listen(paths.socket, r));
          await chmod(paths.socket, 0o600);
          return {
            child,
            paths,
            close: async () => {
              child.kill('SIGKILL');
              for (const c of socks) c.destroy();
              await new Promise<void>((r) => server.close(() => r()));
            },
          };
        };
        const old = await plant('0ldk3y0ldk3y0ldk');
        const odd = await plant('0dd0dd0dd0dd0dd0');
        const read: CommandReader = async (pid) =>
          pid === old.child.pid
            ? `node /x/supervisor-main.js {"key":"${'0ldk3y0ldk3y0ldk'}"}`
            : null;
        try {
          const listed = await listDaemons({ stateDir: cache, readCommand: read });
          expect(listed.map((s) => s.pid)).toEqual([old.child.pid]);
          const r = await stopAllDaemons({ stateDir: cache, readCommand: read });
          expect(r).toEqual([
            {
              key: '0dd0dd0dd0dd0dd0',
              pid: odd.child.pid,
              outcome: 'unverified',
              reason: expect.any(String),
            },
            { key: '0ldk3y0ldk3y0ldk', pid: old.child.pid, outcome: 'stopped' },
          ]);
          expect(pidAlive(old.child.pid!)).toBe(false);
          expect(await readState(old.paths)).toBeNull();
          expect(pidAlive(odd.child.pid!)).toBe(true);
          expect(await readState(odd.paths)).not.toBeNull();
        } finally {
          await old.close();
          await odd.close();
        }
      }),
    15_000,
  );

  it('the default reader reads this process via /proc, else ps, and says "" for a dead pid', async () => {
    const { defaultReadCommand } = await import('./client.js');
    const me = await defaultReadCommand(process.pid);
    expect(me).toContain('node');
    // The sandbox may lack both /proc and ps; then null is the honest answer.
    const dead = await defaultReadCommand(2 ** 22 - 1);
    expect(dead === '' || dead === null).toBe(true);
  });
});
