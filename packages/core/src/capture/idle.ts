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

import { SendTimeoutError } from '../browser/cdp.js';
import type { Page } from '../browser/page.js';
import { matchPattern, type ResolvedSettle } from './settle-options.js';
import type { PendingRequest } from '../types.js';

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
  /** On `timeout`: the counted requests still in flight, full URLs. */
  requests?: PendingRequest[];
  requestsOmitted?: number;
}

/** Most requests a settle report lists by URL; the rest are counted. */
export const MAX_PENDING_REQUESTS = 20;

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

  // Polls and clocks: a paced timer (delay >= 16 ms, a frame) re-armed from
  // the same call site after an earlier one there fired counts only if the
  // DOM changed since that fire. A poll that changes nothing (same function,
  // fresh closure or arrow) stops counting after its first period; a chain
  // that reveals something each step (retry with backoff, a typewriter, a
  // staged reveal) is waited out. The site is the whole stack minus this
  // wrapper, not the top frame, so a shared sleep() helper is a different site
  // per caller. Mutations are flushed with takeRecords() so a re-arm sees the
  // changes its own callback just made.
  //
  // Measured in the review's prototype (round 2): closure, arrow and
  // same-function 200 ms polls settle in 440-453 ms unflagged (they pinned the
  // 1500 ms cap before); a 3-step 100 ms self-chain, sleep() chains,
  // timer-1200-chain, timeout-chain and the timeout-50/120/300/800 pages all
  // capture their final state 3/3. A clock that repaints every tick still
  // counts and hits the cap, flagged: it needs a mask either way. Faster
  // re-arms (setTimeout(step, 0) chunked work) are never keyed and always count.
  // The caller's stack, minus this helper and the wrapper that called it. A
  // page can replace Error.prepareStackTrace with one that returns call sites
  // or throws (#214 review: every rAF then threw a TypeError and never ran);
  // then every site is '', which is the old depth rule, never a broken page.
  var stackKey = function () {
    try { var st = new Error().stack; return typeof st === 'string' ? st.split('\\n').slice(3).join('\\n') : ''; }
    catch (e) { return ''; }
  };
  var PACED_MS = 16, sites = new Map(), MO = null;
  var flushMut = function () { if (MO) S.mut += MO.takeRecords().length; };
  W.setTimeout = function (fn, delay) {
    if (typeof fn !== 'function') return oST.apply(W, arguments);
    var args = Array.prototype.slice.call(arguments, 2); var d = Math.max(0, Number(delay) || 0); var id;
    var key = null, counted = true;
    if (d >= PACED_MS) {
      key = stackKey();
      var site = sites.get(key);
      if (site && site.fired) { flushMut(); counted = S.mut !== site.mutAtFire; }
    }
    var cb = function () { S.timers.delete(id);
      if (key !== null) { flushMut(); sites.set(key, { fired: true, mutAtFire: S.mut }); }
      return fn.apply(W, args); };
    id = oST.call(W, cb, d);
    if (key !== null && !sites.has(key)) sites.set(key, { fired: false });
    if (counted) S.timers.set(id, d);
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
  // rAF re-armed from inside a rAF callback by the same call site is an
  // animation loop; stop counting once a site has requested 3 times in the
  // chain of callbacks above it, or a canvas animation pins the wait at the
  // cap (measured: a perpetual rAF loop settles in 35-40 ms with this).
  //
  // By site, not by nesting depth (issue #197). Spectrum's overlay open runs
  // guaranteedAllTransitionend (three nested rAFs from three closures) and
  // then calls nextFrame() from inside the third: depth 3, no loop. Counting
  // depth alone, that frame went uncounted and the wait returned idle 3 ms
  // before sp-opened, mid-open (traced on overlay--defined-overlay-element,
  // 1 of 20 captures at load 33-48). Measured with the page CPU throttled 4x,
  // 15 interleaved runs each (chrome-headless-shell 151, Apple M5 Pro):
  // overlay--click-content-closed-on-scroll 13 of 30 captures mid-open by
  // depth, 0 of 30 by site; across all 58 Spectrum overlay and dialog stories
  // 3 of 580 -> 0 of 580, every majority hash unchanged. The site is the
  // stack minus this wrapper, as for paced timers; a page that empties its
  // stacks makes every site the same, which is the old depth rule.
  var RAF_REPEATS = 3, rafSites = null;
  W.requestAnimationFrame = function (fn) {
    var site = stackKey();
    var sites = new Map(rafSites || []); var n = (sites.get(site) || 0) + 1; sites.set(site, n);
    var id = oRAF.call(W, function (t) { S.rafs.delete(id); rafSites = sites; try { return fn(t); } finally { rafSites = null; } });
    if (n <= RAF_REPEATS) S.rafs.add(id); return id;
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
  // never completes on the page's session either. What is countable is the
  // conversation: a message posted to the worker is pending until a message
  // comes back, within the timer horizon of the post; and a new worker gets a
  // 300 ms startup grace for unsolicited work, ended by its first message,
  // error or terminate(). A silent worker (comlink-style, answering only when
  // asked) cost ~1040 ms per capture when the whole horizon applied
  // (review round 2); with the grace it costs at most 300 ms, and the 80 ms and
  // 120 ms startup probes (worker-80, worker-delay) still capture their
  // answer. Reflect.construct keeps "class X extends Worker" working.
  var OW = W.Worker, wid = 0, STARTUP_MS = 300;
  if (typeof OW === 'function') {
    var JW = function Worker(url, opts) {
      var w = Reflect.construct(OW, Array.prototype.slice.call(arguments), new.target || OW);
      var id = ++wid; var rec = { t: performance.now(), src: String(url), started: true, posted: 0, replies: 0, lastPost: 0 };
      rec.id = id; S.workers.set(id, rec); recs.set(w, rec);
      w.addEventListener('message', function () { rec.started = false; if (rec.replies < rec.posted) rec.replies++; });
      w.addEventListener('error', function () { rec.started = false; rec.replies = rec.posted; });
      return w;
    };
    // On the prototype, not the instance, so a subclass's own overrides win.
    var recs = new WeakMap(), WP = OW.prototype, oWPM = WP.postMessage, oWT = WP.terminate;
    WP.postMessage = function () { var r = recs.get(this); if (r) { r.posted++; r.lastPost = performance.now(); } return oWPM.apply(this, arguments); };
    WP.terminate = function () { var r = recs.get(this); if (r) S.workers.delete(r.id); return oWT.apply(this, arguments); };
    JW.prototype = WP;
    Object.setPrototypeOf(JW, OW);
    W.Worker = JW;
  }

  var MO_OPTS = { childList: true, subtree: true, attributes: true, characterData: true };
  MO = new MutationObserver(function (list) { S.mut += list.length; });
  MO.observe(document, MO_OPTS);

  // Open shadow roots (issue #152). An observer on the document, a
  // stylesheet in it and document.images all stop at a shadow boundary, so
  // every open root is tracked here: observed like the document, its images
  // in the image wait, and the animation freeze adopted into it. Web
  // component libraries render everything inside one: in the Spectrum Web
  // Components field test (1,086 stories, jux 0.9.0) 31 of the 33 stories
  // whose hash varied across three passes were spinners, progress bars,
  // pulses and dialog or tooltip transitions in shadow DOM.
  //
  // Roots come from wrapping attachShadow, which sees every root a script
  // creates, before its content, and from a walk of the tree (openRoots)
  // for declarative ones (<template shadowrootmode>), which never call it.
  // Held weakly: on a warm page, a removed component's root must be freed.
  //
  // Closed roots are left alone. The wrapper is handed them too, but
  // nothing else in capture can reach them (the reraster walk, mask
  // selectors), and a component that closes its root has asked not to be
  // reached into. Their animations run and their mutations and images are
  // not waited for (docs/configuration.md).
  var roots = [], rootSeen = new WeakSet(), freezeSheet = null;
  var SRP = ShadowRoot.prototype, ASS = Object.getOwnPropertyDescriptor(SRP, 'adoptedStyleSheets');
  // Appended after the page's sheets on every assignment. Not a guarantee
  // of order (adoptedStyleSheets.push and splice bypass the setter), and
  // not needed for one: its rules are !important on a universal selector,
  // so only another !important rule on the same properties competes.
  var withFreeze = function (list) { var out = [];
    for (var i = 0; i < list.length; i++) if (list[i] !== freezeSheet) out.push(list[i]);
    out.push(freezeSheet); return out; };
  // Only roots of this document: a sheet constructed here can't be adopted
  // into another one (an iframe, createHTMLDocument, DOMParser or template
  // content), and the native setter throws NotAllowedError. Those roots
  // stay unfrozen. A root whose host moves to another document later loses
  // the sheet there (the setter below drops it).
  var freezeRoot = function (r) {
    if (freezeSheet && ASS && r.ownerDocument === document) ASS.set.call(r, withFreeze(ASS.get.call(r))); };
  var track = function (r) { if (rootSeen.has(r)) return; rootSeen.add(r);
    roots.push(typeof WeakRef === 'function' ? new WeakRef(r) : { deref: function () { return r; } });
    MO.observe(r, MO_OPTS);
    // Called from attachShadow after the root exists: nothing here may make
    // the page's own call throw.
    try { freezeRoot(r); } catch (e) {} };
  var oAS = Element.prototype.attachShadow;
  // Named, with one parameter: the same name and length as the native.
  var jAS = function attachShadow(init) { var r = oAS.apply(this, arguments);
    if (this.shadowRoot === r) track(r); return r; };
  Element.prototype.attachShadow = jAS;
  // Lit and others assign adoptedStyleSheets after attaching, which would
  // drop the freeze sheet: keep it in the list on a root it was adopted into.
  // The setter takes any iterable (a Set too), so it is read into an array.
  if (ASS && ASS.set) Object.defineProperty(SRP, 'adoptedStyleSheets', { configurable: true, enumerable: ASS.enumerable,
    get: ASS.get, set: Object.defineProperty(function (v) {
      if (freezeSheet && rootSeen.has(this) && v && typeof v === 'object') {
        var list = typeof v.length === 'number' ? v : typeof v[Symbol.iterator] === 'function' ? Array.from(v) : null;
        if (list) {
          if (this.ownerDocument === document) v = withFreeze(list);
          else { v = []; for (var i = 0; i < list.length; i++) if (list[i] !== freezeSheet) v.push(list[i]); }
        }
      }
      return ASS.set.call(this, v); }, 'name', { value: ASS.set.name }) });
  var walk = function (root) { var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) { var r = els[i].shadowRoot; if (r) { track(r); walk(r); } } };
  // Every tracked root still alive and in the document. The walk is not
  // repeated here: this runs on every check of the wait, every 4 ms while a
  // timer is pending, and the walk is a querySelectorAll('*') per root. It
  // runs where a wait starts, at the freeze and before the recheck instead.
  var openRoots = function () { var live = [], out = [];
    for (var i = 0; i < roots.length; i++) { var r = roots[i].deref(); if (!r) continue; live.push(roots[i]);
      if (r.host.isConnected) out.push(r); }
    roots = live; return out; };

  // The page's half of settle.ready. Always defined under jux, so a page can
  // call it unconditionally (window.__juxtapose?.ready() outside jux).
  W.__juxtapose = { ready: function () { S.ready = true; } };

  var pendingImages = function () {
    var vh = W.innerHeight, vw = W.innerWidth, out = [];
    var check = function (img) {
      if (img.complete) return;
      // A lazy image outside the viewport, or not rendered at all
      // (display: none), never loads; waiting for it is what hung the old drain.
      if (img.loading === 'lazy') { if (img.getClientRects().length === 0) return;
        var r = img.getBoundingClientRect(); if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return; }
      out.push(img.currentSrc || img.src || '(no src)');
    };
    Array.prototype.forEach.call(document.images, check);
    // Fonts need no such step: document.fonts reads 'loading' while a face
    // used only by shadow-tree text loads (checked on Chrome 151), and
    // 'loaded' when nothing uses it.
    openRoots().forEach(function (r) { Array.prototype.forEach.call(r.querySelectorAll('img'), check); });
    return out;
  };
  var snapshot = function (horizon) {
    var timers = 0; S.timers.forEach(function (d) { if (d <= horizon) timers++; });
    var now = performance.now(), workers = [];
    S.workers.forEach(function (w) {
      if ((w.started && now - w.t <= STARTUP_MS) || (w.replies < w.posted && now - w.lastPost <= horizon)) workers.push(w.src); });
    var imgs = pendingImages();
    return { timers: timers, rafs: S.rafs.size, msgs: S.sent - S.delivered, delivered: S.delivered, mut: S.mut,
      fonts: document.fonts.status, images: imgs.length, imageSrcs: imgs.slice(0, 3),
      workers: workers.length, workerSrcs: workers.slice(0, 3), ready: S.ready };
  };
  // untracked: rerasterLayers (settle.ts) runs its own style toggles through
  // this, so the mutation counter never sees them and a capture does not take
  // the recheck path for jux's own writes. Page mutations queued before fn are
  // counted first; fn's own records are dropped.
  W.__juxIdle = { snapshot: function (horizon) { walk(document); return snapshot(horizon); },
    reset: function () { S.ready = false; },
    // The animation freeze for open shadow roots, existing and future
    // (capture.ts adds the document's own sheet). A constructed sheet: no
    // element, so no mutation for this counter and nothing in the
    // structure snapshot.
    freeze: function (css) { if (!freezeSheet) { freezeSheet = new CSSStyleSheet(); freezeSheet.replaceSync(css); }
      walk(document); roots.forEach(function (w) { var r = w.deref(); if (r) freezeRoot(r); }); },
    untracked: function (fn) { flushMut(); var m = S.mut; try { return fn(); } finally { if (MO) MO.takeRecords(); S.mut = m; } } };

  // Resolves 'idle' when two consecutive task hops each see no pending work
  // and no mutation since the previous hop, or 'cap' at capMs.
  W.__juxIdleWait = function (capMs, horizon, needReady) {
    return new Promise(function (resolve) {
      walk(document);
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
  /** Set on main-frame requests: the document loader that started it. */
  mainLoader?: string;
}

/** In-flight and completed requests on one page, from CDP Network events. */
export class NetworkTracker {
  private readonly inflight = new Map<string, Request>();
  private done: Request[] = [];
  private readonly listeners = new Set<() => void>();
  /** In flight when the current story started on a warm switch: the last
   *  story's, never this one's. */
  private excluded = new Set<string>();
  /** The committed main document's loader. */
  private mainLoader: string | undefined;

  constructor(page: Page & Required<Pick<Page, 'on'>>, mainFrameId: string | undefined) {
    page.on('Network.requestWillBeSent', (p) => {
      // A dedicated Worker's script request has no loader and never gets
      // loadingFinished on this session (review: every capture of a page
      // with `new Worker('/w.js')` pinned at the cap). The init script counts
      // the worker's conversation instead.
      if (p.loaderId === '') return;
      this.inflight.set(p.requestId, {
        url: p.request.url,
        ...(p.type !== undefined ? { type: p.type } : {}),
        // Every frame's request, not only the main frame's: a child frame's
        // request (an iframe's analytics XHR) never gets loadingFailed when
        // the document navigates away, and without a loader it escaped the
        // sweep below and pinned every later story at the cap.
        ...(p.frameId === mainFrameId
          ? { mainLoader: p.loaderId }
          : this.mainLoader !== undefined
            ? { mainLoader: this.mainLoader }
            : {}),
      });
    });
    // The new main document commits. Its predecessor's requests, including
    // ones it started between the navigation's start and this commit, never
    // get loadingFailed (spike: a long poll pinned the next page at the cap;
    // review: a 2 ms poller flagged the following static page 4 of 6
    // times), and its completions must not satisfy this one's `require`.
    // On the commit, not on the Document request: a navigation that never
    // commits (a 204, a download) must leave the live document's requests
    // counted (review round 2). A request is kept by its loader, not dropped
    // on arrival, because Network events and the commit come from different
    // processes and a new document's first fetch can be reported before it.
    page.on('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId !== undefined || frame.id !== mainFrameId) return;
      this.mainLoader = frame.loaderId;
      for (const [id, r] of this.inflight)
        if (r.mainLoader !== undefined && r.mainLoader !== frame.loaderId) {
          this.inflight.delete(id);
          this.excluded.delete(id);
        }
      this.done = [];
      this.excluded.clear();
      for (const l of [...this.listeners]) l();
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
      .filter(
        ([id, r]) =>
          !this.excluded.has(id) &&
          // Another main-frame loader: the previous document's, or a
          // navigation that has not committed (or never will).
          (r.mainLoader === undefined ||
            this.mainLoader === undefined ||
            r.mainLoader === this.mainLoader),
      )
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
    ...pendingRequests(idle.net, s),
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
    } catch (err) {
      // A wedged page (a synchronous loop) would only wedge a second evaluate
      // too: worst case cap + 2 s + 2 s (review round 2). Skip straight to the
      // capture; a navigation mid-wait gets the fallback wait.
      if (err instanceof SendTimeoutError)
        return {
          status: 'fallback',
          waitedMs: now() - t0,
          pending: [
            'the page stopped answering during the wait; captured without waiting',
          ],
        };
      return fallback(page, t0, capMs, 'the page navigated during the wait');
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
        // The document and its open shadow roots (issue #152).
        var trees = [document]; (function walk(root) { var els = root.querySelectorAll('*');
          for (var k = 0; k < els.length; k++) { var sr = els[k].shadowRoot; if (sr) { trees.push(sr); walk(sr); } } })(document);
        var imgs = []; trees.forEach(function (t) { Array.prototype.push.apply(imgs, t.querySelectorAll('img')); });
        Promise.resolve(document.fonts && document.fonts.ready).then(function () {
          return Promise.all(imgs.filter(function (i) { return !i.complete && i.loading !== 'lazy'; })
            .map(function (i) { return new Promise(function (r) { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }); }));
        }).then(function () {
          var t; var fin = function () { o.disconnect(); clearTimeout(cap); resolve(); };
          var o = new MutationObserver(function () { clearTimeout(t); t = setTimeout(fin, 100); });
          trees.forEach(function (r) { o.observe(r, { childList: true, subtree: true, attributes: true, characterData: true }); });
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
  // Timers, messages and frames too: a callback inside the barrier can
  // schedule work without touching the DOM yet. Frames since issue #197: a
  // Spectrum overlay story awaits nextFrame() six times after sp-opened and
  // then clicks again; with that chain pending and the DOM unchanged, the
  // capture was taken mid-story.
  return (
    after.mut !== before.mut ||
    after.timers > 0 ||
    after.rafs > 0 ||
    after.msgs > 0 ||
    after.workers > 0 ||
    after.fonts === 'loading' ||
    after.images > 0 ||
    idle.net?.busy(s) === true
  );
}

const MAX_REQUEST_LINES = 5;

/** The in-flight requests by full URL, for the flake classifier: `pending`
 *  is worded for people and shows only a path. Read from what the tracker
 *  already holds. */
function pendingRequests(
  net: NetworkTracker | null,
  s: ResolvedSettle,
): { requests?: PendingRequest[]; requestsOmitted?: number } {
  if (!net) return {};
  const seen = new Set<string>();
  const all: PendingRequest[] = [];
  for (const r of net.counted(s)) {
    const key = `${r.type ?? 'Other'} ${r.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ url: r.url, type: r.type ?? 'Other' });
  }
  if (all.length === 0) return {};
  all.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return {
    requests: all.slice(0, MAX_PENDING_REQUESTS),
    ...(all.length > MAX_PENDING_REQUESTS
      ? { requestsOmitted: all.length - MAX_PENDING_REQUESTS }
      : {}),
  };
}

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
