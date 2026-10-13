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
import { lstat, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '../browser.js';
import { CdpConnection } from '../cdp.js';
import { CHROME_VERSION } from '../pins.js';
import { SocketTransport } from '../transport.js';
import {
  acquireLock,
  clearState,
  daemonKey,
  daemonPaths,
  ensureDaemonDirs,
  lockHeld,
  pidAlive,
  readState,
  recheckDaemonDirs,
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
  spawnDaemon?: (args: SpawnArgs, env: NodeJS.ProcessEnv) => void;
  connectTimeoutMs?: number;
}

const DEFAULT_IDLE_MINUTES = 10;
const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
/**
 * A live daemon answers hello in milliseconds; a state file whose pid was
 * reused by an unrelated process must not eat the launch budget (preflight
 * defect 13), so the first probe gets 500 ms, not the whole 2 s.
 */
const PROBE_TIMEOUT_MS = 500;
/** How much longer than the budget a live lock holder is waited on. */
const HOLDER_GRACE_MS = 3000;
/**
 * The supervisor touches its state file every second. Ten silent seconds
 * means stopped or wedged, not busy: a daemon serving a 700-story run still
 * runs its timers.
 */
const HEARTBEAT_STALE_MS = 10_000;
const POLL_MS = 50;

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

/** JUX_BROWSER_IDLE_MINUTES when it is a positive number, else the default (undefined). */
export function daemonIdleMinutes(env: NodeJS.ProcessEnv): number | undefined {
  const n = Number(env.JUX_BROWSER_IDLE_MINUTES);
  return n > 0 ? n : undefined;
}

type StatusOptions = Pick<WarmOptions, 'executablePath' | 'stateDir' | 'args' | 'env'>;

function keyFor(opts: StatusOptions): string {
  return daemonKey({
    binary: opts.executablePath,
    version: CHROME_VERSION,
    args: opts.args ?? [],
    env: opts.env ?? process.env,
  });
}

function pathsFor(opts: StatusOptions): DaemonPaths {
  return daemonPaths(opts.stateDir, keyFor(opts));
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
      c.once<{ product: string }>('jux.ready').then(
        (p) => finish({ kind: 'ok', connection: c, product: p.product }),
        () => finish({ kind: 'refused', reason: 'socket closed during hello' }),
      );
      c.once<{ reason?: string }>('jux.refused').then(
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
 */
export function spawnSupervisor(
  args: SpawnArgs,
  env: NodeJS.ProcessEnv,
  entry = DEFAULT_ENTRY,
): ChildProcess {
  const child = spawn(process.execPath, [entry, JSON.stringify(args)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  return child;
}

/** What became of a daemon this client spawned; `failed` set when it cannot come up. */
interface SpawnWatch {
  failed: string | null;
}

function defaultSpawn(args: SpawnArgs, env: NodeJS.ProcessEnv, watch: SpawnWatch): void {
  const child = spawnSupervisor(args, env);
  // An async spawn failure is an 'error' event; unhandled, it would crash jux.
  child.on('error', (e) => (watch.failed ??= `spawn failed: ${e.message}`));
  // Exit 0 is a lost start race (Ruling 21): the winner is coming, keep polling.
  child.on('exit', (code, signal) => {
    if (code !== 0) watch.failed ??= `daemon exited (${signal ?? `code ${code}`})`;
  });
}

type Outcome = { browser: Browser; warm: true } | { why: string };

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

function commandLine(pid: number): Promise<string> {
  return new Promise((resolve) =>
    execFile('ps', ['-o', 'command=', '-p', String(pid)], (err, out) =>
      resolve(err ? '' : out),
    ),
  );
}

/**
 * True when the daemon behind a timed-out probe is wedged, not busy: its
 * heartbeat is over 10 s old and the pid really is our supervisor-main for
 * this key (not a reused pid, which we must never signal).
 */
async function wedged(s: DaemonState, paths: DaemonPaths, key: string): Promise<boolean> {
  const st = await stat(paths.state).catch(() => null);
  if (!st || Date.now() - st.mtimeMs <= HEARTBEAT_STALE_MS) return false;
  const cmd = await commandLine(s.pid);
  return cmd.includes('supervisor-main') && cmd.includes(key);
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

async function connectOrSpawn(opts: WarmOptions): Promise<Outcome> {
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
      await clearState(paths);
    } else if (!usable(existing, key, opts)) {
      // Never reuse a daemon with another fingerprint (Ruling 7), and never
      // remove a live process's files.
      return { why: `state file names another daemon (pid ${existing.pid})` };
    } else {
      const p = await probe(paths, PROBE_TIMEOUT_MS);
      if (p.kind === 'ok') return wrap(p);
      if (p.kind === 'refused') return { why: `daemon refused: ${p.reason}` };
      if (p.kind === 'timeout') {
        if (!(await wedged(existing, paths, key)))
          return {
            why: `daemon pid ${existing.pid} did not answer in ${PROBE_TIMEOUT_MS} ms`,
          };
        await killWedged(existing.pid);
      }
      // Dead (the pid was reused by an unrelated process) or killed as wedged.
      await clearState(paths);
    }
  }

  let watch: SpawnWatch | null = null;
  let release: (() => Promise<void>) | null = null;
  try {
    for (;;) {
      const s = await readState(paths);
      if (s && s.socket === paths.socket && usable(s, key, opts) && pidAlive(s.pid)) {
        const remaining = start + budget - Date.now();
        const p = await probe(
          paths,
          Math.min(PROBE_TIMEOUT_MS, Math.max(100, remaining)),
        );
        if (p.kind === 'ok') return wrap(p);
        if (p.kind === 'refused') return { why: `daemon refused: ${p.reason}` };
      }
      if (!watch) {
        release = await acquireLock(paths);
        if (release) {
          watch = { failed: null };
          const args: SpawnArgs = {
            executablePath: opts.executablePath,
            args: opts.args ?? [],
            stateDir: opts.stateDir,
            key,
            idleMinutes: opts.idleMinutes ?? DEFAULT_IDLE_MINUTES,
          };
          try {
            if (opts.spawnDaemon) opts.spawnDaemon(args, env);
            else defaultSpawn(args, env, watch);
          } catch (e) {
            return { why: `spawn failed: ${e instanceof Error ? e.message : String(e)}` };
          }
        }
      }
      if (watch?.failed) return { why: watch.failed };
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
  }
}

async function privateLaunch(
  opts: WarmOptions,
): Promise<{ browser: Browser; warm: false }> {
  return {
    browser: await Browser.launch({
      executablePath: opts.executablePath,
      args: opts.args,
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
  if ('browser' in outcome) return outcome;
  if ((opts.env ?? process.env).JUX_DEBUG)
    process.stderr.write(
      `jux: warm browser unavailable (${outcome.why.replace(/\s+/g, ' ')}); launching a private browser\n`,
    );
  return privateLaunch(opts);
}

/** The running daemon for this fingerprint, or null (a dead one's files are cleared). */
export async function daemonStatus(opts: StatusOptions): Promise<DaemonState | null> {
  const paths = pathsFor(opts);
  const s = await readState(paths);
  if (!s) return null;
  if (!pidAlive(s.pid)) {
    await clearState(paths);
    return null;
  }
  return s;
}

/** SIGTERM the supervisor (it closes Chrome and clears its state); true if one was running. */
export async function stopDaemon(opts: StatusOptions): Promise<boolean> {
  const s = await daemonStatus(opts);
  // An in-process supervisor (tests) shares our pid: signalling it would kill us.
  if (!s || s.pid === process.pid) return false;
  // A reused pid is somebody else's process: signal only our supervisor-main.
  const cmd = await commandLine(s.pid);
  if (!cmd.includes('supervisor-main') || !cmd.includes(s.key)) {
    await clearState(pathsFor(opts));
    return false;
  }
  try {
    process.kill(s.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  for (let i = 0; i < 40 && pidAlive(s.pid); i++) await sleep(50);
  await clearState(pathsFor(opts));
  return true;
}
