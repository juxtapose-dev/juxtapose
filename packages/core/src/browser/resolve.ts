// packages/core/src/browser/resolve.ts
//
// Where the browser comes from, in order: --chrome, JUX_CHROME, our cache,
// Playwright's cache. The last one is not a courtesy: it is the same bytes
// (pins.ts), and most early users already have it, so the upgrade costs them
// no download.

import { existsSync } from 'node:fs';
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
}

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
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches');
  if (platform === 'win32')
    return env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return env.XDG_CACHE_HOME || path.join(home, '.cache');
}

export function juxCacheDir(opts: ResolveOptions = {}): string {
  const env = opts.env ?? process.env;
  if (env.JUX_CACHE_DIR) return env.JUX_CACHE_DIR;
  const platform = opts.platform ?? process.platform;
  return path.join(osCacheDir(platform, env, opts.homedir ?? osHomedir()), 'jux');
}

export function chromeInstallDir(
  cacheDir: string,
  version: string = CHROME_VERSION,
): string {
  return path.join(cacheDir, 'chrome-headless-shell', version);
}

/** Mirrors the zip's top-level folder so `extractZip` needs no renaming. */
export function chromeBinaryPath(installDir: string, platform: ChromePlatform): string {
  const exe =
    platform === 'win64' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  return path.join(installDir, `chrome-headless-shell-${platform}`, exe);
}

export function msPlaywrightBinaryPath(opts: ResolveOptions = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const cft = chromePlatform(platform, opts.arch ?? process.arch);
  const root =
    env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(osCacheDir(platform, env, opts.homedir ?? osHomedir()), 'ms-playwright');
  return chromeBinaryPath(
    path.join(root, `chromium_headless_shell-${MS_PLAYWRIGHT_REVISION}`),
    cft,
  );
}

export function resolveChrome(opts: ResolveOptions = {}): ResolvedChrome | null {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;

  if (opts.flag) {
    if (!exists(opts.flag)) throw new Error(`jux: --chrome ${opts.flag} does not exist.`);
    return { path: opts.flag, source: 'flag' };
  }
  if (env.JUX_CHROME) {
    if (!exists(env.JUX_CHROME))
      throw new Error(`jux: JUX_CHROME=${env.JUX_CHROME} does not exist.`);
    return { path: env.JUX_CHROME, source: 'env' };
  }

  let cft: ChromePlatform;
  try {
    cft = chromePlatform(opts.platform ?? process.platform, opts.arch ?? process.arch);
  } catch {
    return null;
  }

  const installDir = chromeInstallDir(juxCacheDir(opts));
  const ours = chromeBinaryPath(installDir, cft);
  if (exists(ours) && exists(path.join(installDir, INSTALL_MARKER)))
    return { path: ours, source: 'jux-cache' };

  const theirs = msPlaywrightBinaryPath(opts);
  // Playwright writes INSTALLATION_COMPLETE last, like our marker.
  const theirMarker = path.join(
    path.dirname(path.dirname(theirs)),
    'INSTALLATION_COMPLETE',
  );
  if (exists(theirs) && exists(theirMarker))
    return { path: theirs, source: 'ms-playwright' };

  return null;
}
