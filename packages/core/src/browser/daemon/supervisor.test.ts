import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startSupervisor,
  SupervisorLostRace,
  type SupervisorOptions,
} from './supervisor.js';
import {
  daemonPaths,
  ensureDaemonDirs,
  readState,
  writeState,
  pidAlive,
  type DaemonPaths,
} from './state.js';
import { CdpConnection, CdpError } from '../cdp.js';
import { SocketTransport } from '../transport.js';
import { CHROME_VERSION } from '../pins.js';
import { chromeForTests } from '../__tests__/helpers.js';
import { Browser } from '../browser.js';
import { snapPages } from '../../capture/snap.js';
import { createServer } from 'node:http';

const chrome = chromeForTests();

type Sup = Awaited<ReturnType<typeof startSupervisor>>;

async function connect(
  socketPath: string,
  version = CHROME_VERSION,
): Promise<{ c: CdpConnection; sock: net.Socket; outcome: 'ready' | 'refused' }> {
  const sock = net.connect(socketPath);
  await new Promise<void>((r, e) => {
    sock.once('connect', r);
    sock.once('error', e);
  });
  const t = new SocketTransport(sock);
  const c = new CdpConnection(t);
  const outcome = Promise.race([
    c.once('jux.ready').then(() => 'ready' as const),
    c.once('jux.refused').then(() => 'refused' as const),
  ]);
  t.send(JSON.stringify({ jux: 'hello', version }));
  return { c, sock, outcome: await outcome };
}

const closed = (c: CdpConnection) =>
  new Promise<void>((r) => {
    c.onClosed(() => r());
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withPaths<T>(fn: (paths: DaemonPaths) => Promise<T>): Promise<T> {
  const cache = await mkdtemp(path.join(tmpdir(), 'jux-sup-'));
  // A unique key: a long tmpdir falls back to the shared /tmp/jux-<uid>.
  const paths = daemonPaths(cache, `t${randomBytes(4).toString('hex')}`);
  try {
    return await fn(paths);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

async function withSupervisor(
  fn: (ctx: { paths: DaemonPaths; sup: Sup }) => Promise<void>,
  idleMinutes = 10,
  prepare?: (paths: DaemonPaths) => Promise<void>,
  extra: Partial<SupervisorOptions> = {},
): Promise<boolean> {
  return withPaths(async (paths) => {
    await prepare?.(paths);
    let exited = false;
    const sup = await startSupervisor({
      executablePath: chrome!.path,
      paths,
      key: 'test',
      idleMinutes,
      onExit: () => (exited = true),
      ...extra,
    });
    try {
      await fn({ paths, sup });
    } finally {
      await sup.stop();
    }
    // stop() leaves nothing behind for the next daemon to trip over.
    expect(await readState(paths)).toBeNull();
    expect(await lstat(paths.socket).catch(() => null)).toBeNull();
    expect(pidAlive(sup.chromePid)).toBe(false);
    return exited;
  });
}

/** Creates a context, a target in it and a flat session on it. */
async function openPage(c: CdpConnection) {
  const { browserContextId } = await c.send<{ browserContextId: string }>(
    'Target.createBrowserContext',
    { disposeOnDetach: true },
  );
  const { targetId } = await c.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const { sessionId } = await c.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  return { browserContextId, targetId, sessionId };
}

describe.skipIf(!chrome)('supervisor', () => {
  it('serves two clients, isolates sessions, and disposes a dead client’s contexts', () =>
    withSupervisor(async ({ paths, sup }) => {
      expect((await readState(paths))?.pid).toBe(process.pid);
      const a = (await connect(paths.socket)).c;
      const b = (await connect(paths.socket)).c;
      const [va, vb] = await Promise.all([
        a.send<{ product: string }>('Browser.getVersion'),
        b.send<{ product: string }>('Browser.getVersion'),
      ]);
      expect(va.product).toBe(vb.product);
      const { browserContextId, sessionId } = await openPage(a);
      let bSaw = 0;
      b.on('Runtime.executionContextCreated', () => bSaw++);
      let aSaw = 0;
      a.on('Runtime.executionContextCreated', () => aSaw++, sessionId);
      await a.send('Runtime.enable', {}, sessionId);
      const r = await a.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: '6*7', returnByValue: true },
        sessionId,
      );
      expect(r.result.value).toBe(42);
      expect(aSaw).toBeGreaterThan(0);
      expect(bSaw).toBe(0);
      // Each client sees only its own contexts (and not the default one).
      const own = await b.send<{ browserContextId: string }>(
        'Target.createBrowserContext',
      );
      const seen = await b.send<{
        browserContextIds: string[];
        defaultBrowserContextId?: string;
      }>('Target.getBrowserContexts');
      expect(seen.browserContextIds).toEqual([own.browserContextId]);
      expect(seen.defaultBrowserContextId).toBeUndefined();
      expect(
        (await a.send<{ browserContextIds: string[] }>('Target.getBrowserContexts'))
          .browserContextIds,
      ).toEqual([browserContextId]);
      expect(await sup.browserContextIds()).toContain(browserContextId);
      a.close();
      // After a drops, its context is gone from the browser.
      for (let i = 0; i < 20; i++) {
        if (!(await sup.browserContextIds()).includes(browserContextId)) break;
        await sleep(50);
      }
      expect(await sup.browserContextIds()).not.toContain(browserContextId);
      b.close();
    }));

  it('a context the client disposed itself is not disposed twice (no error on drop)', () =>
    withSupervisor(async ({ paths, sup }) => {
      const a = (await connect(paths.socket)).c;
      const { browserContextId } = await a.send<{ browserContextId: string }>(
        'Target.createBrowserContext',
      );
      await a.send('Target.disposeBrowserContext', { browserContextId });
      a.close();
      const b = (await connect(paths.socket)).c;
      expect(await sup.browserContextIds()).not.toContain(browserContextId);
      b.close();
    }));

  it('rejects a client with another pinned version', () =>
    withSupervisor(async ({ paths }) => {
      const { outcome, c } = await connect(paths.socket, '0.0.0.0');
      expect(outcome).toBe('refused');
      await closed(c);
    }));

  it('listens over a leftover socket file, and exits when idle', async () => {
    const exited = await withSupervisor(
      async ({ paths }) => {
        const { c, outcome } = await connect(paths.socket);
        expect(outcome).toBe('ready');
        c.close();
        await sleep(900); // idle 0.005 min = 300 ms after the client drops
      },
      0.005,
      async (paths) => {
        await ensureDaemonDirs(paths);
        await writeFile(paths.socket, ''); // a crashed daemon's leftover
      },
    );
    expect(exited).toBe(true);
  });

  it('refreshes the state file mtime every second as a heartbeat (Task 13 fix 2)', () =>
    withSupervisor(async ({ paths }) => {
      const old = new Date(Date.now() - 60_000);
      await utimes(paths.state, old, old);
      await sleep(1300);
      expect(Date.now() - (await stat(paths.state)).mtimeMs).toBeLessThan(2000);
    }));
  it('the socket is a 0600 socket owned by this user', () =>
    withSupervisor(async ({ paths }) => {
      const st = await lstat(paths.socket);
      expect(st.isSocket()).toBe(true);
      expect(st.mode & 0o777).toBe(0o600);
      expect(st.uid).toBe(process.getuid!());
    }));

  it('one client cannot reach, see or dispose another client’s targets and sessions', () =>
    withSupervisor(async ({ paths }) => {
      const a = (await connect(paths.socket)).c;
      const b = (await connect(paths.socket)).c;
      // b listens for every target event the browser session emits.
      const bTargetEvents: string[] = [];
      for (const ev of [
        'Target.targetCreated',
        'Target.targetInfoChanged',
        'Target.attachedToTarget',
        'Target.detachedFromTarget',
        'Target.targetDestroyed',
      ])
        b.on(ev, () => bTargetEvents.push(ev));
      const aCreated: string[] = [];
      a.on('Target.attachedToTarget', () => aCreated.push('attached'));
      const { browserContextId, targetId, sessionId } = await openPage(a);
      expect(aCreated).toEqual(['attached']);

      const refused = async (p: Promise<unknown>) => {
        const e = await p.then(
          () => null,
          (x: unknown) => x,
        );
        expect(e).toBeInstanceOf(CdpError);
        expect((e as Error).message).toMatch(/jux: .*not this client's/);
      };
      await refused(
        b.send('Runtime.evaluate', { expression: '1', returnByValue: true }, sessionId),
      );
      await refused(b.send('Target.attachToTarget', { targetId, flatten: true }));
      await refused(b.send('Target.closeTarget', { targetId }));
      await refused(b.send('Target.disposeBrowserContext', { browserContextId }));
      await refused(b.send('Target.detachFromTarget', { sessionId }));
      await refused(
        b.send('Target.createTarget', { url: 'about:blank', browserContextId }),
      );
      // Browser-wide commands that would reach into a's targets.
      await refused(b.send('Target.createTarget', { url: 'about:blank' }));
      await refused(
        b.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        }),
      );
      await refused(b.send('Target.setDiscoverTargets', { discover: true }));
      await refused(b.send('Browser.close'));
      const { targetInfos } = await b.send<{ targetInfos: { targetId: string }[] }>(
        'Target.getTargets',
      );
      expect(targetInfos.map((t) => t.targetId)).not.toContain(targetId);

      // a's page still works and b heard nothing about it.
      const r = await a.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: '6*7', returnByValue: true },
        sessionId,
      );
      expect(r.result.value).toBe(42);
      await a.send('Target.closeTarget', { targetId });
      await sleep(100);
      expect(bTargetEvents).toEqual([]);
      a.close();
      b.close();
    }));

  it('child sessions auto-attached under a client’s session belong to it', () =>
    withSupervisor(async ({ paths }) => {
      const a = (await connect(paths.socket)).c;
      const b = (await connect(paths.socket)).c;
      let bSaw = 0;
      b.on('Target.attachedToTarget', () => bSaw++);
      b.on('Runtime.executionContextCreated', () => bSaw++);
      const { sessionId } = await openPage(a);
      await a.send(
        'Target.setAutoAttach',
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
        sessionId,
      );
      const child = a.once<{ sessionId: string; targetInfo: { type: string } }>(
        'Target.attachedToTarget',
        sessionId,
      );
      await a.send(
        'Runtime.evaluate',
        {
          expression: `new Worker(URL.createObjectURL(new Blob(['self.x=1'])))`,
        },
        sessionId,
      );
      const { sessionId: childSession, targetInfo } = await child;
      expect(targetInfo.type).toBe('worker');
      const r = await a.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: '2+3', returnByValue: true },
        childSession,
      );
      expect(r.result.value).toBe(5);
      await expect(
        b.send('Runtime.evaluate', { expression: '1' }, childSession),
      ).rejects.toThrow(/not this client's/);
      expect(bSaw).toBe(0);
      a.close();
      b.close();
    }));

  it('a client that stops reading still gets every byte, in order, and others are served meanwhile', () =>
    withSupervisor(async ({ paths }) => {
      const a = await connect(paths.socket);
      const b = (await connect(paths.socket)).c;
      const { sessionId } = await openPage(a.c);
      a.sock.pause();
      const big = a.c.send<{ result: { value: string } }>(
        'Runtime.evaluate',
        { expression: `'x'.repeat(24 * 1024 * 1024)`, returnByValue: true },
        sessionId,
      );
      const small = a.c.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: '1+1', returnByValue: true },
        sessionId,
      );
      // b is not held up by a's full socket.
      expect((await b.send<{ product: string }>('Browser.getVersion')).product).toMatch(
        /HeadlessChrome/,
      );
      await sleep(300);
      a.sock.resume();
      expect((await big).result.value.length).toBe(24 * 1024 * 1024);
      expect((await small).result.value).toBe(2);
      a.c.close();
      b.close();
    }));

  it('when Chrome dies the supervisor exits, clears its state and closes its clients', () =>
    withPaths(async (paths) => {
      let exited = false;
      const sup = await startSupervisor({
        executablePath: chrome!.path,
        paths,
        key: 'test',
        idleMinutes: 10,
        onExit: () => (exited = true),
      });
      const { c } = await connect(paths.socket);
      const gone = closed(c);
      process.kill(sup.chromePid, 'SIGKILL');
      await gone;
      for (let i = 0; i < 40 && !exited; i++) await sleep(50);
      expect(exited).toBe(true);
      expect(await readState(paths)).toBeNull();
      expect(await lstat(paths.socket).catch(() => null)).toBeNull();
      await sup.stop(); // idempotent
    }));

  it('a live daemon on the socket wins: the loser launches nothing and touches nothing', () =>
    withSupervisor(async ({ paths, sup }) => {
      const before = await readState(paths);
      const err = await startSupervisor({
        executablePath: chrome!.path,
        paths,
        key: 'test',
        idleMinutes: 10,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SupervisorLostRace);
      expect((err as SupervisorLostRace).chromePid).toBeUndefined();
      expect(await readState(paths)).toEqual(before);
      expect((await connect(paths.socket)).outcome).toBe('ready');
      expect(sup.state.pid).toBe(process.pid);
    }));

  it('EADDRINUSE at listen (Ruling 21): the loser closes its Chrome and leaves the winner alone', () =>
    withPaths(async (paths) => {
      await ensureDaemonDirs(paths);
      const winnerState = {
        pid: process.pid,
        socket: paths.socket,
        binary: '/winner',
        version: CHROME_VERSION,
        key: 'test',
        startedAt: '2026-10-13T00:00:00Z',
        idleMinutes: 10,
      };
      let winner: net.Server | undefined;
      const err = await startSupervisor({
        executablePath: chrome!.path,
        paths,
        key: 'test',
        idleMinutes: 10,
        // The winner binds between the loser's probe and its listen.
        beforeListen: async () => {
          winner = net.createServer((s) => s.end());
          await new Promise<void>((r) => winner!.listen(paths.socket, r));
          await writeState(paths, winnerState);
        },
      }).then(
        () => null,
        (e: unknown) => e,
      );
      try {
        expect(err).toBeInstanceOf(SupervisorLostRace);
        const pid = (err as SupervisorLostRace).chromePid!;
        expect(pid).toBeGreaterThan(0);
        expect(pidAlive(pid)).toBe(false);
        expect(await readState(paths)).toEqual(winnerState);
        expect((await lstat(paths.socket)).isSocket()).toBe(true);
      } finally {
        await new Promise<void>((r) => winner?.close(() => r()) ?? r());
      }
    }));
});

/** A raw client: writes any frame, exposes the socket, sees every frame back. */
async function rawClient(socketPath: string, hello = true) {
  const sock = net.connect(socketPath);
  await new Promise<void>((r, e) => {
    sock.once('connect', r);
    sock.once('error', e);
  });
  let gone = false;
  sock.on('close', () => (gone = true));
  sock.on('error', () => {});
  const write = (frame: string) => sock.write(frame + '\0');
  if (hello) write(JSON.stringify({ jux: 'hello', version: CHROME_VERSION }));
  return { sock, write, isClosed: () => gone };
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const refusedBy = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e, 'expected a refusal').toBeInstanceOf(CdpError);
  expect((e as Error).message).toMatch(/jux: .*not this client's/);
};

describe.skipIf(!chrome)('supervisor isolation (fix round 1 escapes)', () => {
  it('a page session cannot discover, claim or attach another client’s target, nor reach the default context', () =>
    withSupervisor(async ({ paths }) => {
      const a = (await connect(paths.socket)).c;
      const b = (await connect(paths.socket)).c;
      const pa = await openPage(a);
      const pb = await openPage(b);
      const heard: string[] = [];
      b.on('Target.targetCreated', (p) =>
        heard.push((p as { targetInfo: { targetId: string } }).targetInfo.targetId),
      );
      await refusedBy(
        b.send('Target.setDiscoverTargets', { discover: true }, pb.sessionId),
      );
      await refusedBy(
        b.send('Target.createTarget', { url: 'about:blank' }, pb.sessionId),
      );
      await refusedBy(
        b.send(
          'Target.attachToTarget',
          { targetId: pa.targetId, flatten: true },
          pb.sessionId,
        ),
      );
      const { targetInfos } = await b.send<{ targetInfos: { targetId: string }[] }>(
        'Target.getTargets',
        {},
        pb.sessionId,
      );
      expect(targetInfos.map((t) => t.targetId)).not.toContain(pa.targetId);
      await refusedBy(
        b.send('Target.attachToTarget', { targetId: pa.targetId, flatten: true }),
      );
      await refusedBy(b.send('Target.closeTarget', { targetId: pa.targetId }));
      await sleep(100);
      expect(heard).not.toContain(pa.targetId);
      a.close();
      b.close();
    }));

  it('the browser session takes only the allow-list; everything else is refused', () =>
    withSupervisor(async ({ paths }) => {
      const a = (await connect(paths.socket)).c;
      const b = (await connect(paths.socket)).c;
      const pa = await openPage(a);
      const pb = await openPage(b);
      const refused: [string, object][] = [
        ['Fetch.enable', { patterns: [{ urlPattern: '*' }] }],
        ['Tracing.start', { transferMode: 'ReportEvents' }],
        ['SystemInfo.getProcessInfo', {}],
        ['Memory.getBrowserSamplingProfile', {}],
        ['Storage.getCookies', {}],
        ['Storage.getCookies', { browserContextId: pa.browserContextId }],
        ['Storage.clearCookies', {}],
        // Not a cookie method: the id is a decoy these ignore, acting on the
        // default partition or browser-wide.
        [
          'Storage.clearDataForOrigin',
          {
            origin: 'http://x',
            storageTypes: 'all',
            browserContextId: pb.browserContextId,
          },
        ],
        [
          'Storage.setAttributionReportingLocalTestingMode',
          { enabled: true, browserContextId: pb.browserContextId },
        ],
        ['Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }],
        ['Browser.grantPermissions', { permissions: ['geolocation'] }],
        ['Browser.getWindowForTarget', { targetId: pa.targetId }],
        ['Browser.getWindowBounds', { windowId: 1 }],
        ['Target.attachToBrowserTarget', {}],
        ['Target.exposeDevToolsProtocol', { targetId: pb.targetId }],
        ['Target.setRemoteLocations', { locations: [{ host: 'x', port: 1 }] }],
        ['Target.getTargetInfo', {}],
        ['Target.closeTarget', { targetId: [pa.targetId] }],
        ['Browser.close', {}],
      ];
      for (const [method, params] of refused) await refusedBy(b.send(method, params));
      // On its own page session: the target-escaping Target.* commands and Browser.close.
      for (const [method, params] of [
        ['Target.attachToBrowserTarget', {}],
        ['Target.exposeDevToolsProtocol', { targetId: pb.targetId }],
        ['Browser.close', {}],
        // Task 12 re-review: no context id means the empty default context.
        ['Storage.getCookies', {}],
        ['Storage.clearCookies', {}],
        ['Storage.getCookies', { browserContextId: pa.browserContextId }],
        ['Storage.setCookies', { cookies: [] }],
        // Browser singletons whichever session sends them, and the unknown.
        ['Tracing.start', { transferMode: 'ReportEvents' }],
        ['SystemInfo.getProcessInfo', {}],
        ['Memory.getBrowserSamplingProfile', {}],
        ['NotADomain.method', {}],
        ['nodot', {}],
        // Storage beyond this page's own partition (allow-listed per method).
        ['Storage.setStorageBucketTracking', { storageKey: 'http://x/', enable: true }],
        ['Storage.resetSharedStorageBudget', { ownerOrigin: 'http://x' }],
        ['Storage.setSharedStorageTracking', { enable: true }],
        ['Storage.setInterestGroupTracking', { enable: true }],
        ['Storage.getTrustTokens', {}],
        ['Storage.overrideQuotaForOrigin', { origin: 'http://x' }],
        ['Storage.setAttributionReportingLocalTestingMode', { enabled: true }],
        // Browser-reaching methods inside allowed domains.
        ['Network.clearBrowserCache', {}],
        ['Network.clearBrowserCookies', {}],
        ['Network.setCookieControls', { enableThirdPartyCookieRestriction: false }],
        ['Security.setIgnoreCertificateErrors', { ignore: true }],
      ] as [string, object][])
        await refusedBy(b.send(method, params, pb.sessionId));
      // Allowed with owned ids.
      await b.send('Browser.getVersion');
      await b.send('Storage.getCookies', { browserContextId: pb.browserContextId });
      await b.send('Storage.clearCookies', { browserContextId: pb.browserContextId });
      await b.send('Storage.setCookies', {
        cookies: [{ name: 'n', value: 'v', domain: 'x.test', path: '/' }],
        browserContextId: pb.browserContextId,
      });
      await b.send('Target.getTargetInfo', { targetId: pb.targetId });
      await b.send('Target.activateTarget', { targetId: pb.targetId });
      // Any domain on an owned page session.
      await b.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, pb.sessionId);
      await b.send('Fetch.disable', {}, pb.sessionId);
      a.close();
      b.close();
    }));

  it('malformed frames: before hello the socket is dropped, after hello they are ignored; the daemon lives', () =>
    withSupervisor(async ({ paths }) => {
      const a = (await connect(paths.socket)).c;
      const pa = await openPage(a);
      for (const frame of ['null', '[]', '"x"', '{}', '{bad']) {
        const r = await rawClient(paths.socket, false);
        r.write(frame);
        for (let i = 0; i < 40 && !r.isClosed(); i++) await sleep(25);
        expect(r.isClosed(), `pre-hello ${frame}`).toBe(true);
      }
      const b = await connect(paths.socket);
      for (const frame of [
        'null',
        '[]',
        '"x"',
        '{}',
        '{bad',
        '{"id":"x","method":"Browser.getVersion"}',
      ])
        b.sock.write(frame + '\0');
      expect((await b.c.send<{ product: string }>('Browser.getVersion')).product).toMatch(
        /HeadlessChrome/,
      );
      const r = await a.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: '6*7', returnByValue: true },
        pa.sessionId,
      );
      expect(r.result.value).toBe(42);
      a.close();
      b.c.close();
    }));

  it('an unterminated frame past the cap drops only that client', () =>
    withSupervisor(
      async ({ paths }) => {
        const a = (await connect(paths.socket)).c;
        const r = await rawClient(paths.socket);
        await sleep(50);
        r.sock.write(
          '{"id":1,"method":"Runtime.evaluate","params":{"expression":"' +
            'x'.repeat(2 * 1024 * 1024),
        );
        for (let i = 0; i < 80 && !r.isClosed(); i++) await sleep(25);
        expect(r.isClosed()).toBe(true);
        expect((await a.send<{ product: string }>('Browser.getVersion')).product).toMatch(
          /HeadlessChrome/,
        );
        a.close();
      },
      10,
      undefined,
      { maxFrameChars: 1024 * 1024 },
    ));

  it('a method from every domain the driver sends on a page session still passes', () =>
    withSupervisor(async ({ paths }) => {
      const a = (await connect(paths.socket)).c;
      const { sessionId } = await openPage(a);
      // grep of page.ts and capture/structure.ts: every page-session domain.
      for (const [method, params] of [
        ['Page.enable', {}],
        ['Runtime.enable', {}],
        ['Network.enable', {}],
        ['Log.enable', {}],
        ['Emulation.setFocusEmulationEnabled', { enabled: true }],
        [
          'Storage.clearDataForOrigin',
          { origin: 'http://127.0.0.1', storageTypes: 'all' },
        ],
        ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
        ['Fetch.disable', {}],
        // Page-scoped neighbours of the denied methods stay allowed.
        ['Storage.getUsageAndQuota', { origin: 'http://127.0.0.1' }],
        ['Network.getCookies', {}],
      ] as [string, object][])
        await a.send(method, params, sessionId);
      a.close();
    }));

  it('in-flight commands Chrome never answers are purged on detach and on drop', () =>
    withSupervisor(async ({ paths, sup }) => {
      const a = (await connect(paths.socket)).c;
      const pa = await openPage(a);
      expect(sup.inFlight).toBe(0);
      const hung = a.send('Runtime.evaluate', { expression: 'while(1){}' }, pa.sessionId);
      const settled = hung.then(
        () => 'resolved',
        (e: unknown) => (e as Error).message,
      );
      await sleep(100);
      expect(sup.inFlight).toBe(1);
      // The target dies; Chrome never answers the evaluate (PR #102 probe).
      await a.send('Target.disposeBrowserContext', {
        browserContextId: pa.browserContextId,
      });
      for (let i = 0; i < 40 && sup.inFlight > 0; i++) await sleep(50);
      expect(sup.inFlight).toBe(0);
      expect(await settled).toMatch(/detached before Chrome replied/);

      const b = await connect(paths.socket);
      const pb = await openPage(b.c);
      void b.c
        .send('Runtime.evaluate', { expression: 'while(1){}' }, pb.sessionId)
        .catch(() => {});
      await sleep(100);
      expect(sup.inFlight).toBe(1);
      // Chrome is stopped while b drops, so no detach event can purge the
      // entry: only dropClient can (removing that purge left inFlight at 1).
      process.kill(sup.chromePid, 'SIGSTOP');
      try {
        const gone = new Promise((r) => b.sock.once('close', r));
        b.sock.destroy();
        await gone;
        for (let i = 0; i < 40 && sup.inFlight > 0; i++) await sleep(25);
        expect(sup.inFlight).toBe(0);
      } finally {
        process.kill(sup.chromePid, 'SIGCONT');
      }
      a.close();
    }));

  it('idleMinutes past setTimeout’s range is clamped (no 1 ms exit); non-finite is refused', async () => {
    // Unclamped, 100,000 min overflowed setTimeout to 1 ms: the daemon was
    // gone before a client could connect.
    await withSupervisor(async ({ paths, sup }) => {
      await sleep(300);
      expect(sup.state.idleMinutes).toBe(35_000);
      const { c, outcome } = await connect(paths.socket);
      expect(outcome).toBe('ready');
      c.close();
    }, 100_000);
    for (const idleMinutes of [Number.NaN, Number.POSITIVE_INFINITY, 0])
      await withPaths(async (paths) => {
        await expect(
          startSupervisor({
            executablePath: chrome!.path,
            paths,
            key: 'test',
            idleMinutes,
          }),
        ).rejects.toThrow(/idleMinutes must be a positive number/);
      });
  });

  it('a page session clears its own origin (Storage.clearDataForOrigin) and a later page there sees empty storage', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><p>origin</p>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    try {
      await withSupervisor(async ({ paths }) => {
        const a = (await connect(paths.socket)).c;
        const evalIn = async <T>(sessionId: string, expression: string) =>
          (
            await a.send<{ result: { value: T } }>(
              'Runtime.evaluate',
              { expression, returnByValue: true },
              sessionId,
            )
          ).result.value;
        const loaded = async (sessionId: string) => {
          for (let i = 0; i < 100; i++) {
            const ok = await evalIn<boolean>(
              sessionId,
              `document.readyState === 'complete' && location.origin === ${JSON.stringify(origin)}`,
            );
            if (ok) return;
            await sleep(50);
          }
          throw new Error('page never loaded');
        };
        const first = await openPage(a);
        await a.send('Page.navigate', { url: `${origin}/` }, first.sessionId);
        await loaded(first.sessionId);
        await evalIn(first.sessionId, `localStorage.x = 'LEAKED'`);
        // jux's own between-page reset (page.ts clearOrigin): no context id,
        // it acts on this target's own context.
        await a.send(
          'Storage.clearDataForOrigin',
          { origin, storageTypes: 'all' },
          first.sessionId,
        );
        const { targetId } = await a.send<{ targetId: string }>('Target.createTarget', {
          url: `${origin}/`,
          browserContextId: first.browserContextId,
        });
        const { sessionId } = await a.send<{ sessionId: string }>(
          'Target.attachToTarget',
          { targetId, flatten: true },
        );
        await loaded(sessionId);
        expect(await evalIn<string | null>(sessionId, 'localStorage.getItem("x")')).toBe(
          null,
        );
        a.close();
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it('a real capture through the supervisor needs nothing refused and matches a fresh launch byte for byte', async () => {
    const pages: Record<string, string> = {
      '/one':
        '<!doctype html><body style="margin:0;font:16px sans-serif"><h1>One</h1><div style="width:120px;height:40px;border-radius:8px;background:#36c"></div><script>localStorage.x=1</script></body>',
      '/two':
        '<!doctype html><body style="margin:0"><p>Two</p><input value="typed"></body>',
      // Renders what /one left in localStorage. A fresh launch clears the
      // origin between pages, so this reads "x=undefined"; through the daemon
      // the page-session clearDataForOrigin was refused (and swallowed by
      // resetBetweenPages), so it rendered "x=1" and hashed differently.
      '/three':
        '<!doctype html><body style="margin:0;font:16px sans-serif"><p id=o></p><script>o.textContent="x="+localStorage.x</script></body>',
    };
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(pages[req.url ?? ''] ?? 'missing');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const urls = [`${base}/one`, `${base}/two`, `${base}/three`];
    const viewport = { width: 400, height: 300 };
    try {
      const fresh = await Browser.launch({ executablePath: chrome!.path });
      let freshHashes: string[];
      try {
        freshHashes = (await snapPages({ urls, viewport, browser: fresh })).pages.map(
          (p) => (p.snapshot ? sha256(p.snapshot.image) : `error: ${p.error}`),
        );
      } finally {
        await fresh.close();
      }
      await withSupervisor(async ({ paths }) => {
        for (let run = 0; run < 2; run++) {
          const { c, outcome } = await connect(paths.socket);
          expect(outcome).toBe('ready');
          // The driver swallows some failures (resetBetweenPages is best
          // effort), so a refusal would not surface as an error: record them.
          const refusals: string[] = [];
          const send = c.send.bind(c);
          c.send = ((...args: Parameters<typeof send>) =>
            send(...args).catch((e: unknown) => {
              if (e instanceof Error && /jux: .* refused/.test(e.message))
                refusals.push(e.message);
              throw e;
            })) as typeof c.send;
          const { product } = await c.send<{ product: string }>('Browser.getVersion');
          const browser = Browser.fromConnection(c, {
            version: product,
            close: async () => c.close(),
          });
          const ctx = await browser.newContext({ viewport });
          await ctx.clearCookies();
          await ctx.close();
          const warm = await snapPages({ urls, viewport, browser });
          expect(warm.pages.map((p) => p.error ?? null)).toEqual([null, null, null]);
          expect(refusals).toEqual([]);
          expect(warm.pages.map((p) => sha256(p.snapshot!.image))).toEqual(freshHashes);
          expect(freshHashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
          await browser.close();
        }
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const builtMain = path.join(here, '../../../dist/browser/daemon/supervisor-main.js');
const built = existsSync(builtMain);

describe.skipIf(!chrome)('supervisor-main (the detached process)', () => {
  it.runIf(!!process.env.CI)('CI has the built dist the process tests need', () => {
    expect(built, `missing ${builtMain}: run pnpm build before pnpm test`).toBe(true);
  });

  const start = (stateDir: string, key: string) =>
    spawn(
      process.execPath,
      [
        builtMain,
        JSON.stringify({
          executablePath: chrome!.path,
          args: [],
          stateDir,
          key,
          idleMinutes: 10,
        }),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  const exitOf = (child: ReturnType<typeof spawn>) =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
      child.once('exit', (code, signal) => r({ code, signal })),
    );
  const profileRoot = path.join(tmpdir(), `jux-${process.getuid!()}`);
  const profilesOf = async (pid: number) =>
    (await readdir(profileRoot).catch(() => [] as string[])).filter((n) =>
      n.startsWith(`jux-chrome-${pid}-`),
    );

  it.skipIf(!built)(
    'SIGTERM closes Chrome, removes its profile, clears the state and the socket; a second daemon exits 0',
    () =>
      withPaths(async (paths) => {
        const stateDir = path.dirname(paths.dir);
        const key = path.basename(paths.state, '.json');
        const child = start(stateDir, key);
        const exited = exitOf(child);
        try {
          let s = null;
          for (let i = 0; i < 100 && s?.pid !== child.pid; i++) {
            await sleep(50);
            s = await readState(paths);
          }
          expect(s?.pid).toBe(child.pid);
          const chromePid = Number(
            execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim(),
          );
          expect(pidAlive(chromePid)).toBe(true);
          expect(await profilesOf(child.pid!)).toHaveLength(1);
          const { c, outcome } = await connect(paths.socket);
          expect(outcome).toBe('ready');

          // Ruling 21: the loser of a start race leaves quietly.
          const loser = start(stateDir, key);
          expect(await exitOf(loser)).toEqual({ code: 0, signal: null });
          expect((await readState(paths))?.pid).toBe(child.pid);

          const dropped = closed(c);
          child.kill('SIGTERM');
          expect(await exited).toEqual({ code: 0, signal: null });
          await dropped;
          expect(pidAlive(chromePid)).toBe(false);
          expect(await profilesOf(child.pid!)).toHaveLength(0);
          expect(await readState(paths)).toBeNull();
          expect(await lstat(paths.socket).catch(() => null)).toBeNull();
        } finally {
          child.kill('SIGKILL');
        }
      }),
    20_000,
  );
});
