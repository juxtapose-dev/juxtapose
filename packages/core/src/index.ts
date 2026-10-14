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
  VariantSpec,
  ColorScheme,
  Viewport,
  StoryManifest,
  Snapshot,
  StructureSnapshot,
  StructureElement,
  StructureRect,
  CaptureEnv,
  ChangedRegion,
  Delta,
  Classification,
  StyleTag,
  Flag,
  StructuralVerdict,
  Cause,
  CauseKind,
  DiffStatus,
  DiffResult,
  RunReport,
  RunGroup,
  ApprovalMeta,
  BaselineEntry,
  BaselineManifest,
  ProjectConfig,
  UrlEntry,
  StorageConfig,
  BaselineStore,
  SettleParams,
  NetworkParams,
  SettleReport,
  CaptureFlag,
} from './types.js';

// Implementing a platform adapter.
export type { Platform, EnumerateTarget, SettleContext } from './platform.js';
export { navigateToStory } from './url-platform.js';
export { createUrlPlatform } from './platforms/urls.js';
export { waitForSelector } from './capture/settle.js';

// Per-story capture variants: expansion after enumeration, and selection by a
// base id (story + all variants) or a capture key (one capture).
export {
  expandVariants,
  selectByStoryId,
  captureKey,
  platformStoryId,
  VariantConfigError,
  VARIANT_NAME,
} from './capture/variants.js';
// Settle options: validation and layering shared by the CLI, the MCP server
// and the review server, so a bad value is reported the same way everywhere.
export {
  checkSettle,
  checkPatterns,
  checkProjectSettle,
  isSettleTimeout,
  settleFlag,
  SettleConfigError,
  DEFAULT_SETTLE_TIMEOUT_MS,
  MAX_SETTLE_TIMEOUT_MS,
  DEFAULT_NETWORK_IGNORE,
  type SettleLayer,
} from './capture/settle-options.js';
export { checkNetwork } from './capture/network-policy.js';
export {
  discoverParams,
  prepareCaptures,
  type PrepareOptions,
} from './capture/discover.js';

// Implementing a baseline store. `encodeStoryId` matters for anyone building
// keys from a story id — they are platform-supplied and not path-safe.
export { GitBaselineStore, encodeStoryId } from './baseline/git-store.js';
// hashImage is exported because anything comparing against a manifest entry
// must use the same function the manifest was written with, not its own copy.
export { hashImage } from './baseline/status.js';
export type { BaselineStatus, AncestryCheck } from './baseline/status.js';
export { createAncestryCheck, alwaysAncestor } from './git/ancestry.js';

// Structure sidecars: read and write the gzipped snapshot beside an image.
export { encodeStructure, decodeStructure } from './capture/structure.js';
// Approving a run capture with its sidecar: every approval path (CLI approve,
// init, the review server) goes through this so they cannot disagree.
export {
  approveCapture,
  readRunStructure,
  type RunStructure,
} from './baseline/approve.js';
// Structural diff: two sidecars + a pixel diff → the tier-0 verdict.
export {
  structuralDiff,
  structuralDiffWithCoverage,
  type StructuralDiffInput,
} from './diff/structural.js';
export { compareSnaps, type SnapSide, type SnapComparison } from './diff/compare.js';
// Tier-3 crops: two images + regions → side-by-side PNG strips, no browser.
export { renderCrops, MAX_CROPS, MAX_CROP_SIDE, type Crop } from './diff/crops.js';
export { describeDelta, describeDeltas } from './diff/structural/summary.js';
export { compareCodeUnits } from './diff/structural/deltas.js';
export { shellQuote } from './shell-quote.js';

// Driving a run.
export {
  runCapture,
  DEFAULT_VIEWPORT,
  type RunOptions,
  type RunArtifact,
} from './run/run.js';
export { computeGroups } from './run/groups.js';

// Per-phase timings, so a slow run can say which phase was slow.
export { phases, formatPhases, type Phases } from './run/phases.js';
export {
  snapPage,
  snapPages,
  type SnapOptions,
  type SnapResult,
  type SnapPagesOptions,
  type SnapPageResult,
} from './capture/snap.js';
export { deterministicLaunchOptions, type LaunchOptions } from './browser/flags.js';
export { chromeArgs, PARITY_CHROMIUM_ARGS } from './browser/flags.js';

// The browser driver: our own CDP client over chrome-headless-shell. Adapters
// consume `Page` (see its doc comment for which members are stable).
// `Browser` and `BrowserContext` are types only: `acquireBrowser` is the one
// place that decides where a Browser comes from, so `Browser.launch` is not
// public.
export type { Browser, BrowserContext } from './browser/browser.js';
export { BrowserDiedError } from './browser/browser.js';
export { TargetClosedError } from './browser/cdp.js';
export { PageCrashedError, TimeoutError, type Page } from './browser/page.js';
export { acquireBrowser, type AcquireOptions } from './browser/acquire.js';
export {
  connectWarmBrowser,
  daemonEnabled,
  daemonIdleMinutes,
  daemonKeyFor,
  daemonStatus,
  listDaemons,
  startDaemon,
  stopAllDaemons,
  stopDaemon,
  CI_ENV_VARS,
  type WarmOptions,
  type SpawnArgs,
  type DaemonStop,
  type StopResult,
  type CommandReader,
} from './browser/daemon/client.js';
export { daemonSupported, type DaemonState } from './browser/daemon/state.js';
export {
  resolveChrome,
  juxCacheDir,
  juxStateDir,
  noBrowserMessage,
  NO_BROWSER_MESSAGE,
  type ChromeSource,
  type ResolvedChrome,
} from './browser/resolve.js';
export {
  installChrome,
  proxyReexecArgs,
  stderrProgress,
  type InstallOptions,
  type InstallResult,
} from './browser/install.js';
export { CHROME_VERSION, CHROME_PINS, chromePlatform } from './browser/pins.js';
export { assertCssSelector } from './browser/selectors.js';
export {
  resolveAffected,
  resolveAffectedFromPaths,
  gitIsCommit,
  type AffectedOptions,
  type AffectedResult,
} from './analysis/affected.js';
// Cause: the story's import closure intersected with the changed files.
export {
  buildCauseIndex,
  prepareCause,
  type CauseIndex,
  type CauseSources,
  type ChangedFile,
} from './analysis/cause.js';

// Reporting on one.
export {
  buildHandoffPrompt,
  describeCause,
  describeVariant,
  handoffVariant,
  type HandoffPayload,
} from './agent/handoff.js';
export { buildComment, type CommentOptions } from './report/comment.js';
export { isRunReport, parseRunReport } from './report/run-report.js';
export { buildHtmlReport, type HtmlReportOptions } from './report/html.js';
export {
  formatPercent,
  captureLabel,
  countStories,
  hasVariants,
  type CaptureRef,
} from './report/format.js';
export {
  resolveArtifactUrl,
  resolveGitHubContext,
  postComment,
  type GitHubContext,
} from './report/github.js';
