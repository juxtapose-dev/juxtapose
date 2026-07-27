// The platform seam. Everything Storybook-specific in the original tool
// reduces to the four operations below; Ladle and Histoire implement the same
// four. `core` depends on this interface and never on a concrete platform.

import type { Page } from 'playwright';
import type { StoryManifest, StoryParams } from './types.js';

export interface EnumerateTarget {
  /** Built workbench directory, when capturing a static build. */
  buildDir?: string;
  /** Running dev-server origin, when capturing live. */
  origin?: string;
  /** Project root, for resolving story source paths to absolute. */
  projectRoot: string;
}

export interface SettleContext {
  story: StoryManifest;
  params: StoryParams;
  /** Max ms to wait for render-ready before giving up and screenshotting. */
  timeoutMs: number;
}

export interface Platform {
  readonly name: string;

  /** True if this platform looks present at the target. Used for autodetection. */
  detect(target: EnumerateTarget): Promise<boolean>;

  /** Discover every capturable story. */
  enumerate(target: EnumerateTarget): Promise<StoryManifest[]>;

  /** URL that renders one story in isolation, no workbench chrome. */
  storyUrl(baseUrl: string, storyId: string): string;

  /** Blank preview URL, for warming a page before any story is selected.
   *  Prewarming here means the first real story doesn't pay for bundle
   *  compile and service-worker registration. */
  previewUrl(baseUrl: string): string;

  /**
   * Block until the story has finished rendering.
   *
   * This is the platform's core responsibility and the thing that makes
   * captures deterministic. Implementations should resolve on the platform's
   * own render signal rather than a fixed sleep. Generic settling that applies
   * to every platform — DOM quiescence, network drain, animation freezing —
   * lives in core and runs after this resolves.
   *
   * Must not throw on timeout: resolve and let core screenshot anyway. A
   * late-rendering story should produce a visible diff, not an error.
   */
  settle(page: Page, ctx: SettleContext): Promise<void>;

  /**
   * Switch a warm page to another story without a navigation.
   *
   * Optional, and purely an optimization — but a ~4x one, so implement it if
   * the platform exposes any client-side story-switch channel. Return false
   * if the switch could not be performed; the pool falls back to `goto`.
   */
  switchStory?(page: Page, storyId: string, ctx: SettleContext): Promise<boolean>;

  /**
   * Script evaluated on every page before any story loads. Use it to install
   * observers or hook the platform's client API. Runs once per page.
   */
  initScript?(): string;

  /**
   * Read per-story config from the live preview.
   *
   * Optional because not every platform hides parameters from its static
   * index. Storybook does — it only serializes a whitelist — so reading the
   * index alone silently drops per-story thresholds.
   */
  readLiveParams?(page: Page, storyId: string): Promise<StoryParams | undefined>;

  /** Directories whose contents invalidate every story when changed
   *  (`.storybook`, `.ladle`). Project-relative. */
  readonly configDirs: readonly string[];

  /** Globs identifying story files, for cache keys and change detection. */
  readonly storyFileGlobs: readonly string[];
}
