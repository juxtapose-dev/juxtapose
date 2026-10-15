// packages/core/src/browser/acquire.ts
//
// The one place that decides where a Browser comes from. Every command and
// the review server call this; PR 2 adds the warm daemon here and nowhere
// else, so no caller changes when the policy does (Ruling 3).

import { Browser } from './browser.js';
import { connectWarmBrowser, daemonEnabled, daemonIdleMinutes } from './daemon/client.js';
import { daemonSupported } from './daemon/state.js';
import type { SpawnFn } from './launch.js';
import { resolveOrAdoptChrome } from './adopt.js';
import { juxStateDir, noBrowserMessage } from './resolve.js';

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
  const resolved = await resolveOrAdoptChrome({ flag: opts.chrome, env });
  if (!resolved) throw new Error(noBrowserMessage({ env }));
  // Ruling 22: no daemon on Windows; CI and the opt-outs get PR 1's path exactly.
  if (!daemonSupported() || !daemonEnabled(env, opts.noDaemon)) {
    const first = await Browser.launch({ executablePath: resolved.path, spawn: opts.spawn });
    const browsers = [first];
    try {
      browsers.push(await Browser.launch({ executablePath: resolved.path, spawn: opts.spawn }));
    } catch (error) { await first.close(); throw error; }
    const contexts = browsers.map((browser) => browser.newContext.bind(browser));
    const closes = browsers.map((browser) => browser.close.bind(browser));
    const connected = browsers.map((browser) => browser.isConnected.bind(browser));
    let cursor = 0;
    first.newContext = (options) => contexts[cursor++ % contexts.length]!(options);
    first.isConnected = () => connected.every((check) => check());
    first.close = async () => { await Promise.all(closes.map((close) => close())); };
    return first;
  }
  const { browser } = await (opts.connectWarm ?? connectWarmBrowser)({
    executablePath: resolved.path,
    stateDir: juxStateDir({ env }),
    env,
    idleMinutes: daemonIdleMinutes(env),
  });
  return browser;
}
