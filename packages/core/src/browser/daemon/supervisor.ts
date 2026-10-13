// packages/core/src/browser/daemon/supervisor.ts
//
// Owns the pipe to one chrome-headless-shell and multiplexes local clients
// onto it over a 0600 Unix socket in a private directory. Chrome stays alive
// with zero targets as long as this process holds the pipe (verified
// 2026-10-13: ten client connect/disconnect cycles against one browser, and
// the spike's warm captures hashed byte-identical to fresh ones).
//
// Clients share one browser, so the supervisor is also the isolation
// boundary between them:
// - ids: every client id is rewritten to one from the connection's single
//   allocator (preflight defect 9), so two clients' id 1 never collide with
//   each other or with the supervisor's own sends;
// - ownership: a client owns the contexts it created, the targets created in
//   them and the sessions attached to those (including child sessions
//   auto-attached under one of its sessions, defect 12). Commands naming
//   anything it does not own are refused; events go only to the owner;
// - cleanup: when a client's socket closes, the contexts it still owns are
//   disposed, which is what Chrome's disposeOnDetach would do had the client
//   held the pipe itself. A context the client disposed itself leaves its set
//   at the request (defect 12), so it is not disposed twice.

import net from 'node:net';
import { chmod, lstat, rm } from 'node:fs/promises';
import { CHROME_VERSION } from '../pins.js';
import { launchChrome, type LaunchedChrome } from '../launch.js';
import { NullFramer } from '../transport.js';
import type { RawMessage } from '../cdp.js';
import {
  clearState,
  ensureDaemonDirs,
  readState,
  recheckDaemonDirs,
  writeState,
  type DaemonPaths,
  type DaemonState,
} from './state.js';

/** A client that has not said hello by then is not a jux client. */
const HELLO_TIMEOUT_MS = 5_000;
/** How long a connect probe may take before the listener counts as alive (a full backlog). */
const PROBE_TIMEOUT_MS = 2_000;
/**
 * Frames queued for a client that stopped reading. A full-page screenshot is
 * tens of MB of base64; a client this far behind is wedged, and holding more
 * would let one stuck client exhaust the daemon every other client relies on.
 */
const MAX_BACKLOG_CHARS = 256 * 1024 * 1024;

/** Commands that act on the whole browser, i.e. on every client's targets. */
const BROWSER_WIDE = new Set([
  'Browser.close',
  'Browser.crash',
  'Browser.crashGpuProcess',
  'Target.attachToBrowserTarget',
  'Target.setRemoteLocations',
]);
/**
 * Browser-session state shared by every client: auto-attach with
 * waitForDebuggerOnStart would pause other clients' new targets, and
 * discovery is one switch for all. On a page session they are the client's own.
 */
const BROWSER_SESSION_ONLY = new Set([
  'Target.setAutoAttach',
  'Target.setDiscoverTargets',
]);

/**
 * Another daemon owns the socket (Ruling 21: the stale-lock reclaim race is
 * backstopped here). The loser has closed its own Chrome and touched none of
 * the winner's files; its process should exit 0 and the client connect to
 * the winner.
 */
export class SupervisorLostRace extends Error {
  constructor(
    /** The loser's Chrome, already closed; undefined when none was launched. */
    readonly chromePid?: number,
  ) {
    super('jux: another warm-browser daemon already serves this socket');
    this.name = 'SupervisorLostRace';
  }
}

interface Client {
  socket: net.Socket;
  framer: NullFramer;
  ready: boolean;
  gone: boolean;
  /** Contexts to dispose when the socket closes. */
  contexts: Set<string>;
  targets: Set<string>;
  sessions: Set<string>;
  blocked: boolean;
  backlog: string[];
  backlogChars: number;
  helloTimer: NodeJS.Timeout;
}

interface Owner {
  client: Client;
  clientId: number;
  method: string;
  params: Record<string, unknown>;
}

export interface Supervisor {
  state: DaemonState;
  chromePid: number;
  stop(): Promise<void>;
}

export interface SupervisorOptions {
  executablePath: string;
  args?: string[];
  paths: DaemonPaths;
  key: string;
  idleMinutes: number;
  /** Called once after any shutdown: idle, stop(), or Chrome exiting. */
  onExit?: () => void;
  /** Test seam: runs after the liveness probe, right before listen. */
  beforeListen?: () => Promise<void>;
}

type Params = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** True when something accepts connections on `socketPath`. */
async function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s = net.connect(socketPath);
    const done = (live: boolean) => {
      clearTimeout(timer);
      s.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(true), PROBE_TIMEOUT_MS);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function startSupervisor(opts: SupervisorOptions): Promise<Supervisor> {
  const { paths } = opts;
  const dirs = await ensureDaemonDirs(paths);
  // Cheap first check: a live daemon means there is nothing to launch.
  if (await socketIsLive(paths.socket)) throw new SupervisorLostRace();

  const chrome: LaunchedChrome = await launchChrome({
    executablePath: opts.executablePath,
    args: opts.args,
  });
  let product: string;
  try {
    ({ product } = await chrome.connection.send<{ product: string }>(
      'Browser.getVersion',
    ));
  } catch (e) {
    await chrome.close();
    throw e;
  }

  const clients = new Set<Client>();
  const owners = new Map<number, Owner>();
  const contextOwner = new Map<string, Client>();
  const targetOwner = new Map<string, Client>();
  const sessionOwner = new Map<string, Client>();
  let idleTimer: NodeJS.Timeout | null = null;
  let stopping: Promise<void> | null = null;
  let socketIno = -1;

  const claimTarget = (c: Client, targetId: string | undefined) => {
    if (!targetId || c.gone) return;
    targetOwner.set(targetId, c);
    c.targets.add(targetId);
  };
  const claimSession = (c: Client, sessionId: string | undefined) => {
    if (!sessionId || c.gone) return;
    sessionOwner.set(sessionId, c);
    c.sessions.add(sessionId);
  };
  const claimContext = (c: Client, id: string) => {
    contextOwner.set(id, c);
    c.contexts.add(id);
  };

  // Honors write() back-pressure: once the socket says stop, frames wait in
  // our queue (bounded) until 'drain' instead of piling into Node's buffer.
  const deliver = (c: Client, obj: object) => {
    if (c.socket.destroyed) return;
    const data = JSON.stringify(obj) + '\0';
    if (c.blocked) {
      c.backlog.push(data);
      c.backlogChars += data.length;
      if (c.backlogChars > MAX_BACKLOG_CHARS) c.socket.destroy();
      return;
    }
    c.blocked = !c.socket.write(data);
  };
  const flush = (c: Client) => {
    c.blocked = false;
    while (c.backlog.length > 0 && !c.blocked && !c.socket.destroyed) {
      const data = c.backlog.shift()!;
      c.backlogChars -= data.length;
      c.blocked = !c.socket.write(data);
    }
  };

  const disposeContext = (id: string) =>
    chrome.connection
      .send('Target.disposeBrowserContext', { browserContextId: id })
      .catch(() => {});

  const onReply = (m: RawMessage, o: Owner) => {
    const c = o.client;
    const result = (m.result ?? {}) as Params;
    if (!m.error) {
      if (o.method === 'Target.createBrowserContext') {
        const id = str(result['browserContextId']);
        // Created for a client that has since gone: nobody else will dispose it.
        if (id && c.gone) void disposeContext(id);
        else if (id) claimContext(c, id);
      } else if (o.method === 'Target.createTarget') {
        claimTarget(c, str(result['targetId']));
      } else if (o.method === 'Target.attachToTarget') {
        claimSession(c, str(result['sessionId']));
      } else if (
        o.method === 'Target.getTargets' &&
        Array.isArray(result['targetInfos'])
      ) {
        const mine = (result['targetInfos'] as Params[]).filter(
          (t) =>
            targetOwner.get(str(t['targetId']) ?? '') === c ||
            contextOwner.get(str(t['browserContextId']) ?? '') === c,
        );
        m = { ...m, result: { ...result, targetInfos: mine } };
      }
    } else if (o.method === 'Target.disposeBrowserContext' && !c.gone) {
      // The dispose failed, so the context still exists: dispose it on drop after all.
      const id = str(o.params['browserContextId']);
      if (id && contextOwner.get(id) === c) c.contexts.add(id);
    }
    deliver(c, { ...m, id: o.clientId });
  };

  /**
   * The client an event is about: the first id it names that someone owns.
   * `named` without an owner means it concerns a target nobody here owns
   * (a dropped client's), which no other client may see.
   */
  const attribute = (p: Params): { named: boolean; owner?: Client } => {
    const info = (p['targetInfo'] ?? {}) as Params;
    const refs: [Map<string, Client>, string | undefined][] = [
      [contextOwner, str(info['browserContextId'])],
      [targetOwner, str(info['targetId'])],
      [targetOwner, str(p['targetId'])],
      [contextOwner, str(p['browserContextId'])],
      [sessionOwner, str(p['sessionId'])],
    ];
    let named = false;
    for (const [map, id] of refs) {
      if (id === undefined) continue;
      named = true;
      const owner = map.get(id);
      if (owner) return { named, owner };
    }
    return { named };
  };

  const onEvent = (m: RawMessage & { method: string }) => {
    const p = (m.params ?? {}) as Params;
    const owner = m.sessionId ? sessionOwner.get(m.sessionId) : attribute(p).owner;
    if (!m.sessionId && !owner && !attribute(p).named) {
      // About no target at all: every client may hear it.
      for (const c of clients) if (c.ready) deliver(c, m);
      return;
    }
    if (!owner) return;
    if (m.method === 'Target.attachedToTarget' || m.method === 'Target.targetCreated') {
      // A child auto-attached under a client's session, or a target in its
      // context, belongs to that client.
      claimSession(
        owner,
        m.method === 'Target.attachedToTarget' ? str(p['sessionId']) : undefined,
      );
      claimTarget(owner, str(((p['targetInfo'] ?? {}) as Params)['targetId']));
    }
    deliver(owner, m);
    if (m.method === 'Target.detachedFromTarget') {
      const s = str(p['sessionId']);
      if (s && sessionOwner.get(s) === owner) {
        sessionOwner.delete(s);
        owner.sessions.delete(s);
      }
    } else if (m.method === 'Target.targetDestroyed') {
      const t = str(p['targetId']);
      if (t && targetOwner.get(t) === owner) {
        targetOwner.delete(t);
        owner.targets.delete(t);
      }
    }
  };

  chrome.connection.onRaw = (m: RawMessage) => {
    if (m.id !== undefined) {
      const o = owners.get(m.id);
      if (!o) return; // the supervisor's own send; CdpConnection resolves it
      owners.delete(m.id);
      onReply(m, o);
      return;
    }
    if (m.method) onEvent(m as RawMessage & { method: string });
  };

  /** Why `c` may not send this, or null. Every refusal names the thing it does not own. */
  const refusal = (c: Client, method: string, params: Params, sessionId?: string) => {
    const no = (what: string) => `jux: ${method} refused: ${what} is not this client's`;
    if (sessionId !== undefined && sessionOwner.get(sessionId) !== c)
      return no(`session ${sessionId}`);
    if (BROWSER_WIDE.has(method))
      return no('the browser (it is shared by every client of the warm-browser daemon)');
    if (sessionId === undefined) {
      if (BROWSER_SESSION_ONLY.has(method))
        return no(
          'the browser session (it is shared by every client of the warm-browser daemon)',
        );
      if (
        method === 'Target.createTarget' &&
        str(params['browserContextId']) === undefined
      )
        return no(
          'the default browser context; create one with Target.createBrowserContext',
        );
    }
    const refs: [string, Map<string, Client>][] = [
      ['targetId', targetOwner],
      ['browserContextId', contextOwner],
      ['sessionId', sessionOwner],
    ];
    for (const [key, map] of refs) {
      const id = str(params[key]);
      if (id !== undefined && map.get(id) !== c) return no(`${key} ${id}`);
    }
    return null;
  };

  const onFrame = (c: Client, frame: string) => {
    let m: RawMessage & { jux?: string; version?: string };
    try {
      m = JSON.parse(frame) as typeof m;
    } catch {
      return;
    }
    if (!c.ready) {
      clearTimeout(c.helloTimer);
      if (m.jux !== 'hello') {
        c.socket.destroy();
        return;
      }
      if (m.version !== CHROME_VERSION) {
        deliver(c, {
          method: 'jux.refused',
          params: { reason: `version ${String(m.version)} != ${CHROME_VERSION}` },
        });
        c.socket.end();
        return;
      }
      c.ready = true;
      deliver(c, { method: 'jux.ready', params: { product } });
      return;
    }
    if (typeof m.id !== 'number' || typeof m.method !== 'string') return;
    const params = (m.params ?? {}) as Params;
    const why = refusal(c, m.method, params, m.sessionId);
    if (why) {
      deliver(c, {
        id: m.id,
        error: { code: -32000, message: why },
        ...(m.sessionId ? { sessionId: m.sessionId } : {}),
      });
      return;
    }
    if (m.method === 'Target.disposeBrowserContext') {
      // The client is disposing it: do not dispose again on drop.
      c.contexts.delete(params['browserContextId'] as string);
    }
    const id = chrome.connection.allocateId();
    owners.set(id, { client: c, clientId: m.id, method: m.method, params });
    try {
      chrome.connection.sendRaw({
        id,
        method: m.method,
        params,
        ...(m.sessionId ? { sessionId: m.sessionId } : {}),
      });
    } catch (e) {
      owners.delete(id);
      deliver(c, {
        id: m.id,
        error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
      });
    }
  };

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (clients.size > 0 || stopping) return;
    idleTimer = setTimeout(() => void stop(), opts.idleMinutes * 60_000);
    idleTimer.unref();
  };

  const dropClient = async (c: Client) => {
    if (!clients.delete(c)) return;
    c.gone = true;
    clearTimeout(c.helloTimer);
    c.backlog = [];
    for (const s of c.sessions) if (sessionOwner.get(s) === c) sessionOwner.delete(s);
    for (const t of c.targets) if (targetOwner.get(t) === c) targetOwner.delete(t);
    for (const [id, owner] of contextOwner) if (owner === c) contextOwner.delete(id);
    scheduleIdle();
    if (!chrome.connection.closed) await Promise.all([...c.contexts].map(disposeContext));
  };

  const server = net.createServer((socket) => {
    const c: Client = {
      socket,
      framer: new NullFramer(),
      ready: false,
      gone: false,
      contexts: new Set(),
      targets: new Set(),
      sessions: new Set(),
      blocked: false,
      backlog: [],
      backlogChars: 0,
      helloTimer: setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS),
    };
    c.helloTimer.unref();
    if (stopping) {
      socket.destroy();
      return;
    }
    clients.add(c);
    scheduleIdle();
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => c.framer.push(chunk, (f) => onFrame(c, f)));
    socket.on('drain', () => flush(c));
    socket.on('close', () => void dropClient(c));
    socket.on('error', () => socket.destroy());
  });

  async function stop(): Promise<void> {
    return (stopping ??= (async () => {
      if (idleTimer) clearTimeout(idleTimer);
      for (const c of clients) c.socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      // Only our own files: a daemon that started after we stopped serving
      // may already have replaced them.
      const s = await readState(paths);
      if (s?.pid === process.pid && s.startedAt === state.startedAt)
        await clearState(paths);
      const st = await lstat(paths.socket).catch(() => null);
      if (st?.ino === socketIno) await rm(paths.socket, { force: true });
      await chrome.close();
      opts.onExit?.();
    })());
  }

  // Ruling 21 and defect 11: a crashed daemon leaves its socket file behind
  // (listen would fail with EADDRINUSE forever), but a live one owns it. Only
  // a socket nobody answers on is unlinked; a live one means we lost the race.
  const lose = async (): Promise<never> => {
    await chrome.close();
    throw new SupervisorLostRace(chrome.pid);
  };
  const abort = async (e: unknown): Promise<never> => {
    server.close();
    await chrome.close();
    throw e;
  };
  try {
    await recheckDaemonDirs(paths, dirs);
  } catch (e) {
    await abort(e);
  }
  if (await socketIsLive(paths.socket)) await lose();
  await rm(paths.socket, { force: true }).catch(abort);
  await opts.beforeListen?.();
  const listenError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    server.once('error', resolve);
    server.listen(paths.socket, () => resolve(null));
  });
  if (listenError?.code === 'EADDRINUSE') await lose();
  if (listenError) await abort(listenError);

  // The directory is 0700 already; 0600 on the socket is the second fence.
  try {
    await chmod(paths.socket, 0o600);
    const st = await lstat(paths.socket);
    const uid = process.getuid?.();
    if (
      !st.isSocket() ||
      (st.mode & 0o777) !== 0o600 ||
      (uid !== undefined && st.uid !== uid)
    )
      throw new Error(
        `jux: refusing to serve ${paths.socket}: not a private socket of ours.`,
      );
    socketIno = st.ino;
  } catch (e) {
    await abort(e);
  }
  server.on('error', () => void stop());

  const state: DaemonState = {
    pid: process.pid,
    socket: paths.socket,
    binary: opts.executablePath,
    version: CHROME_VERSION,
    key: opts.key,
    startedAt: new Date().toISOString(),
    idleMinutes: opts.idleMinutes,
  };
  try {
    await writeState(paths, state);
  } catch (e) {
    await stop();
    throw e;
  }

  chrome.connection.onClose = () => void stop();
  if (chrome.connection.closed) void stop();
  scheduleIdle();

  return { state, chromePid: chrome.pid, stop };
}
