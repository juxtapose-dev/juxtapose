# juxtapose

Visual regression testing for component workbenches. Captures every story,
compares against approved baselines, and tells you exactly what changed.

Works with **Storybook** and **Ladle** through the same CLI. Baselines live in
your repo by default — no bucket, no account, no service.

```bash
npx jux run          # capture and compare
npx jux approve --all # bless the current rendering
npx jux check        # exit 0/1, for CI
```

## Why another one

Three things this does differently.

**Pass/fail is a hash, not a threshold.** A story passes if its captured bytes
match the approved baseline exactly. There is no "5% is probably fine" setting
to argue about, and no slow drift as a dozen sub-threshold changes accumulate
into a redesign nobody approved. The pixel diff still runs — but only after a
failure, and only to explain it.

The tradeoff is real and worth naming: byte-exactness means every source of
render nondeterminism is a failed build. That is why so much of this codebase
is settle logic (see below). It is a deliberate trade of engineering effort for
the absence of a fudge factor.

**Baselines are committed.** Approving a change is a diff in the pull request
that caused it, reviewable next to the code. Branches get correct baselines by
checking out the branch. Reverting a bad approval is `git revert`. S3/R2 remains
available for suites too large to carry in git.

**Agent-first, not agent-compatible.** Every command emits JSON. `jux handoff`
turns a failing story into a prompt that hands an agent exact mismatch
percentages, changed-region coordinates and the component's source path —
structured data, not screenshots, because `mismatchPercent: 3.72` is exact
where spatial reasoning over a PNG is a guess, and costs a fraction of the
tokens.

## Getting started

```bash
pnpm add -D @juxtapose/cli
npx storybook build          # or: npx ladle build
npx jux run --all            # everything is "new" the first time
npx jux approve --all        # establish baselines
git add juxtapose.manifest.json .juxtapose/baselines
```

From then on `jux run` captures only what your changes could have affected.

## How it decides what to capture

Given a git ref, it diffs, then walks the **bundler's own import graph**
(Vite's build manifest) backwards from each changed file to find every story
that transitively depends on it.

The failure modes are asymmetric — a false positive costs seconds of capture, a
false negative ships a regression — so every uncertain path escalates to a full
run: config or lockfile changes, a missing manifest, a git failure, or a change
that matches no story at all.

Measured on a real project: a change to one story file narrowed 3 stories to 2;
a change to a component Vite had inlined (so it had no manifest node) correctly
escalated to all 3 rather than silently missing it.

## Determinism

Because pass/fail is byte-exact, capture has to be reproducible. In order:

1. Viewport is set only when it changed (skips a CDP round-trip).
2. Navigate, or switch story on a warm page.
3. Wait for the platform's own render signal — Storybook's render-phase
   machine, Ladle's `data-storyloaded`.
4. Wait for DOM quiescence: 150ms with no mutations and no in-flight fetches,
   capped at 500ms.
5. Await webfonts and image decode — in the same round trip as (4).
6. Freeze animations and transitions, and hide the text caret.

Step 6 matters more than it sounds: without it, any spinner, shimmer or
fade-in makes a story diff against itself on every run.

Captures are **lossless** WebP. Lossy at q90 perturbs ~7.7% of pixels
frame-wide — harmless to the hash, but it floods the diff with compression
noise and destroys the changed-region localization. For flat UI renders,
lossless is usually smaller anyway.

## Speed

Warm-page story switching is the main optimization: reusing a page and
switching story over the platform's own channel re-renders instead of
reloading the bundle. On the original tool this took a 738-story suite from
222s to 57s.

Concurrency defaults to 8 and **more is not better** — at 32 the same suite ran
~50% slower than at 16, because CPU saturation makes render timeouts fire.
Scale to core count.

## Configuration

`juxtapose.config.json`, or a `juxtapose` key in package.json:

```json
{
  "platform": "storybook",
  "concurrency": 8,
  "viewport": { "width": 1280, "height": 800 },
  "storage": { "kind": "git" }
}
```

Per-story, via the platform's own parameter mechanism
(`parameters.juxtapose` in Storybook, `meta.juxtapose` in Ladle):

| option                         | purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `skip`                         | never capture this story                           |
| `viewport`                     | override the capture size                          |
| `animations: 'play'`           | let animations run (for stories testing animation) |
| `captureAfterPlay`             | screenshot after interactions, not at first render |
| `waitForSelector`              | wait for async content the network drain can't see |
| `delay`                        | fixed extra wait; last resort                      |
| `threshold` / `minDiffPercent` | tune the _reported_ diff, not pass/fail            |

## Packages

| package                | what it is                                                 |
| ---------------------- | ---------------------------------------------------------- |
| `@juxtapose/core`      | capture, diff, baselines, analysis — no platform knowledge |
| `@juxtapose/storybook` | Storybook adapter                                          |
| `@juxtapose/ladle`     | Ladle adapter                                              |
| `@juxtapose/cli`       | the `jux` command                                          |

Supporting a new workbench means implementing four methods — enumerate,
storyUrl, settle, and optionally switchStory. Both existing adapters were
written against the same interface with no changes to it.

## Status

Early. Core capture/diff/approve loop is verified end-to-end on both Storybook
and Ladle; the addon UI, HTML report, GitHub PR comments and the S3 store are
not built yet. See `ARCHITECTURE.md` for the full design and the reasoning
behind each decision, and the [issues](https://github.com/juxtapose-dev/juxtapose/issues)
for the roadmap.

## License

MIT © Magic Factory LLC. See [LICENSE](LICENSE).
