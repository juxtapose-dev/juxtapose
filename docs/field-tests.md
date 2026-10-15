# Field tests

<!-- COPY: one-paragraph headline/positioning, written by the maintainer -->

This page lists what jux measured on three public Storybooks, how jux keeps
those captures stable, what still varies, and how to repeat the measurements.

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
