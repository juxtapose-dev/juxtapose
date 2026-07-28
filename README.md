# juxtapose

Visual regression testing for component workbenches. Captures every story,
compares against approved baselines, and tells you exactly what changed.

Works with **Storybook** (any renderer, not just React) and **Ladle**, through
the same CLI.

Capture, compare, approve and gate CI all run locally with no account and no
bucket. Baselines live in your repo. [Juxtapose Pro](#juxtapose-pro) adds team
review in the pull request; it is optional and does not move your baselines.

```bash
npx jux run           # capture and compare
npx jux approve --all # bless the current rendering
npx jux check         # exit 0/1, for CI
```

## Juxtapose Pro

Everything above runs on one machine, free, and stays that way. Pro is for what
a single machine can't do: a team reviewing each other's visual changes in a
pull request.

**Comment on a diff.** Point at the thing that moved and say what you think,
on the diff itself rather than in a thread describing it. Reviewing a visual
change goes better when the words sit next to the pixels they are about.

**See the pixels in the pull request.** GitHub's sanitizer strips `src` from
images in comments, so a PR comment can tell you `card--long-body` changed by
1.01% across two regions, then it has to stop. Pro keeps a copy of your
baselines and renders before, after and diff right there. No artifact
download, no checkout.

The hashes stay in your repo. That is what keeps a green run cheap, since
comparing two strings beats fetching and decoding an image, and it is why
approving is still a reviewable diff in the pull request that caused it.

```bash
npx jux run --comment
# then review at https://<your-org>.juxtapose.dev
```

**Totally optional.** Nothing above moves behind a login. The CLI and the addon
capture, compare, approve and fail CI with no account, baselines in your repo.
That is the whole tool, not a trial of it.

|                        | Local, no account | Juxtapose Pro |
| ---------------------- | ----------------- | ------------- |
| Capture, diff, gate CI | ✅                | ✅            |
| Review in the PR       | ❌                | ✅            |
| Comment on a diff      | ❌                | ✅            |

There is one kind of Pro account. It starts with a free monthly budget of
snapshots, enough for a small team, and that budget is a hard cap. You get a
heads-up as you approach it. If you reach it, the PR comment says so and links
to where you can raise it, and your build keeps working: capture, comparison
and the pass or fail verdict never depended on us.

Add a payment method to raise the budget. Opt into overages if you would rather
a busy month keep reviewing than stop. Both are off until you turn them on, so
a surprise bill is not something that can happen to you.

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
prompt an agent can act on: exact mismatch figures, changed-region coordinates
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
be certain, whether that is a config change, a dependency change, or something
it can't trace, it captures everything instead. Missing a regression is much
worse than spending a few extra seconds, so it errs that way. Every report
says which set it chose and why; `--all` forces a full run.

## Commands

| command                    | what it does                                      |
| -------------------------- | ------------------------------------------------- |
| `jux init`                 | set up config and capture the first baselines     |
| `jux run`                  | capture affected stories and compare to baselines |
| `jux run --all`            | capture everything, skipping change analysis      |
| `jux approve --all`        | promote the last run's captures to baselines      |
| `jux approve --story <id>` | approve one story                                 |
| `jux check`                | exit non-zero if anything needs review, for CI    |
| `jux handoff <id>`         | print an agent-ready prompt for one failing story |

All commands accept `--json` for machine-readable output. `jux run` exits
non-zero when any story fails, is new, or has a stale baseline.

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
lets the PR comment link somewhere useful. The comment adds that link only
when a report was actually written, so a run without `--html` gets no link
rather than one pointing at an empty artifacts list.

This is the no-account way to see pixels from CI: download the artifact, open
the file. [Pro](#juxtapose-pro) skips the download.

Outside a pull request, locally or on a push, `--comment` is a no-op and
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
and `warmSwitch`, off by default and best left there: it is ~4x faster but
does not reproduce cold-load pixels exactly, which under a byte-exact hash
makes a story's verdict depend on where it lands in the queue.

`.juxtaposerc.json` works as well. JSON only; a `.ts` or `.js` config is not
loaded.

`storage.kind` takes `"git"` (the default) or `"fs"`, which is the same store
pointed at a directory you choose with `dir`. `"s3"` is declared in the type but
throws. See [#9](https://github.com/juxtapose-dev/juxtapose/issues/9).

Concurrency defaults to 8. Higher is not automatically better: past your core
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

Captures are reproducible: animations are frozen, webfonts and images are
awaited, and GPU rasterization, subpixel text, colour profile and device scale
are all pinned so they can't drift between runs.

### Capture and verify in the same environment

Those flags remove the variation juxtapose controls. They cannot change which
Chromium you have or which fonts your OS ships, and both of those move the
pixels. A baseline captured on a laptop will not match one captured on a CI
runner byte for byte, so approve where you verify: capture baselines in CI and
commit what CI produced, or run the check on the same image you developed on.

A Playwright upgrade can shift rendering the same way. When it does, every
story reports as changed at once, which is the signature to look for before
assuming a real regression.

### Content that changes every run

A clock, a random avatar, a generated id. Under an exact hash these are
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

The box is the element's bounding box, so if the volatile content changes the
element's _size_ the box changes with it and a sliver leaks at the edge. A bare
timestamp span still failed at 0.015% that way. Give the masked element a fixed
width.

## Watch mode

```bash
pnpm add -D @juxtapose/storybook   # then add it to .storybook/main.js addons
```

With the addon installed, editing a component recaptures it while you work, so
the diff is ready before you go looking for it. Storybook's own hot
reload is the trigger, so there is no file watcher to configure, and a burst of
saves is coalesced into one capture.

Scope is every story sharing the component you edited. If a `storybook build`
happens to be lying around, that widens to everything importing it, since the
dev server has no bundler graph of its own to consult. Set
`liveCapture: false` on a story whose play function or delay makes constant
recapture cost more than it returns; it still captures on a normal run.

juxtapose waits on things it can observe:
network requests, DOM changes, fonts, images. Content that appears on a bare
timer is invisible to that, so a story built on `setTimeout` can race the
capture. `waitForSelector` is the fix.

## Packages

Two of these are the ones you install:

| package                | what it is                                          |
| ---------------------- | --------------------------------------------------- |
| `@juxtapose/cli`       | the `jux` command: capture, approve, check, handoff |
| `@juxtapose/storybook` | Storybook addon: review diffs in place, watch mode  |

Ladle needs no second package. The CLI covers it, and Ladle has no addon slot
to put a panel in.

The rest arrive as dependencies. You would only reach for one directly to build
an adapter or a UI of your own:

| package                        | what it is                                                |
| ------------------------------ | --------------------------------------------------------- |
| `@juxtapose/core`              | capture, diff, baselines, analysis; no platform knowledge |
| `@juxtapose/server`            | the local review API the addon is a skin over             |
| `@juxtapose/adapter-storybook` | teaches the CLI to drive Storybook                        |
| `@juxtapose/adapter-ladle`     | teaches the CLI to drive Ladle                            |

The two Storybook packages are not alternatives. `adapter-storybook` is how the
CLI captures stories. It runs in Node, drives a browser, and you never import
it. `@juxtapose/storybook` is the addon that renders the review UI inside
Storybook itself. Installing the addon pulls the adapter in.

## Status

Early, but usable. The capture, diff and approve loop is verified end to end on
Storybook (React and Vue) and Ladle, the addon gives you the review UI in
place, and CI gets PR comments and a self-contained HTML report.

Hosted baseline storage is the main gap. `storage.kind` accepts `"s3"`, but the
CLI throws on it today. git is the only implemented backend, and `"fs"` is that
same store pointed at a directory you choose. That is about where the image
bytes live, not about review: hosted review works with baselines in git. See
the [issues](https://github.com/juxtapose-dev/juxtapose/issues) for the roadmap.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the design and the reasoning behind it.

## License

MIT © Magic Factory LLC. See [LICENSE](LICENSE).
