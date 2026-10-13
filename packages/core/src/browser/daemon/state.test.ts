import { describe, it, expect } from 'vitest';
import {
  mkdtemp,
  rm,
  stat,
  writeFile,
  utimes,
  mkdir,
  chmod,
  symlink,
  readdir,
  rename,
} from 'node:fs/promises';
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
  daemonSupported,
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
    for (const name of [
      'FONTCONFIG_FILE',
      'FONTCONFIG_PATH',
      'FONTCONFIG_SYSROOT',
      'XDG_DATA_HOME',
      'XDG_DATA_DIRS',
      'LC_CTYPE',
      'LC_MESSAGES',
      'LANGUAGE',
    ])
      expect(daemonKey({ ...fp, env: { ...fp.env, [name]: '/x' } })).not.toBe(k);
    // Unrelated variables do not fork daemons.
    expect(daemonKey({ ...fp, env: { ...fp.env, PATH: '/x' } })).toBe(k);
  });
  it('creates a 0700 dir and 0600 state, reads it back; garbage reads as null', () =>
    withCache(async (paths) => {
      await writeState(paths, state);
      if (process.platform !== 'win32') {
        expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
        expect((await stat(paths.state)).mode & 0o777).toBe(0o600);
      }
      expect(await readState(paths)).toEqual(state);
      await writeFile(paths.state, '{nope');
      expect(await readState(paths)).toBeNull();
    }));
  it.skipIf(process.platform === 'win32')(
    'refuses a group/other-writable dir and a symlinked dir, and never chmods an existing one',
    () =>
      withCache(async (paths, cache) => {
        await mkdir(paths.dir, { recursive: true });
        await chmod(paths.dir, 0o755);
        await writeState(paths, state);
        expect((await stat(paths.dir)).mode & 0o777).toBe(0o755);
        await chmod(paths.dir, 0o775);
        await expect(writeState(paths, state)).rejects.toThrow(/refusing/);
        await expect(acquireLock(paths)).rejects.toThrow(/refusing/);
        await rm(paths.dir, { recursive: true });
        const elsewhere = await mkdtemp(path.join(cache, 'elsewhere-'));
        await symlink(elsewhere, paths.dir);
        await expect(writeState(paths, state)).rejects.toThrow(/refusing/);
        expect(await readdir(elsewhere)).toEqual([]);
      }),
  );
  it('clearState removes the state file and a leftover socket file', () =>
    withCache(async (paths) => {
      await writeState(paths, state);
      if (process.platform !== 'win32') await writeFile(paths.socket, '');
      await clearState(paths);
      expect(await readState(paths)).toBeNull();
      if (process.platform !== 'win32')
        await expect(stat(paths.socket)).rejects.toThrow();
    }));
  it('lock is exclusive, released, and stale after 30 s even if the pid is alive', () =>
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
  it('a fresh lock whose holder pid is dead is stale', () =>
    withCache(async (paths) => {
      await mkdir(paths.dir, { recursive: true, mode: 0o700 });
      await writeFile(paths.lock, String(2 ** 22 - 1), { mode: 0o600 });
      expect(await acquireLock(paths)).not.toBeNull();
    }));
  it('pidAlive', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 - 1)).toBe(false);
  });

  it('no daemon on win32: named pipes cannot be ACLed from Node', () => {
    expect(daemonSupported('win32')).toBe(false);
    expect(daemonSupported('linux')).toBe(true);
    expect(daemonSupported('darwin')).toBe(true);
    expect(() => daemonPaths('C:\\cache', 'abc', { platform: 'win32' })).toThrow(
      /not supported on win32/,
    );
  });
  it('a long cache dir falls back to a short private socket dir; too long throws', () =>
    withCache(async (_p, cache) => {
      const long = path.join(cache, 'x'.repeat(120));
      const short = await mkdtemp(path.join(tmpdir(), 'jux-s-'));
      try {
        const p = daemonPaths(long, 'abc', { shortBase: short, uid: 7 });
        expect(Buffer.byteLength(p.socket)).toBeLessThanOrEqual(100);
        expect(p.socket).toBe(path.join(short, 'jux-7', 'abc.sock'));
        expect(p.state.startsWith(long)).toBe(true);
        if (process.platform !== 'win32') {
          await writeState(p, state);
          expect((await stat(path.dirname(p.socket))).mode & 0o777).toBe(0o700);
        }
        expect(() =>
          daemonPaths(long, 'abc', { shortBase: path.join(short, 'y'.repeat(120)) }),
        ).toThrow(/JUX_STATE_DIR.*--no-daemon/s);
      } finally {
        await rm(short, { recursive: true, force: true });
      }
    }));
  it.skipIf(process.platform === 'win32')(
    'a dir swapped between the check and the rename is refused',
    () =>
      withCache(async (paths, cache) => {
        await expect(
          writeState(paths, state, {
            afterTempOpen: async () => {
              await rename(paths.dir, path.join(cache, 'moved'));
              await mkdir(paths.dir, { mode: 0o700 });
            },
          }),
        ).rejects.toThrow(/changed/);
        expect(await readdir(paths.dir)).toEqual([]);
      }),
  );
  it('readState rejects a record with any missing or mistyped field', () =>
    withCache(async (paths) => {
      await mkdir(paths.dir, { recursive: true, mode: 0o700 });
      for (const bad of [
        { ...state, pid: '1' },
        { ...state, socket: 3 },
        { ...state, binary: undefined },
        { ...state, version: null },
        { ...state, key: 1 },
        { ...state, startedAt: {} },
        { ...state, idleMinutes: 'x' },
        null,
        [],
      ]) {
        await writeFile(paths.state, JSON.stringify(bad));
        expect(await readState(paths)).toBeNull();
      }
    }));
  it('writeState sweeps stray temp files of dead pids only', () =>
    withCache(async (paths) => {
      await mkdir(paths.dir, { recursive: true, mode: 0o700 });
      const dead = path.join(paths.dir, `abc.json.${2 ** 22 - 1}.tmp`);
      const live = path.join(paths.dir, `abc.json.${process.ppid}.tmp`);
      await writeFile(dead, 'x');
      await writeFile(live, 'x');
      await writeState(paths, state);
      await expect(stat(dead)).rejects.toThrow();
      expect((await stat(live)).isFile()).toBe(true);
    }));
  it('concurrent reclaimers of a stale lock yield exactly one holder', () =>
    withCache(async (paths) => {
      const first = await acquireLock(paths);
      expect(first).not.toBeNull();
      const old = new Date(Date.now() - 31_000);
      await utimes(paths.lock, old, old);
      const got = await Promise.all(Array.from({ length: 8 }, () => acquireLock(paths)));
      expect(got.filter((r) => r !== null)).toHaveLength(1);
      expect((await readdir(paths.dir)).filter((f) => f.includes('.stale.'))).toEqual([]);
    }));
  it('release does not remove a lock another process holds', () =>
    withCache(async (paths) => {
      const release = await acquireLock(paths);
      await writeFile(paths.lock, String(process.pid + 1));
      await release!();
      expect((await stat(paths.lock)).isFile()).toBe(true);
    }));
});
