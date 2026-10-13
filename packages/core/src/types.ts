import type { Viewport } from './browser/types.js';
// Core data model. Deliberately free of any platform (Storybook/Ladle) types —
// adapters map their world onto these.

/** Per-story tuning, read from the platform's story parameters. */
export interface StoryParams {
  /** Exclude this story from capture entirely. */
  skip?: boolean;
  viewport?: Viewport;
  /** Fixed extra wait after settle, ms. Escape hatch; prefer waitForSelector. */
  delay?: number;
  /** pixelmatch colour-distance threshold, 0..1. Default 0.1. */
  threshold?: number;
  /** Mismatch % below which a diff still passes. Suppresses AA noise. Default 0. */
  minDiffPercent?: number;
  /** CSS animations during capture. Default 'disabled' so spinners don't flake. */
  animations?: 'play' | 'disabled';
  /** Capture after the story's interaction/play phase rather than at first render. */
  captureAfterPlay?: boolean;
  /** Wait for this selector before screenshotting. For async content the
   *  network drain can't see (SDK init, lazy canvas). */
  waitForSelector?: string;
  /** Max ms to wait for render-ready before screenshotting anyway. Default 2000. */
  captureTimeout?: number;
  /** Selectors to cover with a solid box before the screenshot. For a clock or
   *  a random avatar; prefer stubbing the input. Masks the element's bounding
   *  box, so give it a fixed size or the box resizes with the content. */
  mask?: string[];
  /** Exclude from watch-mode recapture while leaving normal runs alone. For
   *  stories whose play function or delay makes a keystroke-triggered capture
   *  cost more than it returns. Default true. */
  liveCapture?: boolean;
  /** Named capture variants of this story: each is captured, judged and
   *  approved on its own under the key `${storyId}__${name}`. `false` opts
   *  this story out of a project-wide variant of that name. */
  variants?: Record<string, VariantSpec | false>;
  /** Set on a variant's resolved params; a variant-only field. The default
   *  capture is always light, so a story's own `colorScheme` is ignored. */
  colorScheme?: ColorScheme;
  /** How the capture decides the page has finished. Layered over the project
   *  config's `settle` and under per-call options. */
  settle?: SettleParams;
}

/**
 * The event-driven settle wait: the page is captured once it reports no
 * pending timers, frames, messages, fonts or images and no counted request is
 * in flight, or at `timeout`, whichever comes first.
 */
export interface SettleParams {
  /** Hard cap on the wait, ms, 1 to 60000. Default 1500. At the cap the
   *  page is captured anyway and the result is flagged `settle-timeout`. */
  timeout?: number;
  /** Also wait for the page to call `window.__juxtapose.ready()`. */
  ready?: boolean;
  network?: {
    /** Requests never counted as pending. Added to the defaults
     *  (`type:WebSocket`, `type:EventSource`, `type:Ping`, `type:Prefetch`). */
    ignore?: string[];
    /** Each pattern must see a matching request complete before the page
     *  counts as settled. Wins over `ignore`. */
    require?: string[];
  };
}

/** Something about a capture that doesn't fail it but should be read. */
export type CaptureFlag = 'settle-timeout';

/** Present on a capture whose settle wait hit its cap. */
export interface SettleReport {
  status: 'timeout';
  /** The cap that was hit, ms. */
  timeoutMs: number;
  /** What was still pending at the cap, one description per item, such as
   *  `1 request to /api/feed in flight (Fetch)`. Never empty. */
  pending: string[];
}

export type ColorScheme = 'light' | 'dark';

/** One named variant: any per-story option, plus a color scheme and the name
 *  of another variant to start from. `skip` is not a field; set the variant to
 *  `false` to drop it. */
export interface VariantSpec extends Omit<
  StoryParams,
  'skip' | 'variants' | 'liveCapture'
> {
  colorScheme?: ColorScheme;
  /** Another variant (of this story or the project) whose fields this one
   *  starts from. Chains resolve; a cycle or unknown name is a config error. */
  extends?: string;
}

// Lives with the browser driver, which must not import from the rest of core.
export type { Viewport } from './browser/types.js';

/** One capturable story, normalised across platforms. */
export interface StoryManifest {
  /** Stable, URL-safe. The capture key: the platform-native id (Storybook's
   *  `id`, Ladle's key) for a default capture, `${baseStoryId}__${variant}`
   *  for a variant. Everything keyed by story (manifest, baselines, run
   *  images, report.json) uses this. */
  storyId: string;
  /** Set on variant entries: the platform's own id, which every platform call
   *  receives. Absent on a default capture, where it equals `storyId`. */
  baseStoryId?: string;
  /** Set on variant entries: the variant's name. */
  variant?: string;
  /** Set on variant entries: the fields the variant and its `extends` chain
   *  set, already merged into `params`. Kept apart because live params merge
   *  under them — a variant's viewport must beat the story's own. */
  variantParams?: Omit<VariantSpec, 'extends'>;
  /** Group/kind, e.g. "Components/Button". */
  title: string;
  /** Story name within the group, e.g. "Primary". */
  name: string;
  /** Absolute path to the source file. Drives affected-story analysis;
   *  empty string when the platform can't report it (URL-list adapter). */
  componentPath: string;
  params: StoryParams;
}

export interface Snapshot {
  storyId: string;
  /** Copied from the StoryManifest: set only on a variant capture. */
  baseStoryId?: string;
  variant?: string;
  /** WebP-encoded. PNG is an intermediate, never stored. */
  image: Buffer;
  viewport: Viewport;
  capturedAt: string;
  /** Wall time for this story's capture, ms. */
  durationMs: number;
  /** Visible elements and their styles, from the same frame as `image`.
   *  Absent when structure capture failed or was disabled — it explains a
   *  failure, it never decides one. */
  structure?: StructureSnapshot;
  /** Present only when the settle wait hit its cap. */
  settle?: SettleReport;
}

export interface StructureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StructureElement {
  /** tag + (#id | [data-testid] | :nth-of-type) chain from <html>. */
  path: string;
  /** Index of the nearest kept ancestor in `elements`, null at the root. */
  parent: number | null;
  tag: string;
  id?: string;
  testId?: string;
  classes?: string[];
  role?: string;
  name?: string;
  text?: string;
  src?: string;
  rect: StructureRect;
  paintOrder: number;
  /** Compact: see effectiveStyle() in capture/structure.ts. */
  styles: Record<string, string>;
}

export interface StructureSnapshot {
  schema: 'juxtapose.structure/v1';
  viewport: Viewport;
  /** sha256 of the canonical JSON of `elements`. Equal ⇒ identical structure
   *  and styles, so a pixel difference is render drift. */
  structureHash: string;
  /** Full document height, from CDP. Greater than viewport.height means part
   *  of the page was never captured — PR (b)'s `below-fold` flag reads this. */
  contentHeight: number;
  elements: StructureElement[];
  truncated?: { kept: number; total: number };
}

export interface ChangedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One changed fact between two structure snapshots. `el` is a short human
 *  label (`button[name="Save"]`, `div#row-1`, `div.card`, or a trimmed path). */
export type Delta =
  | { kind: 'text'; el: string; from: string; to: string }
  | { kind: 'style'; el: string; prop: string; from: string; to: string }
  | { kind: 'attr'; el: string; attr: 'src' | 'role' | 'name'; from: string; to: string }
  | { kind: 'added'; el: string; rect: StructureRect }
  | { kind: 'removed'; el: string; rect: StructureRect }
  | { kind: 'moved'; el: string; dx: number; dy: number }
  | { kind: 'resized'; el: string; dw: number; dh: number }
  /** ≥3 contiguous elements after `after` moved by the same (dx, dy). */
  | { kind: 'shift'; after: string; dx: number; dy: number; count: number };

export type Classification =
  | 'identical'
  | 'render-drift'
  | 'dimension-change'
  | 'element-added'
  | 'element-removed'
  | 'reflow'
  | 'geometry'
  | 'text-only'
  | 'style-only'
  | 'attr-only'
  | 'mixed'
  | 'unknown';

/** Sub-tags of `style-only`, so "colour tweak" and "spacing change" read
 *  differently at a glance. */
export type StyleTag = 'color' | 'typography' | 'spacing' | 'border' | 'effects';

export type Flag =
  | 'element-removed'
  | 'text-changed'
  | 'large-reflow'
  | 'unexplained-pixels'
  /** The images differ but the pixel diff marked nothing: the change is below
   *  its tolerance, and the structural deltas are the change. */
  | 'sub-threshold'
  | 'structure-truncated'
  | 'no-baseline-structure'
  | 'no-current-structure'
  /** Either side's content is taller than the viewport: changes below the
   *  fold are invisible to both pixels and structure. */
  | 'below-fold'
  /** The current capture's settle wait hit its cap: the page may have been
   *  captured mid-update. The result's `settle.pending` says what was left. */
  | 'settle-timeout';

export type CauseKind =
  /** At least one changed file is in the story's import closure. */
  | 'in-closure'
  /** A changed file reaches every story: a root lockfile or a platform config dir. */
  | 'config'
  /** The closure was traced and no changed file is in it: the strongest
   *  "this is not your code" the tool can give, especially beside render-drift. */
  | 'none-in-closure'
  /** No --since, no manifest, git failed, or the story is not in the graph. */
  | 'unknown';

/** Why this story changed: the cheap link only (story → import closure →
 *  changed files). Matched CSS rules and source lines are later rows. */
export interface Cause {
  kind: CauseKind;
  /** At most 5, nearest first; posix paths relative to the project root. */
  files: Array<{ path: string; distance: number }>;
  /** `in-closure` only: the closure was not fully traced (a bundled chunk
   *  with no src, or a changed file the manifest never names), so the cause
   *  may be a file not listed. Absent, never false, when the trace was full. */
  partial?: true;
}

/** Tier-0: what changed, in a few hundred characters, with whether it
 *  explains every changed pixel. The whole output of `jux diff`. */
export interface StructuralVerdict {
  schema: 'juxtapose.verdict/v1';
  classification: Classification;
  /** Empty unless classification is `style-only` or `mixed`. */
  styleTags: StyleTag[];
  /** Templated, deterministic, ≤ 300 chars. */
  summary: string;
  /** The change with every element reduced to role|tag and no per-story
   *  tail, ≤ 160 chars: what stories sharing a `signature` have in common.
   *  Absent when there are no deltas. */
  change?: string;
  /** At most 20, and only the prefix that keeps the whole verdict within
   *  1,500 chars; `deltaCount` is the total. */
  deltas: Delta[];
  /** Counted after suppression: a child that only followed its parent's
   *  move or resize, and a style inherited from where it originated, are not
   *  deltas, nor is an added/removed element hidden by the other side's
   *  truncation; a shift run counts once. */
  deltaCount: number;
  /** Fraction of changed-region area intersecting some delta's element. */
  coverage: number;
  /** ≥ 0.98 | ≥ 0.5 | below. */
  explained: 'full' | 'partial' | 'none';
  /** The prefix that fits the 1,500-char verdict; `coverage` covers all. */
  unexplainedRegions: ChangedRegion[];
  flags: Flag[];
  /** Present only in `jux run --since`; absent from `jux diff`. */
  cause?: Cause;
  /** sha256 over the classification and the delta set with elements
   *  abstracted to role|tag, so two pages with the same change share one.
   *  Over the same post-suppression facts `deltaCount` counts. */
  signature: string;
  /** The exact command for tier-3 pixels. */
  escalate: { command: string };
}

export type DiffStatus = 'pass' | 'fail' | 'new' | 'stale' | 'skip';

export interface DiffResult {
  /** The capture key. */
  storyId: string;
  /** Set only on a variant capture, so reports can group without parsing keys. */
  baseStoryId?: string;
  variant?: string;
  /** Set only on a variant capture: what the variant sets (its resolved
   *  `extends` chain). Recorded for the same reason as `viewport` — a handoff
   *  can say the conditions it was captured under without re-enumerating. */
  variantParams?: Omit<VariantSpec, 'extends'>;
  status: DiffStatus;
  mismatchPixels: number;
  mismatchPercent: number;
  /** Bounding boxes of changed clusters. Empty unless status is 'fail'. */
  changedRegions: ChangedRegion[];
  /** The viewport the capture was taken at — what `changedRegions` coordinates
   *  are relative to. Absent only when the capture never produced a snapshot.
   *
   *  Recording it here is what lets a consumer describe a region spatially
   *  without re-enumerating stories to recover a per-story viewport override,
   *  which is both slow and wrong when the override exists. */
  viewport?: Viewport;
  /** Set when the capture or diff threw. status is 'fail' in that case. */
  error?: string;
  /** Tier-0 explanation of a failure. Present only when status is 'fail' and
   *  the current capture produced a structure; never consulted on pass. */
  structural?: StructuralVerdict;
  /** Present only when non-empty. Never changes `status`. */
  flags?: CaptureFlag[];
  /** Present only with the `settle-timeout` flag. */
  settle?: SettleReport;
  durationMs: number;
}

/** One change seen on several stories: the same signature on ≥2 failing
 *  results. Listing them is what turns 40 handoffs into one decision;
 *  approving by group is a later row. */
export interface RunGroup {
  signature: string;
  /** The shared change, as `<change> — N stories`: the verdict's `change`
   *  (elements as role|tag), not one page's labelled summary. */
  summary: string;
  /** ≥ 2, code-unit sorted. */
  storyIds: string[];
}

export interface RunReport {
  runId: string;
  branch: string;
  commitSha: string;
  /** What captured these pixels. Optional so a report written by an older
   *  version still parses. */
  env?: CaptureEnv;
  /** How many stories we captured vs how many exist. */
  capturedCount: number;
  totalCount: number;
  results: DiffResult[];
  summary: Record<DiffStatus, number>;
  /** Present when at least one signature is shared by ≥2 failing stories. */
  groups?: RunGroup[];
  durationMs: number;
  startedAt: string;
}

/** What rendered the pixels. Baselines from different environments are not
 *  comparable byte-for-byte, so recording this is what lets an all-red suite
 *  after a toolchain bump be reported as a bump rather than as N regressions. */
export interface CaptureEnv {
  /** Playwright's `browser.version()`, e.g. "151.0.7922.34". */
  browser: string;
  /** `${platform}-${arch}`, e.g. "darwin-arm64". */
  os: string;
  /** libvips, which encodes the WebP. Measured to move bytes far more readily
   *  than the browser does: a libvips bump changed all 17 example baseline
   *  hashes with zero changed pixels, while Chromium 149 -> 151 left 16 of 18
   *  byte-identical. */
  encoder: string;
}

export interface ApprovalMeta {
  commit: string;
  approvedBy: string;
  approvedAt: string;
  /** Absent on entries approved before this was recorded. Absent must not read
   *  as "matches": an unknown origin is unknown, not current. */
  env?: CaptureEnv;
  /** structureHash of the approved capture's sidecar. Absent when the capture
   *  had no structure, or was approved before sidecars existed. */
  structureHash?: string;
}

export interface BaselineEntry extends ApprovalMeta {
  /** sha256 of the baseline image bytes. Detects drift between manifest
   *  and store without downloading the image. */
  hash: string;
}

/** Committed to the repo. The source of truth for what "approved" means,
 *  regardless of which store holds the actual bytes. */
export interface BaselineManifest {
  version: 1;
  baselines: Record<string, BaselineEntry>;
}

/** One page for the `urls` platform. */
export interface UrlEntry {
  /** Stable id; used as the story id and for file names. */
  id: string;
  /** Absolute, or relative to --origin. */
  url: string;
  params?: StoryParams;
  /** Same as `params.variants`; the two are merged, and these win. */
  variants?: Record<string, VariantSpec | false>;
}

/** Project config, from juxtapose.config.{ts,js,json} or package.json#juxtapose. */
export interface ProjectConfig {
  /** Which workbench. Autodetected when omitted. */
  platform?: 'storybook' | 'ladle' | 'urls';
  /** Pages to capture when `platform` is 'urls'. */
  urls?: UrlEntry[];
  /** Where the built static workbench lives. */
  buildDir?: string;
  /** Capture against an already-running dev server instead of building. */
  origin?: string;
  /** Parallel pages. Default 8. More is not better — CPU saturation
   *  causes render timeouts. Scale to core count. */
  concurrency?: number;
  /** Reuse warm pages and switch stories in place instead of navigating.
   *  Much faster, but warm and cold captures do not currently produce
   *  identical pixels, which makes results depend on queue order under a
   *  byte-exact hash. Opt in only if you have measured it on your suite. */
  warmSwitch?: boolean;
  viewport?: Viewport;
  threshold?: number;
  minDiffPercent?: number;
  /** Project-wide settle options; a story's `settle` is layered over them. */
  settle?: SettleParams;
  /** Project-wide `waitForSelector`; a story's own wins. */
  waitForSelector?: string;
  /** Project-wide `delay`, ms; a story's own wins. */
  delay?: number;
  /** Variants every story gets, by name. A story's own variant of the same
   *  name wins; a story sets one to `false` to opt out. Applies to every
   *  platform, the urls list included. */
  variants?: Record<string, VariantSpec | false>;
  storage?: StorageConfig;
  /** `jux mcp` settings. */
  mcp?: {
    /** Snap calls that may capture at once (1-16). Default: half the CPU
     *  cores, 1 to 4; the
     *  `--concurrency` flag overrides it. */
    concurrency?: number;
  };
}

export type StorageConfig =
  | { kind: 'git'; dir?: string }
  | { kind: 'fs'; dir: string }
  | { kind: 's3'; bucket: string; prefix?: string; endpoint?: string };

/** Baseline persistence. The manifest always lives in git; only the image
 *  bytes vary by implementation. */
export interface BaselineStore {
  get(storyId: string): Promise<Buffer | null>;
  put(storyId: string, image: Buffer, meta: ApprovalMeta): Promise<void>;
  remove(storyId: string): Promise<void>;
  readManifest(): Promise<BaselineManifest>;
  writeManifest(manifest: BaselineManifest): Promise<void>;
  /** Optional: stores that can hold the gzipped structure sidecar. */
  putStructure?(storyId: string, gz: Buffer): Promise<void>;
  getStructure?(storyId: string): Promise<Buffer | null>;
  /** Optional: where the baseline image lives on disk, for stores that keep
   *  one. The handoff hands it to `jux diff … --crops`. */
  locate?(storyId: string): string | undefined;
}
