// `jux browser install|path|status` — the browser is a pinned download, not a
// side effect of some other package's postinstall.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  CHROME_VERSION,
  installChrome,
  juxCacheDir,
  noBrowserMessage,
  proxyReexecArgs,
  resolveChrome,
  stderrProgress,
  type InstallOptions,
  type InstallResult,
  type ResolvedChrome,
} from '@juxtapose/core';
import { EXIT } from '../exit-codes.js';

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
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      force: { type: 'boolean', default: false },
      chrome: { type: 'string' },
    },
  });
  const sub = positionals[0] ?? 'status';
  const flag = typeof values.chrome === 'string' ? values.chrome : undefined;
  const force = values.force === true;

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
            ? JSON.stringify({
                installed: false,
                path: r.chrome.path,
                source: r.chrome.source,
                pinned: CHROME_VERSION,
              }) + '\n'
            : `jux: using ${r.chrome.path} (${r.chrome.source}); nothing to install. Pass --force to install the pinned ${CHROME_VERSION} anyway.\n`,
        );
        return EXIT.clean;
      }
    }

    const code = reexecForProxy(io);
    if (code !== null) return code;

    try {
      const r = await io.install({
        cacheDir: juxCacheDir({ env: io.env }),
        env: io.env,
        force,
        onProgress: json ? undefined : stderrProgress(),
      });
      io.write(
        json
          ? JSON.stringify({
              installed: !r.alreadyInstalled,
              path: r.path,
              version: r.version,
              source: r.source ?? 'jux-cache',
              pinned: CHROME_VERSION,
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
    if (!r.chrome) {
      if (json)
        io.write(JSON.stringify({ browser: null, pinned: CHROME_VERSION }) + '\n');
      else io.writeErr(`${noBrowserMessage()}\n`);
      return EXIT.failure;
    }
    if (sub === 'path') io.write(`${r.chrome.path}\n`);
    else
      io.write(
        json
          ? JSON.stringify({
              browser: r.chrome.path,
              source: r.chrome.source,
              pinned: CHROME_VERSION,
            }) + '\n'
          : `jux: ${r.chrome.path} (${r.chrome.source}, pinned ${CHROME_VERSION})\n`,
      );
    return EXIT.clean;
  }

  io.writeErr(`jux: unknown browser subcommand '${sub}'. Use install, path or status.\n`);
  return EXIT.usage;
}
