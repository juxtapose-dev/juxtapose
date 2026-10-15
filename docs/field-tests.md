# Field tests

<!-- COPY: one-paragraph headline/positioning, written by the maintainer -->

This page lists what jux measured on three public Storybooks, how jux keeps
those captures stable, what still varies, and how to repeat the measurements.

## Focused text-rendering investigation

For Linux text noise, use the field-test workflow's `text_probe: true` with comma-separated
story IDs (for example `textfield--empty`), `passes: 20`, and one renderer mode.
Set `concurrency` to 1, 2, or 3 (default 1); sweep is not supported for this probe.
Stories run sequentially, with concurrent captures within each story. Artifacts
live under `<story-id>/<experiment>/`.
The workflow reuses the cached pinned static build. The probe keeps one browser
alive, creates a context per repetition, and captures the normal settled story
followed by two additional screenshots of the same page. It does not approve baselines,
apply visual tolerance, or retry a mismatch.

Locally, after building the packages:

```sh
JUX_TEXT_WORKERS=3 node scripts/probe-text-rendering.mjs /path/to/storybook-static textfield--empty 20 /tmp/text-probe fresh
```

Each repetition saves the original PNG, encoded image, two subsequent
screenshots, exact changed-pixel counts and bounds,
computed font and text geometry through open shadow roots, loaded font status,
CDP's actual platform-font usage, computed border/placeholder styles, and active
animations. This supports offline analysis without
another capture run. The second screenshot distinguishes cross-navigation
variation from variation on an already rendered page.

Measurements follow all three screenshots to avoid changing the first capture's
timing. Consequently they are diagnostic clues, not an atomic record of either
image; closed shadow roots and iframe geometry are not included. If a small
subset does not reproduce the noise, restore the original predecessor story or
capture load before treating it as stable. Success means the probe completed,
not that all pixels matched. Use the full suites only after a hypothesis survives
this focused loop.

`text_experiment: sweep` batches four diagnostic interventions into the same
runner allocation: normal capture, raw CDP capture without screenshot preparation,
an extra paint barrier, and caret hiding before an extra paint barrier. Locally,
set `JUX_TEXT_EXPERIMENT` to `baseline`, `raw`, `paint`, or `caret-paint`.
These are investigation controls, not supported capture policies; the raw control
requires an unscrolled 1280×800 story with no masks. No production behavior changes.
`text_experiment: warm-sweep` compares normal capture with `delay` (100 ms),
`warm-pixel` (a preliminary 1×1 screenshot), and `warm-full` (a preliminary full
screenshot). These controls distinguish elapsed time from screenshot side effects;
they are not proposed defaults.

`text_experiment: timing` interleaves four diagnostic arms: baseline, extra paint,
a timer delay using the latest completed extra-paint duration (33 ms before the
first sample), and a pre-capture style/layout/animation observation. `passes` is
**per arm**, so 100 means 400 captures. Assignments rotate within blocks across
the same worker pool. Results record each arm, actual intervention duration, the
delay target, and whether the before/after observations agree. This is an
approximate elapsed-time control, not paired captures of an identical browser
state. Style reads may force style/layout work, and therefore can hide a race;
the observation arm must be interpreted alongside the untouched baseline.

`text_experiment: transition-check` interleaves baseline, finishing exposed
running `CSSTransition` objects, and inspecting the same objects without
finishing them. `passes` is per arm. It records the transition properties and
timing; this is a diagnostic intervention, not the production freeze policy.

The first [20-repeat Linux probe](https://github.com/juxtapose-dev/juxtapose/actions/runs/38785584994)
took 13 seconds of capture time (about 45 seconds for the runner job with cached
builds). `textfield--empty` produced three initial hashes, but all 20 second
screenshots had identical decoded pixels. Geometry and actual Adobe Clean font
usage matched across repetitions. The first-to-second differences were confined
to the placeholder's bounds, 261–400 pixels. This motivates separating first-frame
paint/preparation from encoding; it does not yet establish the cause or a fix.

Follow-up probes ruled out PNG-to-WebP encoding (zero decoded-pixel changes in
20 pairs). Skipping screenshot preparation still varied; an extra paint barrier
reduced but did not eliminate the differences. A 100 ms delay and a preliminary
1×1 screenshot each stabilized 20/20, motivating inspection of time-dependent
styles rather than adding either workaround to the capture path.

The cause in this reproduction was Spectrum's `input::placeholder` color
transition. The freeze sheet selected elements, `::before`, and `::after`, but
transition properties do not inherit onto `::placeholder`. Adding its selector
produced [20/20 identical initial Linux captures](https://github.com/juxtapose-dev/juxtapose/actions/runs/38787490741),
all matching the second and third screenshots, with no delay or preliminary
capture. Real-browser regression tests fail with the old rule and pass with the
fix in both light and open shadow DOM; `animations: 'play'` remains effective.
This establishes this placeholder-transition cause, not a universal explanation
for all text or antialias differences.

The [five-pass, ten-story Linux follow-up](https://github.com/juxtapose-dev/juxtapose/actions/runs/38787795691)
had no capture errors. Fresh mode varied on one story (`textfield--types`), cache
pulse on one (`textfield--sized`), and shared mode on six. The earlier matching
renderer sweep varied on eight, five, and eight respectively. These are small
samples from different runner allocations, not a precise rate comparison. They
show why the targeted fix does not replace existing renderer recovery or justify
claiming that all remaining noise is solved.

A subsequent focused run found `textfield--types` ([fresh, 40 captures](https://github.com/juxtapose-dev/juxtapose/actions/runs/38792993666))
and `textfield--sized` ([pulse, 40 captures](https://github.com/juxtapose-dev/juxtapose/actions/runs/38793098586))
exactly stable in isolation, including consecutive screenshots, geometry, and
PNG-to-WebP pixels. A [ten-story, ten-pass fresh-renderer sweep](https://github.com/juxtapose-dev/juxtapose/actions/runs/38793312505)
at 1, 2, and 3 workers produced identical initial hashes across all 300 captures
and no errors. The separate fresh-renderer confirmation pass differed twice:
`textfield--grows-only` at 2 workers (pass 3) and `textfield--quiet` at 3 workers
(pass 6). Confirmation is a second capture pass, not an immediate same-page
screenshot. This narrows the next reproduction to concurrent captures; it does
not prove that load causes the failures or that single-worker capture is immune.

The [three-worker probe, 100 captures per story](https://github.com/juxtapose-dev/juxtapose/actions/runs/38794768086)
reproduced nine initial-image deviations on `textfield--grows-only` (four hashes)
and one on `textfield--quiet` (two hashes), with fresh renderers. One grows-only
hash exactly matched the earlier confirmation failure. All second and third
screenshots matched the stable image. Grows-only changed 1,104–1,369 pixels
(maximum channel delta 2–30); quiet changed 1,035 pixels (maximum delta 12).
PNG-to-WebP encoding changed zero pixels. Recorded layout/styles were identical
within each story, with no animations remaining at observation time. Because
observation follows the screenshots, this does not exclude an earlier transition.
The border itself changed (one sample: gray 114 to 144), so this is not solely
text-edge antialiasing. No unrelated predecessor story or shared renderer is
required to reproduce these failures.

A [same-runner intervention sweep](https://github.com/juxtapose-dev/juxtapose/actions/runs/38795095557)
then ran 100 grows-only captures per arm at three workers. Normal capture varied
once (maximum channel delta 2), raw CDP capture varied once (delta 12), an extra
paint barrier varied zero times, and caret hiding plus an extra barrier varied
zero times. Every second/third screenshot was stable and every encoding delta
was zero. Screenshot preparation is therefore not necessary to trigger this
reproduction. The extra barrier is a promising timing control, not proof of a
root cause or a production fix: arms ran sequentially, observed frequency varied
between allocations, and adding a barrier also adds elapsed time. A focused
follow-up should compare paint versus a matched delay and observe pre-capture
styles in a separate diagnostic arm before adding any global capture overhead.

The [interleaved timing experiment](https://github.com/juxtapose-dev/juxtapose/actions/runs/38800391783)
ran 100 captures per arm. Initial-image deviations were baseline 3, extra paint
0, matched delay 1, and pre-capture observation 1. Median intervention costs
were 18.2 ms for paint, 18.5 ms for delay, and 8.5 ms for observation. Six
pre-capture observations found active 130 ms input transitions and intermediate
border/placeholder colors even though computed transition duration was already
`0s`. One of those observations accompanied a differing screenshot. Fonts were
loaded and geometry unchanged; after capture, the transitions had ended.

A minimal real-Chrome fixture confirmed the mechanism: changing duration to
zero does not stop an already-started transition, but setting
`transition-property: none` removes it and immediately exposes the final style.
The freeze stylesheet now applies that declaration, without an extra wait or
animation scan. Regression tests explicitly start a long transition before
applying the production stylesheet in light and open shadow DOM; both fail with
the old rule and pass with the fix, checking computed state and rendered pixels.
The existing `animations: 'play'` tests still pass.

The [exposed-transition control](https://github.com/juxtapose-dev/juxtapose/actions/runs/38801161115)
found four border-color transitions per affected input. Across 100 captures per
arm, baseline differed 4 times, finishing exposed transitions differed 5 times,
and inspection alone differed 3 times. Finishing removed the border changes but
left 564–729 changed pixels (maximum channel delta 1–4). Thus scanning and
finishing exposed animation objects alone is insufficient; the stylesheet must
also cover placeholder pseudo-elements. These counts are small samples, not
estimates of a performance or flake-rate regression.

With the stylesheet fix, the [three-worker Linux verification](https://github.com/juxtapose-dev/juxtapose/actions/runs/38801637168)
produced 200/200 identical initial captures of grows-only and 200/200 of quiet.
Every second/third screenshot also matched, encoding deltas were zero, and each
story had one recorded layout/style hash. Local Storybook (18 stories ×3) and
Ladle (16 stories ×3) were byte-identical; all 14 shadow-DOM tests, build,
typecheck, and full Linux CI passed. This verifies these reproductions, not all
possible sources of renderer-history or application nondeterminism.

## What was tested

You can repeat every run on this page. Each Storybook was built from source
and served locally by jux through [`buildDir`](configuration.md#capture-a-built-or-deployed-storybook),
so the runs never contacted the public sites.

| Storybook               | Stories | Source commit                                                  | Notes                   |
| ----------------------- | ------- | -------------------------------------------------------------- | ----------------------- |
| Chakra UI               | 1,227   | `chakra-ui/chakra-ui@fa9696f328ea5a0df8685c6d8460edbd779b63b9` | Storybook 10.4.2        |
| Primer React            | 1,102   | `primer/react@7f5303d`                                         | One story always errors |
| Spectrum Web Components | 1,086   | `adobe/spectrum-web-components@9d8151f`                        | Lit, shadow DOM         |

Test setup:

- **jux version:** 0.13.0. An earlier run of the same three Storybooks used
  jux 0.9.0; the comparison below uses it as the baseline.
- **Settings:** defaults, including `freshRenderer`, with concurrency 8, a
  1280x800 viewport and the pinned `chrome-headless-shell` 151.0.7922.34 on
  darwin-arm64.
- **Passes:** each Storybook ran three full `jux run --all` passes with a
  separate state dir. Pass A and pass B each launch a fresh browser. Pass C
  runs on a warm browser started with `jux browser start`.
- **Chakra with `network.external: "block"`:** two extra passes, A and B, both
  fresh.

## Results

A story is _byte-identical_ when the sha256 of its capture matches across
independent passes. This is the rule jux uses to pass or fail a story, so a
count of identical stories is a count of stories that would pass a re-run on
unchanged input.

Wall time and per-story timings are preliminary. Read
[Timings caveat](#timings-caveat) before you use them.

| Storybook                              | Stories | Byte-identical A=B | Byte-identical A=C | Errors | Wall time A / B / C | Per-story p50 | Per-story p95  |
| -------------------------------------- | ------- | ------------------ | ------------------ | ------ | ------------------- | ------------- | -------------- |
| Chakra UI                              | 1,227   | 1,223              | 1,223              | 0      | 94 / 107 / 102 s    | 547-641 ms    | 826-911 ms     |
| Chakra UI, `network.external: "block"` | 1,227   | 1,226              | not run            | 0      | 88 / 93 s (A, B)    | 550-585 ms    | 695-716 ms     |
| Primer React                           | 1,102   | 1,101              | 1,101              | 1      | 115 / 85 / 128 s    | 425-498 ms    | 1,944-2,003 ms |
| Spectrum Web Components                | 1,086   | 1,081              | 1,078              | 0      | 81 / 79 / 81 s      | 561-575 ms    | 743-815 ms     |

The p50 and p95 columns give the range across the passes of each row.

Primer React has one story with no image: it exceeds the 60,000 ms per-story
budget on every pass and reports an error. Its identical counts are out of the
1,101 stories that produce an image.

### Comparison with 0.9.0

The same three builds, run on 0.9.0 and on 0.13.0. Counts are stories with a
byte-identical capture. Wall times are for passes A / B / C.

| Storybook               | A=B, 0.9.0 to 0.13.0 | A=C, 0.9.0 to 0.13.0 | Wall time, 0.9.0 to 0.13.0            |
| ----------------------- | -------------------- | -------------------- | ------------------------------------- |
| Chakra UI               | 1,221 to 1,223       | 1,222 to 1,223       | 84 / 99 / 104 s to 94 / 107 / 102 s   |
| Primer React            | 1,100 to 1,101       | 1,099 to 1,101       | 189 / 184 / 180 s to 115 / 85 / 128 s |
| Spectrum Web Components | 1,056 to 1,081       | 1,055 to 1,078       | 52 / 76 / 72 s to 81 / 79 / 81 s      |

## Timings caveat

The wall times and per-story timings on this page came from a shared
development machine under load. The 1-minute load average at the start of a
pass ranged from 3.8 to 39.8 across the 0.13.0 passes. The 0.9.0 passes ran
at lower load. The timings are therefore preliminary and mostly biased upward
compared with an idle machine. They will be replaced by measurements on an
idle machine. Don't use them to compare 0.9.0 with 0.13.0, or to size a CI
job.

The identical counts don't depend on load in the same way, because they
compare hashes and not durations. Load can still change them: a few of the
stories that differ in the 0.13.0 passes differed only in a pass that ran at
high load, and were stable when re-captured one at a time. The counts are
reported from the same loaded runs as the timings.

## How jux keeps captures stable

A capture settles before jux takes the screenshot. The settle step does the
following.

- **Animations:** freezes CSS animations, transitions and Web Animations, including inside shadow DOM.
- **Network:** waits for in-flight requests, and can block third-party requests.
- **Timers and time-based work:** waits for pending work to settle.
- **Rendering:** uses a fresh renderer for each story, and normalizes repaint and layer effects.
- **Fonts and images:** waits for them to load.
- **Hangs:** enforces a per-story time budget, so one bad page can't stall a run.
- **Unstable stories:** requires two identical captures before it approves a baseline.

For the options behind each item, see [Settle](configuration.md#settle).

## What still varies, and what you can do

Across the three Storybooks, the stories that still differ between passes fall
into four groups. Each group has a remedy that you set in your own config. The
`stories` overrides are described in
[Override stories you don't own](configuration.md#override-stories-you-dont-own).

| Cause                                 | Examples from these runs                                                                                                    | What you can do                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External network content              | Chakra: a random-photo `img`, a cross-origin map `iframe`, external avatar images                                           | Set `network.external` to `"block"` ([Third-party requests](configuration.md#third-party-requests)), or add a `mask` or `skip` entry under `stories` for the story.                    |
| Clocks and time                       | Chakra `foundations-sandbox--re-renders` (an ISO timestamp), Primer `relativetime-features--count-down-timer` (a countdown) | Mask the time element, and pin its size ([Content that changes every run](configuration.md#content-that-changes-every-run)). In a Storybook you don't own, use `mask` under `stories`. |
| Dialogs and overlays under heavy load | Spectrum `dialog-*` and `overlay-*` stories; most were stable when captured one at a time, and two differed even then       | Add a `skip` entry under `stories` for the story. Re-run on a less loaded machine to see whether the story is load-sensitive.                                                          |
| Animated GIFs                         | Spectrum `coachmark--with-gif`                                                                                              | Add a `mask` or `skip` entry under `stories` for the story.                                                                                                                            |

For example, this config masks a random photo and skips a story with an
animated image:

```json
{
  "platform": "storybook",
  "buildDir": "chakra/storybook-static",
  "stories": {
    "components-card--basic": { "mask": ["img"] },
    "coachmark--with-gif": { "skip": true }
  }
}
```

With `network.external` set to `"block"`, an external image fails at once and
the page shows its fallback. On the Chakra build, this raised the identical
count to 1,226 of 1,227 in passes A and B. `block` also blocks CDN web fonts
and stylesheets, so it changes the pixels of every story that uses one. See
[Third-party requests](configuration.md#third-party-requests) before you turn
it on.

## Reproduce these results

You need Node 22.2 or later, `git`, and each project's package manager. Build
jux first: run `pnpm install` and `pnpm build` in a jux checkout, then run
`jux browser install` if you haven't. The steps below use `jux` for the built
CLI, `node packages/cli/dist/index.js` from the jux checkout.

1. Clone the Storybook's repo at the commit in the
   [table above](#what-was-tested), and build its static Storybook with the
   repo's own commands:

   | Storybook               | Build commands                                                                                                                                                                                  |
   | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Chakra UI               | `pnpm install --frozen-lockfile`, then `pnpm build:storybook`. The output is `storybook-static/`.                                                                                               |
   | Primer React            | `npm ci` at the repo root, then `DEPLOY_ENV=production npx storybook build --quiet --disable-telemetry --loglevel error` in `packages/react`. The output is `packages/react/storybook-static/`. |
   | Spectrum Web Components | `yarn install` and `yarn build` at the repo root, then `yarn storybook:build` in `1st-gen`. The output is `1st-gen/projects/documentation/dist/storybook/`.                                     |

   `DEPLOY_ENV=production` excludes the `*.dev.stories` files, as the deployed
   Primer site does. Spectrum Web Components uses the Yarn release that the
   repo ships in `.yarn/releases/`.

2. Create a project directory with a `juxtapose.config.json` that points at
   the build:

   ```json
   { "platform": "storybook", "buildDir": "/path/to/storybook-static" }
   ```

3. Run each pass from that directory. Pass A and pass B launch a fresh
   browser each. For pass C, start the warm browser first:

   ```bash
   export JUX_STATE_DIR=$(mktemp -d)
   jux run --all --json --no-daemon > A.json
   jux run --all --json --no-daemon > B.json
   jux browser start
   jux run --all --json > C.json
   jux browser stop
   ```

   `jux run` exits 1 when stories have no baseline, which is the case for every
   story on a first run.

4. Compare the passes. Each run id is in the `runId` field of the pass's JSON
   output, and the comparison needs no browser:

   ```bash
   jux diff --runs <A> <B>
   jux diff --runs <A> <C>
   ```

   See [Commands](cli.md) for the output and exit codes.

### Run it in CI

`.github/workflows/field-tests.yml` runs the script against all three
Storybooks every night and on manual dispatch. It doesn't run on pull
requests, because a full sweep takes about half an hour per Storybook. To check
a capture change before you merge it, dispatch the workflow on your branch. Each job builds the Storybook
from the pinned commit above (cached by commit), runs two passes, and fails on
a capture error, on a story that differs across passes, or on a slow run.

The gate reads `scripts/field-tests.config.json`: for each Storybook,
`knownVariable` lists stories allowed to differ across passes,
`maxUnlistedDifferences` is how many other stories may differ before the job
fails, `allowedErrors`
lists stories allowed to error, and `maxWallSeconds` is the per-pass ceiling.
The first lists came from the macOS runs above. A GitHub runner is several
times slower than a laptop (p50 around 0.9 s against 0.5 s), and its slow runs
show a longer tail of load-sensitive stories that differ, a few new ones on
every run, so the gate tolerates a handful beyond the list. Linux can differ, for example
in fonts and timing, so after a CI run shows a story that is stable or newly
variable, edit the list and note why in the commit. To run the same gate
locally, add `--storybook <name>`.

When a story differs across passes, the artifact also holds its captures: for
each story that differed or errored, `images/<storyId>/` has the image and
structure sidecar from every pass (`pass-<n>-<hash8>.webp`) and a `diff.md`
that lists the hashes, capped at 200 MB in total. The recheck capture that
`jux run` takes is not stored, only its hash. To investigate a story, start
the workflow by hand with `stories` set. This skips the gate and only reports
and uploads images. For example:

```sh
gh workflow run field-tests.yml -f storybook=spectrum \
  -f stories=card--toggles,card--default -f passes=20
```

Locally, pass the same list to the script as `--stories <id,id,...>`; the pass
count stays the second argument.

### Run the script

`scripts/field-test.mjs` does steps 2 to 4 for fresh passes. It takes a
`buildDir` and a pass count. For each pass it runs `jux run --all` with a
fresh browser and a temporary state dir. It then compares every later pass
with the first through `jux diff --runs --json`, and prints the identical
count, the wall time, and the p50 and p95 of `durationMs` from `report.json`.

```bash
pnpm build
node scripts/field-test.mjs /path/to/storybook-static 3
```

The script needs a built CLI, writes its project and state to temporary
directories, and removes them when it finishes. It has no dependencies.

For example, against the Storybook in `examples/`:

```bash
pnpm --filter example-storybook build
node scripts/field-test.mjs examples/storybook/storybook-static 2
```

```text
pass 1: 18 results, 0 errors, wall 1.2 s, p50 155 ms, p95 174 ms
pass 2: 18 results, 0 errors, wall 1.1 s, p50 146 ms, p95 175 ms
pass 1 = pass 2: 18/18 byte-identical, 0 differ, 0 missing
```

The example workbench has 18 results, so its timings aren't comparable with
the tables above.

### Investigating Linux concurrency

For a targeted investigation, dispatch the field-test workflow with `stories`,
`passes: 5`, and `concurrency: sweep`. This runs workers 1, 2, and 3 sequentially
on the same runner and stores separate results in `workers-1/`, `workers-2/`, and
`workers-3/`. Individual concurrency values are also supported; `configured`
keeps the suite's existing setting. Locally, pass `--concurrency 1` (or 2/3) to
`scripts/field-test.mjs`. A story subset skips the tolerance gate, so inspect the
reported differences rather than interpreting a green workflow as determinism.

The workflow's `renderer` input accepts `shared`, `fresh`, `pulse`, or `sweep`.
The sweep runs those policies sequentially and separates artifacts by renderer;
`pulse` enables resource-cache clearing on shared renderers. The local harness
accepts `--renderer shared|fresh|pulse`. These investigation runs compare raw
capture hashes, not the bounded recovery rate against an approved manifest.
