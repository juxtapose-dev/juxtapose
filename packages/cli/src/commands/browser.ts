// `jux browser install|path|status|start|stop` — the browser is a pinned
// download, not a side effect of some other package's postinstall, and the
// warm browser between runs is started, stopped and inspected here.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  CHROME_PINS,
  CHROME_VERSION,
  chromePlatform,
  daemonEnabled,
  daemonIdleMinutes,
  daemonKeyFor,
  daemonStatus,
  daemonSupported,
  installChrome,
  freezeImages,
  juxCacheDir,
  listDaemons,
  juxStateDir,
  noBrowserMessage,
  proxyReexecArgs,
  resolveChrome,
  resolveOrAdoptChrome,
  startDaemon,
  stderrProgress,
  stopAllDaemons,
  type CommandReader,
  type ChromeSource,
  type DaemonState,
  type InstallOptions,
  type InstallResult,
  type ResolvedChrome,
} from '@juxtapose/core';
import { imageAnimationArgs } from '@juxtapose/core/browser';
import { EXIT } from '../exit-codes.js';
import { loadConfig } from '../context.js';
import { BROWSER_HELP } from './browser-help.js';

export interface BrowserCommandIo {
  env: NodeJS.ProcessEnv;
  write: (s: string) => void;
  writeErr: (s: string) => void;
  /** Test seams. */
  install: (opts: InstallOptions) => Promise<InstallResult>;
  spawn: (
    cmd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => SpawnSyncReturns<Buffer>;
  /** The node flags this process accepts, and the argv to re-run (`process.argv.slice(1)`). */
  nodeFlags?: ReadonlySet<string>;
  argv: string[];
  /** Test seam: how a pid's command line is read when verifying the warm browser. */
  readCommand?: CommandReader;
}

const defaultIo = (): BrowserCommandIo => ({
  env: process.env,
  write: (s) => process.stdout.write(s),
  writeErr: (s) => process.stderr.write(s),
  install: installChrome,
  spawn: (cmd, args, env) => spawnSync(cmd, args, { stdio: 'inherit', env }),
  argv: process.argv.slice(1),
});

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** The one JSON shape for install, status and path. `path` is null on a miss. */
interface BrowserReport {
  path: string | null;
  source: ChromeSource | null;
  /** Known only for our own bytes; an explicit --chrome binary could be anything. */
  version: string | null;
  pinned: string;
}

/** The warm browser, as `status` and `start` print it. Null fields: not running. */
interface DaemonReport {
  running: boolean;
  /** False when JUX_NO_DAEMON, a CI variable or this platform turns the daemon off. */
  enabled: boolean;
  pid: number | null;
  key: string | null;
  socket: string | null;
  startedAt: string | null;
  idleMinutes: number | null;
}

const daemonReport = (d: DaemonState | null, enabled: boolean): DaemonReport => ({
  running: d !== null,
  enabled,
  pid: d?.pid ?? null,
  key: d?.key ?? null,
  socket: d?.socket ?? null,
  startedAt: d?.startedAt ?? null,
  idleMinutes: d?.idleMinutes ?? null,
});

const daemonLine = (d: DaemonReport): string =>
  d.running
    ? `warm browser: pid ${d.pid}, started ${d.startedAt}, idle exit after ${d.idleMinutes} min, socket ${d.socket}`
    : `warm browser: not running${d.enabled ? '' : ' (disabled here)'}`;

const report = (r: ResolvedChrome | null): BrowserReport => ({
  path: r?.path ?? null,
  source: r?.source ?? null,
  version: r && r.source !== 'flag' && r.source !== 'env' ? CHROME_VERSION : null,
  pinned: CHROME_VERSION,
});

/**
 * Node's fetch ignores proxy variables unless the process starts with
 * --use-env-proxy, so when one is set (and this Node has the flag) the
 * install runs in a child that has it. Returns the child's exit code, or null
 * to install in-process.
 */
export function reexecForProxy(
  io: Pick<BrowserCommandIo, 'env' | 'spawn' | 'nodeFlags' | 'argv'>,
): number | null {
  const extra = proxyReexecArgs(io.env, io.nodeFlags);
  if (!extra) return null;
  const r = io.spawn(process.execPath, [...extra, ...io.argv], {
    ...io.env,
    NODE_USE_ENV_PROXY: '1',
  });
  return r.status ?? EXIT.failure;
}

/**
 * The one install path for `jux browser install` and `jux init`: re-exec for a
 * proxy, otherwise say what is about to be downloaded (always, even with
 * --json or in CI: a ~100 MB fetch is never silent) and install in-process.
 * `{ code }` means a child did the work (or it failed to); `{ result }` is
 * the in-process outcome. Throws on an install failure.
 */
export async function installWithProxy(
  io: Pick<
    BrowserCommandIo,
    'env' | 'spawn' | 'nodeFlags' | 'argv' | 'install' | 'writeErr'
  >,
  opts: { force: boolean; json: boolean },
): Promise<{ code: number } | { result: InstallResult }> {
  const code = reexecForProxy(io);
  if (code !== null) return { code };

  const cacheDir = juxCacheDir({ env: io.env });
  // JUX_CHROME is not "installed" (installChrome ignores it too).
  const present =
    !opts.force &&
    (await resolveOrAdoptChrome({ env: { ...io.env, JUX_CHROME: '' } })) !== null;
  if (!present) {
    const mb = Math.round(CHROME_PINS[chromePlatform()].bytes / 1048576);
    io.writeErr(
      `jux: downloading Chrome for Testing ${CHROME_VERSION} (~${mb} MB) to ${cacheDir}…\n`,
    );
  }
  const result = await io.install({
    cacheDir,
    env: io.env,
    force: opts.force,
    onProgress: opts.json ? undefined : stderrProgress(),
  });
  return { result };
}

/** `adopt` also copies a matching Playwright build into jux's cache (commands that run the browser); reporting commands only look. */
async function resolveOrExplain(
  flag: string | undefined,
  io: BrowserCommandIo,
  adopt = false,
): Promise<{ chrome: ResolvedChrome | null } | { error: string }> {
  try {
    const opts = { flag, env: io.env };
    return { chrome: adopt ? await resolveOrAdoptChrome(opts) : resolveChrome(opts) };
  } catch (err) {
    // An explicit path that does not exist: say so, never fall back silently.
    return { error: errorMessage(err) };
  }
}

async function warmOptions(chrome: ResolvedChrome, io: BrowserCommandIo) {
  const config = await loadConfig(process.cwd());
  return {
    args: freezeImages(config) ? imageAnimationArgs() : [],
    executablePath: chrome.path,
    stateDir: juxStateDir({ env: io.env }),
    env: io.env,
    idleMinutes: daemonIdleMinutes(io.env),
    readCommand: io.readCommand,
  };
}

const daemonAllowed = (io: BrowserCommandIo): boolean =>
  daemonSupported() && daemonEnabled(io.env);

/** One live daemon in `status`'s list; `current` is the one this jux, browser and env would use. */
type ListedDaemon = DaemonReport & { current: boolean };

/**
 * What `status` reports: the warm browser this jux would use, and every live
 * one in the state dir. A daemon from an older jux build, another binary or
 * other flags runs under another key and idles out on its own; listing it
 * says why a `stop` found more than one. Never throws (a bad state dir is
 * "not running").
 */
async function daemonsReport(
  chrome: ResolvedChrome | null,
  io: BrowserCommandIo,
): Promise<{ daemon: DaemonReport; daemons: ListedDaemon[] }> {
  const enabled = daemonAllowed(io);
  if (!daemonSupported()) return { daemon: daemonReport(null, enabled), daemons: [] };
  let current: string | null = null;
  let live: DaemonState[] = [];
  try {
    if (chrome) current = daemonKeyFor(await warmOptions(chrome, io));
    live = await listDaemons({
      stateDir: juxStateDir({ env: io.env }),
      readCommand: io.readCommand,
    });
  } catch {
    // An unusable state dir: nothing is running that jux could reach.
  }
  const daemons = live.map((s) => ({
    ...daemonReport(s, enabled),
    current: s.key === current,
  }));
  const mine = live.find((s) => s.key === current) ?? null;
  return { daemon: daemonReport(mine, enabled), daemons };
}

const otherLine = (d: DaemonReport): string =>
  `other warm browser (another jux build, browser binary, flags or env): pid ${d.pid}, started ${d.startedAt}, socket ${d.socket}`;

export async function browserCommand(
  argv: string[],
  json: boolean,
  partialIo: Partial<BrowserCommandIo> = {},
): Promise<number> {
  const io = { ...defaultIo(), ...partialIo };
  let values: { force?: boolean; chrome?: string; help?: boolean; json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        force: { type: 'boolean' },
        chrome: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    const flag = /'(-[^']*)'|(--?[\w-]+)/.exec(errorMessage(err));
    io.writeErr(
      `jux browser: ${flag ? `unknown or invalid option ${flag[1] ?? flag[2]}` : errorMessage(err)}. Try \`jux browser --help\`.\n`,
    );
    return EXIT.usage;
  }
  if (values.help) {
    io.write(BROWSER_HELP);
    return EXIT.clean;
  }
  const sub = positionals[0] ?? 'status';
  if (positionals.length > 1) {
    io.writeErr(`jux browser: unexpected argument '${positionals[1]}'.\n`);
    return EXIT.usage;
  }
  const flag = values.chrome;
  const force = values.force === true;
  json = json || values.json === true;

  if (sub === 'install') {
    // An explicit browser (--chrome / JUX_CHROME) is what jux will use, so
    // there is nothing to download unless --force asks for the pinned one.
    if (!force && (flag || io.env.JUX_CHROME)) {
      const r = await resolveOrExplain(flag, io);
      if ('error' in r) {
        io.writeErr(`${r.error}\n`);
        return EXIT.failure;
      }
      if (r.chrome) {
        io.write(
          json
            ? JSON.stringify({ installed: false, ...report(r.chrome) }) + '\n'
            : `jux: using ${r.chrome.path} (${r.chrome.source}); nothing to install. Pass --force to install the pinned ${CHROME_VERSION} anyway.\n`,
        );
        return EXIT.clean;
      }
    }

    try {
      const out = await installWithProxy(io, { force, json });
      if ('code' in out) return out.code;
      const r = out.result;
      io.write(
        json
          ? JSON.stringify({
              installed: !r.alreadyInstalled,
              ...report({ path: r.path, source: r.source ?? 'jux-cache' }),
            }) + '\n'
          : r.alreadyInstalled
            ? `jux: browser already installed at ${r.path} (${r.source}); nothing to do. Pass --force to reinstall.\n`
            : `jux: installed chrome-headless-shell ${r.version} at ${r.path}\n`,
      );
      return EXIT.clean;
    } catch (err) {
      io.writeErr(`${errorMessage(err)}\n`);
      return EXIT.failure;
    }
  }

  if (sub === 'path' || sub === 'status') {
    const r = await resolveOrExplain(flag, io);
    if ('error' in r) {
      // Under --json, stdout is one object even here: `JSON.parse` of the
      // output never meets an empty string.
      if (json)
        io.write(
          JSON.stringify({
            ok: false,
            ...report(null),
            error: r.error.replace(/^jux: /, ''),
          }) + '\n',
        );
      else io.writeErr(`${r.error}\n`);
      return EXIT.failure;
    }
    // Status also says whether the warm browser is up; path stays one line.
    const status = sub === 'status' ? await daemonsReport(r.chrome, io) : null;
    if (json)
      io.write(
        JSON.stringify(
          status
            ? { ok: r.chrome !== null, ...report(r.chrome), ...status }
            : report(r.chrome),
        ) + '\n',
      );
    if (!r.chrome) {
      if (!json) io.writeErr(`${noBrowserMessage({ env: io.env })}\n`);
      return EXIT.failure;
    }
    if (!json) {
      if (!status) io.write(`${r.chrome.path}\n`);
      else
        io.write(
          [
            `jux: ${r.chrome.path} (${r.chrome.source}, pinned ${CHROME_VERSION})`,
            `  ${daemonLine(status.daemon)}`,
            ...status.daemons.filter((d) => !d.current).map((d) => `  ${otherLine(d)}`),
          ].join('\n') + '\n',
        );
    }
    return EXIT.clean;
  }

  if (sub === 'start' || sub === 'stop') {
    try {
      return await daemonCommand(sub, flag, json, io);
    } catch (err) {
      // e.g. a state dir whose socket path is too long: say what to set.
      return daemonFailure(sub, json, io, errorMessage(err));
    }
  }

  io.writeErr(
    `jux browser: unknown subcommand '${sub}'. Use install, path, status, start or stop.\n`,
  );
  return EXIT.usage;
}

/**
 * A failed start or stop: the message on stderr, or under --json one object on
 * stdout, so `JSON.parse` of the output never meets an empty string.
 */
function daemonFailure(
  sub: 'start' | 'stop',
  json: boolean,
  io: BrowserCommandIo,
  error: string,
  extra: Record<string, unknown> = {},
): number {
  if (json)
    io.write(
      JSON.stringify({
        ok: false,
        [sub === 'start' ? 'started' : 'stopped']: false,
        error: error.replace(/^jux: /, ''),
        ...extra,
      }) + '\n',
    );
  else io.writeErr(`${error}\n`);
  return EXIT.failure;
}

async function daemonCommand(
  sub: 'start' | 'stop',
  flag: string | undefined,
  json: boolean,
  io: BrowserCommandIo,
): Promise<number> {
  const r = await resolveOrExplain(flag, io, sub === 'start');
  if ('error' in r) return daemonFailure(sub, json, io, r.error);
  if (sub === 'stop') {
    // Every daemon in the state dir, not only this build's key: the key
    // changes with each jux upgrade, rebuild or Chrome update, and the old
    // daemon would otherwise run until it idled out (up to 35000 minutes).
    // Each pid is still verified as our supervisor-main before it is signalled.
    const results = daemonSupported()
      ? await stopAllDaemons({
          stateDir: juxStateDir({ env: io.env }),
          readCommand: io.readCommand,
        })
      : [];
    const stoppedPids = results.filter((x) => x.outcome === 'stopped').map((x) => x.pid);
    const left = results.flatMap((x) =>
      x.outcome === 'unverified' || x.outcome === 'running'
        ? [{ pid: x.pid, key: x.key, outcome: x.outcome, reason: x.reason }]
        : [],
    );
    const d = daemonReport(null, daemonAllowed(io));
    const stoppedText =
      stoppedPids.length === 1
        ? `stopped the warm browser (pid ${stoppedPids[0]})`
        : `stopped ${stoppedPids.length} warm browsers (pids ${stoppedPids.join(', ')})`;
    const firstLeft = left[0];
    if (firstLeft) {
      if (!json && stoppedPids.length > 0) io.write(`jux: ${stoppedText}\n`);
      const why = left.map((x) =>
        x.outcome === 'unverified'
          ? `pid ${x.pid} is running but could not be verified as the warm browser (${x.reason}); not stopping it`
          : `pid ${x.pid} is still running (${x.reason})`,
      );
      return daemonFailure(sub, json, io, `jux: ${why.join('; ')}`, {
        stopped: stoppedPids.length > 0,
        stoppedPids,
        pid: firstLeft.pid,
        notStopped: left,
      });
    }
    io.write(
      json
        ? JSON.stringify({
            ok: true,
            stopped: stoppedPids.length > 0,
            stoppedPids,
            daemon: d,
          }) + '\n'
        : `jux: ${stoppedPids.length > 0 ? stoppedText : 'no warm browser running'}\n`,
    );
    return EXIT.clean;
  }
  if (!r.chrome) return daemonFailure(sub, json, io, noBrowserMessage({ env: io.env }));
  // Running means it answered a hello, not that its pid is alive (a reused
  // pid after a reboot is not a warm browser).
  const before = await daemonStatus(await warmOptions(r.chrome, io));
  if (before) {
    const d = daemonReport(before, true);
    io.write(
      json
        ? JSON.stringify({ ok: true, started: false, daemon: d }) + '\n'
        : `jux: ${daemonLine(d)} (already running)\n`,
    );
    return EXIT.clean;
  }
  if (!daemonAllowed(io))
    return daemonFailure(
      sub,
      json,
      io,
      'jux: the warm browser is off here (JUX_NO_DAEMON, a CI variable, or an unsupported platform).',
    );
  // The capture path's connect-or-spawn, minus its private-launch fallback:
  // a failed start reports why instead of launching a Chrome to close it.
  const result = await startDaemon(await warmOptions(r.chrome, io));
  if ('error' in result)
    return daemonFailure(
      sub,
      json,
      io,
      `jux: the warm browser could not start (${result.error}); captures will launch a private browser.`,
    );
  const d = daemonReport(result.state, true);
  io.write(
    json
      ? JSON.stringify({ ok: true, started: true, daemon: d }) + '\n'
      : `jux: started the ${daemonLine(d)}\n`,
  );
  return EXIT.clean;
}
