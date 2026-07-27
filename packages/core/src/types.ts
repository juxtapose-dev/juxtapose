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

/** Committed to the repo. The source of truth for what "approved" means,
 *  regardless of which store holds the actual bytes. */
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
  viewport?: Viewport;
  threshold?: number;
  minDiffPercent?: number;
  /** Glob patterns of story ids to never capture. */
  ignore?: string[];
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
