// packages/core/src/browser/install.ts
//
// Download -> sha256 + byte length -> installZip (extract to a temp sibling,
// marker written inside it, atomic swap) -> verify the result runs. The marker
// is what resolve.ts trusts, so it goes in before the swap and an interrupted
// install can never be mistaken for a working one.
//
// Proxies: Node's global fetch ignores HTTPS_PROXY unless the process runs
// with NODE_USE_ENV_PROXY=1 / --use-env-proxy (Node 24+). We cannot set that
// inside a running process, so the CLI re-executes itself with the flag when
// a proxy variable is present (`proxyReexecArgs`), and this module names the
// variable in the error for every other caller (Node 22 included).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  CHROME_PINS,
  CHROME_VERSION,
  chromePlatform,
  type ChromePin,
  type ChromePlatform,
} from './pins.js';
import {
  chromeBinaryPath,
  chromeInstallDir,
  INSTALL_MARKER,
  resolveChrome,
  type ChromeSource,
} from './resolve.js';
import { installZip } from './zip.js';

export interface InstallOptions {
  cacheDir: string;
  platform?: ChromePlatform;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  onProgress?: (received: number, total: number | null) => void;
  /** Test seam: a pin for a fixture zip. */
  pin?: ChromePin;
  /** Reinstall even when a usable browser is already in the jux or Playwright cache. */
  force?: boolean;
  /** Test seams: the flags this Node accepts, and the zip installer. */
  nodeFlags?: ReadonlySet<string>;
  installZip?: typeof installZip;
}

export interface InstallResult {
  path: string;
  version: string;
  alreadyInstalled: boolean;
  /** Where an existing browser was found; absent after a fresh install. */
  source?: ChromeSource;
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const PROXY_FLAG = '--use-env-proxy';

export function proxyHint(
  env: NodeJS.ProcessEnv,
  nodeFlags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
): string {
  const set = PROXY_VARS.find((v) => env[v]);
  if (!set) return '';
  const fix = nodeFlags.has(PROXY_FLAG)
    ? 're-run with NODE_USE_ENV_PROXY=1, or'
    : `this Node lacks ${PROXY_FLAG}, so`;
  return ` ${set} is set but Node's fetch does not use it by default: ${fix} download the zip yourself and set JUX_CHROME.`;
}

/**
 * Extra node args for the CLI to re-exec with, or null. Detects the flag
 * rather than comparing versions: it is whatever this Node accepts.
 */
export function proxyReexecArgs(
  env: NodeJS.ProcessEnv,
  nodeFlags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
  execArgv: readonly string[] = process.execArgv,
): string[] | null {
  if (!PROXY_VARS.some((v) => env[v])) return null;
  if (env.NODE_USE_ENV_PROXY === '1' || execArgv.includes(PROXY_FLAG)) return null;
  return nodeFlags.has(PROXY_FLAG) ? [PROXY_FLAG] : null;
}

/** A progress callback for stderr, or undefined when stderr is not a TTY. */
export function stderrProgress(
  stream: Pick<NodeJS.WriteStream, 'isTTY' | 'write'> = process.stderr,
): InstallOptions['onProgress'] {
  if (!stream.isTTY) return undefined;
  return (received, total) => {
    const mb = (received / 1048576).toFixed(1);
    const of = total ? ` / ${(total / 1048576).toFixed(1)}` : '';
    stream.write(`\rjux: downloading chrome-headless-shell ${mb}${of} MB`);
    if (total !== null && received >= total) stream.write('\n');
  };
}

// resolveChrome speaks Node's platform/arch, not Chrome for Testing's.
const NODE_TARGET: Record<ChromePlatform, { platform: NodeJS.Platform; arch: string }> = {
  linux64: { platform: 'linux', arch: 'x64' },
  'mac-arm64': { platform: 'darwin', arch: 'arm64' },
  'mac-x64': { platform: 'darwin', arch: 'x64' },
  win64: { platform: 'win32', arch: 'x64' },
};

export async function installChrome(opts: InstallOptions): Promise<InstallResult> {
  const platform = opts.platform ?? chromePlatform();
  const pin = opts.pin ?? CHROME_PINS[platform];
  const env = opts.env ?? process.env;
  const installDir = chromeInstallDir(opts.cacheDir, CHROME_VERSION);
  const binary = chromeBinaryPath(installDir, platform);

  if (!opts.force) {
    // JUX_CHROME is not "installed": it may point anywhere, so ignore it here.
    const { JUX_CHROME: _ignored, ...rest } = env;
    const found = resolveChrome({
      ...NODE_TARGET[platform],
      env: { ...rest, JUX_CACHE_DIR: opts.cacheDir },
    });
    if (found) {
      return {
        path: found.path,
        version: CHROME_VERSION,
        alreadyInstalled: true,
        source: found.source,
      };
    }
  }

  const nodeFlags = opts.nodeFlags ?? process.allowedNodeEnvironmentFlags;
  const nextStep = `Retry with \`npx -p @juxtapose/cli jux browser install\`, or download ${pin.url} yourself and set JUX_CHROME to the chrome-headless-shell binary inside it.`;
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(pin.url);
  } catch (err) {
    throw new Error(
      `jux: download failed for ${pin.url}: ${(err as Error).message}.${proxyHint(env, nodeFlags)} ${nextStep}`,
      { cause: err },
    );
  }
  if (!res.ok || !res.body)
    throw new Error(
      `jux: download failed: HTTP ${res.status} for ${pin.url}. ${nextStep}`,
    );
  const total = Number(res.headers.get('content-length')) || null;
  // Streamed into the hash and a chunk list: ~120 MB held once, not twice.
  const chunks: Buffer[] = [];
  let received = 0;
  let overLength = false;
  const hash = createHash('sha256');
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const b = Buffer.from(chunk);
      received += b.length;
      // A server streaming past the pinned size is wrong already; stop buffering.
      if (received > pin.bytes) {
        overLength = true;
        break;
      }
      chunks.push(b);
      hash.update(b);
      opts.onProgress?.(received, total);
    }
  } catch (err) {
    throw new Error(
      `jux: download interrupted for ${pin.url}: ${(err as Error).message}.${proxyHint(env, nodeFlags)} ${nextStep}`,
      { cause: err },
    );
  }
  const digest = hash.digest('hex');
  if (!overLength && digest !== pin.sha256) {
    throw new Error(
      `jux: sha256 mismatch for ${pin.url}: expected ${pin.sha256}, got ${digest}. ` +
        `The download is corrupt or the published file changed; nothing was installed. ${nextStep}`,
    );
  }
  if (overLength || received !== pin.bytes) {
    throw new Error(
      `jux: length mismatch for ${pin.url}: expected ${pin.bytes} bytes, got ${overLength ? `more than ${pin.bytes}` : received} bytes. ` +
        `The download is truncated or the published file changed; nothing was installed. ${nextStep}`,
    );
  }

  await (opts.installZip ?? installZip)(Buffer.concat(chunks), installDir, {
    marker: INSTALL_MARKER,
  });
  await verifyInstall(installDir, binary);
  return { path: binary, version: CHROME_VERSION, alreadyInstalled: false };
}

/**
 * installZip resolves when a concurrent installer "won" the swap, which can
 * also mask a permission error. Trust only what is on disk and runs.
 */
async function verifyInstall(installDir: string, binary: string): Promise<void> {
  const fail = async (why: string): Promise<never> => {
    // Also removes a concurrent installer's dir when that one is the broken one: it is unusable either way.
    await rm(installDir, { recursive: true, force: true });
    throw new Error(
      `jux: install of chrome-headless-shell ${CHROME_VERSION} into ${installDir} is not usable: ${why}. ` +
        'Check permissions on the cache directory (JUX_CACHE_DIR) and retry.',
    );
  };
  if (!(await exists(path.join(installDir, INSTALL_MARKER))))
    return fail(`${INSTALL_MARKER} marker is missing`);
  if (!(await exists(binary))) return fail(`${binary} is missing`);
  let out: string;
  try {
    out = await new Promise<string>((resolve, reject) =>
      execFile(binary, ['--version'], { timeout: 15_000 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      ),
    );
  } catch (err) {
    return fail(`\`${binary} --version\` failed: ${(err as Error).message}`);
  }
  if (!out.includes(CHROME_VERSION))
    return fail(
      `\`--version\` printed ${JSON.stringify(out.trim())}, expected ${CHROME_VERSION}`,
    );
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
