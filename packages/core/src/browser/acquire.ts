// packages/core/src/browser/acquire.ts
//
// The one place that decides where a Browser comes from. Every command and
// the review server call this; PR 2 adds the warm daemon here and nowhere
// else, so no caller changes when the policy does (Ruling 3).

import { Browser } from './browser.js';
import { connectWarmBrowser, daemonEnabled, daemonIdleMinutes } from './daemon/client.js';
import { daemonSupported } from './daemon/state.js';
import type { SpawnFn } from './launch.js';
import { juxStateDir, noBrowserMessage, resolveChrome } from './resolve.js';

export interface AcquireOptions {
  /** `--chrome <path>`; wins over JUX_CHROME and the caches. */
  chrome?: string;
  env?: NodeJS.ProcessEnv;
  /** Fresh launches only; the daemon spawns its own Chrome. */
  spawn?: SpawnFn;
  /** `--no-daemon`. */
  noDaemon?: boolean;
  /** Test seam. */
  connectWarm?: typeof connectWarmBrowser;
}

export async function acquireBrowser(opts: AcquireOptions = {}): Promise<Browser> {
  const env = opts.env ?? process.env;
  const resolved = resolveChrome({ flag: opts.chrome, env });
  if (!resolved) throw new Error(noBrowserMessage());
  // Ruling 22: no daemon on Windows; CI and the opt-outs get PR 1's path exactly.
  if (!daemonSupported() || !daemonEnabled(env, opts.noDaemon))
    return Browser.launch({ executablePath: resolved.path, spawn: opts.spawn });
  const { browser } = await (opts.connectWarm ?? connectWarmBrowser)({
    executablePath: resolved.path,
    stateDir: juxStateDir({ env }),
    env,
    idleMinutes: daemonIdleMinutes(env),
  });
  return browser;
}
