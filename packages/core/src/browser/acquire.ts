// packages/core/src/browser/acquire.ts
//
// The one place that decides where a Browser comes from. Every command and
// the review server call this; PR 2 adds the warm daemon here and nowhere
// else, so no caller changes when the policy does.

import { Browser } from './browser.js';
import type { SpawnFn } from './launch.js';
import { noBrowserMessage, resolveChrome } from './resolve.js';

export interface AcquireOptions {
  /** `--chrome <path>`; wins over JUX_CHROME and the caches. */
  chrome?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  /** PR 2: `--no-daemon`. Accepted now so callers need no change later. */
  noDaemon?: boolean;
}

export async function acquireBrowser(opts: AcquireOptions = {}): Promise<Browser> {
  const env = opts.env ?? process.env;
  const resolved = resolveChrome({ flag: opts.chrome, env });
  if (!resolved) throw new Error(noBrowserMessage());
  return Browser.launch({ executablePath: resolved.path, spawn: opts.spawn });
}
