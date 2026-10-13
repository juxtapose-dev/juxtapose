// The platform seam. Everything Storybook-specific in the original tool
// reduces to the four operations below; Ladle and Histoire implement the same
// four. `core` depends on this interface and never on a concrete platform.

import type { Page } from './browser/page.js';
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

  /**
   * Put this story on screen, from whatever state the page is in.
   *
   * The one operation every platform must provide, and deliberately phrased as
   * an action rather than a URL. Most workbenches address a story by URL and
   * implement this as a navigation — `showStory` in `url-platform.ts` builds
   * exactly that. But Playwright's component-testing galleries have no
   * per-story URL at all: every story lives at the same base URL and is
   * rendered by calling `window.mount(storyId)`. Requiring a URL would have
   * excluded them.
   *
   * Implementations must leave the page ready for `settle()` to run.
   */
  showStory(page: Page, storyId: string, baseUrl: string): Promise<void>;

  /** Blank preview URL, for warming a page before any story is selected.
   *  Prewarming here means the first real story doesn't pay for bundle
   *  compile and service-worker registration. */
  previewUrl(baseUrl: string): string;

  /**
   * URL that renders one story in isolation, when the platform has one.
   *
   * Optional because gallery-based platforms genuinely don't. Only used for
   * reporting — linking a reviewer to a story — never for capture, which goes
   * through `showStory`.
   */
  storyUrl?(baseUrl: string, storyId: string): string;

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
   * Read per-story config from the live preview.
   *
   * Optional because not every platform hides parameters from its static
   * index. Storybook does — it only serializes a whitelist — so reading the
   * index alone silently drops per-story thresholds.
   */
  readLiveParams?(page: Page, storyId: string): Promise<StoryParams | undefined>;

  /**
   * Read every story's params from the live preview once, before capture.
   *
   * Optional, for platforms whose static index drops per-story config.
   * Storybook's index.json carries no `parameters.juxtapose`, so without this
   * a story's own `variants` can't be expanded and its `skip` or `viewport`
   * is only learned after it has rendered. Core calls it once per run on a
   * page of its own, merges the result over the enumerated params (the
   * preview wins) and expands variants from that. Keyed by story id; a story
   * missing from the map keeps its enumerated params.
   *
   * May throw: core warns and carries on with the enumerated params.
   */
  discoverParams?(page: Page, baseUrl: string): Promise<Map<string, StoryParams>>;

  /** Directories whose contents invalidate every story when changed
   *  (`.storybook`, `.ladle`). Project-relative. */
  readonly configDirs: readonly string[];

  /** Globs identifying story files, for cache keys and change detection. */
  readonly storyFileGlobs: readonly string[];
}
