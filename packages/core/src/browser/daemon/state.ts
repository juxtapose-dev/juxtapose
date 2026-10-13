// packages/core/src/browser/daemon/state.ts
//
// One small JSON file says where the warm browser is. Access control is the
// private directory (verified with lstat, Ruling 17) plus 0600 files: a
// process that cannot read the file cannot find the socket, and one that can
// is the same user. There is no TCP debugging port anywhere; the daemon is
// reached over a Unix socket or named pipe only.
//
// The key is an environment fingerprint, not just the binary: TZ, LANG and
// LC_ALL change what a page renders (dates, number formats, font fallback),
// so two invocations with different ones must not share a browser, or the
// pixels would depend on which one started it.

import { createHash } from 'node:crypto';
import { open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { ensurePrivateDir } from '../private-dir.js';

export interface DaemonState {
  pid: number;
  socket: string;
  binary: string;
  version: string;
  key: string;
  startedAt: string;
  idleMinutes: number;
}

export interface Fingerprint {
  binary: string;
  version: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  uid?: number;
}

export interface DaemonPaths {
  dir: string;
  state: string;
  socket: string;
  lock: string;
}

const LOCK_STALE_MS = 30_000;
const RENDER_ENV = ['TZ', 'LANG', 'LC_ALL', 'FONTCONFIG_FILE'] as const;

export function daemonKey(fp: Fingerprint): string {
  const uid = fp.uid ?? safeUid();
  const env = RENDER_ENV.map((k) => `${k}=${fp.env[k] ?? ''}`).join('\n');
  return createHash('sha256')
    .update(
      [fp.binary, fp.version, JSON.stringify(fp.args), env, String(uid)].join('\n\n'),
    )
    .digest('hex')
    .slice(0, 16);
}

export function daemonPaths(cacheDir: string, key: string): DaemonPaths {
  const dir = path.join(cacheDir, 'browser');
  return {
    dir,
    state: path.join(dir, `${key}.json`),
    // Unix sockets have a ~104-byte path limit; the cache dir is short enough
    // on every supported OS default, and JUX_CACHE_DIR users own that choice.
    socket:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\jux-browser-${key}`
        : path.join(dir, `${key}.sock`),
    lock: path.join(dir, `${key}.lock`),
  };
}

function ensureDir(paths: DaemonPaths): Promise<void> {
  const uid = process.getuid?.();
  return ensurePrivateDir(
    paths.dir,
    uid,
    (why) =>
      new Error(
        `jux: refusing to use ${paths.dir}: ${why}. Remove it (rm -rf ${paths.dir}) and run jux again, or set --no-daemon.`,
      ),
  );
}

export async function readState(paths: DaemonPaths): Promise<DaemonState | null> {
  try {
    const s = JSON.parse(await readFile(paths.state, 'utf8')) as DaemonState;
    return typeof s.pid === 'number' && typeof s.socket === 'string' ? s : null;
  } catch {
    return null;
  }
}

export async function writeState(paths: DaemonPaths, state: DaemonState): Promise<void> {
  await ensureDir(paths);
  const tmp = `${paths.state}.${process.pid}.tmp`;
  // 'wx': never write through a pre-planted file or symlink; 0600 at creation.
  await rm(tmp, { force: true });
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(JSON.stringify(state) + '\n');
  } finally {
    await fh.close();
  }
  await rename(tmp, paths.state);
}

export async function clearState(paths: DaemonPaths): Promise<void> {
  await rm(paths.state, { force: true });
  if (process.platform !== 'win32') await rm(paths.socket, { force: true });
}

/**
 * O_EXCL lock for "who launches". Returns a release function, or null if
 * held. Stale when older than 30 s or when the pid inside is dead, so a
 * crashed holder cannot wedge every later invocation.
 */
export async function acquireLock(
  paths: DaemonPaths,
): Promise<(() => Promise<void>) | null> {
  await ensureDir(paths);
  try {
    const age = Date.now() - (await stat(paths.lock)).mtimeMs;
    const holder = Number.parseInt(
      await readFile(paths.lock, 'utf8').catch(() => ''),
      10,
    );
    // An unreadable/empty lock is a holder mid-write: only age can condemn it.
    const dead = Number.isInteger(holder) && holder > 0 && !pidAlive(holder);
    if (age > LOCK_STALE_MS || dead) await unlink(paths.lock).catch(() => {});
  } catch {
    // no lock file
  }
  try {
    const fh = await open(paths.lock, 'wx', 0o600);
    try {
      await fh.writeFile(String(process.pid));
    } finally {
      await fh.close();
    }
    return async () => {
      await unlink(paths.lock).catch(() => {});
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function safeUid(): number {
  try {
    return userInfo().uid;
  } catch {
    return -1;
  }
}
