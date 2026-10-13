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
});
