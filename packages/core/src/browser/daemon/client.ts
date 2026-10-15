// packages/core/src/browser/daemon/client.ts
//
// Try the warm browser; never let it cost correctness or a hang. Every
// failure here (no daemon, stale file, refused hello, a spawn that dies, the
// race lost and the winner slow, a socket we do not trust) ends in the same
// private launch PR 1 ships, with one JUX_DEBUG line saying why. The budget
// is 2 s to reach a daemon this call spawned or found; a client that finds
// another launch in progress (a live lock holder) waits for it 3 s longer
// rather than starting a second Chrome, and no longer, so a Ctrl-Z'd jux
// holding the lock stalls nobody.
//
// Ruling 24: the only socket ever connected to is the one computed from the
// cache dir and key, and only once it is a 0600 socket of ours in a verified
// private directory. The path in the state file is never trusted.
//
// Once connected, the Browser is the daemon's: if the daemon dies mid-run,
// the connection closes, isConnected() goes false and the pool reports
// BrowserDiedError exactly as for a private Chrome that died (PR 1).

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeArgs } from '../flags.js';
import { Browser } from '../browser.js';
import { CdpConnection } from '../cdp.js';
import { CHROME_VERSION } from '../pins.js';
import { errnoCode, isRecord } from '../guards.js';
import { SocketTransport } from '../transport.js';
import {
  acquireLock,
  daemonKey,
  daemonPaths,
  ensureDaemonDirs,
  handOffLock,
  lockHeld,
  pidAlive,
  readState,
  recheckDaemonDirs,
  releaseLockHeldBy,
  type DaemonPaths,
  type DaemonState,
} from './state.js';

export interface SpawnArgs {
  executablePath: string;
  args: string[];
  stateDir: string;
  key: string;
  idleMinutes: number;
}

export interface WarmOptions {
  executablePath: string;
  args?: string[];
  stateDir: string;
  /** The caller's environment: the key is computed from it and the daemon runs with it. */
  env?: NodeJS.ProcessEnv;
  idleMinutes?: number;
  /** Test seam: start a daemon for these args with this env. Default: a detached supervisor-main. */
  spawnDaemon?: (args: SpawnArgs, env: NodeJS.ProcessEnv) => ChildProcess | void;
  connectTimeoutMs?: number;
  /** Test seam: see CommandReader. */
  readCommand?: CommandReader;
}

/**
 * The command line of a pid, '' when no such process exists, null when this
 * machine gives no way to read it (no /proc and no ps).
 */
export type CommandReader = (pid: number) => Promise<string | null>;

const DEFAULT_IDLE_MINUTES = 10;
const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
/**
 * A live daemon answers hello in milliseconds; a state file whose pid was
 * reused by an unrelated process must not eat the launch budget (preflight
 * defect 13), so the first probe gets 500 ms, not the whole 2 s.
 */
const PROBE_TIMEOUT_MS = 500;
/**
 * `status`, `start` and `stop` have no capture waiting on them, so they give
 * a live daemon the whole capture budget to answer: at 500 ms a supervisor
 * busy parsing tens of MB of screenshot frames read as "not running", and
 * `start` then reported that it could not start (PR #102 re-review N4).
 */
const STATUS_PROBE_TIMEOUT_MS = DEFAULT_CONNECT_TIMEOUT_MS;
/** How much longer than the budget a live lock holder is waited on. */
const HOLDER_GRACE_MS = 3000;
/**
 * The supervisor touches its state file every second. Ten silent seconds
 * means stopped or wedged, not busy: a daemon serving a 700-story run still
 * runs its timers.
 */
const HEARTBEAT_STALE_MS = 10_000;
const POLL_MS = 50;

/** A start that exited 0 but left no state this long after is a foreign socket, not a slow winner. */
const FOREIGN_SETTLE_MS = 500;
/**
 * `jux browser start` asked for a daemon and has nothing else to do, so it
 * waits for a cold Chrome (first launch after a download, Gatekeeper's scan)
 * rather than reporting failure at the 2 s capture budget.
 */
const START_TIMEOUT_MS = 30_000;
/** setTimeout clamps anything over 2^31-1 ms (~35791 min) to 1 ms. */
const MAX_IDLE_MINUTES = 35_000;

const DEFAULT_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'supervisor-main.js',
);

/**
 * `CI` is the convention; these are the systems that do not set it (GitHub
 * Actions does, but `CI` can be unset in a step's env; Jenkins sets BUILD_ID).
 */
export const CI_ENV_VARS = [
  'CI',
  'GITHUB_ACTIONS',
  'JENKINS_URL',
  'BUILD_ID',
  'TEAMCITY_VERSION',
  'BUILDKITE',
  'GITLAB_CI',
  'TF_BUILD',
  'CODEBUILD_BUILD_ID',
] as const;

/** Empty is unset (shells export `X=` when clearing it); `0`/`false` say "no" explicitly. */
const truthy = (v: string | undefined): boolean =>
  !!v && v !== '0' && v.toLowerCase() !== 'false';

/** Off with `--no-daemon`, JUX_NO_DAEMON (any truthy value), or any CI marker. */
export function daemonEnabled(env: NodeJS.ProcessEnv, flagNoDaemon = false): boolean {
  if (flagNoDaemon) return false;
  if (truthy(env.JUX_NO_DAEMON)) return false;
  return !CI_ENV_VARS.some((v) => truthy(env[v]));
}

/**
 * JUX_BROWSER_IDLE_MINUTES within [1, 35000], else the default (undefined).
 * The upper bound is setTimeout's: 100000 minutes overflowed to a 1 ms idle
 * timer and the daemon quit as soon as its last client left. Infinity used to
 * pass too, became null in the spawn JSON, and every supervisor exited 1.
 */
export function daemonIdleMinutes(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.JUX_BROWSER_IDLE_MINUTES;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= MAX_IDLE_MINUTES ? n : undefined;
}

type StatusOptions = Pick<
  WarmOptions,
  'executablePath' | 'stateDir' | 'args' | 'env' | 'readCommand'
>;

/** Stands in for the per-launch profile directory in the keyed command line. */
const PROFILE_PLACEHOLDER = '<profile>';

/**
 * Size and mtime of the binary. An auto-updating Chrome behind --chrome or
 * JUX_CHROME is replaced in place under the same path and pin; without this a
 * daemon started before the update kept rendering with the old build while
 * `--no-daemon` and CI used the new one. For our own pinned download it
 * changes only on a reinstall, which is a new daemon either way.
 */
function binaryIdentity(file: string): string {
  try {
    const st = statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}

const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * A hash of `entry` and every file it reaches through relative imports. The
 * supervisor that serves a client is whichever build spawned it; after a
 * rebuild or an upgrade the supervisor's flags, allowlist or protocol can
 * differ from this client's, and reusing it would render with the old code.
 * A missing file hashes as missing (vitest runs the .ts sources, where the
 * .js entry does not exist).
 */
export function buildIdentity(entry: string): string {
  return buildClosure(entry).hash;
}

function buildClosure(entry: string): { hash: string; files: string[] } {
  const hash = createHash('sha256');
  const seen = new Set<string>();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      hash.update(`${file}\0missing\0`);
      continue;
    }
    hash.update(`${path.basename(file)}\0${src}\0`);
    for (const m of src.matchAll(RELATIVE_IMPORT))
      queue.push(path.resolve(path.dirname(file), m[1]!)); // the group is not optional
  }
  return { hash: hash.digest('hex').slice(0, 16), files: [...seen] };
}

const PACKAGE_JSON = fileURLToPath(new URL('../../../package.json', import.meta.url));

function packageVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    return isRecord(pkg) && typeof pkg['version'] === 'string' ? pkg['version'] : '';
  } catch {
    return '';
  }
}

/** Size and mtime of each file, '-' for a missing one: what a rebuild or upgrade changes. */
function filesStamp(files: string[]): string {
  return files
    .map((f) => {
      try {
        const st = statSync(f);
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${f}:-`;
      }
    })
    .join('\n');
}

const identityCache = new Map<string, { files: string[]; stamp: string; id: string }>();

/**
 * `<@juxtapose/core version>+<build hash of the supervisor entry>`. Cached
 * per process, but rechecked by stat on every call (about ten files): a
 * Storybook addon or review server that stays up across a `pnpm build` kept
 * the old key while spawning the new supervisor-main from disk, so it never
 * shared a daemon with the CLI and ran a mixed build (PR #102 re-review N5).
 */
export function juxIdentity(entry: string = DEFAULT_ENTRY): string {
  const hit = identityCache.get(entry);
  if (hit && filesStamp(hit.files) === hit.stamp) return hit.id;
  const closure = buildClosure(entry);
  const files = [PACKAGE_JSON, ...closure.files];
  // Stamped before hashing would miss a write landing between the two; after
  // is safe: a write after the stamp changes it, and the next call rehashes.
  const id = `${packageVersion()}+${closure.hash}`;
  identityCache.set(entry, { files, stamp: filesStamp(files), id });
  return id;
}

/**
 * The daemon key for these options. It covers everything a fresh launch
 * would render with: the binary (path, size, mtime), the pin, the full Chrome
 * command line jux would launch, the render env and this jux build. Keys that
 * differ name different sockets, so a daemon from an older jux or other
 * flags is never reused; it idles out.
 */
export function daemonKeyFor(
  opts: Pick<WarmOptions, 'executablePath' | 'args' | 'env'>,
  jux: string = juxIdentity(),
): string {
  const binary = path.resolve(opts.executablePath);
  return daemonKey({
    binary,
    binaryId: binaryIdentity(binary),
    version: CHROME_VERSION,
    args: chromeArgs({
      userDataDir: PROFILE_PLACEHOLDER,
      args: opts.args,
      env: opts.env ?? process.env,
    }),
    env: opts.env ?? process.env,
    jux,
  });
}

const keyFor = (opts: StatusOptions): string => daemonKeyFor(opts);

/**
 * `stateDir` and `executablePath` made absolute before anything is keyed or
 * spawned: the supervisor runs with its cwd in the state dir, so a relative
 * `stateDir` made it bind `<stateDir>/<stateDir>/browser/<key>.sock` while
 * the client looked in `<stateDir>/browser`. Every run fell back to a private
 * launch, waited out the lock grace, and left an orphan supervisor (PR #102
 * re-review N2).
 */
function absolute<T extends { stateDir: string; executablePath: string }>(opts: T): T {
  return {
    ...opts,
    stateDir: path.resolve(opts.stateDir),
    executablePath: path.resolve(opts.executablePath),
  };
}

/**
 * Ruling 24: null when `paths.socket` is a 0600 socket owned by us in the
 * verified private directories, else why not. Run right before connecting.
 */
async function untrustedSocket(paths: DaemonPaths): Promise<string | null> {
  try {
    await recheckDaemonDirs(paths, await ensureDaemonDirs(paths));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const st = await lstat(paths.socket).catch(() => null);
  if (!st) return null; // nothing there yet: connecting finds nobody
  const uid = process.getuid?.();
  if (
    !st.isSocket() ||
    (st.mode & 0o777) !== 0o600 ||
    (uid !== undefined && st.uid !== uid)
  )
    return `${paths.socket} is not a private socket of ours`;
  return null;
}

type Probe =
  | { kind: 'ok'; connection: CdpConnection; product: string }
  /** Nothing listens (ENOENT, ECONNREFUSED): the daemon is gone. */
  | { kind: 'dead' }
  | { kind: 'timeout' }
  /** Something listens but would not finish the hello. */
  | { kind: 'refused'; reason: string };

/** One connect + hello within `timeoutMs`, to the computed socket only. */
function tryConnect(paths: DaemonPaths, timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    let settled = false;
    let conn: CdpConnection | null = null;
    const sock = net.connect(paths.socket);
    const finish = (p: Probe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (p.kind !== 'ok') {
        if (conn) conn.close();
        else sock.destroy();
      }
      resolve(p);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    sock.once('error', () => {
      if (!conn) finish({ kind: 'dead' });
    });
    sock.once('connect', () => {
      const t = new SocketTransport(sock);
      const c = (conn = new CdpConnection(t));
      c.once('jux.ready').then(
        (p) => finish({ kind: 'ok', connection: c, product: p.product }),
        () => finish({ kind: 'refused', reason: 'socket closed during hello' }),
      );
      c.once('jux.refused').then(
        (p) => finish({ kind: 'refused', reason: p.reason ?? 'hello refused' }),
        () => {},
      );
      t.send(JSON.stringify({ jux: 'hello', version: CHROME_VERSION }));
    });
  });
}

/** Verify, then connect: a socket we do not trust is never connected to. */
async function probe(paths: DaemonPaths, timeoutMs: number): Promise<Probe> {
  const why = await untrustedSocket(paths);
  return why ? { kind: 'refused', reason: why } : tryConnect(paths, timeoutMs);
}

/**
 * Start a detached supervisor-main with the caller's env: the key was computed
 * from that env, so Chrome must render with it (TZ, LANG, fonts), not with
 * whatever env this process happens to have. Detached in its own process
 * group with stdio ignored: it outlives this jux, and a Ctrl-C to this
 * terminal must not reach it.
 *
 * NODE_OPTIONS is not a render input and is dropped: VS Code's debug
 * terminal (`--require …/bootloader.js`), `--inspect` or `--cpu-prof` would
 * otherwise attach to a process that lives for hours, and `--cpu-prof` would
 * write a profile into the project when it finally exits. The cwd is the
 * state dir for the same reason: not the project that happened to start it.
 */
export function spawnSupervisor(
  args: SpawnArgs,
  env: NodeJS.ProcessEnv,
  entry = DEFAULT_ENTRY,
): ChildProcess {
  const { NODE_OPTIONS: _dropped, ...childEnv } = env;
  const child = spawn(process.execPath, [entry, JSON.stringify(args)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: args.stateDir,
    env: childEnv,
  });
  child.unref();
  return child;
}

/** What became of a daemon this client spawned; `failed` set when it cannot come up. */
interface SpawnWatch {
  failed: string | null;
  /** When the child exited 0: a lost start race (Ruling 21) or a foreign socket. */
  exitedCleanAt: number | null;
}

function watchChild(child: ChildProcess, watch: SpawnWatch): void {
  // An async spawn failure is an 'error' event; unhandled, it would crash jux.
  child.on('error', (e) => (watch.failed ??= `spawn failed: ${e.message}`));
  child.on('exit', (code, signal) => {
    if (code === 0) watch.exitedCleanAt = Date.now();
    else watch.failed ??= `daemon exited (${signal ?? `code ${code}`})`;
  });
}

type Outcome =
  | { browser: Browser; warm: true }
  | { why: string; /** Said on stderr even without JUX_DEBUG. */ notice?: string };

function wrap(p: { connection: CdpConnection; product: string }): Outcome {
  const { connection } = p;
  return {
    // close() drops this client's socket only; the supervisor then disposes
    // the contexts this client still owns. The daemon and its Chrome live on.
    browser: Browser.fromConnection(connection, {
      version: p.product,
      close: async () => connection.close(),
    }),
    warm: true,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function usable(s: DaemonState, key: string, opts: WarmOptions): boolean {
  return (
    s.key === key && s.binary === opts.executablePath && s.version === CHROME_VERSION
  );
}

/** Linux: /proc/<pid>/cmdline, NUL-separated. */
async function procCommand(pid: number): Promise<string | null> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim();
  } catch (e) {
    // No such pid is an answer only when /proc is really there.
    if (errnoCode(e) === 'ENOENT')
      return (await stat('/proc/self').catch(() => null)) ? '' : null;
    return null;
  }
}

function psCommand(pid: number): Promise<string | null> {
  return new Promise((resolve) =>
    execFile('ps', ['-o', 'command=', '-p', String(pid)], (err, out) =>
      // ps missing (ENOENT) cannot say; a non-zero exit is "no such process".
      resolve(err ? (typeof err.code === 'string' ? null : '') : out),
    ),
  );
}

export const defaultReadCommand: CommandReader = async (pid) => {
  if (process.platform === 'linux') {
    const c = await procCommand(pid);
    if (c !== null) return c;
  }
  return psCommand(pid);
};

type Ownership = 'ours' | 'foreign' | 'unknown';

/** Is `pid` our supervisor-main for `key`? 'unknown' when its command line cannot be read. */
async function ownership(
  pid: number,
  key: string,
  read: CommandReader = defaultReadCommand,
): Promise<Ownership> {
  const cmd = await read(pid);
  if (cmd === null) return 'unknown';
  return cmd.includes('supervisor-main') && cmd.includes(key) ? 'ours' : 'foreign';
}

/**
 * True when the daemon behind a timed-out probe is wedged, not busy: its
 * heartbeat is over 10 s old and the pid really is our supervisor-main for
 * this key (not a reused pid, which we must never signal).
 */
async function wedged(
  s: DaemonState,
  paths: DaemonPaths,
  key: string,
  read?: CommandReader,
): Promise<boolean> {
  const st = await stat(paths.state).catch(() => null);
  if (!st || Date.now() - st.mtimeMs <= HEARTBEAT_STALE_MS) return false;
  // Unverifiable is not replaceable: we never signal what we cannot identify.
  return (await ownership(s.pid, key, read)) === 'ours';
}

async function killWedged(pid: number): Promise<void> {
  // SIGKILL: a stopped process does not act on SIGTERM. Its Chrome loses the
  // pipe and exits with it.
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(POLL_MS);
}

/** True when something accepts a connection on `socket` (a full backlog counts). */
function socketLive(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(socket);
    const done = (live: boolean) => {
      clearTimeout(timer);
      s.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(true), PROBE_TIMEOUT_MS);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * Remove the files of the daemon `s` describes, and nothing newer. The state
 * goes only if it still names the same pid and start time: between our read
 * and this call another client may have spawned a replacement that wrote its
 * own (the review traced `jux browser stop` deleting a new daemon's files
 * while the old one's Chrome took 5 s to close, orphaning the new one). The
 * socket goes only if it is the path that state named and nothing listens on
 * it, compared by inode so a socket bound meanwhile is left alone.
 */
export async function clearStaleState(paths: DaemonPaths, s: DaemonState): Promise<void> {
  const now = await readState(paths);
  if (!now || now.pid !== s.pid || now.startedAt !== s.startedAt) return;
  await rm(paths.state, { force: true });
  if (s.socket !== paths.socket) return;
  const before = await lstat(paths.socket).catch(() => null);
  if (!before?.isSocket() || (await socketLive(paths.socket))) return;
  const after = await lstat(paths.socket).catch(() => null);
  if (after && after.ino === before.ino && after.dev === before.dev)
    await rm(paths.socket, { force: true });
}

async function connectOrSpawn(
  given: WarmOptions,
  probeMs = PROBE_TIMEOUT_MS,
): Promise<Outcome> {
  const opts = absolute(given);
  const env = opts.env ?? process.env;
  const key = keyFor(opts);
  const paths = daemonPaths(opts.stateDir, key);
  const start = Date.now();
  const budget = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const existing = await readState(paths);
  if (existing) {
    if (!pidAlive(existing.pid) || existing.socket !== paths.socket) {
      // SIGKILLed daemon, a reboot, or a state naming a socket we would never
      // connect to (Ruling 24): nothing to reuse.
      await clearStaleState(paths, existing);
    } else if (!usable(existing, key, opts)) {
      // Never reuse a daemon with another fingerprint (Ruling 7), and never
      // remove a live process's files.
      return { why: `state file names another daemon (pid ${existing.pid})` };
    } else {
      const p = await probe(paths, probeMs);
      if (p.kind === 'ok') return wrap(p);
      if (p.kind === 'refused') return { why: `daemon refused: ${p.reason}` };
      if (p.kind === 'timeout') {
        if (!(await wedged(existing, paths, key, opts.readCommand)))
          return {
            why: `daemon pid ${existing.pid} did not answer in ${probeMs} ms`,
          };
        await killWedged(existing.pid);
      }
      // Dead (the pid was reused by an unrelated process) or killed as wedged.
      await clearStaleState(paths, existing);
    }
  }

  let watch: SpawnWatch | null = null;
  let release: (() => Promise<void>) | null = null;
  /** The supervisor pid our lock was handed to, if any. */
  let handedTo: number | null = null;
  try {
    for (;;) {
      const s = await readState(paths);
      if (s && s.socket === paths.socket && usable(s, key, opts) && pidAlive(s.pid)) {
        const remaining = start + budget - Date.now();
        const p = await probe(paths, Math.min(probeMs, Math.max(100, remaining)));
        if (p.kind === 'ok') return wrap(p);
        if (p.kind === 'refused') return { why: `daemon refused: ${p.reason}` };
      }
      if (!watch) {
        release = await acquireLock(paths);
        // The holder we were waiting on may have come up and dropped the lock
        // between the state read above and now: spawning then starts a
        // redundant supervisor that only loses the bind. Look again under
        // the lock, and if a daemon is there, let the next pass probe it.
        if (release && (await daemonListed(paths, key, opts))) {
          await release();
          release = null;
        } else if (release) {
          watch = { failed: null, exitedCleanAt: null };
          const args: SpawnArgs = {
            executablePath: opts.executablePath,
            args: opts.args ?? [],
            stateDir: opts.stateDir,
            key,
            idleMinutes: opts.idleMinutes ?? DEFAULT_IDLE_MINUTES,
          };
          let child: ChildProcess | void;
          try {
            child = opts.spawnDaemon
              ? opts.spawnDaemon(args, env)
              : spawnSupervisor(args, env);
          } catch (e) {
            return { why: `spawn failed: ${e instanceof Error ? e.message : String(e)}` };
          }
          if (child) {
            watchChild(child, watch);
            // The lock now lives as long as the supervisor's start, not as
            // long as this client waits (see handOffLock).
            if (child.pid !== undefined && (await handOffLock(paths, child.pid))) {
              handedTo = child.pid;
              release = null;
            }
          }
        }
      }
      if (watch?.failed) return { why: watch.failed };
      if (
        watch?.exitedCleanAt &&
        Date.now() - watch.exitedCleanAt >= FOREIGN_SETTLE_MS &&
        !(await readState(paths)) &&
        (await lstat(paths.socket).catch(() => null))
      )
        return {
          why: `something else is listening on ${paths.socket}`,
          notice: `jux: something else is listening on ${paths.socket}; using a private browser. Remove it or set JUX_STATE_DIR.`,
        };
      const elapsed = Date.now() - start;
      if (elapsed >= budget) {
        // Past the budget, only another client's launch in progress is worth
        // waiting for, and only briefly; our own spawn had its 2 s.
        if (watch || elapsed >= budget + HOLDER_GRACE_MS || !(await lockHeld(paths)))
          return { why: `no daemon answered within ${elapsed} ms` };
      }
      await sleep(POLL_MS);
    }
  } finally {
    if (release) await release();
    else if (
      handedTo !== null &&
      (watch?.failed ||
        watch?.exitedCleanAt ||
        // Up before the hand-off landed: it found no lock of its own to drop.
        (await readState(paths))?.pid === handedTo)
    )
      await releaseLockHeldBy(paths, handedTo);
  }
}

/** Whether the state file names a live, usable daemon for this key. */
async function daemonListed(
  paths: DaemonPaths,
  key: string,
  opts: WarmOptions,
): Promise<boolean> {
  const s = await readState(paths);
  return !!s && s.socket === paths.socket && usable(s, key, opts) && pidAlive(s.pid);
}

async function privateLaunch(
  opts: WarmOptions,
): Promise<{ browser: Browser; warm: false }> {
  return {
    browser: await Browser.launch({
      executablePath: opts.executablePath,
      args: opts.args,
      env: opts.env,
    }),
    warm: false,
  };
}

/**
 * The warm daemon's browser, or a private one if the daemon cannot be had.
 * Never rejects because of the daemon; a private launch failure rejects as in
 * PR 1.
 */
export async function connectWarmBrowser(
  opts: WarmOptions,
): Promise<{ browser: Browser; warm: boolean }> {
  let outcome: Outcome;
  try {
    outcome = await connectOrSpawn(opts);
  } catch (e) {
    outcome = { why: e instanceof Error ? e.message : String(e) };
  }
  const debug = (opts.env ?? process.env).JUX_DEBUG;
  if ('browser' in outcome) {
    // Positive evidence for check:determinism --daemon: a run whose clients
    // all fell back privately prints none of these.
    if (debug) process.stderr.write('jux: using the warm browser\n');
    return outcome;
  }
  if (outcome.notice) process.stderr.write(`${outcome.notice}\n`);
  else if (debug)
    process.stderr.write(
      `jux: warm browser unavailable (${outcome.why.replace(/\s+/g, ' ')}); launching a private browser\n`,
    );
  return privateLaunch(opts);
}

/**
 * Start (or find) the daemon without a private fallback: `jux browser start`
 * must not launch and close a whole Chrome just to report that the daemon
 * could not start.
 */
export async function startDaemon(
  opts: WarmOptions,
): Promise<{ state: DaemonState } | { error: string }> {
  let outcome: Outcome;
  try {
    // A live daemon busy with another run gets the status budget to answer,
    // not the capture path's 500 ms: `start` has nothing else to do.
    outcome = await connectOrSpawn(
      { connectTimeoutMs: START_TIMEOUT_MS, ...opts },
      STATUS_PROBE_TIMEOUT_MS,
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!('browser' in outcome)) return { error: outcome.why };
  await outcome.browser.close();
  const s = await daemonStatus(opts);
  return s ? { state: s } : { error: 'the warm browser exited right after starting' };
}

/**
 * `s` if the daemon it describes is alive, else null (and a dead one's files
 * cleared). Alive means it answered a hello on our socket, not that its pid
 * is alive: after a reboot the pid can belong to anything, and `start` used
 * to report "already running" for a daemon that did not exist. A hello that
 * times out still counts when the pid is verifiably our supervisor-main for
 * this key: a busy daemon is running. With `refusedIsLive`, so does a daemon
 * that refuses our hello: one from a jux with another Chrome pin is still a
 * live process to list.
 */
async function liveState(
  paths: DaemonPaths,
  s: DaemonState,
  read: CommandReader | undefined,
  refusedIsLive = false,
): Promise<DaemonState | null> {
  if (!pidAlive(s.pid) || s.socket !== paths.socket) {
    await clearStaleState(paths, s);
    return null;
  }
  const p = await probe(paths, STATUS_PROBE_TIMEOUT_MS);
  if (p.kind === 'ok') {
    p.connection.close();
    return s;
  }
  // Nothing listens: the pid was reused. A timeout or refusal is a live
  // listener; its files are not ours to remove.
  if (p.kind === 'dead') {
    await clearStaleState(paths, s);
    return null;
  }
  if (p.kind === 'refused' && !refusedIsLive) return null;
  return (await ownership(s.pid, s.key, read)) === 'ours' ? s : null;
}

/** The running daemon for this fingerprint, or null. A dead daemon's files are cleared. */
export async function daemonStatus(given: StatusOptions): Promise<DaemonState | null> {
  const opts = absolute(given);
  const key = keyFor(opts);
  const paths = daemonPaths(opts.stateDir, key);
  const s = await readState(paths);
  if (!s || s.key !== key) {
    if (s && (!pidAlive(s.pid) || s.socket !== paths.socket))
      await clearStaleState(paths, s);
    return null;
  }
  return liveState(paths, s, opts.readCommand);
}

type ListOptions = Pick<WarmOptions, 'stateDir' | 'readCommand'>;

/**
 * Every state file under `<stateDir>/browser`, whatever key wrote it: the key
 * covers the jux build and the binary's size and mtime, so each upgrade,
 * rebuild or Chrome update leaves the previous daemon under a key the current
 * jux no longer computes (PR #102 re-review N3). A file whose content names
 * another key is skipped, never touched.
 */
async function stateFiles(
  stateDir: string,
): Promise<{ paths: DaemonPaths; state: DaemonState }[]> {
  const dir = path.join(path.resolve(stateDir), 'browser');
  const names = await readdir(dir).catch((): string[] => []);
  const out: { paths: DaemonPaths; state: DaemonState }[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const key = name.slice(0, -'.json'.length);
    let paths: DaemonPaths;
    try {
      paths = daemonPaths(path.resolve(stateDir), key);
    } catch {
      continue;
    }
    const state = await readState(paths).catch(() => null);
    if (state && state.key === key) out.push({ paths, state });
  }
  return out;
}

/** Every live daemon in `stateDir`, whichever key; dead ones' files are cleared on the way. */
export async function listDaemons(opts: ListOptions): Promise<DaemonState[]> {
  const found = await Promise.all(
    (await stateFiles(opts.stateDir)).map(({ paths, state }) =>
      liveState(paths, state, opts.readCommand, true),
    ),
  );
  return found.filter((s): s is DaemonState => s !== null);
}

/**
 * What stopping one daemon did: `none` (nothing running, or the state named a
 * pid that is not ours and nothing listened on its socket), `stopped` (its
 * pid is gone), `unverified` (a live pid we could not confirm as ours:
 * nothing is signalled or removed), or `running` (ours, signalled, and still
 * alive after 2 s).
 */
export type StopResult =
  | { outcome: 'none' | 'stopped' }
  | { outcome: 'unverified' | 'running'; pid: number; reason: string };

/** SIGTERM the supervisor `s` describes (it closes Chrome and clears its state). */
async function stopOne(
  paths: DaemonPaths,
  s: DaemonState,
  read: CommandReader | undefined,
): Promise<StopResult> {
  if (!pidAlive(s.pid)) {
    await clearStaleState(paths, s);
    return { outcome: 'none' };
  }
  // An in-process supervisor (tests) shares our pid: signalling it would kill us.
  if (s.pid === process.pid) return { outcome: 'none' };
  // A reused pid is somebody else's process: signal only our supervisor-main.
  const who = await ownership(s.pid, s.key, read);
  if (who === 'unknown')
    return {
      outcome: 'unverified',
      pid: s.pid,
      reason: 'no /proc or ps to read its command line',
    };
  if (who === 'foreign') {
    // A false "foreign" (a wrapper entry whose command line lacks
    // supervisor-main) must not delete a live daemon's files: it would keep
    // running, unreachable, with its Chrome. Only a socket nobody answers on
    // proves the pid was reused.
    const p: Probe =
      s.socket === paths.socket
        ? await probe(paths, STATUS_PROBE_TIMEOUT_MS)
        : { kind: 'dead' };
    if (p.kind === 'ok') p.connection.close();
    if (p.kind !== 'dead')
      return {
        outcome: 'unverified',
        pid: s.pid,
        reason: 'its command line is not the warm browser, yet its socket is live',
      };
    await clearStaleState(paths, s);
    return { outcome: 'none' };
  }
  try {
    process.kill(s.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  for (let i = 0; i < 40 && pidAlive(s.pid); i++) await sleep(50);
  // A stopped (SIGSTOP) supervisor keeps its SIGTERM pending and is still
  // there after the wait; reporting it stopped told scripts a lie.
  if (pidAlive(s.pid))
    return {
      outcome: 'running',
      pid: s.pid,
      reason: 'it was signalled but had not exited after 2 s',
    };
  // Gone: only its own files are removed, never a successor's.
  await clearStaleState(paths, s);
  return { outcome: 'stopped' };
}

/** Stop the daemon for this fingerprint only. */
export async function stopDaemon(given: StatusOptions): Promise<StopResult> {
  const opts = absolute(given);
  const paths = daemonPaths(opts.stateDir, keyFor(opts));
  const s = await readState(paths);
  if (!s) return { outcome: 'none' };
  return stopOne(paths, s, opts.readCommand);
}

/** One daemon `stopAllDaemons` found, and what stopping it did. */
export type DaemonStop = { key: string; pid: number } & StopResult;

/**
 * Stop every daemon in `stateDir`, whichever key it runs under, each through
 * the same verification as `stopDaemon`. Entries whose outcome is `none`
 * (stale files, reused pids) are cleared and left out.
 */
export async function stopAllDaemons(opts: ListOptions): Promise<DaemonStop[]> {
  const out: DaemonStop[] = [];
  for (const { paths, state } of await stateFiles(opts.stateDir)) {
    const r = await stopOne(paths, state, opts.readCommand);
    if (r.outcome !== 'none') out.push({ key: state.key, pid: state.pid, ...r });
  }
  return out;
}
