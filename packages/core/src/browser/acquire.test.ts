import { describe, it, expect } from 'vitest';
import { acquireBrowser } from './acquire.js';
import { chromeForTests } from './__tests__/helpers.js';
import { CI_ENV_VARS } from './daemon/client.js';

const chrome = chromeForTests();
// vitest.config sets JUX_NO_DAEMON=1 for every test; these cases decide for themselves.
const base = { ...process.env, JUX_NO_DAEMON: undefined };
// The CI runner's own markers would switch the daemon off in the "outside CI" cases.
const outsideCi = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  for (const v of CI_ENV_VARS) delete env[v];
  return env;
};

describe.skipIf(!chrome)('acquireBrowser', () => {
  it('never touches the daemon in CI or with noDaemon', async () => {
    const boom = () => {
      throw new Error('daemon path used');
    };
    const a = await acquireBrowser({
      env: { ...base, CI: 'true' },
      connectWarm: boom,
    });
    expect(a.isConnected()).toBe(true);
    await a.close();
    const b = await acquireBrowser({
      env: { ...base, CI: '' },
      noDaemon: true,
      connectWarm: boom,
    });
    await b.close();
  });
  it('asks the daemon in JUX_STATE_DIR, which moves apart from the cache', async () => {
    if (process.platform === 'win32') return;
    const env: NodeJS.ProcessEnv = {
      ...base,
      JUX_STATE_DIR: '/tmp/s',
      JUX_CACHE_DIR: '/tmp/c',
    };
    outsideCi(env);
    delete env.JUX_NO_DAEMON;
    let seen: string | undefined;
    await acquireBrowser({
      env,
      connectWarm: (o) => {
        seen = o.stateDir;
        throw new Error('seam');
      },
    }).catch(() => undefined);
    expect(seen).toBe('/tmp/s');
  });
  it('outside CI it asks the warm daemon first', async () => {
    const env = outsideCi({ ...base });
    let asked = 0;
    const err = await acquireBrowser({
      env,
      connectWarm: () => {
        asked++;
        throw new Error('warm seam');
      },
    }).catch((e: Error) => e);
    // The real client never throws (it falls back itself); the seam does, so
    // the call is visible.
    expect(asked).toBe(process.platform === 'win32' ? 0 : 1);
    if (process.platform !== 'win32') expect((err as Error).message).toBe('warm seam');
    else await (err as unknown as { close(): Promise<void> }).close();
  });
});
