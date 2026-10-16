import type { Viewport } from './browser/types.js';
import type { StructureCaptureTimings } from './capture/structure.js';
export type { StructureCaptureTimings } from './capture/structure.js';
// Core data model. Deliberately free of any platform (Storybook/Ladle) types —
// adapters map their world onto these.

// Configuration types are derived from config/schema.ts, the one source the
// published JSON Schema and the runtime validation also come from.
import type {
  JuxtaposeParameters,
  NetworkParams,
  ProjectConfig,
  RecheckMode,
  SettleParams,
  StorageConfig,
  StoryOverride,
  UrlEntry,
  VariantSpec,
} from './config/schema.js';
export type {
  JuxtaposeParameters,
  NetworkParams,
  ProjectConfig,
  RecheckMode,
  SettleParams,
  StorageConfig,
  StoryOverride,
  UrlEntry,
  VariantSpec,
};

/** Per-story tuning, read from the platform's story parameters: what
 *  `parameters.juxtapose` accepts. */
export type StoryParams = JuxtaposeParameters;

/** Something about a capture that doesn't fail it but should be read.
 *  `settle-timeout`: the settle wait hit its cap. `settle-fallback`: the
 *  event-driven wait could not run and a weaker one stood in.
 *  `renderer-reused`: the story ran in a renderer process an earlier story
 *  used, so its pixels can depend on that story (#153). */
export type CaptureFlag = SettleFlag | 'renderer-reused';

/** The flags a settle report raises; the verdict carries these too. */
export type SettleFlag = 'settle-timeout' | 'settle-fallback';

/** Present on a capture whose settle wait hit its cap (`timeout`), or could
 *  not run as designed (`fallback`). */
export type SettleReport =
  | {
      status: 'timeout';
      /** The cap that was hit, ms. */
      timeoutMs: number;
      /** What was still pending at the cap, one description per item, such
       *  as `1 request to /api/feed in flight (Fetch)`. Never empty. */
      pending: string[];
      /** The counted requests still in flight, with their full URLs and CDP
       *  resource types (`pending` shows paths only). At most
       *  MAX_PENDING_REQUESTS; `requestsOmitted` counts the rest. Absent on
       *  reports written before it was recorded. */
      requests?: PendingRequest[];
      requestsOmitted?: number;
      /** The origin of the page, so a request to another one can be told
       *  from the page's own. */
      origin?: string;
    }
  | {
      status: 'fallback';
      /** Why the event-driven wait could not run. Never empty. */
      pending: string[];
    };

/** A request still in flight at the settle cap. */
export interface PendingRequest {
  url: string;
  /** CDP resource type (`Image`, `Fetch`, `Document`...); `Other` if unknown. */
  type: string;
}

export type ColorScheme = 'light' | 'dark';

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
  /** Set when the project config's `stories` matched this capture: the merged
   *  override already folded into `params`. Kept apart because live params
   *  are read after render and must not undo it. */
  override?: StoryOverride;
  /** Set when a config override (not the story) skips this capture: the
   *  globs that matched, so the report can say who skipped it. */
  skippedBy?: string[];
}

/**
 * Wall time per phase of one capture, ms to 0.1. Measurement only: the clock is
 * read around calls the capture already makes, so it cannot change a pixel.
 * The named phases plus `other` sum to `durationMs` (within rounding).
 */
export interface CaptureTimings {
  /** The platform's showStory (goto and its ready signal) or switchStory. */
  navigate: number;
  /** The data: URL hop into a new renderer process (issue #153); 0 on a
   *  page's first story or with freshRenderer off. */
  freshRenderer: number;
  /** Waiting for the story to render: the platform's settle and the live
   *  params read after it. */
  render: number;
  /** Generic settling: waitForSelector, the idle wait (and the second one
   *  when work landed in the paint barrier), the fixed delay. */
  settle: number;
  /** The paint barrier: layer re-raster, two rAFs, the moved-since check. */
  paint: number;
  structure: number;
  /** page.screenshot: the CDP capture, Chrome's lossless WebP encode and
   *  transfer included. */
  screenshot: number;
  /** Dropping the ICC chunk from Chrome's WebP (encoder.ts). Before
   *  native capture, PNG to lossless WebP in sharp. */
  encode: number;
  /** The remainder: page setup, viewport and scheme, network policy, the
   *  animation freeze, the renderer check. */
  other: number;
}

export interface Snapshot {
  /** Effective live per-story comparison policy, if declared. */
  comparison?: StoryParams['comparison'];
  /** Effective renderer settings used for this capture. */
  renderer?: Required<NonNullable<StoryParams['renderer']>>;
  storyId: string;
  /** Copied from the StoryManifest: set only on a variant capture. */
  baseStoryId?: string;
  variant?: string;
  /** Lossless WebP, as Chrome encoded it, minus the ICC chunk. */
  image: Buffer;
  viewport: Viewport;
  capturedAt: string;
  /** Wall time for this story's capture, ms. */
  durationMs: number;
  /** Where `durationMs` went. */
  timings?: CaptureTimings;
  /** Optional diagnostic breakdown within timings.structure, in milliseconds.
   *  Recorded only with JUX_STRUCTURE_PROFILE=1; not additional capture time. */
  structureTimings?: StructureCaptureTimings;
  /** Visible elements and their styles, from the same frame as `image`.
   *  Absent when structure capture failed or was disabled — it explains a
   *  failure, it never decides one. */
  structure?: StructureSnapshot;
  /** Present only when the settle wait hit its cap. */
  settle?: SettleReport;
  /** Set when the capture ran in a renderer process an earlier capture in
   *  the run used: the fresh-renderer hop did not get a new one (#153). */
  rendererReused?: true;
}

export interface StructureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How an element reaches a third-party URL. */
export const EXTERNAL_KINDS = ['image', 'background', 'frame'] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];

/** A resource from an origin other than the page's own. The query and hash are
 *  dropped: sidecars are committed, and a signed URL's query is a credential. */
export interface ExternalRef {
  kind: ExternalKind;
  /** `https://picsum.photos`. */
  origin: string;
  /** The URL's path, without query or hash. */
  path: string;
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
  /** Third-party resources this element paints or embeds: where `src` keeps
   *  only a file name (the origin changes per run), this keeps the origin. Not
   *  part of `structureHash`. Absent when there are none. */
  external?: ExternalRef[];
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
  | 'settle-timeout'
  /** The current capture's event-driven settle wait could not run; a
   *  fonts/images/quiet-DOM wait stood in. */
  | 'settle-fallback';

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
  /** Present only when an opt-in policy accepted different exact hashes.
   * The approved baseline is unchanged. Absent on exact passes. */
  comparison?: {
    method: 'pixelmatch';
    version: '6.0.0';
    threshold: number;
    includeAA: false;
    baselineHash: string;
    rawMismatchPixels: number;
  };
  /** Evidence from bounded cache-pulse and fresh-renderer retries, independent of recheck. */
  rendererRetry?: {
    outcome: 'resolved' | 'mismatch' | 'unconfirmed' | 'cap';
    initialRenderer: Required<NonNullable<StoryParams['renderer']>>;
    initialHash: string;
    /** Present when cache-pulse recovery produced a capture. */
    cachePulseHash?: string;
    cachePulseError?: string;
    resolvedBy?: 'cache-pulse' | 'fresh';
    freshHash?: string;
    reason?: string;
  };
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
  /** Set on a 'skip' that the project config's `stories` asked for: the
   *  matching globs, most specific last. */
  skippedBy?: string[];
  /** sha256 of the current capture's WebP: the same hash `baseline/` compares,
   *  so two runs are byte-identical per story exactly when these match. Absent
   *  on skipped and errored stories (nothing was captured) and on reports
   *  written before it was recorded. */
  hash?: string;
  /** Set when a new or failing story was captured a second time and the two
   *  hashes differed: the capture is nondeterministic, so approving it would
   *  baseline a flake. `jux approve` refuses it unless told otherwise.
   *  `unconfirmed` (a reason) means the second capture produced no image, so
   *  stability is unknown and approval is refused the same way. Absent
   *  when the two captures matched, and for every pass, skip and stale. */
  unstable?: { hashes: string[]; unconfirmed?: string };
  /** A new or failing story the run did not capture a second time, because
   *  `recheck` is "off", or is "new" and this one failed (#195). Nothing is
   *  known about its stability yet, so `jux approve` takes the confirming
   *  capture itself before writing a baseline. Always set with an `unstable`
   *  placeholder (`unconfirmed` starting "not rechecked") so older approvers
   *  refuse it. Absent on every pass, skip and
   *  stale, and on stories the recheck covered. */
  unrechecked?: true;
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
  /** Set on a 'fail' whose approved image is not on this machine (not in the
   *  baseline cache): the hash mismatch stands, the pixel diff could not run,
   *  and `structural` is all there is to explain it. */
  baselineImage?: 'unavailable';
  /** Set on a 'fail' whose baseline was approved with another encoder: its
   *  entry's `env.encoder` ("8.17.3", the libvips of jux 0.20 and earlier),
   *  or "unrecorded" for an entry with no `env`. Its hash cannot match
   *  whatever the pixels are, so the run reports the encoder change and the
   *  fix (re-approve) rather than a regression. */
  baselineEncoder?: string;
  /** Tier-0 explanation of a failure. Present only when status is 'fail' and
   *  the current capture produced a structure; never consulted on pass. */
  structural?: StructuralVerdict;
  /** Present only when non-empty. Never changes `status`. */
  flags?: CaptureFlag[];
  /** Present only with the `settle-timeout` flag. */
  settle?: SettleReport;
  /** Why an `unstable` story's two captures differed, and the config change
   *  that would fix it. Present only with `unstable` (and only when the
   *  second capture produced an image to compare). */
  flake?: Flake;
  durationMs: number;
  /** Per-phase split of `durationMs`; absent on reports written before it
   *  existed, on skips, and on a capture that threw. */
  timings?: CaptureTimings;
  /** Optional diagnostic breakdown within timings.structure, in milliseconds.
   *  Recorded only with JUX_STRUCTURE_PROFILE=1; not additional capture time. */
  structureTimings?: StructureCaptureTimings;
}

/** Why two captures of one story differ. Ordered as the classifier checks
 *  them: the first confident match wins. */
export const FLAKE_CAUSES = [
  'settle-timeout',
  'external-image',
  'embed',
  'order-dependence',
  'async-element',
  'clock',
  'random-content',
  'render-drift',
  'unknown',
] as const;
export type FlakeCause = (typeof FLAKE_CAUSES)[number];

export const FLAKE_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type FlakeConfidence = (typeof FLAKE_CONFIDENCES)[number];

/** Which capture an element appears in, for `async-element`. */
export type FlakeSide = 'first' | 'second';

/** The facts behind a cause: enough for a one-line message and for an agent
 *  to decide. Only the fields that apply are set. */
export interface FlakeEvidence {
  /** A CSS selector for the element, valid in `mask` and `waitForSelector`. */
  selector?: string;
  /** The third-party resource, without query or hash. */
  url?: string;
  host?: string;
  /** Changed text, first capture then second. */
  before?: string;
  after?: string;
  /** What the settle wait was still waiting on at the cap. */
  pending?: string[];
  /** `async-element`: the capture the element is missing from is the other. */
  presentIn?: FlakeSide;
  /** `order-dependence`: the captures that ran in a renderer process an
   *  earlier story had used. */
  reusedIn?: FlakeSide[];
  /** `render-drift` and `unknown`: how much of the frame differs. */
  mismatchPercent?: number;
  flags?: CaptureFlag[];
}

/** An exact patch for `juxtapose.config.json`: merge it in (arrays append).
 *  Story-scoped under `stories` where the option exists per story; a
 *  project-only option (`freshRenderer`) or a fix shared by a group of stories
 *  sits at the top level. */
export interface FlakeFix {
  stories?: Record<string, StoryOverride>;
  freshRenderer?: boolean;
  network?: NetworkParams;
}

/** Several unstable stories with one project-level fix: the same cause and
 *  host, or the same project-scoped cause. */
export interface FlakeGroup {
  cause: FlakeCause;
  /** `external-image` and `embed`: the third-party host they share. */
  host?: string;
  /** At least 3, code-unit sorted. */
  storyIds: string[];
  /** One patch for the whole project instead of one per story. */
  fix: FlakeFix;
}

export interface Flake {
  cause: FlakeCause;
  confidence: FlakeConfidence;
  evidence: FlakeEvidence;
  /** Null when no config change helps: `render-drift`, `unknown`. */
  fix: FlakeFix | null;
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
  /** The recheck mode the run used, after the config and the call were
   *  layered. "off" explains why no story has a `flake`. Absent on
   *  reports written before the option existed (which always rechecked
   *  "changed"). */
  recheck?: RecheckMode;
  summary: Record<DiffStatus, number>;
  /** Present when at least one signature is shared by ≥2 failing stories. */
  groups?: RunGroup[];
  /** Present when at least 3 unstable stories share a project-level fix. */
  flakeGroups?: FlakeGroup[];
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
  /** What encodes the WebP: `CAPTURE_ENCODER` ("chrome-webp-lossless") since
   *  Chrome encodes it, so its libwebp moves with `browser`. Before that, the
   *  libvips version sharp encoded with ("8.17.3"). Kept as its own field
   *  because the encoder moves bytes far more readily than the browser does:
   *  a libvips bump changed all 17 example baseline hashes with zero changed
   *  pixels, while Chromium 149 -> 151 left 16 of 18 byte-identical. */
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
  /** Generated readable compact structure file, relative to the project root. */
  structureFile?: string;
  /** SHA-256 of the complete file bytes; mismatched evidence is never used. */
  structureFileHash?: string;
  /** sha256 of the baseline image bytes. Detects drift between manifest
   *  and store without downloading the image. */
  hash: string;
  /** Legacy inline evidence. New approvals use structureFile; readers retain
   * compatibility so migration never requires recapturing or approving. */
  structure?: Omit<StructureSnapshot, 'structureHash'>;
}

/** Committed to the repo. The source of truth for what "approved" means,
 *  regardless of which store holds the actual bytes. */
export interface BaselineManifest {
  /** Generated-file guidance; excluded from all image/structure hashes. */
  $comment?: string;
  /** Always written as 1 (an older reader accepts only 1); 2 is read only. */
  version: 1 | 2;
  baselines: Record<string, BaselineEntry>;
}

/**
 * What a store can say about a story's baseline image. A manifest hash does
 * not imply the bytes are on this machine (the default store keeps images in
 * a local cache that CI restores), so "no image" is a normal answer with a
 * reason, not an error.
 */
export type BaselineImageLookup =
  | { kind: 'found'; image: Buffer }
  | {
      kind: 'unavailable';
      reason: 'no-manifest-entry' | 'not-in-cache';
      /** The approved hash the missing image would have had. */
      hash?: string;
    };

/** Baseline persistence. The manifest always lives in git; only the image
 *  bytes vary by implementation. */
export interface BaselineStore {
  /** Optional bulk approval scope. Manifest changes become durable only after
   * the callback succeeds and the returned promise resolves. Images may be
   * written earlier. Use the supplied store only inside the callback. */
  batch?(action: (store: BaselineStore) => Promise<void>): Promise<void>;
  get(storyId: string): Promise<Buffer | null>;
  /** Optional: cache an image by its hash without touching the manifest. A
   *  passing run calls it so the cache fills from captures that match. */
  keepImage?(image: Buffer): Promise<void>;
  /** Optional: `get` with the reason an image is missing. */
  lookup?(storyId: string): Promise<BaselineImageLookup>;
  put(storyId: string, image: Buffer, meta: ApprovalMeta): Promise<void>;
  remove(storyId: string): Promise<void>;
  readManifest(): Promise<BaselineManifest>;
  writeManifest(manifest: BaselineManifest): Promise<void>;
  /** Optional: stores that can hold the structure sidecar (readable JSON from
   *  `formatStructure`; legacy sidecars are gzip, `decodeStructure` takes both). */
  putStructure?(storyId: string, gz: Buffer): Promise<void>;
  getStructure?(storyId: string): Promise<Buffer | null>;
  /** Optional: where the baseline image lives on disk, for stores that keep
   *  one. The handoff hands it to `jux diff … --crops`. */
  locate?(storyId: string): string | undefined;
}
