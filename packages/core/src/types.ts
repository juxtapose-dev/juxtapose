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
}

export interface Viewport {
  width: number;
  height: number;
}

/** One capturable story, normalised across platforms. */
export interface StoryManifest {
  /** Stable, URL-safe. Platform-native id (Storybook's `id`, Ladle's key). */
  storyId: string;
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
  /** WebP-encoded. PNG is an intermediate, never stored. */
  image: Buffer;
  viewport: Viewport;
  capturedAt: string;
  /** Wall time for this story's capture, ms. */
  durationMs: number;
}

export interface ChangedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DiffStatus = 'pass' | 'fail' | 'new' | 'stale' | 'skip';

export interface DiffResult {
  storyId: string;
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
  durationMs: number;
}

export interface RunReport {
  runId: string;
  branch: string;
  commitSha: string;
  /** How many stories we captured vs how many exist. */
  capturedCount: number;
  totalCount: number;
  results: DiffResult[];
  summary: Record<DiffStatus, number>;
  durationMs: number;
  startedAt: string;
}

export interface ApprovalMeta {
  commit: string;
  approvedBy: string;
  approvedAt: string;
}

export interface BaselineEntry extends ApprovalMeta {
  /** sha256 of the baseline image bytes. Detects drift between manifest
   *  and store without downloading the image. */
  hash: string;
}

/** Committed to the repo. Hashes rather than images, so a green run compares
 *  two strings instead of fetching and decoding a baseline. */
export interface BaselineManifest {
  version: 1;
  baselines: Record<string, BaselineEntry>;
}

/** Project config, from juxtapose.config.{ts,js,json} or package.json#juxtapose. */
export interface ProjectConfig {
  /** Which workbench. Autodetected when omitted. */
  platform?: 'storybook' | 'ladle';
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
  storage?: StorageConfig;
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
}
