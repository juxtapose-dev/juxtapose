// packages/core/src/browser/cdp.ts
//
// The whole protocol client: ids out, replies back, events routed by
// sessionId. Playwright's CRConnection does the same in ~300 lines plus
// the parts we never use.
//
// Every send has a Node-side timeout. Chrome answers Runtime.evaluate only
// when the script returns, so a story with a synchronous infinite loop would
// otherwise hang the worker and the run.

import type { Transport } from './transport.js';

export interface RawMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  sessionId?: string;
}

export const SEND_TIMEOUT_MS = 30_000;

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

type Handler = (params: unknown, sessionId?: string) => void;

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

  send<T = unknown>(
    method: string,
    params: object = {},
    sessionId?: string,
    opts: { timeout?: number } = {},
  ): Promise<T> {
    if (this._closed)
      return Promise.reject(new TargetClosedError(this.closeReason, method));
    const id = this.allocateId();
    const timeout = opts.timeout ?? SEND_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SendTimeoutError(method, timeout));
      }, timeout);
      timer.unref();
      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        this.sendRaw(
          sessionId ? { id, method, params, sessionId } : { id, method, params },
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  on(method: string, handler: Handler, sessionId?: string): () => void {
    const key = `${sessionId ?? ''}\n${method}`;
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
  once<P = unknown>(
    method: string,
    sessionId?: string,
    predicate: (p: P) => boolean = () => true,
  ): Promise<P> {
    if (this._closed)
      return Promise.reject(new TargetClosedError(this.closeReason, method));
    return new Promise<P>((resolve, reject) => {
      const onClosed = (e: Error) => {
        off();
        reject(e);
      };
      const off = this.on(
        method,
        (params) => {
          if (!predicate(params as P)) return;
          off();
          this.closeWaiters.delete(onClosed);
          resolve(params as P);
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
    let m: RawMessage;
    try {
      m = JSON.parse(raw) as RawMessage;
    } catch {
      return; // Chrome never sends non-JSON frames; nothing to do but ignore.
    }
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
        h(m.params, m.sessionId);
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
