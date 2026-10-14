// Event-driven settle: wait as long as the page still has work, not a fixed
// quiet window.
//
// Replaces the 150 ms DOM-quiet window (capped at 500 ms) that ran on every
// story. Measured in the settle spike (raw CDP replica of this pipeline, 5
// runs per story, chrome-headless-shell 151.0.7922.34): byte-identical to the
// quiet window on 29/29 example stories (Storybook 15, Ladle 14), stable 5/5,
// settle p50 168 -> 39 ms (Storybook) and 162 -> 34 ms (Ladle). On adversarial
// pages it captures the final state of setTimeout(300) and (800) and of a
// fetch resolving after 200 ms, all of which the quiet window captured
// mid-update (0/5), and it does not hang on a lazy image below the fold,
// where the old uncapped image wait in `drain` never returned.
//
// Shipped, through the CLI (2026-10-13, Apple M5 Pro, 15 cores, load average
// 15-18, median of 5, interleaved with main): `jux run --all` on the
// Storybook example 1339 -> 653 ms (story p50 203 -> 75 ms), Ladle 1127 ->
// 603 ms (208 -> 80 ms); a warm `jux snap` of one story 356 -> 209 ms. Every
// default and variant capture (Storybook 18, Ladle 16) byte-identical to
// baselines approved by the quiet-window build, fresh launch and daemon.
//
// Two halves. An init script, installed before any page script runs, counts
// the page's own pending work: short timers, animation frames, posted
// messages, DOM mutations, loading fonts and loading in-viewport images. CDP
// Network events count in-flight requests, which the page cannot see for
// itself (a fetch started before any wrapper could be installed, a <link>
// stylesheet, an image the parser started). Idle is both at zero, re-checked
// once more after a round trip because renderer and browser events are not
// ordered against each other.
//
// Never throws: a wait that hits its cap is reported, and the page is captured
// as it is. A slow story must produce a reviewable result, not abort a run.

import type { Page } from '../browser/page.js';
import { matchPattern, type ResolvedSettle } from './settle-options.js';

/** What the page reported at its last check. */
export interface IdleSnapshot {
  timers: number;
  rafs: number;
  /** Posted messages sent and not yet delivered. */
  msgs: number;
  delivered: number;
  /** Workers created within the horizon that have not answered yet. */
  workers: number;
  workerSrcs: string[];
  mut: number;
  fonts: string;
  images: number;
  /** The first few incomplete images, for the pending description. */
  imageSrcs: string[];
  ready: boolean;
  /** The last check saw the DOM change. */
  changing?: boolean;
}

export interface IdleResult {
  /** `fallback`: the detector could not run (not installed, or the page
   *  navigated mid-wait), so a fonts/images/quiet-DOM wait stood in. */
  status: 'idle' | 'timeout' | 'fallback';
  waitedMs: number;
  snap?: IdleSnapshot;
  /** Set on `timeout` (what was still pending) and `fallback` (why).
   *  Never empty. */
  pending?: string[];
}

/**
 * Runs before any page script (Page.addScriptToEvaluateOnNewDocument), so the
 * wrappers are in place before a framework captures the natives. A library
 * that re-patches them later (zone.js, Sentry) is still tracked as long as it
 * calls through, which they do.
 *
 * String timer handlers pass straight through, untracked: wrapping them would
 * need eval, which a page's CSP may forbid.
 */
const IDLE_INIT = `(function () {
  if (window.__juxIdle) return;
  var W = window;
  var S = { timers: new Map(), rafs: new Set(), sent: 0, delivered: 0, workers: new Map(), mut: 0, ready: false };
  var oST = W.setTimeout, oCT = W.clearTimeout, oSI = W.setInterval, oCI = W.clearInterval;
  var oRAF = W.requestAnimationFrame, oCAF = W.cancelAnimationFrame, oPM = W.postMessage;
  var PP = MessagePort.prototype, oPPM = PP.postMessage, oAEL = PP.addEventListener, oREL = PP.removeEventListener;

  // Task hop on a private channel, created before MessagePort is patched so
  // its own messages are never counted as the page's.
  var hop = (function () { var ch = new MessageChannel(); var q = [];
    ch.port1.onmessage = function () { var f = q.shift(); if (f) f(); };
    return function (f) { q.push(f); oPPM.call(ch.port2, 0); }; })();

  // A timer that re-arms itself from its own callback is a poll or a clock
  // (setTimeout(poll, 200) forever, a 1 s tick): counted for its first arm
  // only once it is paced (delay >= 16 ms, a frame), or every capture of the
  // page waits for it until the cap. Measured on the review's probes: a 200 ms
  // poll pinned every capture at the 1500 ms cap; with 1 generation it settles
  // in one period. 2 generations already pins a 1000 ms clock at the cap (2 x
  // 1000 > 1500). Faster re-arms are yields inside chunked work (5 x
  // setTimeout(step, 0)) and stay counted, or the chunked work is captured
  // after its first chunk.
  var TIMER_GENERATIONS = 1, PACED_MS = 16;
  var curFn = null, curGen = 0;
  W.setTimeout = function (fn, delay) {
    if (typeof fn !== 'function') return oST.apply(W, arguments);
    var args = Array.prototype.slice.call(arguments, 2); var d = Math.max(0, Number(delay) || 0); var id;
    var gen = fn === curFn ? curGen + 1 : 0;
    var cb = function () { S.timers.delete(id); var pf = curFn, pg = curGen; curFn = fn; curGen = gen;
      try { return fn.apply(W, args); } finally { curFn = pf; curGen = pg; } };
    id = oST.call(W, cb, d);
    if (gen < TIMER_GENERATIONS || d < PACED_MS) S.timers.set(id, d);
    return id;
  };
  W.clearTimeout = function (id) { S.timers.delete(id); return oCT.call(W, id); };
  // An interval counts until its first tick only: it must not block forever.
  W.setInterval = function (fn, delay) {
    if (typeof fn !== 'function') return oSI.apply(W, arguments);
    var args = Array.prototype.slice.call(arguments, 2); var d = Math.max(0, Number(delay) || 0); var id; var first = true;
    var cb = function () { if (first) { first = false; S.timers.delete(id); } return fn.apply(W, args); };
    id = oSI.call(W, cb, d); S.timers.set(id, d); return id;
  };
  W.clearInterval = function (id) { S.timers.delete(id); return oCI.call(W, id); };
  // rAF re-armed from inside a rAF callback is an animation loop; stop counting
  // after 3 generations or a canvas animation pins the wait at the cap
  // (measured: a perpetual rAF loop settles in 35-40 ms with this).
  var rafGen = 0;
  W.requestAnimationFrame = function (fn) {
    var gen = rafGen;
    var id = oRAF.call(W, function (t) { S.rafs.delete(id); rafGen = gen + 1; try { return fn(t); } finally { rafGen = 0; } });
    if (gen < 3) S.rafs.add(id); return id;
  };
  W.cancelAnimationFrame = function (id) { S.rafs.delete(id); return oCAF.call(W, id); };
  // Posted messages (React's scheduler uses a MessageChannel): count sends
  // and deliveries, each event once however many listeners see it. Pending
  // is the difference; the waiter treats it as stale only when deliveries
  // stop moving (a port nobody listens to), never while they continue (the
  // review measured 40 x 5 ms of scheduler slices captured mid-render when
  // a steady 1-in-flight count was read as stale).
  var seen = new WeakSet();
  var deliver = function (e) { if (e && typeof e === 'object') { if (seen.has(e)) return; seen.add(e); }
    if (S.delivered < S.sent) S.delivered++; };
  W.postMessage = function () { S.sent++; return oPM.apply(W, arguments); };
  W.addEventListener('message', deliver, true);
  var wrapped = new WeakMap();
  var wrap = function (fn) { if (typeof fn !== 'function') return fn; var w = wrapped.get(fn);
    if (!w) { w = function (e) { deliver(e); return fn.call(this, e); }; wrapped.set(fn, w); } return w; };
  PP.postMessage = function () { S.sent++; return oPPM.apply(this, arguments); };
  PP.addEventListener = function (type, fn, opt) { return oAEL.call(this, type, type === 'message' ? wrap(fn) : fn, opt); };
  PP.removeEventListener = function (type, fn, opt) {
    return oREL.call(this, type, type === 'message' && typeof fn === 'function' ? (wrapped.get(fn) || fn) : fn, opt); };
  var onmsg = Object.getOwnPropertyDescriptor(PP, 'onmessage');
  Object.defineProperty(PP, 'onmessage', { configurable: true,
    get: function () { return onmsg.get.call(this); }, set: function (fn) { return onmsg.set.call(this, wrap(fn)); } });

  // A dedicated Worker runs where this script can't see; its script request
  // never completes on the page's session either. Count it as pending until
  // its first message, error or terminate, within the timer horizon: a worker
  // that answers late is waited for like a timer, a silent one costs at most
  // the horizon.
  var OW = W.Worker, wid = 0;
  if (typeof OW === 'function') {
    var JW = function (url, opts) {
      var w = new OW(url, opts); var id = ++wid; var src = String(url);
      S.workers.set(id, { t: performance.now(), src: src });
      var done = function () { S.workers.delete(id); };
      w.addEventListener('message', done, { once: true });
      w.addEventListener('error', done, { once: true });
      var term = w.terminate; w.terminate = function () { done(); return term.apply(w, arguments); };
      return w;
    };
    JW.prototype = OW.prototype;
    W.Worker = JW;
  }

  new MutationObserver(function (list) { S.mut += list.length; })
    .observe(document, { childList: true, subtree: true, attributes: true, characterData: true });

  // The page's half of settle.ready. Always defined under jux, so a page can
  // call it unconditionally (window.__juxtapose?.ready() outside jux).
  W.__juxtapose = { ready: function () { S.ready = true; } };

  var pendingImages = function () {
    var vh = W.innerHeight, vw = W.innerWidth, out = [];
    Array.prototype.forEach.call(document.images, function (img) {
      if (img.complete) return;
      // A lazy image outside the viewport, or not rendered at all
      // (display: none), never loads; waiting for it is what hung the old drain.
      if (img.loading === 'lazy') { if (img.getClientRects().length === 0) return;
        var r = img.getBoundingClientRect(); if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return; }
      out.push(img.currentSrc || img.src || '(no src)');
    });
    return out;
  };
  var snapshot = function (horizon) {
    var timers = 0; S.timers.forEach(function (d) { if (d <= horizon) timers++; });
    var now = performance.now(), workers = [];
    S.workers.forEach(function (w) { if (now - w.t <= horizon) workers.push(w.src); });
    var imgs = pendingImages();
    return { timers: timers, rafs: S.rafs.size, msgs: S.sent - S.delivered, delivered: S.delivered, mut: S.mut,
      fonts: document.fonts.status, images: imgs.length, imageSrcs: imgs.slice(0, 3),
      workers: workers.length, workerSrcs: workers.slice(0, 3), ready: S.ready };
  };
  W.__juxIdle = { snapshot: snapshot, reset: function () { S.ready = false; } };

  // Resolves 'idle' when two consecutive task hops each see no pending work
  // and no mutation since the previous hop, or 'cap' at capMs.
  W.__juxIdleWait = function (capMs, horizon, needReady) {
    return new Promise(function (resolve) {
      var t0 = performance.now(); var lastMut = -1; var lastDelivered = -1; var quiet = 0; var stale = 0; var done = false; var changing = false;
      var finish = function (status, s) { if (done) return; done = true; oCT.call(W, capTimer);
        s = s || snapshot(horizon); s.changing = changing;
        resolve({ status: status, waitedMs: performance.now() - t0, snap: s }); };
      var capTimer = oST.call(W, function () { finish('cap'); }, capMs);
      var check = function () {
        if (done) return;
        var s = snapshot(horizon);
        if (s.msgs > 0 && s.delivered === lastDelivered) stale++; else stale = 0; lastDelivered = s.delivered;
        var msgsOk = s.msgs === 0 || stale >= 3;
        var noWork = s.timers === 0 && s.rafs === 0 && msgsOk && s.workers === 0 && s.fonts !== 'loading' && s.images === 0 && (!needReady || s.ready);
        changing = s.mut !== lastMut && lastMut !== -1;
        var isQuiet = noWork && s.mut === lastMut;
        lastMut = s.mut;
        quiet = isQuiet ? quiet + 1 : 0;
        if (quiet >= 2) return finish('idle', s);
        if (noWork) hop(check);                                        // a mutation just happened: look again next task
        else if (s.rafs > 0) oRAF.call(W, function () { hop(check); }); // sleep to the frame edge
        else oST.call(W, check, 4);                                    // timer/font/image/worker/ready pending: poll cheaply
      };
      // First check after a frame: style and layout must run once before
      // fonts and in-viewport images start loading.
      oRAF.call(W, function () { hop(check); });
    });
  };
})();`;

/** Completed requests kept per document for `require`; past this a page is
 *  a firehose and the oldest are dropped. */
const MAX_DONE = 5000;

interface Request {
  url: string;
  type?: string;
}

/** In-flight and completed requests on one page, from CDP Network events. */
export class NetworkTracker {
  private readonly inflight = new Map<string, Request>();
  private done: Request[] = [];
  private readonly listeners = new Set<() => void>();
  /** In flight when the current story started on a warm switch: the last
   *  story's, never this one's. */
  private excluded = new Set<string>();
  /** The current main document's loader. */
  private mainLoader: string | undefined;

  constructor(page: Page & Required<Pick<Page, 'on'>>, mainFrameId: string | undefined) {
    page.on('Network.requestWillBeSent', (p) => {
      // A new main document: requests the navigation cancelled do not always
      // get loadingFailed (spike: a long-poll fetch lingered and pinned the
      // next page at the cap), and the previous document's completions must
      // not satisfy this one's `require`.
      if (p.type === 'Document' && p.frameId === mainFrameId) {
        this.inflight.clear();
        this.done = [];
        this.excluded.clear();
        this.mainLoader = p.loaderId;
      }
      // A dedicated Worker's script request has no loader and never gets
      // loadingFinished on this session (review: every capture of a page
      // with `new Worker('/w.js')` pinned at the cap). The init script counts
      // the worker itself until it answers.
      if (p.loaderId === '') return;
      // Started by the previous document between the navigation's start and
      // its commit: it never gets loadingFailed either (review: a 2 ms poller
      // followed by a static page flagged the static page at the cap 4 of 6
      // times).
      if (
        p.frameId === mainFrameId &&
        this.mainLoader !== undefined &&
        p.loaderId !== this.mainLoader
      )
        return;
      this.inflight.set(p.requestId, {
        url: p.request.url,
        ...(p.type !== undefined ? { type: p.type } : {}),
      });
    });
    const finish = (p: { requestId: string }) => {
      const r = this.inflight.get(p.requestId);
      if (!r) return;
      this.inflight.delete(p.requestId);
      this.excluded.delete(p.requestId);
      this.done.push(r);
      if (this.done.length > MAX_DONE) this.done.splice(0, this.done.length - MAX_DONE);
      for (const l of [...this.listeners]) l();
    };
    page.on('Network.loadingFinished', finish);
    page.on('Network.loadingFailed', finish);
  }

  /** A warm switch renders a new story in the same document: the last
   *  story's completions must not satisfy `require`, and its requests still
   *  in flight (a long poll) must not pin this one at the cap. */
  reset(): void {
    this.done = [];
    this.excluded = new Set(this.inflight.keys());
  }

  /** In-flight requests the wait counts: required, or not ignored. */
  counted(s: ResolvedSettle): Request[] {
    return [...this.inflight.entries()]
      .filter(([id]) => !this.excluded.has(id))
      .map(([, r]) => r)
      .filter(
        (r) =>
          s.require.some((p) => matchPattern(p, r.url, r.type)) ||
          !s.ignore.some((p) => matchPattern(p, r.url, r.type)),
      );
  }

  /** `require` patterns no completed request has matched yet. */
  missing(s: ResolvedSettle): string[] {
    return s.require
      .filter((p) => !this.done.some((r) => matchPattern(p, r.url, r.type)))
      .map((p) => p.source);
  }

  busy(s: ResolvedSettle): boolean {
    return this.counted(s).length > 0 || this.missing(s).length > 0;
  }

  /** Resolves when the wait no longer counts anything, or after `ms`. */
  async settled(s: ResolvedSettle, ms: number): Promise<void> {
    if (!this.busy(s)) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve();
      };
      const check = () => {
        if (!this.busy(s)) done();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.listeners.add(check);
    });
  }
}

/** One page's settle machinery: the init script is installed, and the
 *  tracker is null when the page cannot deliver events. */
export interface IdleDetector {
  net: NetworkTracker | null;
}

const installed = new WeakMap<Page, Promise<IdleDetector>>();

/**
 * Install the init script and the request tracker, once per page, before
 * its first navigation: the script applies to every later document on the
 * page. Network.enable is already part of page init.
 */
export function installIdleDetector(page: Page): Promise<IdleDetector> {
  let p = installed.get(page);
  if (!p) {
    p = (async () => {
      await page
        .send('Page.addScriptToEvaluateOnNewDocument', { source: IDLE_INIT })
        .catch(() => {});
      if (!page.on) return { net: null };
      const tree = await page.send('Page.getFrameTree').catch(() => undefined);
      const mainFrameId = tree?.frameTree?.frame?.id;
      return {
        net: new NetworkTracker(page as Page & Required<Pick<Page, 'on'>>, mainFrameId),
      };
    })();
    installed.set(page, p);
  }
  return p;
}

/** Before a story renders: forget the last story's completions, and on a
 *  warm switch (same document) its ready() call. */
export async function resetIdle(
  page: Page,
  idle: IdleDetector,
  warm: boolean,
): Promise<void> {
  idle.net?.reset();
  if (warm)
    await page.evaluate('window.__juxIdle && window.__juxIdle.reset()').catch(() => {});
}

const now = () => performance.now();

const isSnapshot = (v: unknown): v is IdleSnapshot =>
  typeof v === 'object' && v !== null && typeof (v as IdleSnapshot).mut === 'number';

/**
 * Wait until the page reports no pending work and no counted request is in
 * flight, or `capMs` passes. Never throws.
 */
export async function waitForIdle(
  page: Page,
  idle: IdleDetector,
  s: ResolvedSettle,
  capMs = s.timeoutMs,
): Promise<IdleResult> {
  const t0 = now();
  let snap: IdleSnapshot | undefined;
  const timeout = (): IdleResult => ({
    status: 'timeout',
    waitedMs: now() - t0,
    ...(snap ? { snap } : {}),
    pending: describePending(snap, idle.net, s),
  });
  for (;;) {
    const remaining = capMs - (now() - t0);
    if (remaining <= 0) return timeout();
    let r: unknown;
    try {
      r = await page.evaluate(
        `window.__juxIdleWait ? window.__juxIdleWait(${Math.ceil(remaining)}, ${s.horizonMs}, ${s.ready}) : Promise.resolve({ status: 'noinit' })`,
        undefined,
        // The in-page cap fires first; this only matters if the page is wedged.
        { timeout: Math.ceil(remaining) + 2000 },
      );
    } catch {
      return fallback(
        page,
        t0,
        capMs,
        'the page navigated or stopped answering during the wait',
      );
    }
    const status =
      typeof r === 'object' && r !== null
        ? (r as { status?: unknown }).status
        : undefined;
    const got = (r as { snap?: unknown } | undefined)?.snap;
    if (isSnapshot(got)) snap = got;
    if (status === 'cap') return timeout();
    if (status !== 'idle')
      return fallback(
        page,
        t0,
        capMs,
        'the idle detector was not installed in this page',
      );
    const net = idle.net;
    if (!net) return { status: 'idle', waitedMs: now() - t0, ...(snap ? { snap } : {}) };
    if (net.busy(s)) {
      await net.settled(s, capMs - (now() - t0));
      continue;
    }
    // One more round trip, so the Network event for a request the page
    // started just before it reported idle has arrived.
    await page.evaluate('1').catch(() => {});
    if (net.busy(s)) {
      await net.settled(s, capMs - (now() - t0));
      continue;
    }
    return { status: 'idle', waitedMs: now() - t0, ...(snap ? { snap } : {}) };
  }
}

/**
 * When the detector can't run, wait the way the quiet window did: fonts,
 * eager images and 100 ms without a DOM change, all inside what is left of the
 * cap. Flagged `settle-fallback`, so the weaker wait is never silent.
 */
async function fallback(
  page: Page,
  t0: number,
  capMs: number,
  why: string,
): Promise<IdleResult> {
  const remaining = Math.max(0, Math.ceil(capMs - (now() - t0)));
  await page
    .evaluate(
      `new Promise(function (resolve) {
        var cap = setTimeout(resolve, ${remaining});
        Promise.resolve(document.fonts && document.fonts.ready).then(function () {
          return Promise.all(Array.prototype.filter.call(document.images, function (i) { return !i.complete && i.loading !== 'lazy'; })
            .map(function (i) { return new Promise(function (r) { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }); }));
        }).then(function () {
          var t; var fin = function () { o.disconnect(); clearTimeout(cap); resolve(); };
          var o = new MutationObserver(function () { clearTimeout(t); t = setTimeout(fin, 100); });
          o.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
          t = setTimeout(fin, 100);
        });
      })`,
      undefined,
      { timeout: remaining + 2000 },
    )
    .catch(() => {});
  return {
    status: 'fallback',
    waitedMs: now() - t0,
    pending: [`${why}; waited for fonts, images and a quiet DOM only`],
  };
}

/** After the paint barrier: did the DOM, fonts, images or network move? */
export async function movedSincePaint(
  page: Page,
  idle: IdleDetector,
  before: IdleSnapshot | undefined,
  s: ResolvedSettle,
): Promise<boolean> {
  if (!before) return false;
  const after = await page
    .evaluate<unknown>(
      `window.__juxIdle ? window.__juxIdle.snapshot(${s.horizonMs}) : null`,
    )
    .catch(() => null);
  if (!isSnapshot(after)) return false;
  // Timers and messages too: a callback inside the barrier can schedule work
  // without touching the DOM yet.
  return (
    after.mut !== before.mut ||
    after.timers > 0 ||
    after.msgs > 0 ||
    after.workers > 0 ||
    after.fonts === 'loading' ||
    after.images > 0 ||
    idle.net?.busy(s) === true
  );
}

const MAX_REQUEST_LINES = 5;

/** A request URL as a person would name it: the path and query for http(s),
 *  else the URL, either one trimmed. */
function displayUrl(url: string): string {
  let out = url;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') out = u.pathname + u.search;
  } catch {
    // not a URL; show it as is
  }
  return out.length > 100 ? `${out.slice(0, 99)}…` : out;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * What was still pending at the cap, one line per kind, so an agent reading
 * the result can respond: ignore a request, require one, raise the cap, or
 * mask what keeps changing. Never empty.
 */
export function describePending(
  snap: IdleSnapshot | undefined,
  net: NetworkTracker | null,
  s: ResolvedSettle,
): string[] {
  const out: string[] = [];
  if (net) {
    const groups = new Map<string, number>();
    for (const r of net.counted(s)) {
      const key = `${displayUrl(r.url)}\0${r.type ?? 'Other'}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const lines = [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, n]) => {
        const [url, type] = key.split('\0');
        return `${plural(n, 'request')} to ${url} in flight (${type})`;
      });
    out.push(...lines.slice(0, MAX_REQUEST_LINES));
    if (lines.length > MAX_REQUEST_LINES)
      out.push(`${lines.length - MAX_REQUEST_LINES} more requests in flight`);
    for (const p of net.missing(s))
      out.push(`no request matching required pattern '${p}' has completed`);
  }
  if (snap) {
    if (s.ready && !snap.ready) out.push('window.__juxtapose.ready() was not called');
    if (snap.timers > 0)
      out.push(`${plural(snap.timers, 'timer')} due within ${s.horizonMs} ms`);
    if (snap.rafs > 0)
      out.push(`${plural(snap.rafs, 'animation frame callback')} pending`);
    if (snap.msgs > 0) out.push(`${plural(snap.msgs, 'posted message')} undelivered`);
    if (snap.workers > 0)
      out.push(
        `${plural(snap.workers, 'worker')} not answered yet: ${snap.workerSrcs.map(displayUrl).join(', ')}`,
      );
    if (snap.fonts === 'loading') out.push('web fonts still loading');
    if (snap.images > 0)
      out.push(
        `${plural(snap.images, 'image')} still loading: ${snap.imageSrcs.map(displayUrl).join(', ')}`,
      );
    if (out.length === 0 && snap.changing) out.push('the DOM kept changing');
  }
  if (out.length === 0) out.push(`the page did not settle within ${s.timeoutMs} ms`);
  return out;
}
