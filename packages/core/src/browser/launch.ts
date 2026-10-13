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
import { mkdtemp, rm } from 'node:fs/promises';
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
    rmSync(l.userDataDir, { recursive: true, force: true });
  }
  live.clear();
}

function installExitHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', terminateAll);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      terminateAll();
      // Re-raise so the exit status says "killed by signal", as it would have.
      process.kill(process.pid, sig);
    });
  }
}

export async function launchChrome(opts: {
  executablePath: string;
  args?: string[];
  headless?: boolean;
  spawn?: SpawnFn;
}): Promise<LaunchedChrome> {
  const spawn = opts.spawn ?? nodeSpawn;
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'jux-chrome-'));
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
    proc.once('error', (error) => resolve({ code: null, error }));
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

  // Race the handshake against an early exit (bad binary, missing .so).
  const outcome = await Promise.race([
    connection.send('Browser.getVersion').then(() => 'ready' as const),
    exited.then((e) => e),
  ]);
  if (outcome !== 'ready') {
    live.delete(entry);
    await rm(userDataDir, { recursive: true, force: true });
    const why = outcome.error
      ? describeSpawnError(outcome.error, opts.executablePath)
      : `the browser at ${opts.executablePath} exited with code ${outcome.code} before it was ready.${describeStderr(stderr)}`;
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
