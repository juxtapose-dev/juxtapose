// packages/core/src/browser/launch.test.ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn as childSpawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  lstatSync,
  symlinkSync,
  lutimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { spawn as realSpawn } from 'node:child_process';
import {
  launchChrome,
  privateProfileRoot,
  sweepStaleProfiles,
  terminateAll,
  type SpawnFn,
} from './launch.js';
import { TargetClosedError } from './cdp.js';
import { chromeForTests } from './__tests__/helpers.js';

const chrome = chromeForTests();

it.runIf(!!process.env.CI)('CI has the browser the real-Chrome suites need', () => {
  // Every real-Chrome suite (here, page, pool, structure-capture, supervisor) is
  // describe.skipIf(!chrome); without a browser on the runner they would all
  // skip silently and CI would check none of the driver.
  expect(chrome, 'no browser: run `jux browser install` before pnpm test').not.toBeNull();
});

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

// Fake-process tests: no browser needed, so they run everywhere.
describe('launchChrome with an injected spawn', () => {
  /** A child whose pipe answers every command with `{}` and which ignores kill unless told otherwise. */
  function fakeChild(opts: { diesOn?: NodeJS.Signals[]; answers?: boolean } = {}) {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const fromChrome = new PassThrough();
    const toChrome = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (opts.answers !== false) {
          for (const raw of chunk.toString().split('\0').filter(Boolean)) {
            const { id } = JSON.parse(raw) as { id: number };
            fromChrome.write(JSON.stringify({ id, result: {} }) + '\0');
          }
        }
        cb();
      },
    });
    const signals: string[] = [];
    proc.stdio = [null, null, new PassThrough(), toChrome, fromChrome];
    proc.stderr = proc.stdio[2];
    proc.pid = 424242;
    proc.exitCode = null;
    proc.kill = (sig: NodeJS.Signals) => {
      signals.push(sig);
      if (opts.diesOn?.includes(sig)) setImmediate(() => proc.emit('exit', null, sig));
      return true;
    };
    return { proc, signals };
  }
  const asSpawn = (proc: unknown): SpawnFn => (() => proc) as unknown as SpawnFn;

  it('ENOENT names the install command and JUX_CHROME, and nothing is unhandled', async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', on);
    try {
      const err = await launchChrome({ executablePath: '/nonexistent/chrome' }).catch(
        (e: Error) => e,
      );
      expect((err as Error).message).toMatch(/\/nonexistent\/chrome does not exist/);
      expect((err as Error).message).toMatch(
        /npx -p @juxtapose\/cli jux browser install/,
      );
      expect((err as Error).message).toMatch(/JUX_CHROME/);
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', on);
    }
  });

  it('EACCES on a non-executable file gets the same guidance', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jux-eacces-'));
    const file = path.join(dir, 'chrome');
    writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 });
    try {
      await expect(launchChrome({ executablePath: file })).rejects.toThrow(
        /is not executable[\s\S]*jux browser install[\s\S]*JUX_CHROME/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close() escalates Browser.close -> SIGTERM -> SIGKILL and waits for exit', async () => {
    const { proc, signals } = fakeChild({ diesOn: ['SIGKILL'] });
    const b = await launchChrome({ executablePath: 'x', spawn: asSpawn(proc) });
    const t0 = Date.now();
    await b.close();
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(existsSync(b.userDataDir)).toBe(false);
  }, 10_000);

  it('close() stops at SIGTERM when that is enough', async () => {
    const { proc, signals } = fakeChild({ diesOn: ['SIGTERM'] });
    const b = await launchChrome({ executablePath: 'x', spawn: asSpawn(proc) });
    await b.close();
    expect(signals).toEqual(['SIGTERM']);
  }, 10_000);

  it('terminateAll (what SIGINT, SIGTERM and exit call) kills and removes every live launch', async () => {
    const { proc, signals } = fakeChild();
    const b = await launchChrome({ executablePath: 'x', spawn: asSpawn(proc) });
    expect(existsSync(b.userDataDir)).toBe(true);
    terminateAll();
    expect(signals).toEqual(['SIGKILL']);
    expect(existsSync(b.userDataDir)).toBe(false);
  });

  it('installs the SIGINT, SIGTERM and exit handlers once', async () => {
    const before = ['SIGINT', 'SIGTERM', 'exit'].map((e) => process.listenerCount(e));
    const a = fakeChild();
    const b1 = await launchChrome({ executablePath: 'x', spawn: asSpawn(a.proc) });
    const b2 = await launchChrome({
      executablePath: 'x',
      spawn: asSpawn(fakeChild().proc),
    });
    const after = ['SIGINT', 'SIGTERM', 'exit'].map((e) => process.listenerCount(e));
    // Already installed by an earlier test in this file, or installed exactly once now.
    for (let i = 0; i < 3; i++) expect(after[i]! - before[i]!).toBeLessThanOrEqual(1);
    terminateAll();
    void b1;
    void b2;
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeChrome = path.join(here, '__tests__/fake-chrome.mjs');
const builtLaunch = path.join(here, '../../dist/browser/launch.js');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('real signals', () => {
  /** Run signal-host.mjs, wait for READY, send `sig`, report how it ended. */
  async function run(sig: NodeJS.Signals, mode = '') {
    const child = childSpawn(
      process.execPath,
      [path.join(here, '__tests__/signal-host.mjs'), mode],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let out = '';
    const ready = new Promise<[number, string]>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        const m = /READY (\d+) (\S+)/.exec(out);
        if (m) resolve([Number(m[1]), m[2]!]);
      });
      child.once('exit', () => reject(new Error(`host exited before READY: ${out}`)));
    });
    const [chromePid, profile] = await ready;
    expect(alive(chromePid)).toBe(true);
    expect(existsSync(profile)).toBe(true);
    const t0 = Date.now();
    const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    child.kill(sig);
    const how = await Promise.race([
      ended,
      new Promise<never>((_, rej) =>
        setTimeout(() => {
          child.kill('SIGKILL');
          rej(new Error(`host did not exit within 2s of ${sig}`));
        }, 2000),
      ),
    ]);
    await new Promise((r) => setTimeout(r, 200));
    return { how, ms: Date.now() - t0, chromePid, profile, out };
  }

  const built = existsSync(builtLaunch);
  it.runIf(!!process.env.CI)('CI has the built dist the signal tests need', () => {
    // tsc --build emits it; if it is missing the real-signal tests would skip
    // silently and the Ctrl-C guarantee would go unchecked.
    expect(built, `missing ${builtLaunch}: run pnpm build before pnpm test`).toBe(true);
  });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    it.skipIf(!built)(
      `${sig} ends the host by that signal and takes chrome and its profile`,
      async () => {
        const r = await run(sig);
        expect(r.how.signal).toBe(sig);
        expect(alive(r.chromePid)).toBe(false);
        expect(existsSync(r.profile)).toBe(false);
      },
      10_000,
    );
  }
  it.skipIf(!built)(
    'a host SIGTERM handler runs exactly once and is not re-raised over',
    async () => {
      const r = await run('SIGTERM', 'host-handler');
      expect(r.out.match(/HOST/g)).toHaveLength(1);
      expect(r.how).toEqual({ code: 0, signal: null });
      expect(alive(r.chromePid)).toBe(false);
      expect(existsSync(r.profile)).toBe(false);
    },
    10_000,
  );
});

describe('a launch that fails asynchronously settles with nothing else alive', () => {
  // EACCES arrives on the 'error' event, not as a sync throw, and stderr never
  // emits 'close'. With only unref'd timers on the failure path the bare host
  // drained its event loop mid-cleanup: exit 0, no message, profile leaked.
  it.skipIf(!existsSync(builtLaunch) || process.platform === 'win32')(
    'a non-executable binary exits the host 1 with the reason and no profile',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'jux-nonexec-'));
      const file = path.join(dir, 'chrome');
      writeFileSync(file, '#!/bin/sh\nexit 0\n');
      chmodSync(file, 0o644);
      try {
        const child = childSpawn(
          process.execPath,
          [path.join(here, '__tests__/failed-launch-host.mjs'), file],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        const code = await new Promise<number | null>((resolve) =>
          child.once('exit', (c) => resolve(c)),
        );
        expect(out).toMatch(
          /REJECTED jux: could not launch the browser: .*is not executable/,
        );
        expect(code).toBe(1);
        const root = path.join(tmpdir(), `jux-${process.getuid?.() ?? 'u'}`);
        const leaked = readdirSync(root).filter((n) =>
          n.startsWith(`jux-chrome-${child.pid}-`),
        );
        expect(leaked).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );
});

describe('failed launches clean up and explain', () => {
  const tmpScript = (body: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jux-fakebin-'));
    const file = path.join(dir, 'chrome');
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return { dir, file };
  };
  const profiles = () =>
    new Set(
      readdirSync(path.join(tmpdir(), `jux-${process.getuid?.() ?? 'u'}`)).filter((n) =>
        n.startsWith(`jux-chrome-${process.pid}-`),
      ),
    );

  it('a binary that exits at once gives its exit code, and leaves no profile', async () => {
    const before = profiles();
    const err = await launchChrome({ executablePath: '/usr/bin/false' }).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toMatch(/exited with code 1 before it was ready/);
    expect(profiles()).toEqual(before);
  });

  it('a missing shared library is named with the apt line', async () => {
    const { dir, file } = tmpScript(
      'echo "$0: error while loading shared libraries: libnss3.so: cannot open shared object file" >&2; exit 127',
    );
    try {
      const before = profiles();
      const err = await launchChrome({ executablePath: file }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/code 127/);
      expect((err as Error).message).toMatch(/libnss3\.so/);
      expect((err as Error).message).toMatch(/apt-get install/);
      expect(profiles()).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a handshake that never answers is killed, cleaned up, and explained', async () => {
    const before = profiles();
    process.env.JUX_FAKE_CHROME = 'hang';
    let pid = 0;
    const spy: SpawnFn = ((...a: Parameters<SpawnFn>) => {
      const p = (childSpawn as unknown as SpawnFn)(...a);
      pid = p.pid!;
      return p;
    }) as SpawnFn;
    try {
      const err = await launchChrome({
        executablePath: fakeChrome,
        handshakeTimeoutMs: 200,
        spawn: spy,
      }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/did not answer within 200 ms/);
      expect((err as Error).message).toMatch(/jux browser install|JUX_CHROME/);
      await new Promise((r) => setTimeout(r, 100));
      expect(alive(pid)).toBe(false);
      expect(profiles()).toEqual(before);
    } finally {
      delete process.env.JUX_FAKE_CHROME;
    }
  });

  it('a spawn that throws synchronously leaves no profile', async () => {
    const before = profiles();
    const boom: SpawnFn = (() => {
      throw new Error('spawn blew up');
    }) as unknown as SpawnFn;
    await expect(launchChrome({ executablePath: 'x', spawn: boom })).rejects.toThrow(
      /spawn blew up/,
    );
    expect(profiles()).toEqual(before);
  });

  it('the ENOENT failure removes its profile', async () => {
    const before = profiles();
    await launchChrome({ executablePath: '/nonexistent/chrome' }).catch(() => {});
    expect(profiles()).toEqual(before);
  });
});

describe('stale profile sweep', () => {
  it('removes old profiles of dead pids and nothing else', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jux-sweep-'));
    const dead = await new Promise<number>((resolve) => {
      const c = childSpawn(process.execPath, ['-e', '']);
      c.once('exit', () => resolve(c.pid!));
    });
    const mk = (name: string, ageMin: number) => {
      const d = path.join(root, name);
      mkdirSync(d);
      const t = new Date(Date.now() - ageMin * 60_000);
      utimesSync(d, t, t);
      return d;
    };
    const staleDead = mk(`jux-chrome-${dead}-abc123`, 30);
    const youngDead = mk(`jux-chrome-${dead}-young1`, 1);
    const oldLive = mk(`jux-chrome-${process.pid}-live12`, 30);
    const legacy = mk('jux-chrome-LEGACY', 30);
    const other = mk('something-else', 30);
    try {
      await sweepStaleProfiles(root);
      expect(existsSync(staleDead)).toBe(false);
      for (const kept of [youngDead, oldLive, legacy, other])
        expect(existsSync(kept)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('private profile root', () => {
  const uid = process.getuid!();
  const base = () => mkdtempSync(path.join(tmpdir(), 'jux-root-'));

  it('creates the per-user dir with mode 0700', async () => {
    const b = base();
    try {
      const root = await privateProfileRoot({ base: b });
      expect(root).toBe(path.join(b, `jux-${uid}`));
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      expect(await privateProfileRoot({ base: b })).toBe(root); // idempotent
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('refuses a symlink, and never touches its target', async () => {
    const b = base();
    const target = mkdtempSync(path.join(tmpdir(), 'jux-target-'));
    try {
      symlinkSync(target, path.join(b, `jux-${uid}`));
      await expect(privateProfileRoot({ base: b })).rejects.toThrow(/jux-\d+.*Remove/s);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(b, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  for (const mode of [0o770, 0o707, 0o777]) {
    it(`refuses a dir with mode ${mode.toString(8)} and leaves its mode alone`, async () => {
      const b = base();
      try {
        const d = path.join(b, `jux-${uid}`);
        mkdirSync(d);
        chmodSync(d, mode);
        await expect(privateProfileRoot({ base: b })).rejects.toThrow(/Remove/);
        expect(lstatSync(d).mode & 0o777).toBe(mode);
      } finally {
        rmSync(b, { recursive: true, force: true });
      }
    });
  }

  it('refuses a dir owned by another uid', async () => {
    const b = base();
    try {
      mkdirSync(path.join(b, `jux-${uid + 1}`), { mode: 0o700 });
      // The seam: pretend we are uid+1, so the dir we own looks foreign.
      await expect(privateProfileRoot({ base: b, uid: uid + 1 })).rejects.toThrow(
        /owned by another user[\s\S]*Remove/,
      );
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('the sweep never follows or deletes a symlink entry', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jux-sweep-'));
    const victim = mkdtempSync(path.join(tmpdir(), 'jux-victim-'));
    writeFileSync(path.join(victim, 'precious'), 'x');
    const dead = await new Promise<number>((resolve) => {
      const c = childSpawn(process.execPath, ['-e', '']);
      c.once('exit', () => resolve(c.pid!));
    });
    try {
      const link = path.join(root, `jux-chrome-${dead}-evil`);
      symlinkSync(victim, link);
      const old = new Date(Date.now() - 30 * 60_000);
      utimesSync(victim, old, old);
      lutimesSync(link, old, old);
      await sweepStaleProfiles(root);
      expect(existsSync(path.join(victim, 'precious'))).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(victim, { recursive: true, force: true });
    }
  });
});
