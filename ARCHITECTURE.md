# Architecture

Visual regression testing for component workbenches. Captures screenshots of
every story, diffs them against baselines, and tells you what changed.

The core owns capture, comparison and baseline storage. Storybook and Ladle
adapters supply workbench-specific navigation and readiness; URL-list projects
use the same capture pipeline. Local use needs no hosted service: image hashes
and readable structure metadata are committed, while baseline images live in a
local cache by default. CLI commands expose JSON for automation.

## Package layout

```
packages/
  core/               @juxtapose/core        capture (own CDP driver in browser/), diff, storage, analysis — no platform knowledge
  adapter-storybook/  @juxtapose/adapter-storybook   index.json enumeration + preview channel driver
  adapter-ladle/      @juxtapose/adapter-ladle       meta.json enumeration + Ladle's ready signal
  cli/                @juxtapose/cli         `jux` — init, run, approve, check, handoff
  server/             @juxtapose/server      local review API; the addon is a skin over it
  storybook/          @juxtapose/storybook   panel, test provider, sidebar decoration, watch mode
```

`core` never imports an adapter. Adapters depend on `core` for types only. The
CLI resolves an adapter at runtime from config or autodetection.

## The platform adapter seam

Everything Storybook-specific reduces to a handful of operations. Two of them —
showing a story and waiting for it to render — are the whole of it; the rest is
metadata the core needs to do its own work.

```ts
interface Platform {
  readonly name: string;
  /** Workbench-owned top-level containers, omitted from component diff facts. */
  readonly structureContextIds?: readonly string[];
  /** Is this the platform in use here? Drives autodetection. */
  detect(target: EnumerateTarget): Promise<boolean>;
  /** Discover stories. Storybook: index.json. Ladle: meta.json. */
  enumerate(target: EnumerateTarget): Promise<StoryManifest[]>;
  /** Get a story on screen, however this platform does that. */
  showStory(page: Page, storyId: string, baseUrl: string): Promise<void>;
  previewUrl(baseUrl: string): string;
  /** Wait until a story has finished rendering. The hard part. */
  settle(page: Page, ctx: SettleContext): Promise<void>;

  /** Where config lives, so a change there can force a full run. */
  readonly configDirs: readonly string[];
  readonly storyFileGlobs: readonly string[];

  /** Optional: a human-visitable URL, for reports. Not the capture path. */
  storyUrl?(baseUrl: string, storyId: string): string;
  /** Optional: switch story in a warm page without a navigation. */
  switchStory?(page: Page, storyId: string, ctx: SettleContext): Promise<boolean>;
  /** Optional: read per-story params the static index dropped. */
  readLiveParams?(page: Page, storyId: string): Promise<StoryParams | undefined>;
}
```

The optional methods are recoveries rather than requirements. `switchStory`
is an optimization — a platform without it still works, just slower, because
the pool falls back to `goto`. `readLiveParams` exists because Storybook
serializes only a whitelist of parameters into `index.json`, so `skip` and
per-story viewports are invisible until you ask the running preview. Ladle
needs neither: its `meta` is statically extracted and complete.

Storybook declares `storybook-root` as structural context. Capture retains the
raw container for evidence, but agent-facing structural diffs omit its own
deltas and shorten descendant labels to the component. Children inherit its
font/color evidence; sibling portals remain included. Context metadata from a
new capture also applies to older baselines, so no baseline migration is needed.
Framework-only paint changes remain unexplained pixel differences, rather than
being hidden or counted as component changes. Existing saved verdicts are not
rewritten; rerun capture to generate the new explanation.

## Data model

Carried over almost unchanged from the original, which got this right. The
platform-specific leakage was confined to `StoryManifest`.

- **`StoryManifest`** — `{ storyId, title, name, componentPath, params }`.
  `componentPath` is the absolute path to the source file; it is what makes
  affected-story analysis possible. Adapters populate it.
- **`Snapshot`** — captured image + viewport + timestamp. Stored as WebP.
- **`DiffResult`** — `pass | fail | new | stale | skip`, mismatch pixels and
  percent, plus `changedRegions` (bounding boxes of changed clusters, merged
  with an 8px gap tolerance so one logical change is one box, not 400).
- **`RunReport`** — the run envelope. This is the JSON agents consume.
- **`BaselineManifest`** — `storyId → { hash, commit, approvedAt, approvedBy }`.
  Committed to the repo. This is the source of truth for what "approved" means.

## Capture: the settle pipeline

This is where visual testing lives or dies. A flaky settle produces false diffs,
and false diffs train people to ignore the tool. The pipeline, in order:

1. **Viewport** — set only if changed from the last story on this page (skips a
   CDP round-trip).
2. **Idle detector** — once per page, before its first navigation, an init
   script (`Page.addScriptToEvaluateOnNewDocument`) wraps timers, animation
   frames and posted messages and counts DOM mutations, so it is watching
   before any page script runs. CDP `Network` events count requests in flight.
3. **Navigate or switch** — cold `goto`/`showStory`, or warm channel switch.
4. **Freeze animations** — inject CSS zeroing transitions/animations so
   spinners and shimmer don't randomize the frame. Opt out per story with
   `animations: 'play'`. **This runs before the render signal, not after**:
   injected styles survive a warm story switch but not a navigation, so
   freezing afterwards makes warm and cold captures of the same story disagree.
   Moving it is a behaviour change, not a refactor.
5. **Render-ready** — platform-specific. Storybook fires render-phase events;
   resolve at `playing` to capture pre-interaction state, or at `played` when
   the story opts into `captureAfterPlay`.
6. **Live params** — re-read `parameters.juxtapose` from the running preview,
   because Storybook drops custom parameters from its static index. Honours a
   late `skip`, and re-settles if the story declares its own viewport.
7. **Quiescence** — `waitForSelector` if declared, then the event-driven idle
   wait (`capture/idle.ts`): two consecutive task hops with no pending short
   timer, frame, message, font, in-viewport image or DOM change, and no counted
   request in flight, capped at `settle.timeout` (default 1500 ms). At the cap
   the story is captured and flagged `settle-timeout` with what was pending.
   Then an optional fixed `delay`.
8. **Paint barrier** — two nested rAFs plus an idle callback. A quiet DOM is
   not a painted frame; without this, captures intermittently catch an
   intermediate one. If the DOM, fonts, images or network moved during the
   barrier, the idle wait and the barrier run once more within the cap.
9. **Screenshot** → Chrome's lossless WebP (`quality: 100`), ICC chunk dropped.

Everything except steps 5 and 6 is platform-neutral and lives in `core`; those
two are the adapter's only contribution to settling.

### Warm-page switching

The single largest optimization, and the reason `switchStory` exists in the
interface. Measured on the original tool, 738 stories:

| strategy                               | wall-clock | per-story |
| -------------------------------------- | ---------- | --------- |
| sequential, one page                   | ~600s      | 1.5s      |
| 16 parallel contexts, `goto` per story | 222s       | 4.8s      |
| 16 parallel, **warm channel switch**   | **57s**    | **1.2s**  |
| 32 parallel, warm switch               | 87s        | 3.8s      |

Two lessons encoded as defaults:

- Reusing a warm page and switching the story over the platform's own channel
  beats navigating, by ~4x. A `goto` reloads the bundle; a switch re-renders.
- **More concurrency is not better.** 32 was slower than 16 because CPU
  saturation makes render timeouts fire. Default concurrency is 8, tuned for a
  10-core machine at ~80% utilization. Scale to core count, not to infinity.

## Affected-story analysis

Don't capture 738 stories when 3 changed. Given a git ref:

1. `git diff --name-only <since>..HEAD`.
2. If any of `.storybook/**`, `.ladle/**`, `package.json`, or a lockfile
   changed → full run. Config and dependency changes can affect anything.
3. Load the **Vite build manifest** and build a reverse import graph
   (`file → files that import it`).
4. Walk transitively from each changed file, collecting dependents.
5. Keep stories whose `componentPath` is in that set.
6. **If nothing matched but files did change → full run.** The safety net.

Note this is Vite-specific, not Storybook-specific. Storybook and Ladle are both
Vite-based, so it transfers unchanged. Non-Vite platforms fall back to a runtime
import-graph parse.

The bias is deliberate and asymmetric: a false positive costs a few seconds of
capture, a false negative ships a visual regression. Every failure path
escalates to a full run.

## Storage: local-first, pluggable

The original required an S3 bucket before it would do anything. That's a
adoption tax for what is fundamentally a local tool, so the default inverts:

```ts
interface BaselineStore {
  get(storyId: string): Promise<Buffer | null>;
  put(storyId: string, image: Buffer, meta: ApprovalMeta): Promise<void>;
  remove(storyId: string): Promise<void>;
  readManifest(): Promise<BaselineManifest>;
  writeManifest(manifest: BaselineManifest): Promise<void>;
}
```

- **`cache` (default)** — images live in a local, git-ignored directory
  (`.juxtapose/cache/baselines/`) named by their own sha256, so any commit's
  manifest finds its image if it was ever captured here, and two caches merge
  without conflict. The repo carries a small manifest of hashes and references plus readable
  `juxtapose.structures/` JSON files (one element per line, with relative path
  segments and parent indices, so an approval's diff shows what changed). A passing run
  keeps its capture in the cache; CI saves and restores the directory (see
  [CI](docs/ci.md)). A failing story whose image is missing is reported by hash
  and structure ("structure diff only"), never as an error. It still reads an
  old committed `.juxtapose/baselines/` layout, hash-checked, so upgrading does
  not blank existing diffs.
- **`git`** — the opt-in legacy layout: baselines committed under
  `.juxtapose/baselines/` as WebP. Costs repo size for good, since every
  approval adds binary history.
- **`fs`** — the same store pointed at a directory you choose, rather than a
  separate implementation.
- **`s3`** — declared in `StorageConfig` but **not implemented**: the CLI
  throws if you select it.

The `BaselineManifest` is committed in every case. It, not the image, defines
"approved".

## Exact identity and optional visual equivalence

SHA-256 remains the artifact identity and exact comparison fast path. Matching
hashes need no baseline image lookup, decode, or pixel comparison. Exact mode
is the default. Capture determinism remains important: filtering a difference
is not evidence that it was harmless noise.

The opt-in `comparison.mode: "pixelmatch"` policy can accept a hash mismatch
when the approved image is available and its bytes match the manifest hash,
the baseline commit has valid ancestry, dimensions match, and Pixelmatch counts
zero remaining differing pixels. It uses `comparison.threshold` (default 0.05)
and `includeAA: false`, with no pixel-count allowance. The result records both
hashes, the applied threshold, and the raw changed-pixel count. A pass does not
update the manifest. Approval and renderer recovery remain exact.

Status resolution, in order:

| condition                                  | status                                                   |
| ------------------------------------------ | -------------------------------------------------------- |
| no manifest entry                          | `new`                                                    |
| `hash` differs                             | `fail`, unless explicit visual-equivalence policy passes |
| baseline commit is not an ancestor of HEAD | `stale`                                                  |
| otherwise                                  | `pass`                                                   |

`stale` matters: a baseline approved on a branch that never merged is not a
valid baseline for HEAD. Detecting it needs a `git merge-base --is-ancestor`
call; results are memoized across the run rather than repeating the process for
every story.

## Diff (the cold path)

Only for stories that already failed the hash check.

`sharp` decode → `pixelmatch(threshold, includeAA: false)` → changed-region
extraction → WebP encode. Thresholds resolve per story: story params override
project config override the default of 0.1. `minDiffPercent` suppresses
sub-pixel AA noise in the _reported_ percentage.

The legacy top-level thresholds tune the report only. The separate explicit
`comparison` policy determines whether a hash mismatch can pass; its zero-pixel
requirement cannot be relaxed with `minDiffPercent`. They exist so a reviewer can tell "one word changed" from
"the whole layout moved".

## Agent loop

The original's best idea, kept and made central. Failing visual diffs are a
task an agent can close, given the right context:

- `jux run --json` emits a `RunReport` on stdout.
- For any failing story the report names the baseline, current and diff image
  paths, plus the component source path.
- `jux handoff <storyId>` builds a prompt naming those paths and asking for a
  verdict: intentional change → `jux approve --story <id>`; regression → propose
  a fix. The prompt footer records the project root so a session in the wrong
  repo detects the mismatch.
- `jux approve` and `jux check` are non-interactive. Approval is still an
  explicit decision about selected captures and requires fresh confirmation.
  Hosted PR review follows its separate [GitHub approval workflow](docs/github-pr-review.md).

## Capture identity and recovery

[Variants](packages/core/src/capture/variants.ts) expand a platform story into
independent capture keys (`baseStoryId__variant`). Navigation uses the base story
ID; images, baselines and approval selection use the capture key. Merge project
and story variants by name, validate inheritance/collisions, and preserve explicit
selection. Device presets and viewports must be applied and reset for every job.
A mobile-named preset emulates supported behavior in Chromium; it does not run
Safari or native hardware. See [configuration](docs/configuration.md#devices).

Shared renderer reuse, a warm browser daemon and warm story switching are
separate policies. [Run recovery](packages/core/src/run/run.ts) selects candidates
deterministically with a budget of `ceil(0.1 * non-skipped captures)`. A cache pulse
replaces the initial result only after exact baseline-hash checks pass. A fresh
retry is reported even when it still differs, retaining the initial hash and
retry evidence. Recovery outcomes are observations, not proof of a cache cause.

Approval requires fresh confirmation of the selected reviewed capture, including
identity and environment checks. A stability override does not authorize different
bytes. Preserve these checks across CLI, addon and server entry points. Relevant
regressions live beside [run recovery](packages/core/src/run/run-recheck.test.ts)
and [approval](packages/core/src/baseline/).

## Structure evidence

[Structure capture](packages/core/src/capture/structure.ts) records normalized DOM,
geometry and selected computed styles alongside image capture. It explains observed
changes; it does not decide the image verdict or establish a framework component
tree. Missing, truncated, masked or ambiguous evidence must remain explicit.

The semantic structure hash, image hash and stored-file checksum have different
purposes. Compact structure files expand to the same semantic representation;
missing, corrupt or unsafe sidecar paths yield unavailable structure, not a new
image verdict. A batch of sidecar/manifest writes is not a filesystem transaction.
Preserve checksum validation, masks, parent indices and stable ordering in the
[structure tests](packages/core/src/capture/structure.test.ts) and
[baseline readers](packages/core/src/baseline/).
