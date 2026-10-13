// packages/core/src/browser/daemon/supervisor.ts
//
// Owns the pipe to one chrome-headless-shell and multiplexes local clients
// onto it over a 0600 Unix socket in a private directory. Chrome stays alive
// with zero targets as long as this process holds the pipe (verified
// 2026-10-13: ten client connect/disconnect cycles against one browser, and
// the spike's warm captures hashed byte-identical to fresh ones).
//
// Threat model: the socket is 0600 in a 0700 directory, so every client is
// the same uid. Isolation between clients is therefore not a privilege
// boundary (that user can ptrace Chrome anyway); it is a correctness
// guarantee: two concurrent jux runs sharing this browser must never affect
// each other's captures, by accident or by a stray command. It is still
// enforced strictly, as an allow-list, because "by accident" includes any
// future driver change.
//
// Clients share one browser, so the supervisor is the isolation boundary
// between them:
// - ids: every client id is rewritten to one from the connection's single
//   allocator (preflight defect 9), so two clients' id 1 never collide with
//   each other or with the supervisor's own sends;
// - ownership: a client owns the contexts it created, the targets created in
//   them and the sessions attached to those (including child sessions
//   auto-attached under one of its sessions, defect 12). On the shared
//   browser session only an allow-list of commands passes, each naming ids
//   the client owns; on its own page sessions only an allow-list of
//   target-scoped domains passes, plus the few Target/Browser commands that
//   stay within that page. Events go only to their owner; events about
//   nothing a client owns are dropped;
// - cleanup: when a client's socket closes, the contexts it still owns are
//   disposed, which is what Chrome's disposeOnDetach would do had the client
//   held the pipe itself. A context the client disposed itself leaves its set
//   at the request (defect 12), so it is not disposed twice.

import net from 'node:net';
import { chmod, lstat, rm, utimes } from 'node:fs/promises';
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

/**
 * The state file's mtime is a heartbeat. A SIGSTOPped or event-loop-blocked
 * daemon never idles out, and every client would pay a probe timeout forever;
 * a client replaces a daemon whose heartbeat is over 10 s old (client.ts).
 */
const HEARTBEAT_MS = 1_000;
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
/**
 * setTimeout takes at most 2^31-1 ms (about 35,791 minutes); past that Node
 * prints a TimeoutOverflowWarning to the detached daemon's invisible stderr
 * and fires after 1 ms, so JUX_BROWSER_IDLE_MINUTES=100000 ("keep it warm")
 * stopped the daemon the moment it started (PR #102 review).
 */
const MAX_IDLE_MINUTES = 35_000;

type IdKey = 'targetId' | 'browserContextId' | 'sessionId';
const ID_KEYS: readonly IdKey[] = ['targetId', 'browserContextId', 'sessionId'];

/**
 * Storage methods that take a browserContextId and, without one, act on the
 * shared default context (every other Storage method ignores the id and acts
 * on the session's own partition, or browser-wide). From any session they
 * need an owned context id.
 */
const COOKIE_METHODS = [
  'Storage.getCookies',
  'Storage.setCookies',
  'Storage.clearCookies',
];

/**
 * The browser session is shared by every client, so it takes only these
 * commands, each with the ids listed present and owned by the sender. Anything
 * else there (Fetch.enable, Tracing.start, Storage.* on the default context,
 * setDiscoverTargets, ...) would see or change other clients' pages. The driver
 * sends Browser.getVersion, Target.createBrowserContext/createTarget/
 * attachToTarget/closeTarget/disposeBrowserContext and Storage.clearCookies
 * here (browser.ts); the real-capture test proves none of them is refused.
 *
 * Storage is listed method by method, not as a prefix: with a decoy owned
 * browserContextId, a prefix rule passed clearDataForOrigin (acts on the
 * default partition) and setAttributionReportingLocalTestingMode (flips a
 * browser-wide mode), neither of which looks at the id (PR #102 review).
 */
const BROWSER_SESSION_ALLOW: Readonly<Record<string, readonly IdKey[]>> = {
  'Browser.getVersion': [],
  'Target.createBrowserContext': [],
  'Target.getBrowserContexts': [],
  'Target.getTargets': [], // reply filtered to the sender's targets
  'Target.disposeBrowserContext': ['browserContextId'],
  'Target.createTarget': ['browserContextId'],
  'Target.closeTarget': ['targetId'],
  'Target.attachToTarget': ['targetId'],
  'Target.detachFromTarget': [], // sessionId or targetId, checked below
  'Target.getTargetInfo': ['targetId'],
  'Target.activateTarget': ['targetId'],
  'Browser.getWindowForTarget': ['targetId'],
  'Browser.setDownloadBehavior': ['browserContextId'],
  'Browser.grantPermissions': ['browserContextId'],
  ...Object.fromEntries(COOKIE_METHODS.map((m) => [m, ['browserContextId'] as const])),
};

/**
 * Domains whose commands on a page session act on that page (or its own
 * context's partition) only. An allow-list, not a deny-list: some domains are
 * browser singletons whichever session sends them. Tracing.start on A's page
 * session made B's fail with "Tracing has already been started (possibly in
 * another tab)" and put B's renderer activity in A's trace (PR #102 review);
 * SystemInfo and Memory are the same kind. An unknown domain is refused until
 * someone checks which kind it is.
 *
 * The driver sends Page, Runtime, Network, Log, Emulation, Storage
 * (clearDataForOrigin) and DOMSnapshot on page sessions (page.ts,
 * capture/structure.ts); the rest are the standard target-scoped domains.
 *
 * Storage passes method by method (PAGE_SESSION_STORAGE); some methods
 * inside an allowed domain reach past the page (PAGE_SESSION_DENY).
 */
/**
 * Storage on a page session: only methods that act on this target's own
 * storage partition and origin. clearDataForOrigin is jux's own reset
 * (page.ts clearOrigin); refusing it (the PR #102 rule) silently broke
 * resetBetweenPages, so a page read localStorage the previous page wrote and
 * hashed 0bc8f889… through the daemon against 89456235… from a fresh launch.
 * Left out on purpose: trust tokens, interest groups, shared storage and
 * its budget, bucket tracking, bounce tracking, related website sets and
 * k-anonymity (browser- or profile-wide state), and overrideQuotaForOrigin
 * (not verified to stay in one partition). The cookie methods go by
 * COOKIE_METHODS instead. Method list from the pinned Chrome's /json/protocol.
 */
const PAGE_SESSION_STORAGE: ReadonlySet<string> = new Set([
  'Storage.getStorageKey',
  'Storage.getStorageKeyForFrame',
  'Storage.clearDataForOrigin',
  'Storage.clearDataForStorageKey',
  'Storage.getUsageAndQuota',
  'Storage.trackCacheStorageForOrigin',
  'Storage.trackCacheStorageForStorageKey',
  'Storage.trackIndexedDBForOrigin',
  'Storage.trackIndexedDBForStorageKey',
  'Storage.untrackCacheStorageForOrigin',
  'Storage.untrackCacheStorageForStorageKey',
  'Storage.untrackIndexedDBForOrigin',
  'Storage.untrackIndexedDBForStorageKey',
]);

/**
 * Methods of allowed page-session domains whose names or descriptions say
 * they reach past the page ("Clears browser cache", third-party cookie
 * controls, "whether all certificate errors should be ignored"). Found by
 * scanning the pinned Chrome's /json/protocol for those domains; refused
 * conservatively since jux never sends them and one client clearing the
 * cache or flipping cookie policy would change another's next load.
 */
const PAGE_SESSION_DENY: ReadonlySet<string> = new Set([
  'Network.clearBrowserCache',
  'Network.clearBrowserCookies',
  'Network.setCookieControls',
  'Security.setIgnoreCertificateErrors',
]);

const PAGE_SESSION_DOMAINS: ReadonlySet<string> = new Set([
  'Accessibility',
  'Animation',
  'Audits',
  'CacheStorage',
  'Console',
  'CSS',
  'Debugger',
  'DOM',
  'DOMDebugger',
  'DOMSnapshot',
  'DOMStorage',
  'Emulation',
  'Fetch',
  'HeapProfiler',
  'IndexedDB',
  'Input',
  'Inspector',
  'IO',
  'LayerTree',
  'Log',
  'Network',
  'Overlay',
  'Page',
  'Performance',
  'Profiler',
  'Runtime',
  'Security',
  'Storage',
]);

/**
 * Target.* and Browser.* reach the browser from any session (setDiscoverTargets
 * there reports every target; Browser.close closes the browser), so on a page
 * session they pass only from this list, with owned ids as above.
 */
const PAGE_SESSION_ALLOW: Readonly<Record<string, readonly IdKey[]>> = {
  'Browser.getVersion': [],
  'Target.setAutoAttach': [], // children of this page only
  'Target.autoAttachRelated': ['targetId'],
  'Target.getTargets': [],
  'Target.getTargetInfo': [],
  'Target.createTarget': ['browserContextId'],
  'Target.closeTarget': ['targetId'],
  'Target.attachToTarget': ['targetId'],
  'Target.detachFromTarget': [],
  'Target.activateTarget': ['targetId'],
};

/** What an unlisted command would reach, for the refusal message. */
const browserWideWhy = (method: string) =>
  method.startsWith('Storage.')
    ? 'the default browser context'
    : 'the browser session (it is shared by every client of the warm-browser daemon)';

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
  /**
   * Only what onReply needs: the full params (a multi-MB evaluate source)
   * stayed in `owners` forever when Chrome never answered.
   */
  browserContextId?: string;
  /** The session the command went out on, so its detach can purge it. */
  sessionId?: string;
}

export interface Supervisor {
  state: DaemonState;
  chromePid: number;
  stop(): Promise<void>;
  /** Proxied commands still awaiting Chrome's reply; a leak test's yardstick. */
  readonly inFlight: number;
  /** Test seam: every context in the browser, unfiltered by owner. */
  browserContextIds(): Promise<string[]>;
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
  /** Largest frame a client may send; default MAX_BACKLOG_CHARS. Test seam. */
  maxFrameChars?: number;
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
  if (!Number.isFinite(opts.idleMinutes) || opts.idleMinutes <= 0)
    throw new Error(
      `jux: idleMinutes must be a positive number, got ${opts.idleMinutes}`,
    );
  const idleMinutes = Math.min(opts.idleMinutes, MAX_IDLE_MINUTES);
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
  // Assigned once serving; stop() may run before that (a failed writeState).
  let heartbeat: NodeJS.Timeout | undefined = undefined;
  let stopping: Promise<void> | null = null;
  let socketIno = -1;

  const claimTarget = (c: Client, targetId: string | undefined) => {
    if (!targetId || c.gone) return;
    // Never re-assign a target: ownership comes from creating it (fix round 1:
    // a discovery event on B's session must not hand B A's target).
    if (targetOwner.has(targetId) && targetOwner.get(targetId) !== c) return;
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
      } else if (
        o.method === 'Target.getBrowserContexts' &&
        Array.isArray(result['browserContextIds'])
      ) {
        // Same as getTargets: another client's context ids are not this one's
        // to see. The default context is nobody's, so its id goes too.
        const mine = (result['browserContextIds'] as unknown[]).filter(
          (id) => contextOwner.get(str(id) ?? '') === c,
        );
        const rest: Params = { ...result, browserContextIds: mine };
        delete rest['defaultBrowserContextId'];
        m = { ...m, result: rest };
      }
    } else if (o.method === 'Target.disposeBrowserContext' && !c.gone) {
      // The dispose failed, so the context still exists: dispose it on drop after all.
      const id = o.browserContextId;
      if (id && contextOwner.get(id) === c) c.contexts.add(id);
    }
    deliver(c, { ...m, id: o.clientId });
  };

  /**
   * The client a browser-session Target.* event is about: the target's
   * context when the event carries one (no fallback: a context nobody owns
   * means nobody may hear it), else the session or target it names.
   */
  const ownerOfBrowserEvent = (p: Params): Client | undefined => {
    const ctx = str(((p['targetInfo'] ?? {}) as Params)['browserContextId']);
    if (ctx !== undefined) return contextOwner.get(ctx);
    const session = str(p['sessionId']);
    if (session !== undefined) return sessionOwner.get(session);
    const target = str(p['targetId']);
    if (target !== undefined) return targetOwner.get(target);
    const context = str(p['browserContextId']);
    return context === undefined ? undefined : contextOwner.get(context);
  };

  /**
   * Chrome never answers a command in flight on a session whose target died
   * (probe: Runtime.evaluate 'while(1){}', then dispose the context). Its
   * owner entry would stay forever, one per hung story, in a daemon that
   * lives for hours, so the entry goes. Nothing is answered in Chrome's
   * place: a synthetic error reply reached the client before the detach
   * event, so the page saw CdpError where a fresh launch gives
   * TargetClosedError, and the pool, which rebuilds a worker only on
   * TargetClosedError or PageCrashedError, failed the next story on that
   * worker too (PR #102 re-review N1). The client's own detach handling
   * rejects page work; any other sender times out, as against a fresh Chrome.
   */
  const purgeSession = (sessionId: string) => {
    for (const [id, o] of owners) if (o.sessionId === sessionId) owners.delete(id);
  };

  const onEvent = (m: RawMessage & { method: string }) => {
    const p = (m.params ?? {}) as Params;
    // Before any owner check: entries of a client that is gone are purged
    // too (dropClient does that as well, but this covers a late detach).
    if (m.method === 'Target.detachedFromTarget') {
      const s = str(p['sessionId']);
      if (s !== undefined) purgeSession(s);
    }
    let owner: Client | undefined;
    if (m.sessionId !== undefined) owner = sessionOwner.get(m.sessionId);
    // Browser-session events: only Target.* ones about a client's own
    // targets. Nothing else there is any one client's to hear.
    else if (m.method.startsWith('Target.')) owner = ownerOfBrowserEvent(p);
    if (!owner) return;
    const info = (p['targetInfo'] ?? {}) as Params;
    const infoCtx = str(info['browserContextId']);
    // A target event on the owner's session about a target in someone else's
    // context is not the owner's to hear (defense in depth: discovery is refused).
    if (infoCtx !== undefined && contextOwner.get(infoCtx) !== owner) return;
    const infoTarget = str(info['targetId']);
    if (m.method === 'Target.attachedToTarget') {
      // A child auto-attached under the owner's session, or a target in its context.
      const held = infoTarget === undefined ? undefined : targetOwner.get(infoTarget);
      if (held && held !== owner) return;
      claimSession(owner, str(p['sessionId']));
      if (infoCtx !== undefined) claimTarget(owner, infoTarget);
    } else if (m.method === 'Target.targetCreated' && infoCtx !== undefined) {
      claimTarget(owner, infoTarget);
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
    const byKey: Record<IdKey, Map<string, Client>> = {
      targetId: targetOwner,
      browserContextId: contextOwner,
      sessionId: sessionOwner,
    };
    let required: readonly IdKey[] | undefined;
    if (sessionId === undefined) {
      required = BROWSER_SESSION_ALLOW[method];
      if (!required) return no(browserWideWhy(method));
    } else {
      if (sessionOwner.get(sessionId) !== c) return no(`session ${sessionId}`);
      const domain = method.slice(0, Math.max(0, method.indexOf('.')));
      if (domain === 'Target' || domain === 'Browser') {
        required = PAGE_SESSION_ALLOW[method];
        if (!required) return no(browserWideWhy(method));
      } else if (COOKIE_METHODS.includes(method)) {
        required = ['browserContextId'];
      } else if (
        domain === 'Storage'
          ? PAGE_SESSION_STORAGE.has(method)
          : PAGE_SESSION_DOMAINS.has(domain) && !PAGE_SESSION_DENY.has(method)
      ) {
        required = [];
      } else return no(`the browser (${domain || method} is not scoped to one page)`);
    }
    if (method === 'Target.createTarget' && params['browserContextId'] === undefined)
      return `${no('the default browser context')}; create one with Target.createBrowserContext`;
    if (
      method === 'Target.detachFromTarget' &&
      params['sessionId'] === undefined &&
      params['targetId'] === undefined
    )
      return no('an unnamed session');
    for (const key of required)
      if (params[key] === undefined)
        return no(
          key === 'browserContextId'
            ? 'the default browser context'
            : `an unnamed ${key}`,
        );
    // Every id a command names, required or not, must be an owned string.
    for (const key of ID_KEYS) {
      if (!(key in params)) continue;
      const id = params[key];
      if (typeof id !== 'string' || byKey[key].get(id) !== c)
        return no(`${key} ${JSON.stringify(id)}`);
    }
    return null;
  };

  const onFrame = (c: Client, frame: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      parsed = undefined;
    }
    // `null`, arrays and scalars parse fine and crashed the daemon on a
    // property read (fix round 1): only plain objects get past here.
    const m =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Params)
        : null;
    if (!c.ready) {
      clearTimeout(c.helloTimer);
      if (m?.['jux'] !== 'hello') {
        c.socket.destroy();
        return;
      }
      if (m['version'] !== CHROME_VERSION) {
        deliver(c, {
          method: 'jux.refused',
          params: { reason: `version ${String(m['version'])} != ${CHROME_VERSION}` },
        });
        c.socket.end();
        return;
      }
      c.ready = true;
      deliver(c, { method: 'jux.ready', params: { product } });
      return;
    }
    // After hello a frame without a usable id has nobody to answer: ignore it.
    const clientId = m?.['id'];
    if (!m || typeof clientId !== 'number' || !Number.isSafeInteger(clientId)) return;
    const method = m['method'];
    const sessionId = m['sessionId'];
    const rawParams = m['params'] ?? {};
    const fail = (message: string) =>
      deliver(c, {
        id: clientId,
        error: { code: -32000, message },
        ...(typeof sessionId === 'string' ? { sessionId } : {}),
      });
    if (
      typeof method !== 'string' ||
      (sessionId !== undefined && typeof sessionId !== 'string') ||
      typeof rawParams !== 'object' ||
      rawParams === null ||
      Array.isArray(rawParams)
    ) {
      fail(
        'jux: malformed command: needs a string method, an object params and a string sessionId if any',
      );
      return;
    }
    const params = rawParams as Params;
    const why = refusal(c, method, params, sessionId);
    if (why) {
      fail(why);
      return;
    }
    if (method === 'Target.disposeBrowserContext') {
      // The client is disposing it: do not dispose again on drop.
      const ctx = str(params['browserContextId']);
      if (ctx !== undefined) c.contexts.delete(ctx);
    }
    const id = chrome.connection.allocateId();
    owners.set(id, {
      client: c,
      clientId,
      method,
      ...(method === 'Target.disposeBrowserContext'
        ? { browserContextId: str(params['browserContextId']) }
        : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    try {
      chrome.connection.sendRaw({
        id,
        method,
        params,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    } catch (e) {
      owners.delete(id);
      fail(e instanceof Error ? e.message : String(e));
    }
  };

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (clients.size > 0 || stopping) return;
    idleTimer = setTimeout(() => void stop(), idleMinutes * 60_000);
    idleTimer.unref();
  };

  const dropClient = async (c: Client) => {
    if (!clients.delete(c)) return;
    c.gone = true;
    clearTimeout(c.helloTimer);
    c.backlog = [];
    // Chrome may never answer this client's in-flight commands (its contexts
    // are about to be disposed); nobody is left to hear them anyway.
    for (const [id, o] of owners) if (o.client === c) owners.delete(id);
    for (const s of c.sessions) if (sessionOwner.get(s) === c) sessionOwner.delete(s);
    for (const t of c.targets) if (targetOwner.get(t) === c) targetOwner.delete(t);
    for (const [id, owner] of contextOwner) if (owner === c) contextOwner.delete(id);
    scheduleIdle();
    if (!chrome.connection.closed) await Promise.all([...c.contexts].map(disposeContext));
  };

  const server = net.createServer((socket) => {
    const c: Client = {
      socket,
      framer: new NullFramer(opts.maxFrameChars ?? MAX_BACKLOG_CHARS),
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
    socket.on('data', (chunk: Buffer) => {
      // A frame past the cap (FrameTooLargeError) or any bug in handling
      // one client's frame costs that client its connection, never the
      // daemon every other client shares.
      try {
        c.framer.push(chunk, (f) => onFrame(c, f));
      } catch {
        socket.destroy();
      }
    });
    socket.on('drain', () => flush(c));
    socket.on('close', () => void dropClient(c));
    socket.on('error', () => socket.destroy());
  });

  async function stop(): Promise<void> {
    return (stopping ??= (async () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearInterval(heartbeat);
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
  await recheckDaemonDirs(paths, dirs).catch(abort);
  if (await socketIsLive(paths.socket)) await lose();
  await rm(paths.socket, { force: true }).catch(abort);
  await opts.beforeListen?.();
  // Directly before listen: the directory we verified is still the one we bind in.
  await recheckDaemonDirs(paths, dirs).catch(abort);
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
    idleMinutes,
  };
  try {
    await writeState(paths, state);
  } catch (e) {
    await stop();
    throw e;
  }

  // Only our own file: a daemon that replaced us owns its heartbeat.
  heartbeat = setInterval(() => {
    void readState(paths).then(async (s) => {
      if (s?.pid !== process.pid || s.startedAt !== state.startedAt) return;
      const now = new Date();
      await utimes(paths.state, now, now).catch(() => {});
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  chrome.connection.onClose = () => void stop();
  if (chrome.connection.closed) void stop();
  scheduleIdle();

  return {
    state,
    chromePid: chrome.pid,
    stop,
    get inFlight() {
      return owners.size;
    },
    browserContextIds: async () =>
      (
        await chrome.connection.send<{ browserContextIds: string[] }>(
          'Target.getBrowserContexts',
        )
      ).browserContextIds,
  };
}
