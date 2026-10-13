# juxtapose

Visual regression testing for component workbenches. Captures every story,
compares against approved baselines, and tells you exactly what changed.

Works with **Storybook** — any renderer, not just React — and **Ladle**,
through the same CLI. Baselines live in
your repo by default — no bucket, no account, no service.

```bash
npx jux run           # capture and compare
npx jux approve --all # bless the current rendering
npx jux check         # exit 0/1, for CI
```

## Hosted review

<!-- [YOUR COPY] one or two sentences on what hosted review is for and who it
     is for. Everything below this line is factual and can stay as written. -->

```bash
npx jux run --comment
# then review at https://<your-org>.juxtapose.dev
```

Two things worth knowing up front:

**Your baselines don't move.** They stay committed in your repo. The service
renders the review surface; git still defines what "approved" means, exactly as
it does locally. Approving in the browser produces the same manifest diff you
would get from `jux approve`.

**It's optional.** The CLI and the Storybook addon work with no account at all.
Hosted review is the same API the addon already talks to — one review surface,
two places to open it.

## What's different

**Pass/fail is exact.** A story passes if it renders identically to its
approved baseline. There is no "5% is probably fine" threshold to argue about,
and no slow drift as a dozen small changes accumulate into a redesign nobody
approved. When a story does change, you get the mismatch percentage and the
exact regions that moved.

**Baselines are committed.** Approving a change is a diff in the pull request
that caused it, reviewable next to the code. Branches get the right baselines
by checking out the branch, and undoing a bad approval is `git revert`.

**Every command emits JSON**, and `jux handoff` turns a failing story into a
prompt an agent can act on — exact mismatch figures, changed-region coordinates
and the component's source path, rather than an image it has to squint at.

## Getting started

```bash
pnpm add -D @juxtapose/cli
npx storybook build          # or: npx ladle build
npx jux init                 # writes the config, captures, approves
```

`init` does the steps below in one command; run them yourself if you'd rather
see each:

```bash
npx jux run --all            # everything is "new" the first time
npx jux approve --all        # establish baselines
git add juxtapose.manifest.json .juxtapose/baselines
```

From then on, `jux run` captures only the stories your changes could have
affected, by following the import graph from each changed file. When it can't
be certain — a config or dependency change, or anything it can't trace — it
captures everything instead. Missing a regression is much worse than spending a
few extra seconds, so it errs that way deliberately. Every report says which
set it chose and why; `--all` forces a full run.

## Commands

| command                       | what it does                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `jux init`                    | set up config and capture the first baselines                                    |
| `jux run`                     | capture affected stories and compare to baselines                                |
| `jux run --all`               | capture everything, skipping change analysis                                     |
| `jux approve --all`           | promote the last run's captures to baselines                                     |
| `jux approve --story <id>`    | approve one story                                                                |
| `jux check`                   | exit non-zero if anything still needs review — for CI                            |
| `jux handoff <id>`            | print an agent-ready prompt for one failing story                                |
| `jux snap <url>… --as <name>` | capture a page (or several with `--as-prefix`): pixels + structure, no workbench |
| `jux diff <a> <b> --json`     | tier-0 verdict: what changed between two snaps, no browser                       |

All commands accept `--json` for machine-readable output. `jux run` exits
non-zero when any story fails, is new, or has a stale baseline.

## Agent loop: snap → edit → snap → diff

Pixels say _where_ something changed. The verdict says _what_: which element,
which property, old → new, and whether that explains every changed pixel.

```bash
jux snap http://localhost:5173/settings --as before
# …edit code…
jux snap http://localhost:5173/settings --as after
jux diff before after
```

Exit 0 means identical, 1 means different, 2 is a usage error, 3 means the
tool or environment failed (no browser, an input that will not read) — never
approve on a 3. `jux diff` does not launch a browser. The outputs below are
real, from the mutation corpus (`scripts/structural-corpus.mjs`): one page, one
CSS property changed per variant.

Human form:

```
style-only (color): button[name="Save"] color #ffffff→#fef08a. Structure explains the changed region.

  button[name="Save"] color #ffffff → #fef08a

next: jux diff before after-color --crops  (opens the pixels)
```

With `--json`, the same verdict as one object, byte-identical for the same
inputs:

```json
{
  "schema": "juxtapose.verdict/v1",
  "classification": "style-only",
  "styleTags": ["color"],
  "summary": "style-only (color): button[name=\"Save\"] color #ffffff→#fef08a. Structure explains the changed region.",
  "deltas": [
    {
      "kind": "style",
      "el": "button[name=\"Save\"]",
      "prop": "color",
      "from": "rgb(255, 255, 255)",
      "to": "rgb(254, 240, 138)"
    }
  ],
  "deltaCount": 1,
  "coverage": 1,
  "explained": "full",
  "unexplainedRegions": [],
  "flags": [],
  "signature": "4ea08e7155e04f1e8e213dacfcc01e7aa2292ab257df85a8840def0d566632d4",
  "escalate": {
    "command": "jux diff before after-color --crops"
  }
}
```

### Why structure: a change the pixel diff cannot see

A `background-color` change from `#2563eb` to `#1d4ed8` is under the pixel
diff's tolerance: the images differ, but nothing is marked. The verdict still
names the property:

```
style-only (color): button[name="Save"] background-color #2563eb→#1d4ed8. Pixel diff below tolerance; structure explains it.

  button[name="Save"] background-color #2563eb → #1d4ed8

flags: sub-threshold

next: jux diff before after-bg --crops  (opens the pixels)
```

`flags: sub-threshold` is how you know the pixels alone would have told you
nothing; the deltas are the change.

### Several pages at once

One browser launch, one snap per page, then one verdict per page. Below, the
corpus server plays the edit: before it, `/op/color` and `/op/padding` serve
the unchanged page.

```bash
jux snap $URL/op/noop $URL/op/color $URL/op/padding --as-prefix before
# …edit code…
jux snap $URL/op/noop $URL/op/color $URL/op/padding --as-prefix after
jux diff --prefix before after
```

```
3 pages: 2 changed, 1 identical

op-color: style-only (color): button[name="Save"] color #ffffff→#fef08a. Structure explains the changed region.

  button[name="Save"] color #ffffff → #fef08a

next: jux diff before-op-color after-op-color --crops  (opens the pixels)

op-padding: style-only (spacing): button[name="Save"] padding 8px 12px→12px 16px; 6 elements after button[name="Save"] moved down 4px; main resized height +4px (+3 more). Structure explains all 9 changed regions.

  button[name="Save"]
    padding 8px 12px → 12px 16px
    resized +8×+8px, moved up 4px
  6 elements after button[name="Save"] moved down 4px
  img[name="Logo"] moved right 8px
  main resized height +4px

next: jux diff before-op-padding after-op-padding --crops  (opens the pixels)

op-noop: identical: images byte-identical, no structural change.
```

`--json` prints the page set (`juxtapose.verdict-set/v1`, below).

### The verdict (`juxtapose.verdict/v1`)

| field                | meaning                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`             | `juxtapose.verdict/v1`                                                                                                                                                                                                                                                                                                                                  |
| `classification`     | `identical` (byte-identical images and no deltas — never just "0 changed pixels"; if the pixels contradict the caller's `imagesIdentical`, the pixels win), `render-drift`, `dimension-change`, `element-added`, `element-removed`, `reflow`, `geometry`, `text-only`, `style-only`, `attr-only`, `mixed`, `unknown`                                    |
| `styleTags`          | for `style-only`/`mixed`: `color`, `typography`, `spacing`, `border`, `effects`                                                                                                                                                                                                                                                                         |
| `summary`            | templated, ≤ 300 chars                                                                                                                                                                                                                                                                                                                                  |
| `deltas`             | at most 20 typed facts (`text`, `style`, `attr`, `added`, `removed`, `moved`, `resized`, `shift`), and only the prefix that keeps the verdict ≤ 1,500 chars (labels ≤ 60, values ≤ 200)                                                                                                                                                                 |
| `deltaCount`         | total deltas found, including any not listed                                                                                                                                                                                                                                                                                                            |
| `coverage`           | fraction of changed-region area touching a delta's element                                                                                                                                                                                                                                                                                              |
| `explained`          | `full` (coverage ≥ 0.98), `partial` (≥ 0.5) or `none`                                                                                                                                                                                                                                                                                                   |
| `unexplainedRegions` | changed regions no delta accounts for: canvas, image content, or rendering drift (the prefix that fits the 1,500-char budget; `coverage` covers all)                                                                                                                                                                                                    |
| `flags`              | `element-removed`, `text-changed`, `large-reflow`, `unexplained-pixels`, `sub-threshold` (the images differ but the pixel diff marked nothing; the deltas are the change), `structure-truncated`, `no-baseline-structure`, `no-current-structure`, `below-fold`                                                                                         |
| `signature`          | sha256 of the classification and the deltas with elements abstracted to role/tag — the same change on two pages shares one                                                                                                                                                                                                                              |
| `escalate.command`   | the next command to run: `jux diff <a> <b> --crops` for a snap pair, `jux handoff <id>` for a story in a run. `--crops` is not implemented yet; it prints the two image paths to open and exits 0. Arguments are shell-quoted when needed, and a `.webp` path argument appears verbatim, so a verdict for two absolute paths names this machine's paths |

The verdict never decides pass/fail — the pixel hash does. It explains a
failure so an agent can compare the deltas with what it meant to change.
`jux run` attaches the same object to each failing story as
`results[].structural`, and `jux handoff` leads with it.

### The page set (`juxtapose.verdict-set/v1`)

`jux diff --prefix before after --json` pairs `before-<slug>` with
`after-<slug>`. Slugs are path-based (path, query and fragment), so the
pairing survives a dev-server port change.

| field     | meaning                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`  | `juxtapose.verdict-set/v1`                                                                                                                                                                                                                                                                                                                                                 |
| `pages`   | `{ slug, a, b, verdict }` per paired page, sorted by slug; `verdict` is a `juxtapose.verdict/v1`                                                                                                                                                                                                                                                                           |
| `missing` | `{ slug, have, want }` for a slug present under only one prefix: `want` is the snap name to take                                                                                                                                                                                                                                                                           |
| `errors`  | `{ slug, code, file }` for a pair that could not be compared. `code` is `snap-missing`, `sidecar-undecodable`, `image-undecodable` or `pair-undecodable` (both images look like WebP but one will not decode, and the decoder cannot say which); `file` is the snap file's basename (the same on every OS), or `null` for `pair-undecodable`. Never contains OS error text |
| `summary` | `{ identical, different, missing, errored }`                                                                                                                                                                                                                                                                                                                               |

### Exit codes

| code | meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| 0    | identical                                                                             |
| 1    | different (for a page set: any page `different` or `missing`)                         |
| 2    | usage error: bad flags, a snap name collision, an input that cannot be a snap         |
| 3    | the tool or environment failed: no browser, an unreadable input, any `errors[]` entry |

For a page set, 3 beats 1 beats 0. One bad pair does not stop the others from
being verdicted. An unexpected crash prints one line and exits 3; set
`JUX_DEBUG=1` to also print the stack trace.

## In CI

`jux run --comment` posts a summary to the pull request, updating the same
comment on every push rather than adding a new one:

```yaml
- run: npx storybook build
- run: npx jux run --comment --html
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: juxtapose-report
    path: .juxtapose/runs/*/report.html
```

The job needs `permissions: pull-requests: write`.

`--html` writes a self-contained `report.html` into the run directory: every
image is inlined, so it works opened straight from disk. Uploading it is what
lets the PR comment link somewhere useful — the comment adds that link only
when a report was actually written, so a run without `--html` gets no link
rather than one pointing at an empty artifacts list.

Outside a pull request — locally, or on a push — `--comment` is a no-op and
never changes the exit code: a reporting problem should not fail a build that
otherwise passed.

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

Also accepted: `buildDir` and `origin` (the CLI flags' defaults), `threshold`
and `minDiffPercent` as project-wide versions of the per-story options below,
and `warmSwitch` — off by default, and best left there: it is ~4x faster but
does not reproduce cold-load pixels exactly, which under a byte-exact hash
makes a story's verdict depend on where it lands in the queue.

`.juxtaposerc.json` works as well. JSON only — a `.ts` or `.js` config is not
loaded.

Concurrency defaults to 8. Higher is not automatically better — past your core
count, contention slows captures down rather than speeding them up.

Per-story options go through the platform's own parameter mechanism
(`parameters.juxtapose` in Storybook, `meta.juxtapose` in Ladle):

| option                         | purpose                                             |
| ------------------------------ | --------------------------------------------------- |
| `skip`                         | never capture this story                            |
| `viewport`                     | override the capture size                           |
| `animations: 'play'`           | let animations run (for stories testing animation)  |
| `captureAfterPlay`             | screenshot after interactions, not at first render  |
| `waitForSelector`              | wait for async content juxtapose can't detect       |
| `delay`                        | fixed extra wait; last resort                       |
| `threshold` / `minDiffPercent` | tune the _reported_ diff; the hash still decides    |
| `captureTimeout`               | max ms to wait for render-ready (default 2000)      |
| `mask`                         | paint over selectors before the shutter (see below) |
| `liveCapture: false`           | exclude from watch-mode recapture (see below)       |

Captures are reproducible: animations are frozen, webfonts and images
are awaited, and rendering is pinned to settings that don't vary by machine.

### Content that changes every run

A clock, a random avatar, a generated id — under an exact hash these are
permanently red, and no threshold rescues them. Stub the date, seed the random
source, pin the fixture. That keeps full pixel coverage.

When the nondeterminism isn't yours to control, `mask` covers it:

```jsx
export const Deploy = {
  render: () => <DeployStatus />,
  parameters: { juxtapose: { mask: ['[data-testid="finished-at"]'] } },
};
```

Everything outside the box is still compared exactly.

A mask hides what is inside the box, not the box itself. The box is the
element's bounding box, so if the volatile content changes the element's
_size_, the box changes with it and everything around it moves. A bare
timestamp span failed at 0.015% that way, from a sliver leaking at the edge.

A fixed width alone is not enough. Our example clock had `width: 200px` and
still flaked: some timestamps fit on one line and some wrapped to two, so the
box went from 18 to 36 px tall and pushed the card around it. Pin both
dimensions:

```jsx
<span
  data-testid="finished-at"
  style={{ display: 'inline-block', width: 280, whiteSpace: 'nowrap' }}
>
  {new Date().toISOString()}
</span>
```

- **`white-space: nowrap`** keeps the height fixed.
- **A width that fits the longest value** keeps the text from overflowing the
  box. Overflowing text is painted outside the mask.

If you can't change the element, mask a fixed-size container around it
instead.

## Watch mode

```bash
pnpm add -D @juxtapose/storybook   # then add it to .storybook/main.js addons
```

With the addon installed, editing a component recaptures it while you work, so
the diff is ready before you go looking for it. Storybook's own hot
reload is the trigger — there is no file watcher to configure — and a burst of
saves is coalesced into one capture.

Scope is every story sharing the component you edited. If a `storybook build`
happens to be lying around, that widens to everything importing it, since the
dev server has no bundler graph of its own to consult. Set
`liveCapture: false` on a story whose play function or delay makes constant
recapture cost more than it returns; it still captures on a normal run.

juxtapose waits on things it can observe —
network requests, DOM changes, fonts, images. Content that appears on a bare
timer is invisible to that, so a story built on `setTimeout` can race the
capture. `waitForSelector` is the fix.

## Packages

Two of these are the ones you install:

| package                | what it is                                           |
| ---------------------- | ---------------------------------------------------- |
| `@juxtapose/cli`       | the `jux` command — capture, approve, check, handoff |
| `@juxtapose/storybook` | Storybook addon: review diffs in place, watch mode   |

Ladle needs no second package — the CLI covers it, and Ladle has no addon slot
to put a panel in.

The rest arrive as dependencies. You would only reach for one directly to build
an adapter or a UI of your own:

| package                        | what it is                                                 |
| ------------------------------ | ---------------------------------------------------------- |
| `@juxtapose/core`              | capture, diff, baselines, analysis — no platform knowledge |
| `@juxtapose/server`            | the local review API the addon is a skin over              |
| `@juxtapose/adapter-storybook` | teaches the CLI to drive Storybook                         |
| `@juxtapose/adapter-ladle`     | teaches the CLI to drive Ladle                             |

The two Storybook packages are not alternatives. `adapter-storybook` is how the
CLI captures stories — it runs in Node, drives a browser, and you never import
it. `@juxtapose/storybook` is the addon that renders the review UI inside
Storybook itself. Installing the addon pulls the adapter in.

## Status

Early, but usable. The capture, diff and approve loop is verified end to end on
Storybook (React and Vue) and Ladle, the addon gives you the review UI in
place, and CI gets PR comments and a self-contained HTML report.

Hosted baseline storage is the main gap. `storage.kind` accepts `"s3"`, but the
CLI throws on it today — git is the only implemented backend, and `"fs"` is that
same store pointed at a directory you choose. That is about where the image
bytes live, not about review: hosted review works with baselines in git. See
the [issues](https://github.com/juxtapose-dev/juxtapose/issues) for the roadmap.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the design and the reasoning behind it.

## License

MIT © Magic Factory LLC. See [LICENSE](LICENSE).
