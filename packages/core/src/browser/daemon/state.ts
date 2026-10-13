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
import {
  lstat,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
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
  /** Holds the state and lock files. */
  dir: string;
  state: string;
  socket: string;
  lock: string;
  /** Directory holding the socket: `dir`, or a short private fallback. */
  socketDir: string;
}

/** dev/ino of the verified directories, to detect a swap after the check. */
export interface DirIdentity {
  dir: { dev: number; ino: number };
  socketDir: { dev: number; ino: number };
}

const LOCK_STALE_MS = 30_000;
// sun_path is 104 bytes on macOS, 108 on Linux; stay under both.
const MAX_SOCKET_BYTES = 100;
// Everything that can change fonts, locale formatting or text shaping.
const RENDER_ENV = [
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LANGUAGE',
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
  'FONTCONFIG_SYSROOT',
  'XDG_DATA_HOME',
  'XDG_DATA_DIRS',
] as const;

/**
 * Ruling 22: no daemon on Windows. A named pipe lives in the global
 * `\\.\pipe` namespace, any user can squat a name, and Node cannot set a
 * pipe ACL, so another user could read captured pages or forge screenshots.
 * Callers fall back to a fresh launch.
 */
export function daemonSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

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

export function daemonPaths(
  cacheDir: string,
  key: string,
  opts: { platform?: NodeJS.Platform; uid?: number; shortBase?: string } = {},
): DaemonPaths {
  if (!daemonSupported(opts.platform ?? process.platform))
    throw new Error(`jux: the warm browser daemon is not supported on win32`);
  const dir = path.join(cacheDir, 'browser');
  let socketDir = dir;
  let socket = path.join(dir, `${key}.sock`);
  if (Buffer.byteLength(socket) > MAX_SOCKET_BYTES) {
    socketDir = path.join(opts.shortBase ?? '/tmp', `jux-${opts.uid ?? safeUid()}`);
    socket = path.join(socketDir, `${key}.sock`);
    if (Buffer.byteLength(socket) > MAX_SOCKET_BYTES)
      throw new Error(
        `jux: no socket path under ${MAX_SOCKET_BYTES} bytes (cache dir ${cacheDir}). Set JUX_CACHE_DIR to a shorter path, or pass --no-daemon.`,
      );
  }
  return {
    dir,
    state: path.join(dir, `${key}.json`),
    socket,
    lock: path.join(dir, `${key}.lock`),
    socketDir,
  };
}

async function ensureOne(dir: string): Promise<{ dev: number; ino: number }> {
  const uid = process.getuid?.();
  await ensurePrivateDir(
    dir,
    uid,
    (why) =>
      new Error(
        `jux: refusing to use ${dir}: ${why}. Remove it (rm -rf ${dir}) and run jux again, or pass --no-daemon.`,
      ),
  );
  const st = await lstat(dir);
  return { dev: st.dev, ino: st.ino };
}

/** Creates (0700) and verifies the daemon directories; returns their identity. */
export async function ensureDaemonDirs(paths: DaemonPaths): Promise<DirIdentity> {
  const dir = await ensureOne(paths.dir);
  const socketDir =
    paths.socketDir === paths.dir ? dir : await ensureOne(paths.socketDir);
  return { dir, socketDir };
}

/**
 * Re-lstat the directories and refuse if either is no longer the one we
 * verified. Call right before rename/listen. Residual risk: a swap between
 * this check and the syscall that follows is still possible; closing it needs
 * dirfd-relative syscalls Node does not expose. The 0700 owner-only parent
 * makes the swapper the same user in practice.
 */
export async function recheckDaemonDirs(
  paths: DaemonPaths,
  id: DirIdentity,
): Promise<void> {
  const pairs: [string, { dev: number; ino: number }][] = [[paths.dir, id.dir]];
  if (paths.socketDir !== paths.dir) pairs.push([paths.socketDir, id.socketDir]);
  for (const [dir, want] of pairs) {
    const st = await lstat(dir).catch(() => null);
    if (!st || st.isSymbolicLink() || st.dev !== want.dev || st.ino !== want.ino)
      throw new Error(`jux: refusing to use ${dir}: it changed while in use.`);
  }
}

function isState(v: unknown): v is DaemonState {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s['pid'] === 'number' &&
    Number.isInteger(s['pid']) &&
    typeof s['socket'] === 'string' &&
    typeof s['binary'] === 'string' &&
    typeof s['version'] === 'string' &&
    typeof s['key'] === 'string' &&
    typeof s['startedAt'] === 'string' &&
    typeof s['idleMinutes'] === 'number'
  );
}

export async function readState(paths: DaemonPaths): Promise<DaemonState | null> {
  try {
    const s: unknown = JSON.parse(await readFile(paths.state, 'utf8'));
    return isState(s) ? s : null;
  } catch {
    return null;
  }
}

async function sweepTempFiles(dir: string): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = /\.json\.(\d+)\.tmp$/.exec(name);
    if (!m || pidAlive(Number(m[1]))) continue;
    const file = path.join(dir, name);
    if ((await lstat(file).catch(() => null))?.isFile()) await rm(file, { force: true });
  }
}

export async function writeState(
  paths: DaemonPaths,
  state: DaemonState,
  /** Test seam: runs after the temp file is open, before the final checks. */
  hooks: { afterTempOpen?: () => Promise<void> } = {},
): Promise<void> {
  const id = await ensureDaemonDirs(paths);
  await sweepTempFiles(paths.dir);
  const tmp = `${paths.state}.${process.pid}.tmp`;
  // 'wx': never write through a pre-planted file or symlink; 0600 at creation.
  await rm(tmp, { force: true });
  const fh = await open(tmp, 'wx', 0o600);
  try {
    const st = await fh.stat();
    const uid = process.getuid?.();
    if (uid !== undefined && (st.uid !== uid || (st.mode & 0o777) !== 0o600))
      throw new Error(`jux: refusing to write ${tmp}: not a private file of ours.`);
    await hooks.afterTempOpen?.();
    await fh.writeFile(JSON.stringify(state) + '\n');
    await recheckDaemonDirs(paths, id);
  } catch (err) {
    await fh.close();
    await rm(tmp, { force: true });
    throw err;
  }
  await fh.close();
  await rename(tmp, paths.state);
}

export async function clearState(paths: DaemonPaths): Promise<void> {
  await rm(paths.state, { force: true });
  await rm(paths.socket, { force: true });
}

async function lockIsStale(file: string): Promise<boolean> {
  const age = Date.now() - (await stat(file)).mtimeMs;
  const holder = Number.parseInt(await readFile(file, 'utf8').catch(() => ''), 10);
  // An unreadable/empty lock is a holder mid-write: only age can condemn it.
  const dead = Number.isInteger(holder) && holder > 0 && !pidAlive(holder);
  return age > LOCK_STALE_MS || dead;
}

/**
 * O_EXCL lock for "who launches". Returns a release function, or null if
 * held. Stale when older than 30 s or when the pid inside is dead, so a
 * crashed holder cannot wedge every later invocation. A stale lock is
 * renamed aside by the one racer holding the reclaim guard; everyone then
 * competes on O_EXCL creation, so exactly one holder results.
 */
export async function acquireLock(
  paths: DaemonPaths,
): Promise<(() => Promise<void>) | null> {
  await ensureDaemonDirs(paths);
  if (await lockIsStale(paths.lock).catch(() => false)) {
    // Reclaim under a guard file so the staleness verdict and the rename are
    // one step: a bare rename can move a fresh lock that a faster racer just
    // created. Losing the guard means someone else is reclaiming: report held.
    const guard = `${paths.lock}.reclaim`;
    try {
      if (await lockIsStale(guard).catch(() => false))
        await unlink(guard).catch(() => {});
      await (await open(guard, 'wx', 0o600)).close();
    } catch {
      return null;
    }
    try {
      if (await lockIsStale(paths.lock).catch(() => false)) {
        const aside = `${paths.lock}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
        await rename(paths.lock, aside).catch(() => {});
        await unlink(aside).catch(() => {});
      }
    } finally {
      await unlink(guard).catch(() => {});
    }
  }
  try {
    const fh = await open(paths.lock, 'wx', 0o600);
    try {
      await fh.writeFile(String(process.pid));
    } finally {
      await fh.close();
    }
    return async () => {
      // Never remove a lock someone else took over (we were deemed stale).
      const holder = Number.parseInt(
        await readFile(paths.lock, 'utf8').catch(() => ''),
        10,
      );
      if (holder === process.pid) await unlink(paths.lock).catch(() => {});
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
