// packages/core/src/browser/launch.ts
//
// Spawn Chrome with the pipe on fds 3/4, as Playwright does (coreBundle.js
// L39607). Measured 74–91 ms to Browser.getVersion on an M-series Mac, the
// same as Playwright's launch: the cost is Chrome's, not the driver's.
//
// `spawn` is injectable so the no-browser probe (scripts/check-diff.mjs) and
// tests can assert nothing is launched without patching node:child_process.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromeArgs } from '../capture/launch.js';
import { CdpConnection } from './cdp.js';
import { PipeTransport } from './transport.js';

export type SpawnFn = typeof nodeSpawn;

export interface LaunchedChrome {
  connection: CdpConnection;
  pid: number;
  userDataDir: string;
  close(): Promise<void>;
}

/** How long Browser.close gets, then how long SIGTERM gets, before SIGKILL. */
const GRACEFUL_CLOSE_MS = 2000;
const TERM_GRACE_MS = 1000;
/** After SIGKILL the exit event is imminent; bound the wait so close() cannot hang. */
const KILL_WAIT_MS = 2000;
/** Chrome answers Browser.getVersion in ~80 ms; this only bounds a wedged binary. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** How long a failed launch waits for the exit event and the last of stderr. */
const FAILURE_WAIT_MS = 2000;
const STDERR_DRAIN_MS = 300;
/** A profile of a dead owner is only swept once it is this old. */
const STALE_PROFILE_MS = 10 * 60_000;

interface Live {
  proc: ChildProcess;
  userDataDir: string;
  /** Set by the exit/error event; `exitCode` is null after a signal death, so it cannot serve. */
  gone: boolean;
}

/** Live launches, so a signal or exit can take every Chrome and profile with it. */
const live = new Set<Live>();
let handlersInstalled = false;

/** Kill every live Chrome and remove its profile, synchronously. Exported for tests. */
export function terminateAll(): void {
  for (const l of live) {
    if (!l.gone) {
      try {
        l.proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    try {
      rmSync(l.userDataDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // best effort: the stale-profile sweep gets it on a later launch
    }
  }
  live.clear();
}

const signalHandlers = new Map<'SIGINT' | 'SIGTERM', () => void>();

function installExitHandlers(): void {
  if (!handlersInstalled) {
    handlersInstalled = true;
    process.on('exit', terminateAll);
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    if (signalHandlers.has(sig)) continue;
    const handler = () => {
      // Detach first: re-raising with our listener attached would loop forever.
      process.removeListener(sig, handler);
      signalHandlers.delete(sig);
      terminateAll();
      // Only when nobody else listens is dying the right response; a host with
      // its own handler (a CLI that prints "interrupted") decides for itself.
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    signalHandlers.set(sig, handler);
    process.on(sig, handler);
  }
}

const PROFILE_PREFIX = 'jux-chrome-';

/**
 * Remove profiles left by a jux that was SIGKILLed or lost power: named
 * `jux-chrome-<pid>-…`, owner pid dead, untouched for 10 minutes. Anything
 * else in the directory is not ours to touch.
 */
export async function sweepStaleProfiles(dir: string = tmpdir()): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      const m = /^jux-chrome-(\d+)-/.exec(name);
      if (!m) continue;
      try {
        process.kill(Number(m[1]), 0);
        continue; // owner alive (EPERM also lands here via the throw below)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      }
      const full = path.join(dir, name);
      try {
        if (Date.now() - (await stat(full)).mtimeMs < STALE_PROFILE_MS) continue;
        await rm(full, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // raced with another sweeper, or unreadable: leave it
      }
    }
  } catch {
    // no readable tmpdir: nothing to sweep
  }
}

async function sweepThenMkdtemp(): Promise<string> {
  await sweepStaleProfiles();
  return mkdtemp(path.join(tmpdir(), `${PROFILE_PREFIX}${process.pid}-`));
}

export async function launchChrome(opts: {
  executablePath: string;
  args?: string[];
  headless?: boolean;
  spawn?: SpawnFn;
  /** Test seam: how long to wait for Browser.getVersion before giving up. */
  handshakeTimeoutMs?: number;
}): Promise<LaunchedChrome> {
  const spawn = opts.spawn ?? nodeSpawn;
  const userDataDir = await sweepThenMkdtemp();
  const args = chromeArgs({ userDataDir, args: opts.args, headless: opts.headless });
  let proc: ChildProcess;
  try {
    proc = spawn(opts.executablePath, args, {
      // stdin/stdout ignored, stderr kept for the "missing shared library"
      // message on Linux, 3 = Chrome reads, 4 = Chrome writes.
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true });
    throw new Error(
      `jux: could not launch the browser: ${describeSpawnError(error as Error, opts.executablePath)}`,
      { cause: error },
    );
  }
  const entry: Live = { proc, userDataDir, gone: false };
  live.add(entry);
  installExitHandlers();

  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    if (stderr.length < 8192) stderr += d.toString();
  });

  // One promise for "the process is gone", resolved never rejected, so an
  // exit after a successful launch is not an unhandled rejection.
  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    proc.on('error', (error) => resolve({ code: null, error }));
    proc.once('exit', (code) => resolve({ code }));
  });
  void exited.then(() => {
    entry.gone = true;
    live.delete(entry);
  });

  const transport = new PipeTransport(
    proc.stdio[3] as NodeJS.WritableStream,
    proc.stdio[4] as NodeJS.ReadableStream,
  );
  const connection = new CdpConnection(transport);
  void exited.then(() => transport.close());

  let stderrClosed = !proc.stderr;
  proc.stderr?.once('close', () => (stderrClosed = true));

  // Race the handshake against an early exit (bad binary, missing .so) and a
  // wedged binary. Any failure ends in one place that kills, waits, cleans up
  // and explains.
  const timeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    connection.send('Browser.getVersion').then(
      () => 'ready' as const,
      () => 'closed' as const,
    ),
    exited.then(() => 'closed' as const),
    new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), timeoutMs))),
  ]);
  clearTimeout(timer);
  if (outcome !== 'ready') {
    if (outcome === 'timeout' && !entry.gone) proc.kill('SIGKILL');
    const result = await Promise.race([exited, sleep(FAILURE_WAIT_MS)]);
    if (!entry.gone) proc.kill('SIGKILL');
    if (!stderrClosed) await sleep(STDERR_DRAIN_MS);
    connection.close();
    live.delete(entry);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    const exe = opts.executablePath;
    const why =
      outcome === 'timeout'
        ? `the browser at ${exe} did not answer within ${timeoutMs} ms and was killed. Reinstall it with \`npx -p @juxtapose/cli jux browser install\`, or point JUX_CHROME at a working Chrome.`
        : result?.error
          ? describeSpawnError(result.error, exe)
          : `the browser at ${exe} exited with code ${result?.code ?? 'unknown'} before it was ready.${describeStderr(stderr)}`;
    throw new Error(`jux: could not launch the browser: ${why}`);
  }

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      if (!connection.closed) {
        connection.send('Browser.close').catch(() => {});
        await Promise.race([exited, sleep(GRACEFUL_CLOSE_MS)]);
      }
      // Escalate, then wait for the exit so no zombie outlives close().
      if (!entry.gone) {
        proc.kill('SIGTERM');
        await Promise.race([exited, sleep(TERM_GRACE_MS)]);
      }
      if (!entry.gone) {
        proc.kill('SIGKILL');
        await Promise.race([exited, sleep(KILL_WAIT_MS)]);
      }
      connection.close();
      live.delete(entry);
      await rm(userDataDir, { recursive: true, force: true });
    })());

  return { connection, pid: proc.pid!, userDataDir, close };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** ENOENT / EACCES on spawn: say what to do, not just what the kernel said. */
function describeSpawnError(error: Error, executablePath: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'EACCES') {
    const what = code === 'ENOENT' ? 'does not exist' : 'is not executable';
    return `${executablePath} ${what}. Install the pinned browser with \`npx -p @juxtapose/cli jux browser install\`, or point JUX_CHROME at a Chrome you already have.`;
  }
  return `${error.message} (${executablePath})`;
}

/** Linux: `error while loading shared libraries: libnss3.so` → name the apt line. */
function describeStderr(stderr: string): string {
  const m = /error while loading shared libraries: ([^:]+):/.exec(stderr);
  if (m) {
    return ` Missing system library ${m[1]}. On Ubuntu 24.04: sudo apt-get install libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2`;
  }
  return stderr.trim() ? `\n${stderr.trim().split('\n').slice(-3).join('\n')}` : '';
}
