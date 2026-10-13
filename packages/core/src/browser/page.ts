// packages/core/src/browser/page.ts
//
// One target, one flattened session. The init sequence is exactly what the
// byte-identity spike sent (spec §Decisions 3) — no more: Target.setAutoAttach
// without its handler pauses every worker and cross-origin iframe forever,
// and the geolocation/file-chooser overrides are things Playwright only
// sends when asked. The screenshot is a verbatim port of
// Screenshotter.screenshotPage (coreBundle.js L21258–21370).

import type { Protocol } from 'devtools-protocol';
import type { Viewport } from './types.js';
import {
  CdpConnection,
  CdpError,
  TargetClosedError,
  type CdpMethod,
  type CdpParams,
  type CdpResult,
} from './cdp.js';
import { assertCssSelector, QUERY_ALL_SOURCE, queryAllExpression } from './selectors.js';

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** The renderer died (OOM, Page.crash, a GPU fault); the page cannot be used again. */
export class PageCrashedError extends Error {
  constructor() {
    super('jux: the page crashed (its renderer process is gone)');
    this.name = 'PageCrashedError';
  }
}

/**
 * The page a platform adapter drives: the public adapter API, exported from
 * `@juxtapose/core`. Adapters receive it in `showStory`, `settle`,
 * `switchStory` and `readLiveParams`.
 *
 * Stable (semver): `goto`, `url`, `evaluate`, `waitForFunction`,
 * `waitForSelector`, `addStyleTag`, `setViewportSize`, `screenshot`.
 * Everything else serves core's own pipeline (snap, structure, the pool) and
 * may change without a major version.
 *
 * Selectors (`waitForSelector`, `screenshot({ mask })`) are CSS, resolved
 * through open shadow roots; anything else throws synchronously.
 */
export interface Page {
  /** Navigate and resolve on the main frame's `load`; rejects at `timeout` with the URL. */
  goto(url: string, opts?: { timeout?: number }): Promise<void>;
  url(): string;
  evaluate<R, A = undefined>(
    fn: string | ((arg: A) => R | Promise<R>),
    arg?: A,
    opts?: { timeout?: number },
  ): Promise<R>;
  waitForFunction<A = undefined>(
    fn: (arg: A) => unknown,
    arg?: A,
    opts?: { timeout?: number },
  ): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<void>;
  addStyleTag(opts: { content: string }): Promise<void>;
  setViewportSize(viewport: Viewport): Promise<void>;
  /**
   * Re-apply the fixed media emulation with this `prefers-color-scheme`.
   * @internal Core sets it per capture for variants; adapters must not.
   */
  setColorScheme(scheme: 'light' | 'dark'): Promise<void>;
  screenshot(opts?: { mask?: string[] }): Promise<Buffer>;
  /**
   * Raw CDP on this page's session, for DOMSnapshot.
   * @internal Not part of the adapter API; the protocol surface is Chrome's, not ours.
   */
  send<M extends CdpMethod>(method: M, params?: CdpParams<M>): Promise<CdpResult<M>>;
  /**
   * Untyped fallback: a method newer than the pinned protocol, or a caller
   * written against 0.7's `send<T>(method: string)`.
   * @internal
   */
  send<T = unknown>(method: string, params?: object): Promise<T>;
  /** HTTP status of each main-document response; returns the unsubscribe. */
  onMainResponse(handler: (status: number) => void): () => void;
  /** Storage.clearDataForOrigin on this page's session: localStorage, IndexedDB, Cache Storage, service workers. */
  clearOrigin(origin: string): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Page.setFontFamilies tables, playwright-core 1.62.0 `platformToFontFamilies`
// (coreBundle.js L36529+), copied verbatim: linux has no forScripts; mac has
// jpan/hang/hans/hant; win has seven. Generic families resolve through these
// in headless mode; without them a story that says `font-family: sans-serif`
// renders with Chromium's built-in defaults and the bytes differ from every
// existing baseline.
const FONT_FAMILIES: Record<
  'linux' | 'mac' | 'win',
  Protocol.Page.SetFontFamiliesRequest
> = {
  linux: {
    fontFamilies: {
      standard: 'Times New Roman',
      fixed: 'Monospace',
      serif: 'Times New Roman',
      sansSerif: 'Arial',
      cursive: 'Comic Sans MS',
      fantasy: 'Impact',
    },
  },
  mac: {
    fontFamilies: {
      standard: 'Times',
      fixed: 'Courier',
      serif: 'Times',
      sansSerif: 'Helvetica',
      cursive: 'Apple Chancery',
      fantasy: 'Papyrus',
    },
    forScripts: [
      {
        script: 'jpan',
        fontFamilies: {
          standard: 'Hiragino Kaku Gothic ProN',
          fixed: 'Osaka-Mono',
          serif: 'Hiragino Mincho ProN',
          sansSerif: 'Hiragino Kaku Gothic ProN',
        },
      },
      {
        script: 'hang',
        fontFamilies: {
          standard: 'Apple SD Gothic Neo',
          serif: 'AppleMyungjo',
          sansSerif: 'Apple SD Gothic Neo',
        },
      },
      {
        script: 'hans',
        fontFamilies: {
          standard: ',PingFang SC,STHeiti',
          serif: 'Songti SC',
          sansSerif: ',PingFang SC,STHeiti',
          cursive: 'Kaiti SC',
        },
      },
      {
        script: 'hant',
        fontFamilies: {
          standard: ',PingFang TC,Heiti TC',
          serif: 'Songti TC',
          sansSerif: ',PingFang TC,Heiti TC',
          cursive: 'Kaiti TC',
        },
      },
    ],
  },
  win: {
    fontFamilies: {
      standard: 'Times New Roman',
      fixed: 'Consolas',
      serif: 'Times New Roman',
      sansSerif: 'Arial',
      cursive: 'Comic Sans MS',
      fantasy: 'Impact',
    },
    forScripts: [
      {
        script: 'cyrl',
        fontFamilies: {
          standard: 'Times New Roman',
          fixed: 'Courier New',
          serif: 'Times New Roman',
          sansSerif: 'Arial',
        },
      },
      { script: 'arab', fontFamilies: { fixed: 'Courier New', sansSerif: 'Segoe UI' } },
      {
        script: 'grek',
        fontFamilies: {
          standard: 'Times New Roman',
          fixed: 'Courier New',
          serif: 'Times New Roman',
          sansSerif: 'Arial',
        },
      },
      {
        script: 'jpan',
        fontFamilies: {
          standard: ',Meiryo,Yu Gothic',
          fixed: 'MS Gothic',
          serif: ',Yu Mincho,MS PMincho',
          sansSerif: ',Meiryo,Yu Gothic',
        },
      },
      {
        script: 'hang',
        fontFamilies: {
          standard: 'Malgun Gothic',
          fixed: 'Gulimche',
          serif: 'Batang',
          sansSerif: 'Malgun Gothic',
          cursive: 'Gungsuh',
        },
      },
      {
        script: 'hans',
        fontFamilies: {
          standard: 'Microsoft YaHei',
          fixed: 'NSimsun',
          serif: 'Simsun',
          sansSerif: 'Microsoft YaHei',
          cursive: 'KaiTi',
        },
      },
      {
        script: 'hant',
        fontFamilies: {
          standard: 'Microsoft JhengHei',
          fixed: 'MingLiU',
          serif: 'PMingLiU',
          sansSerif: 'Microsoft JhengHei',
          cursive: 'DFKai-SB',
        },
      },
    ],
  },
};

// coreBundle.js L51296, verbatim (serviceWorkers: 'block').
const BLOCK_SERVICE_WORKERS_SCRIPT = `
if (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by Playwright'); };
`;

const metricsOverride = (
  v: Viewport,
): Protocol.Emulation.SetDeviceMetricsOverrideRequest => ({
  mobile: false,
  width: v.width,
  height: v.height,
  screenWidth: v.width,
  screenHeight: v.height,
  deviceScaleFactor: 1,
  screenOrientation: { angle: 0, type: 'landscapePrimary' },
});

// Only the color scheme varies (per-story variants); every other feature is
// pinned for every capture.
const emulatedMedia = (
  scheme: 'light' | 'dark',
): Protocol.Emulation.SetEmulatedMediaRequest => ({
  media: '',
  features: [
    { name: 'prefers-color-scheme', value: scheme },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
    { name: 'forced-colors', value: 'none' },
    { name: 'prefers-contrast', value: 'no-preference' },
  ],
});

const EMULATED_MEDIA = emulatedMedia('light');

// Screenshotter._preparePageForScreenshots with caret:'hide', animations:'allow'.
const PREPARE_SCREENSHOT = `(function (hideCaret) {
  const collectRoots = (root, roots = []) => {
    roots.push(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    do {
      const node = walker.currentNode;
      const shadowRoot = node instanceof Element ? node.shadowRoot : null;
      if (shadowRoot) collectRoots(shadowRoot, roots);
    } while (walker.nextNode());
    return roots;
  };
  const roots = collectRoots(document);
  const cleanupCallbacks = [];
  if (hideCaret) {
    const elements = new Map();
    for (const root of roots) {
      root.querySelectorAll('input,textarea,[contenteditable]').forEach((element) => {
        elements.set(element, { value: element.style.getPropertyValue('caret-color'), priority: element.style.getPropertyPriority('caret-color') });
        element.style.setProperty('caret-color', 'transparent', 'important');
      });
    }
    cleanupCallbacks.push(() => { for (const [element, value] of elements) element.style.setProperty('caret-color', value.value, value.priority); });
  }
  window.__juxCleanupScreenshot = () => { for (const cb of cleanupCallbacks) cb(); delete window.__juxCleanupScreenshot; };
})(true)`;

// Playwright's mask overlay: injected highlight.css + Highlight.updateHighlight.
const HIGHLIGHT_CSS =
  ':host{font-size:13px;font-family:system-ui,Ubuntu,Droid Sans,sans-serif;color:#333;color-scheme:light}svg{position:absolute;height:0}x-pw-highlight{position:absolute;top:0;left:0;width:0;height:0}';
const MASK_BODY = `
  const glass = document.createElement('x-pw-glass');
  glass.setAttribute('popover', 'manual');
  const s = glass.style;
  s.inset = '0'; s.width = '100%'; s.height = '100%'; s.maxWidth = 'none'; s.maxHeight = 'none';
  s.padding = '0'; s.margin = '0'; s.border = 'none'; s.overflow = 'visible';
  s.pointerEvents = 'none'; s.display = 'flex'; s.backgroundColor = 'transparent';
  const shadow = glass.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(HIGHLIGHT_CSS)};
  shadow.appendChild(style);
  document.documentElement.appendChild(glass);
  glass.showPopover();
  const entries = els.map((el) => { const h = document.createElement('x-pw-highlight'); shadow.appendChild(h); return { el, h }; });
  for (const { el, h } of entries) {
    const box = el.getBoundingClientRect();
    h.style.backgroundColor = a0;
    h.style.left = box.x + 'px'; h.style.top = box.y + 'px';
    h.style.width = box.width + 'px'; h.style.height = box.height + 'px';
    h.style.display = 'block';
  }
  window.__juxUnmask = () => { glass.remove(); delete window.__juxUnmask; };
  return entries.length;`;

// Playwright's default waitForSelector state is 'visible': the first match
// has a non-empty box and is not visibility:hidden. Matches pierce open
// shadow roots, as Playwright's css engine does.
const SELECTOR_VISIBLE = `function (selector) {
  const el = (${QUERY_ALL_SOURCE})(selector)[0];
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}`;

/** CDP's Frame.url excludes the fragment; Playwright's page.url() includes it. */
const frameUrl = (f: Protocol.Page.Frame) => f.url + (f.urlFragment ?? '');

function serialize(arg: unknown): string {
  return arg === undefined ? 'undefined' : JSON.stringify(arg);
}

export class CdpPage implements Page {
  private currentUrl = 'about:blank';
  private viewport: Viewport;
  private closed = false;
  /**
   * Why the page is unusable, once it is. `goneP` rejects with it at that
   * moment and every send, evaluate and goto races it, so work already in
   * flight fails at once: Chrome never answers a command on a crashed or
   * detached session, and a committed navigation whose `load` never comes
   * would otherwise hold a pool worker for its full timeout.
   */
  private goneError: Error | null = null;
  private rejectGone!: (e: Error) => void;
  private readonly goneP: Promise<never>;
  /** Every connection listener this page holds; dispose() removes them all. */
  private readonly offs: (() => void)[] = [];

  private constructor(
    private readonly connection: CdpConnection,
    readonly targetId: string,
    readonly sessionId: string,
    viewport: Viewport,
  ) {
    this.viewport = viewport;
    this.goneP = new Promise<never>((_, reject) => (this.rejectGone = reject));
    // A crash or close with nothing in flight rejects this with no racer
    // attached; without the catch that is an unhandledRejection, which kills
    // a host running with Node's default --unhandled-rejections=throw.
    // Racers still see the rejection: each race attaches its own handler.
    this.goneP.catch(() => {});
    this.offs.push(
      connection.on(
        'Page.frameNavigated',
        ({ frame }) => {
          if (!frame.parentId) this.currentUrl = frameUrl(frame);
        },
        sessionId,
      ),
      // Playwright's DialogManager with no handlers (coreBundle.js L12963,
      // L37640): beforeunload is accepted so navigation proceeds, every other
      // dialog is dismissed. A story that calls alert() would otherwise block
      // every later evaluate on this page.
      connection.on(
        'Page.javascriptDialogOpening',
        ({ type }) => {
          const accept = type === 'beforeunload';
          void this.send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
        },
        sessionId,
      ),
      // The earliest crash signal CDP has. RenderFrameDevToolsAgentHost::
      // RenderProcessExited sends it first, then NotifyCrashed → the
      // browser-level Target.targetCrashed in the same call (measured: same
      // millisecond on macOS), so listening there too would gain nothing.
      // Nothing can beat it: the browser learns of the death only when the
      // renderer process is gone.
      connection.on(
        'Inspector.targetCrashed',
        () => this.fail(new PageCrashedError()),
        sessionId,
      ),
      // The same function's other branch: a renderer that exits with a status
      // Chromium does not class as a crash gets Inspector.detached("Render
      // process gone.") instead, and no Target event at all while the target
      // stays open. Without this, work in flight would wait out its timeout.
      connection.on(
        'Inspector.detached',
        (p) => {
          // Typed as always present; `?? ''` kept from before the protocol types.
          const reason = p.reason ?? '';
          this.fail(
            /render process gone/i.test(reason)
              ? new PageCrashedError()
              : new TargetClosedError(reason || 'inspector detached'),
          );
        },
        sessionId,
      ),
      // Browser-session event: the target closed under us (context disposed,
      // window.close()). Drop our listeners with it.
      connection.on('Target.detachedFromTarget', (p) => {
        if (p.sessionId !== this.sessionId) return;
        this.fail(new TargetClosedError('target closed'));
        this.dispose();
      }),
      connection.onClosed((e) => this.fail(e)),
    );
  }

  /** The spike's init list (spec §Decisions 3), plus Log.enable which Playwright also sends. */
  static async create(
    connection: CdpConnection,
    targetId: string,
    sessionId: string,
    opts: { viewport: Viewport; blockServiceWorkers: boolean; os: NodeJS.Platform },
  ): Promise<CdpPage> {
    const page = new CdpPage(connection, targetId, sessionId, opts.viewport);
    // Keyed on the host's process.platform, where Playwright keys on the
    // browser's UA. The two agree for every supported setup: the pinned
    // download is per-host, and a BYO binary (JUX_CHROME / --chrome) is
    // necessarily same-OS because we spawn it locally.
    const fonts =
      FONT_FAMILIES[opts.os === 'darwin' ? 'mac' : opts.os === 'win32' ? 'win' : 'linux'];
    try {
      await Promise.all([
        page.send('Page.enable'),
        page.send('Page.setLifecycleEventsEnabled', { enabled: true }),
        page.send('Runtime.enable'),
        page.send('Network.enable'),
        page.send('Log.enable'),
        page.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
        page.send('Emulation.setDeviceMetricsOverride', metricsOverride(opts.viewport)),
        page.send('Page.setFontFamilies', fonts),
        page.send('Emulation.setEmulatedMedia', EMULATED_MEDIA),
        ...(opts.blockServiceWorkers
          ? [
              page.send('Page.addScriptToEvaluateOnNewDocument', {
                source: BLOCK_SERVICE_WORKERS_SCRIPT,
                runImmediately: true,
              }),
            ]
          : []),
      ]);
    } catch (e) {
      page.dispose();
      throw e;
    }
    return page;
  }

  send<M extends CdpMethod>(method: M, params?: CdpParams<M>): Promise<CdpResult<M>>;
  send<T = unknown>(method: string, params?: object): Promise<T>;
  send(method: string, params?: object): Promise<unknown> {
    if (this.goneError) return Promise.reject(this.goneError);
    return this.guard(this.connection.send(method, params, this.sessionId));
  }

  url(): string {
    return this.currentUrl;
  }

  onMainResponse(handler: (status: number) => void): () => void {
    if (this.closed) return () => {};
    const off = this.connection.on(
      'Network.responseReceived',
      (r) => {
        // The top frame's id is the target id in Chromium (verified 2026-10-13).
        if (r.type === 'Document' && r.frameId === this.targetId)
          handler(r.response.status);
      },
      this.sessionId,
    );
    this.offs.push(off);
    return off;
  }

  /**
   * Page.navigate, then the main frame's `load` for the document that
   * navigation created. The timeout covers the whole thing: Chrome answers
   * Page.navigate only at commit or failure, so a server that never responds
   * never replies. A child frame's own `load` must not count (a same-process
   * iframe fires one for itself), nor may a late `load` from the previous
   * document: Playwright waits on the new document's loaderId.
   */
  async goto(url: string, opts: { timeout?: number } = {}): Promise<void> {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    const early: string[] = []; // loaderIds that fired load before navigate replied
    let wanted: string | undefined;
    let onLoad!: () => void;
    const loaded = new Promise<void>((r) => (onLoad = r));
    const off = this.connection.on(
      'Page.lifecycleEvent',
      (e) => {
        if (e.name !== 'load' || e.frameId !== this.targetId) return;
        if (wanted === undefined) early.push(e.loaderId);
        else if (e.loaderId === wanted) onLoad();
      },
      this.sessionId,
    );
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new TimeoutError(
              `jux: navigation to ${url} did not fire load within ${timeout} ms`,
            ),
          ),
        timeout,
      );
    });
    const navigated = (async () => {
      if (this.goneError) throw this.goneError;
      // The send's own cap sits past the goto timeout so the TimeoutError
      // naming the url is the one the caller sees.
      const res = await this.connection.send('Page.navigate', { url }, this.sessionId, {
        timeout: timeout + 1000,
      });
      if (res.errorText)
        throw new Error(`jux: navigation to ${url} failed: ${res.errorText}`);
      // No loaderId: a same-document navigation (fragment change); the
      // document is already loaded and no new `load` will fire.
      if (res.loaderId === undefined) return;
      wanted = res.loaderId;
      if (early.includes(wanted)) return;
      await loaded;
    })();
    try {
      await Promise.race([navigated, expired, this.goneP]);
    } finally {
      clearTimeout(timer);
      off();
      navigated.catch(() => {}); // the loser of the race is not an unhandled rejection
    }
    const { frameTree } = await this.send('Page.getFrameTree');
    this.currentUrl = frameUrl(frameTree.frame);
  }

  async evaluate<R, A = undefined>(
    fn: string | ((arg: A) => R | Promise<R>),
    arg?: A,
    opts: { timeout?: number } = {},
  ): Promise<R> {
    const expression =
      typeof fn === 'string' ? fn : `(${fn.toString()})(${serialize(arg)})`;
    if (this.goneError) throw this.goneError;
    const r = await this.guard(
      this.connection.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        this.sessionId,
        { timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS },
      ),
    );
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
      );
    }
    // The caller's claim about what its page code returns: nothing on this
    // side can check it (returnByValue gives back whatever JSON the page made).
    return r.result.value as R;
  }

  /** Playwright polls on requestAnimationFrame by default (polling: 'raf'). */
  waitForFunction<A = undefined>(
    fn: (arg: A) => unknown,
    arg?: A,
    opts: { timeout?: number } = {},
  ): Promise<void> {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    return this.poll(fn.toString(), serialize(arg), timeout).then((ok) => {
      if (!ok)
        throw new TimeoutError(`jux: waitForFunction timed out after ${timeout} ms`);
    });
  }

  waitForSelector(selector: string, opts: { timeout?: number } = {}): Promise<void> {
    assertCssSelector(selector); // throws synchronously: a non-CSS selector is a config error, not a slow page
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    return this.poll(SELECTOR_VISIBLE, JSON.stringify(selector), timeout).then((ok) => {
      if (!ok)
        throw new TimeoutError(
          `jux: selector '${selector}' did not appear within ${timeout} ms`,
        );
    });
  }

  /** rAF-poll `predicate(arg)` in the page; true once truthy, false at the in-page cap. */
  private async poll(predicate: string, arg: string, timeout: number): Promise<boolean> {
    const outcome = await this.evaluate<string>(
      `new Promise((resolve) => {
        const predicate = ${predicate};
        const arg = ${arg};
        const start = performance.now();
        const tick = () => {
          let value;
          try { value = predicate(arg); } catch (e) { return resolve('error:' + (e && e.message)); }
          if (value) return resolve('ok');
          if (performance.now() - start > ${timeout}) return resolve('timeout');
          requestAnimationFrame(tick);
        };
        tick();
      })`,
      undefined,
      // The in-page cap fires first; the node-side cap only matters if the page is wedged.
      { timeout: timeout + 1000 },
    );
    if (outcome.startsWith('error:')) throw new Error(outcome.slice(6));
    return outcome === 'ok';
  }

  /** Frame._addStyleTag → addStyleContent, verbatim. */
  async addStyleTag(opts: { content: string }): Promise<void> {
    await this.evaluate((content: string) => {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.appendChild(document.createTextNode(content));
      document.head.appendChild(style);
      return true;
    }, opts.content);
  }

  async setViewportSize(viewport: Viewport): Promise<void> {
    if (
      viewport.width === this.viewport.width &&
      viewport.height === this.viewport.height
    )
      return;
    await this.send('Emulation.setDeviceMetricsOverride', metricsOverride(viewport));
    this.viewport = viewport;
  }

  async setColorScheme(scheme: 'light' | 'dark'): Promise<void> {
    await this.send('Emulation.setEmulatedMedia', emulatedMedia(scheme));
  }

  /** Screenshotter.screenshotPage: prepare → fonts.ready → mask → getLayoutMetrics → captureScreenshot → cleanup. */
  async screenshot(opts: { mask?: string[] } = {}): Promise<Buffer> {
    const mask = opts.mask ?? [];
    for (const sel of mask) assertCssSelector(sel);
    await this.evaluate(PREPARE_SCREENSHOT);
    try {
      await this.evaluate('document.fonts.ready').catch(() => {});
      if (mask.length) {
        // One glass pane for all selectors: Playwright adds every selector's
        // matches to the same highlight list before painting.
        await this.evaluate(queryAllExpression(mask.join(', '), MASK_BODY, '#F0F'));
      }
      try {
        // The device-pixel `visualViewport` Playwright reads, not the protocol's
        // preferred cssVisualViewport (@deprecated there): the clip must match
        // Screenshotter's.
        const { visualViewport } = await this.send('Page.getLayoutMetrics');
        const clip = {
          x: visualViewport.pageX,
          y: visualViewport.pageY,
          width: Math.ceil(this.viewport.width / visualViewport.scale),
          height: Math.ceil(this.viewport.height / visualViewport.scale),
          scale: visualViewport.scale,
        };
        const { data } = await this.send('Page.captureScreenshot', {
          format: 'png',
          clip,
          captureBeyondViewport: false,
        });
        return Buffer.from(data, 'base64');
      } finally {
        if (mask.length)
          await this.evaluate('window.__juxUnmask && window.__juxUnmask()').catch(
            () => {},
          );
      }
    } finally {
      await this.evaluate(
        'window.__juxCleanupScreenshot && window.__juxCleanupScreenshot()',
      ).catch(() => {});
    }
  }

  async clearOrigin(origin: string): Promise<void> {
    await this.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.dispose();
    await this.connection
      .send('Target.closeTarget', { targetId: this.targetId })
      .catch((e) => {
        if (!(e instanceof CdpError) && !(e instanceof TargetClosedError)) throw e;
      });
  }

  /** Mark closed and drop every listener; idempotent. BrowserContext.close calls it for its pages. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new TargetClosedError('page closed'));
    for (const off of this.offs.splice(0)) off();
  }

  /** First cause wins: a crash followed by the context closing still reports the crash. */
  private fail(e: Error): void {
    if (this.goneError) return;
    this.goneError = e;
    this.rejectGone(e);
  }

  /** `p`, unless the page goes first. */
  private guard<T>(p: Promise<T>): Promise<T> {
    p.catch(() => {}); // the loser of the race is not an unhandled rejection
    return Promise.race([p, this.goneP]);
  }
}
