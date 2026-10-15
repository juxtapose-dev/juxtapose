// packages/core/src/browser/browser.ts
//
// Browser = one CDP connection (pipe now, daemon socket in PR 2).
// BrowserContext = Target.createBrowserContext, one per pool worker, so
// concurrently rendering stories never share storage or service workers
// (pool.ts measured isolation at ~0% cost).

import type { Viewport } from './types.js';
import { CdpConnection } from './cdp.js';
import type { SpawnFn } from './launch.js';
import { CdpPage, type Page } from './page.js';

/**
 * The browser process is gone (killed, crashed, or closed under us). Every
 * story still queued fails with this one error rather than with N cascading
 * TargetClosedErrors that each look like a story problem.
 */
export class BrowserDiedError extends Error {
  constructor(cause?: unknown) {
    super(
      'jux: the browser died mid-run; the remaining stories were not captured',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'BrowserDiedError';
  }
}

export interface ContextOptions {
  viewport: Viewport;
  /** `serviceWorkers: 'block'` in Playwright terms: an init script that stubs registration. */
  blockServiceWorkers?: boolean;
}

export class BrowserContext {
  private closed = false;
  private readonly pages = new Set<CdpPage>();

  constructor(
    private readonly connection: CdpConnection,
    readonly id: string,
    private readonly opts: ContextOptions,
    private readonly os: NodeJS.Platform,
  ) {}

  async newPage(): Promise<Page> {
    const { targetId } = await this.connection.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId: this.id,
    });
    let page: CdpPage;
    try {
      const { sessionId } = await this.connection.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      page = await CdpPage.create(this.connection, targetId, sessionId, {
        viewport: this.opts.viewport,
        blockServiceWorkers: this.opts.blockServiceWorkers === true,
        os: this.os,
      });
    } catch (e) {
      // A target nobody drives is a leak until the context closes; close it now.
      await this.connection.send('Target.closeTarget', { targetId }).catch(() => {});
      throw e;
    }
    this.pages.add(page);
    return page;
  }

  /** Storage.clearCookies, as Playwright's clearCookies (coreBundle.js L38394). */
  async clearCookies(): Promise<void> {
    await this.connection.send('Storage.clearCookies', { browserContextId: this.id });
  }

  /** Disposing the context closes its targets; their listeners go with them. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const page of this.pages) page.dispose();
    this.pages.clear();
    await this.connection
      .send('Target.disposeBrowserContext', { browserContextId: this.id })
      .catch(() => {});
  }
}

export class Browser {
  private constructor(
    private readonly connection: CdpConnection,
    private readonly productVersion: string,
    private readonly closeFn: () => Promise<void>,
    private readonly os: NodeJS.Platform,
  ) {}

  static async launch(opts: {
    executablePath: string;
    args?: string[];
    spawn?: SpawnFn;
    /** Explicit caller environment, also used when selecting the pipe protocol. */
    env?: NodeJS.ProcessEnv;
  }): Promise<Browser> {
    // Lazy: the launcher is the only module that spawns Chrome, and `jux diff`
    // (which imports core for its pixel code) must never load it. The
    // no-browser probe in scripts/check-diff.mjs holds that line.
    const { launchChrome } = await import('./launch.js');
    const launched = await launchChrome(opts);
    try {
      const { product } = await launched.connection.send('Browser.getVersion');
      return new Browser(
        launched.connection,
        stripProduct(product),
        launched.close,
        process.platform,
      );
    } catch (e) {
      await launched.close();
      throw e;
    }
  }

  /** PR 2: a connection owned by someone else (the daemon). */
  static fromConnection(
    connection: CdpConnection,
    opts: { version: string; close: () => Promise<void> },
  ): Browser {
    return new Browser(
      connection,
      stripProduct(opts.version),
      opts.close,
      process.platform,
    );
  }

  /** `151.0.7922.34` — the string Playwright's `browser.version()` returned, so CaptureEnv compares equal. */
  version(): string {
    return this.productVersion;
  }

  isConnected(): boolean {
    return !this.connection.closed;
  }

  async newContext(opts: ContextOptions): Promise<BrowserContext> {
    const { browserContextId } = await this.connection.send(
      'Target.createBrowserContext',
      {
        disposeOnDetach: true,
      },
    );
    return new BrowserContext(this.connection, browserContextId, opts, this.os);
  }

  async close(): Promise<void> {
    await this.closeFn();
  }
}

function stripProduct(product: string): string {
  return product.replace(/^[A-Za-z]+\//, '');
}
