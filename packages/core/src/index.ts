// The public surface of @juxtapose/core.
//
// Everything here is a semver commitment once this publishes, so it is chosen
// rather than accumulated. The settle pipeline, the diff internals and the
// worker pool are deliberately NOT exported: CLAUDE.md describes them as
// load-bearing and easy to break, and exporting them invites downstream code
// to pin exactly the parts that most need freedom to change.
//
// If you are writing a third-party adapter or baseline store, the types and
// helpers below are what you need. If something is missing for that, the seam
// needs widening — say so rather than reaching into the package.

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

// Implementing a platform adapter.
export type { Platform, EnumerateTarget, SettleContext } from './platform.js';
export { navigateToStory } from './url-platform.js';
export { waitForSelector } from './capture/settle.js';

// Implementing a baseline store. `encodeStoryId` matters for anyone building
// keys from a story id — they are platform-supplied and not path-safe.
export { GitBaselineStore, encodeStoryId } from './baseline/git-store.js';
// hashImage is exported because anything comparing against a manifest entry
// must use the same function the manifest was written with, not its own copy.
export { hashImage } from './baseline/status.js';
export type { BaselineStatus, AncestryCheck } from './baseline/status.js';
export { createAncestryCheck, alwaysAncestor } from './git/ancestry.js';

// Driving a run.
export {
  runCapture,
  DEFAULT_VIEWPORT,
  type RunOptions,
  type RunArtifact,
} from './run/run.js';
export { deterministicLaunchOptions, type LaunchOptions } from './capture/launch.js';
export {
  resolveAffected,
  resolveAffectedFromPaths,
  type AffectedOptions,
  type AffectedResult,
} from './analysis/affected.js';

// Reporting on one.
export { buildHandoffPrompt, type HandoffPayload } from './agent/handoff.js';
export { buildComment, type CommentOptions } from './report/comment.js';
export { buildHtmlReport, type HtmlReportOptions } from './report/html.js';
export { formatPercent } from './report/format.js';
export {
  resolveArtifactUrl,
  resolveGitHubContext,
  postComment,
  type GitHubContext,
} from './report/github.js';
