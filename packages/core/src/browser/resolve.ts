// packages/core/src/browser/resolve.ts
//
// Where the browser comes from, in order: --chrome, JUX_CHROME, our cache,
// Playwright's cache. The last one is not a courtesy: it is the same bytes
// (pins.ts), and most early users already have it, so the upgrade costs them
// no download.

import { existsSync, statSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import {
  CHROME_VERSION,
  MS_PLAYWRIGHT_REVISION,
  chromePlatform,
  type ChromePlatform,
} from './pins.js';

export interface ResolveOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  homedir?: string;
  exists?: (p: string) => boolean;
  isDirectory?: (p: string) => boolean;
}

/** Paths follow the target platform, not the host, so tests can assert win32 strings anywhere. */
const pathFor = (platform: NodeJS.Platform) =>
  platform === 'win32' ? path.win32 : path.posix;

const isDirectoryOnDisk = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export type ChromeSource = 'flag' | 'env' | 'jux-cache' | 'ms-playwright';

export interface ResolvedChrome {
  path: string;
  source: ChromeSource;
}

export const INSTALL_MARKER = '.complete';

export const NO_BROWSER_MESSAGE =
  'jux: no browser. Run `npx -p @juxtapose/cli jux browser install`, or set JUX_CHROME=<path to a Chromium headless shell>.';

/** The no-browser message, with the platform explanation when there is no build to install. */
export function noBrowserMessage(opts: ResolveOptions = {}): string {
  try {
    chromePlatform(opts.platform ?? process.platform, opts.arch ?? process.arch);
    return NO_BROWSER_MESSAGE;
  } catch (err) {
    return (err as Error).message;
  }
}

function osCacheDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const p = pathFor(platform);
  if (platform === 'darwin') return p.join(home, 'Library', 'Caches');
  if (platform === 'win32') return env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
  return env.XDG_CACHE_HOME || p.join(home, '.cache');
}

export function juxCacheDir(opts: ResolveOptions = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const p = pathFor(platform);
  if (env.JUX_CACHE_DIR) return p.resolve(env.JUX_CACHE_DIR);
  return p.join(osCacheDir(platform, env, opts.homedir ?? osHomedir()), 'jux');
}

/** A cache dir with a drive letter or backslashes is a Windows path. */
const platformOfCacheDir = (cacheDir: string): NodeJS.Platform =>
  /^[A-Za-z]:|\\/.test(cacheDir) ? 'win32' : 'linux';

export function chromeInstallDir(
  cacheDir: string,
  version: string = CHROME_VERSION,
): string {
  return pathFor(platformOfCacheDir(cacheDir)).join(
    cacheDir,
    'chrome-headless-shell',
    version,
  );
}

/** Mirrors the zip's top-level folder so `extractZip` needs no renaming. */
export function chromeBinaryPath(installDir: string, platform: ChromePlatform): string {
  const exe =
    platform === 'win64' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const p = platform === 'win64' ? path.win32 : path.posix;
  return p.join(installDir, `chrome-headless-shell-${platform}`, exe);
}

export function msPlaywrightBinaryPath(opts: ResolveOptions = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const cft = chromePlatform(platform, opts.arch ?? process.arch);
  const p = pathFor(platform);
  const root =
    env.PLAYWRIGHT_BROWSERS_PATH ||
    p.join(osCacheDir(platform, env, opts.homedir ?? osHomedir()), 'ms-playwright');
  return chromeBinaryPath(
    p.join(root, `chromium_headless_shell-${MS_PLAYWRIGHT_REVISION}`),
    cft,
  );
}

export function resolveChrome(opts: ResolveOptions = {}): ResolvedChrome | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const p = pathFor(platform);
  const exists = opts.exists ?? existsSync;
  const isDirectory = opts.isDirectory ?? isDirectoryOnDisk;

  // Resolved so a daemon or child with another cwd sees the same file; an
  // existing directory would only fail later at spawn, with a worse message.
  const explicit = (raw: string, label: string): string => {
    const abs = p.resolve(raw);
    if (!exists(abs)) throw new Error(`jux: ${label} does not exist.`);
    if (isDirectory(abs))
      throw new Error(`jux: ${label} is a directory, not a browser executable.`);
    return abs;
  };

  if (opts.flag)
    return { path: explicit(opts.flag, `--chrome ${opts.flag}`), source: 'flag' };
  // An empty JUX_CHROME (`JUX_CHROME= jux ...`) is unset, not a path.
  if (env.JUX_CHROME)
    return {
      path: explicit(env.JUX_CHROME, `JUX_CHROME=${env.JUX_CHROME}`),
      source: 'env',
    };

  let cft: ChromePlatform;
  try {
    cft = chromePlatform(platform, opts.arch ?? process.arch);
  } catch {
    return null;
  }

  const installDir = chromeInstallDir(juxCacheDir(opts));
  const ours = chromeBinaryPath(installDir, cft);
  if (exists(ours) && exists(p.join(installDir, INSTALL_MARKER)))
    return { path: ours, source: 'jux-cache' };

  // PLAYWRIGHT_BROWSERS_PATH=0 is Playwright's "install inside node_modules"
  // sentinel, not a directory; joining it would probe a relative "0/" path.
  if (env.PLAYWRIGHT_BROWSERS_PATH === '0') return null;

  const theirs = msPlaywrightBinaryPath(opts);
  // Playwright writes INSTALLATION_COMPLETE last, like our marker.
  const theirMarker = p.join(p.dirname(p.dirname(theirs)), 'INSTALLATION_COMPLETE');
  if (exists(theirs) && exists(theirMarker))
    return { path: theirs, source: 'ms-playwright' };

  return null;
}
