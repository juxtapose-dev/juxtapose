# Working in this repo

Visual regression testing for component workbenches. `ARCHITECTURE.md` has the
full design; this file covers what will bite you if you don't know it.

## The one invariant everything rests on

**Pass/fail is a byte-exact hash.** A story passes if `sha256(webp)` equals the
hash recorded in `juxtapose.manifest.json`. There is no threshold, no
tolerance, no "5% is probably fine".

The consequence is the thing to internalize: **any nondeterminism in capture is
a failed build**, not a small mismatch percentage someone can wave through. A
single pixel of antialiasing jitter on one rounded corner turns a suite red.

This is why `packages/core/src/capture/` is disproportionately large and fussy
relative to what it does. Every line in the settle pipeline is there because
something was flaky without it. Before you simplify anything in that directory,
assume it is load-bearing and find out what it was protecting against.

The upside, and the reason the trade is worth it: a green run is nearly free.
Hash the bytes, compare, done — no decode, no diff, no baseline fetch. The
pixel diff in `diff/` is a **cold path** that only runs to explain a story that
already failed. Optimizing it helps only in proportion to how broken things
already are.

## Determinism failures found the hard way

If captures start flaking, check these before theorizing. Each cost real
debugging time and each is now guarded:

**Ordering in `captureStory` is load-bearing.** The animation-freeze stylesheet
is injected _before_ the render signal, not after. Injected styles survive a
warm story switch but not a navigation, so freezing after render means a warm
story renders frozen while a cold story renders unfrozen — different pixels for
the same story. Moving that call is not a refactor; it is a behavior change.

**A quiet DOM is not a painted frame.** `waitForPaint` (two nested rAFs plus an
idle callback) runs immediately before the screenshot. Without it, captures
intermittently catch an intermediate frame.

**Browser flags matter.** `capture/launch.ts` forces CPU rasterization, sRGB, no
LCD/subpixel text, and a pinned device scale factor. GPU rasterization was
producing off-by-one differences on antialiased edges. `launch.test.ts` guards
these; if you're tempted to trim the list, that test explains each one.

**Warm-page switching is opt-in and off by default** (`warmSwitch: true`). It is
~4x faster and it does not reproduce cold-load pixels exactly. Each path is
internally stable; they disagree with each other. Since the work queue is
shuffled, that made a story's verdict depend on where it landed in the queue.
See issue #32 before re-enabling — it lists what has already been ruled out.

**Captures are lossless WebP.** Lossy at q90 perturbs ~7.7% of pixels
frame-wide. The hash survives that (encoding is deterministic), but the diff
fills with compression noise and the changed-region map degenerates to the whole
viewport. For flat UI renders lossless is usually smaller anyway.

## Verify against a real build, not just unit tests

Every significant bug in this repo so far was invisible to unit tests and
obvious the moment the tool ran against a real workbench. The sharpest example:
`computeChangedRegions` tested `alpha > 0`, but pixelmatch writes the _whole
frame_ into its diff buffer — unchanged pixels as the faded original at full
alpha. Every diff reported as one full-viewport region. The unit fixtures
encoded the same wrong assumption, so they passed while production was broken.

So: when you change capture, diff, or the adapters, run the examples.

```bash
pnpm --filter example-storybook visual
pnpm --filter example-ladle visual
```

And when the change touches determinism, run it several times — a single green
run proves nothing about a race.

```bash
for i in $(seq 5); do
  (cd examples/storybook && node ../../packages/cli/dist/index.js run --all 2>/dev/null | grep pass)
done
```

Prefer a test that exercises the real library over a hand-rolled fixture.
`regions.test.ts` now runs actual pixelmatch output through the extractor for
exactly this reason.

## Layout

```
packages/core/              no platform knowledge — never import an adapter here
  capture/    settle pipeline, worker pool, launch flags
  baseline/   hash comparison (the pass/fail authority) + git store
  diff/       pixelmatch wrapper + region extraction — COLD PATH
  analysis/   which stories a change could affect
  agent/      handoff prompt construction
  run/        orchestration
packages/adapter-storybook/ index.json, preview channel
packages/adapter-ladle/     meta.json, ladleDispatch
packages/cli/               the `jux` command
examples/                   Storybook + Ladle workbenches sharing one component lib
```

## The platform seam

Four methods: `enumerate`, `storyUrl`, `settle`, and optionally `switchStory`.
Both adapters were written against this interface without changing it, which is
the evidence it is a real abstraction rather than Storybook's API in disguise.

Keep it that way. If something Storybook-shaped is creeping into `core`, that is
a signal the seam needs another method, not that core needs a special case.
Generic settling — DOM quiescence, network drain, fonts, images, animation
freeze — belongs in core because it applies to any DOM. Only the platform's own
render signal belongs in an adapter.

`settle` must not throw on timeout. A slow story should produce a reviewable
diff, not abort a 700-story run.

## Affected-story analysis is deliberately pessimistic

`analysis/affected.ts` walks Vite's build manifest backwards from changed files.
The failure modes are asymmetric — a false positive costs seconds of capture, a
false negative ships a regression — so every uncertain path escalates to
capturing everything: config or lockfile changes, a missing manifest, a git
failure, or a change that matched no story.

The `reason` field on the result exists so a full run is never mysterious. If
you add a path, give it a reason string too.

## Conventions

**Comments explain why, not what.** The code says what it does. The comments
carry the measurement or the failure that justifies it — that is the part that
cannot be re-derived by reading the code. When you fix a determinism bug,
record the number you measured.

**Non-trivial logic leaves one runnable check behind.** Not a suite per
function; the smallest thing that fails if the logic breaks.

**Don't claim it works without running it.** State what you ran and what it
printed. "Tests pass" means you ran them.

## Commands

```bash
pnpm build              # all packages
pnpm test               # vitest
pnpm typecheck          # tsc --build across project references
pnpm lint               # eslint
pnpm format             # prettier --write
pnpm check:determinism  # capture the examples repeatedly, assert byte-stability
```

CI runs all of these. `check:determinism` needs `pnpm build` and a built
example workbench first; it is the one that catches races, so run it after any
change to `capture/` rather than trusting a single green run.

Releases go through changesets. Add one with `pnpm changeset` when a change
should ship; merging to main without a changeset publishes nothing.

Committing baselines (`juxtapose.manifest.json` + `.juxtapose/baselines/`) is
normal and intended — it is what makes approval a reviewable diff. The
`examples/` directories are the exception: antialiasing differs across machines
and Chromium versions, so committed baselines there would be red for everyone
but the author.
