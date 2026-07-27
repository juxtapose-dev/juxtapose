# Architecture

Visual regression testing for component workbenches. Captures screenshots of
every story, diffs them against baselines, and tells you what changed.

This is a ground-up rebuild of an internal Storybook-only tool. The goals are
unchanged; the shape is different in three ways:

1. **Platform-agnostic core.** Storybook is one adapter, not the architecture.
   Ladle, Histoire and plain URL lists are peers.
2. **Zero-infra by default.** Baselines live in the repo's git objects, not a
   bucket you have to provision before the tool does anything.
3. **Agent-first.** Every command is non-interactive and emits JSON. The review
   loop is designed for an agent to close, not just a human.

## Package layout

```
packages/
  core/               @juxtapose/core        capture, diff, storage, analysis — no platform knowledge
  adapter-storybook/  @juxtapose/adapter-storybook   index.json enumeration + preview channel driver
  adapter-ladle/      @juxtapose/adapter-ladle       meta.json enumeration + Ladle's ready signal
  adapter-histoire/   @juxtapose/adapter-histoire    histoire.json enumeration + sandbox ready message
  cli/                @juxtapose/cli         `jux` — init, run, approve, check, handoff
  server/             @juxtapose/server      local review API; the addon is a skin over it
  addon-storybook/    @juxtapose/storybook   panel, test provider, sidebar decoration, watch mode
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
  /** Is this the platform in use here? Drives autodetection. */
  detect(target: EnumerateTarget): Promise<boolean>;
  /** Discover stories. Storybook: index.json. Ladle: meta.json.
   *  Histoire: histoire.json. */
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

The optional three are all recoveries rather than requirements. `switchStory`
is an optimization — a platform without it still works, just slower, because
the pool falls back to `goto`. `readLiveParams` exists because Storybook
serializes only a whitelist of parameters into `index.json`, so `skip` and
per-story viewports are invisible until you ask the running preview. Ladle
needs neither: its `meta` is statically extracted and complete.

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
2. **Arm the observer** — a `MutationObserver` installed via `page.evaluate`
   _before_ the render is triggered, so it is already watching when the story
   mounts. It resolves after 150ms of no mutations, capped at 500ms.
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
7. **Quiescence** — `waitForSelector` if declared, then network drain and image
   decode in a _single_ `page.evaluate` rather than three, then an optional
   fixed `delay`.
8. **Paint barrier** — two nested rAFs plus an idle callback. A quiet DOM is
   not a painted frame; without this, captures intermittently catch an
   intermediate one.
9. **Screenshot** → PNG → lossless WebP.

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
2. If any of `.storybook/**`, `.ladle/**`, `.histoire/**`, `package.json`, or a lockfile
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

- **`git` (default)** — baselines committed under `.juxtapose/baselines/` as
  WebP. Zero infra, baselines version with the code, review happens in the PR
  diff, and branches get correct baselines by construction. Costs repo size,
  though lossless WebP of a flat UI render is usually smaller than the PNG.
- **`fs`** — the same store pointed at a directory you choose, rather than a
  separate implementation.
- **`s3`** — declared in `StorageConfig` but **not implemented**: the CLI
  throws if you select it. Intended for suites too large to carry in git.

The `BaselineManifest` is committed in every case. Even with the S3 store, the
manifest in git is what defines "approved" — the bucket only holds the bytes.

## Pass/fail is a hash, not a threshold

The most important design decision in the tool, and the least obvious:

**A story passes if `sha256(webp) === manifest[storyId].hash`.** Byte-exact.
The pixel diff does not decide anything — it runs _only after_ a hash mismatch,
purely to produce artifacts a reviewer (or agent) can act on: mismatch percent,
changed regions, diff overlay.

The consequence is severe and worth stating plainly: **any nondeterminism in
capture is a hard failure.** There is no threshold to hide behind. That is why
the settle pipeline above is so elaborate, and why animation freezing and font
waiting are on by default rather than opt-in. Every flake is a failed build.

The upside is that a green run costs almost nothing: hash the WebP, compare,
done. No decode, no diff, no baseline fetch. Diffing is a cold path that only
runs for stories that already failed.

Status resolution, in order:

| condition                                  | status  |
| ------------------------------------------ | ------- |
| no manifest entry                          | `new`   |
| `hash` differs                             | `fail`  |
| baseline commit is not an ancestor of HEAD | `stale` |
| otherwise                                  | `pass`  |

`stale` matters: a baseline approved on a branch that never merged is not a
valid baseline for HEAD. Detecting it needs a `git merge-base --is-ancestor`
call, which forks a process at ~40ms — so it is memoized across the run. At 738
stories that is the difference between ~30s and ~50ms.

## Diff (the cold path)

Only for stories that already failed the hash check.

`sharp` decode → `pixelmatch(threshold, includeAA: false)` → changed-region
extraction → WebP encode. Thresholds resolve per story: story params override
project config override the default of 0.1. `minDiffPercent` suppresses
sub-pixel AA noise in the _reported_ percentage.

Note these thresholds tune what gets _reported_, not what passes — the hash
already decided that. They exist so a reviewer can tell "one word changed" from
"the whole layout moved".

## On Rust

Browser capture is ~85-90% of a run's wall clock and is irreducible in any
language — Chromium renders at the speed it renders. **A Rust rewrite of the
pipeline does not move the headline number.** Anyone promising otherwise is
selling something.

But there are three places native code genuinely pays, and none of them are
"rewrite the tool":

1. **The diff path, on a heavily-failing run.** pixelmatch with
   `includeAA: false` runs an 8-neighbour antialiasing scan per differing
   pixel, single-threaded JS over ~1M pixels. It is also embarrassingly
   parallel — across stories _and_ across rows — where JS gets one event loop
   and `Promise.all` over CPU-bound work is concurrency theatre. SIMD + rayon
   is plausibly 10-30x here. Mitigated by the hash-first design: on a green run
   this cost is zero.

2. **The dependency scanner.** `madge` parses every source file with a JS AST
   parser on every run, uncached, and it sits on the critical path _before_ any
   capture starts. On a large monorepo that is seconds to tens of seconds of
   dead time. An `oxc`-based import scanner with an mtime-keyed incremental
   cache is the easiest large win available — and it helps every run, passing
   or failing.

3. **Format round-trips.** Today a story costs: PNG encode inside Chromium →
   PNG decode in sharp → WebP encode. A failing story adds two more decodes and
   several more encodes for diff and heatmap. `sharp` is already native libvips,
   so the library is not the problem — the redundant conversions are, and those
   are architectural, fixable in TypeScript by asking CDP for raw bitmap data
   and encoding once.

So: **TypeScript first, with the CPU-bound work behind a narrow boundary.**
`diff()`, `hash()` and region extraction are pure functions over buffers with no
platform coupling; a napi-rs implementation drops in behind that boundary
without touching callers. Fix the round-trips first — that is a free win in TS.
Reach for Rust on (1) and (2) when a benchmark says so, not before.

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
- `jux approve` and `jux check` are non-interactive, so the loop closes without
  a human.

## Non-goals for v1

Multi-browser, multi-viewport matrix, full-page scroll capture, interaction
state matrices, perceptual/SSIM diffing, hosted review UI. All were deferred
upstream for good reasons and none are load-bearing for the core value.
