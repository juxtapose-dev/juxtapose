// packages/core/src/browser/cdp.ts
//
// The whole protocol client: ids out, replies back, events routed by
// sessionId. Playwright's CRConnection does the same in ~300 lines plus
// the parts we never use.
//
// Every send has a Node-side timeout. Chrome answers Runtime.evaluate only
// when the script returns, so a story with a synchronous infinite loop would
// otherwise hang the worker and the run.

import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import { isRecord } from './guards.js';
import type { Transport } from './transport.js';

export interface RawMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  sessionId?: string;
}

/**
 * A parsed frame with the shape RawMessage promises. Only the envelope is
 * checked; params and result stay `unknown` here and get their protocol types
 * from `send` and `on`. Unknown keys are kept: the supervisor forwards frames
 * as they came.
 */
export function isRawMessage(v: unknown): v is RawMessage {
  if (!isRecord(v)) return false;
  const { id, method, sessionId, error } = v;
  return (
    (id === undefined || typeof id === 'number') &&
    (method === undefined || typeof method === 'string') &&
    (sessionId === undefined || typeof sessionId === 'string') &&
    (error === undefined ||
      (isRecord(error) &&
        typeof error['code'] === 'number' &&
        typeof error['message'] === 'string'))
  );
}

type Commands = ProtocolMapping.Commands;

/** Every command Chrome's protocol defines, as of the pinned devtools-protocol. */
export type CdpMethod = keyof Commands;
export type CdpParams<M extends CdpMethod> = Commands[M]['paramsType'][0];
export type CdpResult<M extends CdpMethod> = Commands[M]['returnType'];

/**
 * The warm-browser daemon's own events, sent by the supervisor on the same
 * socket as Chrome's (supervisor.ts, the hello handshake).
 */
export interface JuxEvents {
  'jux.ready': [{ product: string }];
  'jux.refused': [{ reason?: string }];
}

type Events = ProtocolMapping.Events & JuxEvents;
export type CdpEvent = keyof Events;
/** An event's params; `undefined` for the events that carry none (Inspector.targetCrashed). */
export type CdpEventParams<E extends CdpEvent> = Events[E] extends [infer P]
  ? P
  : undefined;

export const SEND_TIMEOUT_MS = 30_000;
/** JSON-RPC's "internal error": what a reply that fails isRawMessage rejects with. */
export const MALFORMED_REPLY_CODE = -32603;

export class CdpError extends Error {
  constructor(
    public readonly code: number,
    method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
  }
}

export class TargetClosedError extends Error {
  constructor(reason = 'browser closed', method?: string) {
    super(
      `jux: browser connection closed (${reason})${method ? ` while waiting for ${method}` : ''}`,
    );
    this.name = 'TargetClosedError';
  }
}

export class SendTimeoutError extends Error {
  constructor(method: string, timeout: number) {
    super(`jux: ${method} got no reply from the browser within ${timeout} ms`);
    this.name = 'SendTimeoutError';
  }
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A stored handler. `never` params: every typed handler is assignable to it,
 * and dispatch is the one caller (through asProtocol).
 *
 * send, on and once each have a typed overload (a protocol method or event,
 * inferred) and an untyped fallback (any string, the caller's `<T>`): the
 * fallback keeps methods newer than the pinned protocol, the daemon's own
 * events, and adapters written against 0.7's `send<T>(method: string)`
 * compiling. A typed name with an explicit `<T>` takes the fallback too.
 */
type Handler = (params: never, sessionId?: string) => void;

/**
 * The one place a reply or event gets its protocol type: the peer is Chrome
 * (or the supervisor proxying it), trusted to speak the protocol it
 * advertises, exactly as Playwright and Puppeteer trust it. Validating every
 * frame against the protocol schema would cost the hot path (a 2 MB
 * screenshot reply per story) for a peer we launched ourselves.
 */
const asProtocol = <T>(v: unknown): T => v as T;

export class CdpConnection {
  private lastId = 0;
  private readonly pending = new Map<number, Pending>();
  /** key = `${sessionId ?? ''}\n${method}` */
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly closeWaiters = new Set<(e: Error) => void>();
  private _closed = false;
  private closeReason: string | undefined;
  onClose: ((reason?: string) => void) | null = null;
  /** Every parsed frame, before routing. The PR 2 supervisor proxies from here. */
  onRaw: ((m: RawMessage) => void) | null = null;
  /**
   * A throwing event handler or onRaw must not escape into the stream's data
   * event (an uncaught exception would kill the daemon) nor skip the rest of
   * the chunk. Default: one line on stderr.
   */
  onError: (error: unknown, where: 'handler' | 'onRaw') => void = (error, where) => {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`jux: ${where} threw: ${msg}\n`);
  };

  constructor(private readonly transport: Transport) {
    transport.onMessage = (m) => this.dispatch(m);
    transport.onClose = (reason) => this.handleClose(reason);
  }

  get closed(): boolean {
    return this._closed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Number of distinct (session, method) handler keys; empty sets are pruned. */
  get handlerKeyCount(): number {
    return this.handlers.size;
  }

  /** Total registered handlers, summed over every key; a leak test's yardstick. */
  get handlerCount(): number {
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }

  /**
   * Call `listener` once when the connection closes (at once if it already
   * has); returns the unsubscribe. Pages use it to fail in-flight work fast
   * instead of waiting out each send's timeout.
   */
  onClosed(listener: (e: Error) => void): () => void {
    if (this._closed) {
      listener(new TargetClosedError(this.closeReason));
      return () => {};
    }
    this.closeWaiters.add(listener);
    return () => this.closeWaiters.delete(listener);
  }

  allocateId(): number {
    return ++this.lastId;
  }

  /**
   * Throws TargetClosedError once the connection is closed, so a proxying
   * caller (the PR 2 supervisor) learns its client message was not delivered
   * instead of waiting for a reply that cannot come.
   */
  sendRaw(message: RawMessage & { id: number; method: string }): void {
    if (this._closed) throw new TargetClosedError(this.closeReason, message.method);
    this.transport.send(JSON.stringify(message));
  }

  /** Params default to `{}`, as Chrome expects for a command that takes none. */
  send<M extends CdpMethod>(
    method: M,
    params?: CdpParams<M>,
    sessionId?: string,
    opts?: { timeout?: number },
  ): Promise<CdpResult<M>>;
  send<T = unknown>(
    method: string,
    params?: object,
    sessionId?: string,
    opts?: { timeout?: number },
  ): Promise<T>;
  send(
    method: string,
    params?: object,
    sessionId?: string,
    opts: { timeout?: number } = {},
  ): Promise<unknown> {
    if (this._closed)
      return Promise.reject(new TargetClosedError(this.closeReason, method));
    const id = this.allocateId();
    const timeout = opts.timeout ?? SEND_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SendTimeoutError(method, timeout));
      }, timeout);
      timer.unref();
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      });
      try {
        const p = params ?? {};
        this.sendRaw(
          sessionId ? { id, method, params: p, sessionId } : { id, method, params: p },
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  on<E extends CdpEvent>(
    event: E,
    handler: (params: CdpEventParams<E>, sessionId?: string) => void,
    sessionId?: string,
  ): () => void;
  on(
    event: string,
    handler: (params: unknown, sessionId?: string) => void,
    sessionId?: string,
  ): () => void;
  on(event: string, handler: Handler, sessionId?: string): () => void {
    const key = `${sessionId ?? ''}\n${event}`;
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0 && this.handlers.get(key) === set) this.handlers.delete(key);
    };
  }

  /**
   * Without a sessionId this listens on the browser session only, where
   * session-scoped events never arrive; pass the page's sessionId for page
   * events.
   */
  once<E extends CdpEvent>(
    event: E,
    sessionId?: string,
    predicate?: (p: CdpEventParams<E>) => boolean,
  ): Promise<CdpEventParams<E>>;
  once<P = unknown>(
    event: string,
    sessionId?: string,
    predicate?: (p: P) => boolean,
  ): Promise<P>;
  once(
    event: string,
    sessionId?: string,
    predicate: (p: never) => boolean = () => true,
  ): Promise<unknown> {
    if (this._closed)
      return Promise.reject(new TargetClosedError(this.closeReason, event));
    return new Promise<unknown>((resolve, reject) => {
      const onClosed = (e: Error) => {
        off();
        reject(e);
      };
      const off = this.on(
        event,
        (params) => {
          if (!predicate(asProtocol<never>(params))) return;
          off();
          this.closeWaiters.delete(onClosed);
          resolve(params);
        },
        sessionId,
      );
      this.closeWaiters.add(onClosed);
    });
  }

  close(): void {
    this.transport.close();
  }

  private dispatch(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Chrome never sends non-JSON frames; nothing to do but ignore.
    }
    // Nor frames that are not a message object. A `null` frame used to throw
    // here, out of the transport's data event. A malformed reply to one of our
    // own sends still answers it, as an error, rather than leaving it to time
    // out.
    if (!isRawMessage(parsed)) {
      const id = isRecord(parsed) ? parsed['id'] : undefined;
      const p = typeof id === 'number' ? this.pending.get(id) : undefined;
      if (typeof id === 'number' && p) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(
          new CdpError(
            MALFORMED_REPLY_CODE,
            p.method,
            'malformed reply from the browser',
          ),
        );
      }
      return;
    }
    const m = parsed;
    try {
      this.onRaw?.(m);
    } catch (e) {
      this.onError(e, 'onRaw');
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return; // a raw (proxied) id, or a reply after its timeout
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new CdpError(m.error.code, p.method, m.error.message));
      else p.resolve(m.result);
      return;
    }
    if (m.method) {
      const set = this.handlers.get(`${m.sessionId ?? ''}\n${m.method}`);
      if (set) this.runHandlers(set, m);
      // Session-less listeners see every event (the browser session's Target.* events).
      if (m.sessionId) {
        const all = this.handlers.get(`\n${m.method}`);
        if (all) this.runHandlers(all, m);
      }
    }
  }

  private runHandlers(set: Set<Handler>, m: RawMessage): void {
    for (const h of [...set]) {
      try {
        h(asProtocol<never>(m.params), m.sessionId);
      } catch (e) {
        this.onError(e, 'handler');
      }
    }
  }

  private handleClose(reason?: string): void {
    if (this._closed) return;
    this._closed = true;
    this.closeReason = reason;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new TargetClosedError(reason, p.method));
    }
    this.pending.clear();
    const err = new TargetClosedError(reason);
    for (const w of [...this.closeWaiters]) w(err);
    this.closeWaiters.clear();
    this.onClose?.(reason);
  }
}
