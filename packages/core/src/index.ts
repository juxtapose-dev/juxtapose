export type {
  StoryParams,
  Viewport,
  StoryManifest,
  Snapshot,
  ChangedRegion,
  DiffStatus,
  DiffResult,
  RunReport,
  ApprovalMeta,
  BaselineEntry,
  BaselineManifest,
  ProjectConfig,
  StorageConfig,
  BaselineStore,
} from './types.js';

export type { Platform, EnumerateTarget, SettleContext } from './platform.js';
export { navigateToStory } from './url-platform.js';

export {
  hashImage,
  resolveStatus,
  toDiffStatus,
  type BaselineStatus,
  type AncestryCheck,
} from './baseline/status.js';
export { GitBaselineStore, encodeStoryId } from './baseline/git-store.js';

export { createAncestryCheck, alwaysAncestor } from './git/ancestry.js';

export {
  armSettle,
  drain,
  waitForSelector,
  waitForPaint,
  FREEZE_ANIMATIONS_CSS,
  DOM_IDLE_MS,
  DOM_IDLE_TIMEOUT_MS,
} from './capture/settle.js';
export { captureStory, type CaptureDeps } from './capture/capture.js';
export {
  deterministicLaunchOptions,
  DETERMINISTIC_CHROMIUM_ARGS,
  type LaunchOptions,
} from './capture/launch.js';
export {
  capturePool,
  DEFAULT_CONCURRENCY,
  type PoolOptions,
  type CaptureOutcome,
} from './capture/pool.js';

export {
  diffImages,
  resolveThreshold,
  resolveMinDiffPercent,
  type DiffOutput,
} from './diff/diff.js';
export { computeChangedRegions } from './diff/regions.js';

export {
  resolveAffected,
  type AffectedOptions,
  type AffectedResult,
} from './analysis/affected.js';

export {
  runCapture,
  DEFAULT_VIEWPORT,
  type RunOptions,
  type RunArtifact,
} from './run/run.js';

export {
  buildHandoffPrompt,
  describeRegion,
  type HandoffPayload,
} from './agent/handoff.js';

export { buildComment, COMMENT_MARKER, type CommentOptions } from './report/comment.js';
export {
  resolveGitHubContext,
  postComment,
  type GitHubContext,
} from './report/github.js';

export { buildHtmlReport, type HtmlReportOptions } from './report/html.js';
