// `jux browser install|path|status` — the browser is a pinned download, not a
// side effect of some other package's postinstall.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  CHROME_PINS,
  CHROME_VERSION,
  chromePlatform,
  installChrome,
  juxCacheDir,
  noBrowserMessage,
  proxyReexecArgs,
  resolveChrome,
  stderrProgress,
  type ChromeSource,
  type InstallOptions,
  type InstallResult,
  type ResolvedChrome,
} from '@juxtapose/core';
import { EXIT } from '../exit-codes.js';
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
    !opts.force && resolveChrome({ env: { ...io.env, JUX_CHROME: '' } }) !== null;
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

function resolveOrExplain(
  flag: string | undefined,
  io: BrowserCommandIo,
): { chrome: ResolvedChrome | null } | { error: string } {
  try {
    return { chrome: resolveChrome({ flag, env: io.env }) };
  } catch (err) {
    // An explicit path that does not exist: say so, never fall back silently.
    return { error: errorMessage(err) };
  }
}

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
      const r = resolveOrExplain(flag, io);
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
    const r = resolveOrExplain(flag, io);
    if ('error' in r) {
      io.writeErr(`${r.error}\n`);
      return EXIT.failure;
    }
    if (json) io.write(JSON.stringify(report(r.chrome)) + '\n');
    if (!r.chrome) {
      if (!json) io.writeErr(`${noBrowserMessage()}\n`);
      return EXIT.failure;
    }
    if (!json)
      io.write(
        sub === 'path'
          ? `${r.chrome.path}\n`
          : `jux: ${r.chrome.path} (${r.chrome.source}, pinned ${CHROME_VERSION})\n`,
      );
    return EXIT.clean;
  }

  io.writeErr(`jux browser: unknown subcommand '${sub}'. Use install, path or status.\n`);
  return EXIT.usage;
}
