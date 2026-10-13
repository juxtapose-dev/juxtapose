// packages/core/src/browser/daemon/client.ts
//
// Try the warm browser; never let it cost correctness or a hang. Every
// failure here (no daemon, stale file, refused hello, a spawn that dies, the
// race lost and the winner slow) ends in the same private launch PR 1 ships,
// with one JUX_DEBUG line saying why. The budget is 2 s to reach a daemon
// this call spawned or found; a client that finds another launch in progress
// (a live lock holder) waits for it up to the lock's 30 s stale window rather
// than starting a second Chrome.
//
// Once connected, the Browser is the daemon's: if the daemon dies mid-run,
// the connection closes, isConnected() goes false and the pool reports
// BrowserDiedError exactly as for a private Chrome that died (PR 1).

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '../browser.js';
import { CdpConnection } from '../cdp.js';
import { CHROME_VERSION } from '../pins.js';
import { SocketTransport } from '../transport.js';
import {
  LOCK_STALE_MS,
  acquireLock,
  clearState,
  daemonKey,
  daemonPaths,
  lockHeld,
  pidAlive,
  readState,
  type DaemonPaths,
  type DaemonState,
} from './state.js';

export interface SpawnArgs {
  executablePath: string;
  args: string[];
  cacheDir: string;
  key: string;
  idleMinutes: number;
}

export interface WarmOptions {
  executablePath: string;
  args?: string[];
  cacheDir: string;
  env?: NodeJS.ProcessEnv;
  idleMinutes?: number;
  /** Test seam: start a daemon for these args. Default: a detached supervisor-main. */
  spawnDaemon?: (args: SpawnArgs) => void;
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
const POLL_MS = 50;

/** `CI` is the convention; these are the systems that do not set it. */
export const CI_ENV_VARS = [
  'CI',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'BUILDKITE',
  'GITLAB_CI',
  'TF_BUILD',
  'CODEBUILD_BUILD_ID',
] as const;

/**
 * Off with `--no-daemon`, JUX_NO_DAEMON=1, or any CI marker. An empty marker
 * is unset (shells export `CI=` when clearing it), and `CI=false`/`CI=0` are
 * how people say "not CI" explicitly.
 */
export function daemonEnabled(env: NodeJS.ProcessEnv, flagNoDaemon = false): boolean {
  if (flagNoDaemon) return false;
  if (env.JUX_NO_DAEMON === '1') return false;
  for (const v of CI_ENV_VARS) {
    const value = env[v];
    if (value && value !== 'false' && value !== '0') return false;
  }
  return true;
}

type StatusOptions = Pick<WarmOptions, 'executablePath' | 'cacheDir' | 'args' | 'env'>;

function keyFor(opts: StatusOptions): string {
  return daemonKey({
    binary: opts.executablePath,
    version: CHROME_VERSION,
    args: opts.args ?? [],
    env: opts.env ?? process.env,
  });
}

function pathsFor(opts: StatusOptions): DaemonPaths {
  return daemonPaths(opts.cacheDir, keyFor(opts));
}

type Probe =
  | { kind: 'ok'; connection: CdpConnection; product: string }
  /** Nothing listens (ENOENT, ECONNREFUSED): the daemon is gone. */
  | { kind: 'dead' }
  | { kind: 'timeout' }
  /** Something listens but would not finish the hello. */
  | { kind: 'refused'; reason: string };

/** One connect + hello within `timeoutMs`. */
function tryConnect(socketPath: string, timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    let settled = false;
    let conn: CdpConnection | null = null;
    const sock = net.connect(socketPath);
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

/** What became of a daemon this client spawned; `failed` set when it cannot come up. */
interface SpawnWatch {
  failed: string | null;
}

function defaultSpawn(args: SpawnArgs, watch: SpawnWatch): void {
  const entry = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'supervisor-main.js',
  );
  // Detached in its own process group with stdio ignored: the daemon must
  // outlive this jux, and a Ctrl-C to this terminal must not reach it.
  const child = spawn(process.execPath, [entry, JSON.stringify(args)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // An async spawn failure is an 'error' event; unhandled, it would crash jux.
  child.on('error', (e) => (watch.failed ??= `spawn failed: ${e.message}`));
  // Exit 0 is a lost start race (Ruling 21): the winner is coming, keep polling.
  child.on('exit', (code, signal) => {
    if (code !== 0) watch.failed ??= `daemon exited (${signal ?? `code ${code}`})`;
  });
  child.unref();
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

async function connectOrSpawn(opts: WarmOptions): Promise<Outcome> {
  const key = keyFor(opts);
  const paths = daemonPaths(opts.cacheDir, key);
  const start = Date.now();
  const budget = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const existing = await readState(paths);
  if (existing) {
    if (!pidAlive(existing.pid)) {
      await clearState(paths); // SIGKILLed daemon or a reboot: nothing to reuse
    } else if (!usable(existing, key, opts)) {
      // Never reuse a daemon with another fingerprint (Ruling 7), and never
      // remove a live process's files.
      return { why: `state file names another daemon (pid ${existing.pid})` };
    } else {
      const p = await tryConnect(existing.socket, PROBE_TIMEOUT_MS);
      if (p.kind === 'ok') return wrap(p);
      if (p.kind === 'timeout')
        return {
          why: `daemon pid ${existing.pid} did not answer in ${PROBE_TIMEOUT_MS} ms`,
        };
      if (p.kind === 'refused') return { why: `daemon refused: ${p.reason}` };
      // Nobody listens: the pid was reused by an unrelated process.
      await clearState(paths);
    }
  }

  let watch: SpawnWatch | null = null;
  let release: (() => Promise<void>) | null = null;
  try {
    for (;;) {
      const s = await readState(paths);
      if (s && usable(s, key, opts) && pidAlive(s.pid)) {
        const remaining = start + budget - Date.now();
        const p = await tryConnect(
          s.socket,
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
            cacheDir: opts.cacheDir,
            key,
            idleMinutes: opts.idleMinutes ?? DEFAULT_IDLE_MINUTES,
          };
          try {
            if (opts.spawnDaemon) opts.spawnDaemon(args);
            else defaultSpawn(args, watch);
          } catch (e) {
            return { why: `spawn failed: ${e instanceof Error ? e.message : String(e)}` };
          }
        }
      }
      if (watch?.failed) return { why: watch.failed };
      const elapsed = Date.now() - start;
      if (elapsed >= budget) {
        // Past the budget, only another client's launch in progress is worth
        // waiting for; our own spawn had its 2 s.
        if (watch || elapsed >= LOCK_STALE_MS || !(await lockHeld(paths)))
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
  try {
    process.kill(s.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  for (let i = 0; i < 40 && pidAlive(s.pid); i++) await sleep(50);
  await clearState(pathsFor(opts));
  return true;
}
