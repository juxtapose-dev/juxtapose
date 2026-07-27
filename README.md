# juxtapose

Visual regression testing for component workbenches. Captures every story,
compares against approved baselines, and tells you exactly what changed.

One CLI for **Storybook** (any renderer, not just React) and **Ladle**.
Baselines live in your repo by default — no bucket, no account, no service.

## Why another one

**Pass/fail is exact.** A story passes if it renders identically to its
approved baseline. There is no "5% is probably fine" threshold to argue about,
and no slow drift as a dozen small changes accumulate into a redesign nobody
approved. When a story does change, you get the mismatch percentage and the
exact regions that moved.

**Baselines are committed.** Approving a change is a diff in the pull request
that caused it, reviewable next to the code. Branches get the right baselines
by checking out the branch, and undoing a bad approval is `git revert`.

**Agent-first, not agent-compatible.** Every command emits JSON, and
`jux handoff` turns a failing story into a prompt an agent can act on — exact
mismatch figures, changed-region coordinates and the component's source path,
rather than screenshots it has to squint at.

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

| command                    | what it does                                          |
| -------------------------- | ----------------------------------------------------- |
| `jux init`                 | set up config and capture the first baselines         |
| `jux run`                  | capture affected stories and compare to baselines     |
| `jux run --all`            | capture everything, skipping change analysis          |
| `jux approve --all`        | promote the last run's captures to baselines          |
| `jux approve --story <id>` | approve one story                                     |
| `jux check`                | exit non-zero if anything still needs review — for CI |
| `jux handoff <id>`         | print an agent-ready prompt for one failing story     |

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

| option                         | purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `skip`                         | never capture this story                           |
| `viewport`                     | override the capture size                          |
| `animations: 'play'`           | let animations run (for stories testing animation) |
| `captureAfterPlay`             | screenshot after interactions, not at first render |
| `waitForSelector`              | wait for async content juxtapose can't detect      |
| `delay`                        | fixed extra wait; last resort                      |
| `threshold` / `minDiffPercent` | tune the _reported_ diff; the hash still decides   |
| `captureTimeout`               | max ms to wait for render-ready (default 2000)     |
| `liveCapture: false`           | exclude from watch-mode recapture (see below)      |

Captures are reproducible by design: animations are frozen, webfonts and images
are awaited, and rendering is pinned to settings that don't vary by machine.

### Watch mode

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

The limit worth knowing is that juxtapose waits on things it can observe —
network requests, DOM changes, fonts, images. Content that appears on a bare
timer is invisible to that, so a story built on `setTimeout` can race the
capture. `waitForSelector` is the fix.

## Packages

Two of these are the ones you install:

| package                | what it is                                           |
| ---------------------- | ---------------------------------------------------- |
| `@juxtapose/cli`       | the `jux` command — capture, approve, check, handoff |
| `@juxtapose/storybook` | Storybook addon: review diffs in place, watch mode   |

The rest are pulled in for you, and are only worth knowing about if you are
building an adapter or a UI of your own:

| package                        | what it is                                                 |
| ------------------------------ | ---------------------------------------------------------- |
| `@juxtapose/core`              | capture, diff, baselines, analysis — no platform knowledge |
| `@juxtapose/server`            | the local review API the addon is a skin over              |
| `@juxtapose/adapter-storybook` | Storybook adapter                                          |
| `@juxtapose/adapter-ladle`     | Ladle adapter                                              |

## Status

Early, but usable. The capture, diff and approve loop is verified end to end on
Storybook (React and Vue) and Ladle, the addon gives you the review UI in
place, and CI gets PR comments and a self-contained HTML report.

Hosted storage is the main gap. `storage.kind` accepts `"s3"`, but the CLI
throws on it today — git is the only implemented backend, and `"fs"` is that
same store pointed at a directory you choose. See the
[issues](https://github.com/juxtapose-dev/juxtapose/issues) for the roadmap.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the design and the reasoning behind it.

## License

MIT © Magic Factory LLC. See [LICENSE](LICENSE).
