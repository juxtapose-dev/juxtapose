// packages/core/src/browser/adopt.ts
//
// Playwright's cache holds the same bytes as our pin (pins.ts), and most early
// users already have it, so first run should not need a 100 MB download. But
// jux must never *run* from there: `playwright install`, a Playwright upgrade
// or a disk cleanup deletes that directory at any time, mid-run (#141).
//
// So a matching build is copied into our cache once (an APFS/reflink clone
// where the filesystem has one, else a plain copy), checked by running it,
// and only then marked complete. Everything after that sees our own copy.

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from './guards.js';
import { CHROME_VERSION, chromePlatform, type ChromePlatform } from './pins.js';
import {
  chromeBinaryPath,
  chromeInstallDir,
  INSTALL_MARKER,
  juxCacheDir,
  msPlaywrightBinaryPath,
  resolveChrome,
  type ResolvedChrome,
  type ResolveOptions,
} from './resolve.js';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Why `binary` is not the pinned browser, or null when it runs and reports CHROME_VERSION. */
export async function pinnedVersionProblem(binary: string): Promise<string | null> {
  let out: string;
  try {
    out = await new Promise<string>((resolve, reject) =>
      execFile(binary, ['--version'], { timeout: 15_000 }, (err, stdout) =>
        // ExecFileException is an Error at runtime but an Omit<> type, which
        // the reject-with-an-Error lint cannot see through; instanceof can.
        err
          ? reject(err instanceof Error ? err : new Error(err.message, { cause: err }))
          : resolve(stdout),
      ),
    );
  } catch (err) {
    return `\`${binary} --version\` failed: ${errorMessage(err)}`;
  }
  if (!out.includes(CHROME_VERSION))
    return `\`--version\` printed ${JSON.stringify(out.trim())}, expected ${CHROME_VERSION}`;
  return null;
}

/**
 * Copy a complete Playwright build of the pinned browser into jux's cache.
 * Null when there is none (or it fails verification); the Playwright
 * directory is only ever read.
 */
export async function adoptPlaywrightBrowser(
  opts: ResolveOptions = {},
): Promise<ResolvedChrome | null> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  let cft: ChromePlatform;
  try {
    cft = chromePlatform(platform, opts.arch ?? process.arch);
  } catch {
    return null;
  }
  // PLAYWRIGHT_BROWSERS_PATH=0 is Playwright's "install inside node_modules"
  // sentinel, not a directory; joining it would probe a relative "0/" path.
  if (env.PLAYWRIGHT_BROWSERS_PATH === '0') return null;

  const theirs = msPlaywrightBinaryPath(opts);
  const theirBuild = path.dirname(theirs);
  // Playwright writes INSTALLATION_COMPLETE last, like our marker.
  const theirMarker = path.join(path.dirname(theirBuild), 'INSTALLATION_COMPLETE');
  if (!(await pathExists(theirs)) || !(await pathExists(theirMarker))) return null;

  const installDir = chromeInstallDir(juxCacheDir(opts));
  const tmp = `${installDir}.adopt-${process.pid}-${Date.now().toString(36)}`;
  try {
    await mkdir(path.dirname(installDir), { recursive: true });
    await cp(theirBuild, path.join(tmp, path.basename(theirBuild)), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    const copy = chromeBinaryPath(tmp, cft);
    if (await pinnedVersionProblem(copy)) return null;
    await writeFile(path.join(tmp, INSTALL_MARKER), '');
    try {
      await rename(tmp, installDir);
    } catch {
      // A concurrent adopter or installer may have won; trust only a complete dir.
      if (!(await pathExists(path.join(installDir, INSTALL_MARKER)))) {
        await rm(installDir, { recursive: true, force: true });
        await rename(tmp, installDir);
      }
    }
  } catch {
    return null;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return resolveChrome({ ...opts, flag: undefined, env: { ...env, JUX_CHROME: '' } });
}

/** resolveChrome, plus the copy-on-first-use from Playwright's cache. */
export async function resolveOrAdoptChrome(
  opts: ResolveOptions & { flag?: string } = {},
): Promise<ResolvedChrome | null> {
  const found = resolveChrome(opts);
  if (found) return found;
  return adoptPlaywrightBrowser(opts);
}
