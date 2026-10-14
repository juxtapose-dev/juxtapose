# Configuration

`juxtapose.config.json`, or a `juxtapose` key in package.json:

```json
{
  "$schema": "./node_modules/@juxtapose/cli/schema.json",
  "platform": "storybook",
  "concurrency": 8,
  "viewport": { "width": 1280, "height": 800 },
  "storage": { "kind": "git" }
}
```

Also accepted: `buildDir` and `origin` (the CLI flags' defaults), `threshold`,
`minDiffPercent`, `waitForSelector`, `delay`, `settle` and `network` as project-wide
versions of the per-story options below, and `warmSwitch` — off by default, and best left there: it is ~4x faster but
does not reproduce cold-load pixels exactly, which under a byte-exact hash
makes a story's verdict depend on where it lands in the queue.

`stories` sets per-story options by story id glob, for a Storybook you don't
own: see [Override stories you don't own](#override-stories-you-dont-own).

The `$schema` line gives editors such as VS Code completion, hover docs and
validation for every option. `jux init` writes it pinned to the installed
version of `@juxtapose/core`, so the editor knows the options your jux knows:
`https://cdn.jsdelivr.net/npm/@juxtapose/core@<version>/schema.json`. Update
the version when you upgrade. To work offline, point it at a local copy
instead:

- `./node_modules/@juxtapose/cli/schema.json`, which works with any package
  manager when `@juxtapose/cli` is a dependency of the project.
- `./node_modules/@juxtapose/core/schema.json`, which needs `@juxtapose/core`
  as a direct dependency under pnpm, since pnpm doesn't hoist.

The schema isn't on SchemaStore yet, so editors don't find it without the
`$schema` line.

The editor flags any key the schema doesn't know. `jux` doesn't refuse one.
`jux run`, `init`, `snap`, `mcp` and the review server print one warning per
unknown key on stderr, with the closest option it could mean. The warning
doesn't change the exit code or `--json` output:

```
jux: project config: unknown option 'concurency' is ignored (did you mean 'concurrency'?)
```

An unknown key in `parameters.juxtapose` is reported once per run, naming the
first story that sets it and how many more do.

The schemas are also exported from `@juxtapose/core` (`ProjectConfigSchema`,
`JuxtaposeParametersSchema`, `SettleSchema` and others) as
[TypeBox](https://github.com/sinclairzx81/typebox) schemas. They use jux's own
string formats (URL patterns, CSS selectors) and an enum kind. Call
`registerFormats()` before checking a value with TypeBox. If your TypeBox is a
different copy from the one `@juxtapose/core` uses, pass its registries:
`registerFormats({ FormatRegistry, TypeRegistry })`.

`.juxtaposerc.json` works as well. JSON only — a `.ts` or `.js` config is not
loaded.

`storyTimeout` (ms, whole number from 1000, default 60000) is the budget for capturing one story, navigation through encode. It is a floor under settle: a story's effective budget is the larger of `storyTimeout` and its settle timeout plus `delay` plus 15 s, so a slow story still yields a flagged capture instead of an error. A story that uses all of it fails once with an error naming the step it was stuck in, its page is discarded and replaced, and the run continues. A page whose main thread is busy (a very large DOM, a runaway script) otherwise stalls each browser call for 30 s in turn. The failed story records its real `durationMs`.

`freshRenderer` (default `true`) starts each cold capture after a page's first
in a new Chrome renderer process. jux reuses one page per worker, and Chrome's
renderer keeps state across navigations, including about:blank: canvas text
measurement at a fractional font size, font metrics and raster caches. One
story could change the next one's pixels. In Primer React, PageLayout's
pull-request-page heading was 0.11 px wider after a story that measured canvas
text, and in Spectrum the edge of a card's cover image changed after a button
group. The queue is shuffled, so such a story's verdict depended on queue
order. With `freshRenderer` on, a story's hash is independent of the story
captured before it on the same page. A story whose pixels depend on load or
timing can still vary from run to run; that is what the settle options are for.

Chrome decides whether a navigation gets a new process. Once a browser holds
its renderer-process limit, Chrome reuses a process that already ran a story.
Chrome derives its default limit from memory: 24 on a 4 GB machine. jux
launches Chrome with `--renderer-process-limit=1000`, so with the browser jux
starts the limit isn't reached. With a browser that holds a lower limit, a
story can still land in a used renderer. jux flags that result
`renderer-reused` (in `report.json` `flags` and in `jux snap` output) and warns
once per run.

The check that every story starts in a new renderer process is
`packages/core/src/capture/fresh-renderer-capture.test.ts`. Its pixel test
fails only with the macOS system font, so on Linux the renderer-process tests
in the same file are the guard.

It costs time. A cold renderer runs the workbench's JavaScript again without
the JIT state it had built up. Measured on Chrome 151, macOS, on a shared,
loaded machine:

|                                                    | renderer reused | fresh renderer |
| -------------------------------------------------- | --------------- | -------------- |
| trivial page navigation                            | 3 ms            | 34 ms          |
| Spectrum story load, median                        | 125–142 ms      | 350–395 ms     |
| full Spectrum pass (1,086 stories), concurrency 8  | 47 s            | 83 s           |
| full Spectrum pass (1,086 stories), concurrency 16 | 36 s            | 70 s           |

The V8 code cache does not recover the cost, and raising `concurrency` does not
hide it: the work is CPU-bound.

Set `"freshRenderer": false`, or pass `--no-fresh-renderer` to `jux run` or
`jux snap`, for speed-critical runs where you accept that a story's pixels can
depend on the story captured before it. A pass can then disagree with an
earlier one for a few stories, with no code change behind it. Warm switching
(`warmSwitch`) never starts a new renderer.

Concurrency defaults to 8. Higher is not automatically better — past your core
count, contention slows captures down rather than speeding them up.

`mcp.concurrency` sets how many snaps `jux mcp` captures at once, from 1 to 16. The default is half the CPU cores, from 1 up to 4. See [MCP server](mcp.md#snap-concurrency).

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
| `settle`                       | how long to wait for the page to finish (see below) |
| `threshold` / `minDiffPercent` | tune the _reported_ diff; the hash still decides    |
| `captureTimeout`               | max ms to wait for render-ready (default 2000)      |
| `mask`                         | paint over selectors before the shutter (see below) |
| `liveCapture: false`           | exclude from watch-mode recapture (see below)       |

In a TypeScript Storybook, `parameters.juxtapose` is typed once
`@juxtapose/storybook` is part of the program, so a misspelled option is a type
error. Import it for its types anywhere in the project, for example in
`.storybook/preview.ts`:

```ts
import type {} from '@juxtapose/storybook';
```

The type is `JuxtaposeParameters`, exported by `@juxtapose/storybook` and
`@juxtapose/core`. The augmentation has been verified with Storybook 8.6's
`Meta` and `StoryObj`. It targets `storybook/internal/csf`, which Storybook 9
and 10 also export, but it hasn't been checked against them yet.

Captures are reproducible: juxtapose freezes animations, waits for the page to
finish its work (see [Settle](#settle)), and pins rendering to settings that
don't vary by machine.

### Shadow DOM

The animation freeze, the settle wait and the image wait reach into open
shadow roots, including roots attached after the story starts rendering, so
web components (Lit, for example) are frozen and waited for like the rest of
the page. Web fonts are waited for wherever they're used.

Closed shadow roots (`attachShadow({ mode: 'closed' })`) stay out of reach:
animations inside them keep running, and their DOM changes and images aren't
waited for. If a component uses one, `mask` its host element, and use
`settle.ready` to wait for it to finish rendering.

## Settle

After a story renders, juxtapose waits until the page has no pending work, then
captures it. Pending work is any of the following:

- A timer due within 1000 ms (`setTimeout`, or a `setInterval` before its first
  tick). A timer of 16 ms or more, set again from the same place in the code
  after an earlier one there fired, counts only if the DOM changed since that
  one fired. So a poll that changes nothing stops counting after its first
  period, while a chain that reveals something at each step is waited for.
- An animation frame callback, unless the page re-requests it from inside one
  for more than three frames, which is an animation loop.
- A posted message not yet delivered, such as React's scheduler. Messages to a
  port that never delivers stop counting once deliveries stop.
- A dedicated `Worker` that hasn't answered a message posted to it, for up to
  1000 ms after the post, or a new worker that hasn't sent anything yet, for up
  to 300 ms after it's created.
- A DOM change since the previous check, in the document or an open shadow
  root.
- A web font that is still loading.
- An image that is still loading, in the document or an open shadow root,
  unless it's lazy and either outside the viewport or not rendered
  (`display: none`).
- A network request in flight, unless it's ignored (see
  [Network requests](#network-requests)).

A page with no pending work is captured within a few tens of milliseconds. A
page that keeps working is captured when the wait reaches its cap,
`settle.timeout`. The capture still happens, and the result is flagged
`settle-timeout` with a list of what was pending, for example
`1 request to /api/feed in flight (Fetch)`. The flag never changes a pass or a
failure, and it appears in `jux run` output, in `report.json` (`flags` and
`settle` on the result, and `settle-timeout` in the verdict's `flags`), in
`jux snap` results and in `jux handoff`.

If the wait can't run at all, for example because the page navigated during
it, juxtapose waits for fonts, images and 100 ms without a DOM change instead,
within the same cap, and flags the result `settle-fallback` with the reason.

```json
{
  "settle": {
    "timeout": 3000,
    "ready": false,
    "network": {
      "ignore": ["/api/poll", "type:Fetch **/analytics/**"],
      "require": ["/api/feed"]
    }
  }
}
```

| option            | default | purpose                                                                    |
| ----------------- | ------- | -------------------------------------------------------------------------- |
| `timeout`         | `1500`  | the cap on the wait, in ms, from 1 to 60000                                |
| `ready`           | `false` | also wait until the page calls `window.__juxtapose.ready()`                |
| `network.ignore`  | `[]`    | URL patterns never counted as pending, added to the built-in list          |
| `network.require` | `[]`    | URL patterns that must each see a matching request complete before capture |

Timers longer than 1000 ms are never waited for, because a timer that long is
usually a session timeout or a poll, not part of the render. With a `timeout`
below 1500 ms, the limit is two thirds of the `timeout`. To wait for work that
starts later than that, use `ready`, `network.require` or `waitForSelector`.

### Layers

Settle options come from five places. Each one overrides the one before it:

1. Built-in defaults.
1. The project config: `settle`, `waitForSelector` and `delay`.
1. The story's parameters (`parameters.juxtapose`, including a variant's own
   settings).
1. The project config's [`stories` overrides](#override-stories-you-dont-own).
1. The command: `jux snap` and `jux run` flags, or the `settle` argument of the
   MCP `snap` and `run` tools.

`timeout`, `ready`, `waitForSelector` and `delay` take the value from the
highest layer that sets them. The `network.ignore` and `network.require` lists
combine across layers, so a story adds patterns to the project's lists.

An invalid value is a usage error. The command exits with status 2 and names
where the value came from, such as `project config` or
`story 'feed--default'`. A value that only the live Storybook preview declares
is checked when the story renders, and an invalid one fails that story.

### Network requests

A pattern is a URL glob, a resource type, or both, separated by a space:

| pattern                      | matches                                               |
| ---------------------------- | ----------------------------------------------------- |
| `/api/feed`                  | requests whose path is exactly `/api/feed`, any query |
| `/api/*`                     | one path segment under `/api/`                        |
| `/api/**`                    | anything under `/api/`                                |
| `https://cdn.example.com/**` | the whole URL, when the glob doesn't start with `/`   |
| `type:EventSource`           | every request of that type                            |
| `type:Fetch /api/**`         | `fetch()` requests under `/api/`                      |

In a glob, `**` matches any characters, `*` matches any characters except `/`,
and `?` matches one character except `/`. The type is a Chrome DevTools
Protocol
[resource type](https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-ResourceType),
such as `Fetch`, `XHR`, `Image`, `Script` or `EventSource`, in any case.

`network.ignore` always includes `type:WebSocket`, `type:EventSource`,
`type:Ping` (`navigator.sendBeacon` and `<a ping>`) and `type:Prefetch`. These
requests stay open for the life of the page or don't affect its pixels. Add a
pattern for anything else that never finishes, such as a long poll or an
analytics call.

`network.require` waits for a request that starts too late for the rest of the
wait to notice, such as a fetch behind a long timer. Each pattern must match a
request that completes, successfully or not, after the story starts rendering.
If a request matches both lists, `require` wins, so you can wait for one
request of an ignored type.

### Navigation and slow subresources

Navigation resolves when the page's `DOMContentLoaded` event fires, not its
`load` event. `load` waits for every subresource, so one image or script that
never finishes (a broken third-party link that answers after 20 s) used to hold
a worker for up to 30 s on every run, whatever `captureTimeout` or
`settle.timeout` said. Now the settle wait owns that time: it tracks requests
and images still in flight, and a page that is still waiting on a subresource
at `settle.timeout` is captured anyway and flagged `settle-timeout` with the
request named in `pending`. Pages that had finished loading capture the same
pixels as before, with one difference: a subresource that takes longer than
`settle.timeout` but under 30 s to arrive used to be waited for by `load` and
captured loaded. It's now captured without it and flagged `settle-timeout`
naming the request. Raise `settle.timeout` for such a page, or
[block](#third-party-requests) the request. A document that never reaches `DOMContentLoaded` (a blocking
script that hangs) still fails the story after 30 s.

### Third-party requests

```json
{ "network": { "external": "block" } }
```

| option             | default | purpose                                                                                      |
| ------------------ | ------- | -------------------------------------------------------------------------------------------- |
| `network.external` | `allow` | `block` fails requests to origins other than the page's own (the story URL's origin) at once |

With `block`, an external image, font, script or frame fails the moment it's
requested. It doesn't fetch bytes that change between runs (a random photo, a
CDN), it never holds the page to the settle cap, and it isn't counted as
pending, so the capture isn't flagged. The page sees an ordinary failed
request, so an `<img>` shows its fallback. `data:`, `blob:` and `about:` URLs,
and the top-level document (including a redirect to another origin, whose own
resources then count as same-origin), are never blocked. Dedicated-worker
fetches are intercepted. WebSockets and anything running outside the page's
own browser process (an out-of-process iframe) are not.

`block` also blocks CDN web fonts and stylesheets, such as Google Fonts, so
turning it on changes the pixels of every story that uses one and re-baselines
the suite. A deployed Storybook that serves its assets from a separate origin
(a CDN host) fails under `block`; use it with a build on disk or a dev server
that serves its own assets.

It's layered like `settle`: the project config, then the story's
`parameters.juxtapose.network`, then the command (`--network-external block`,
or `network: { "external": "block" }` in the MCP `snap` and `run` tools). Only
values known before navigation apply, so a value that only the live Storybook
preview declares is ignored. Recording and replaying external responses is
tracked in #147 and isn't implemented.

### Ready signal

For content that no request or timer reveals, such as a chart that renders in a
worker, let the page say when it's done. Set `settle.ready` to `true` and call
the function when the page is ready:

```js
window.__juxtapose?.ready();
```

juxtapose defines `window.__juxtapose` before any of the page's scripts run, so
the call is safe at any time, including before juxtapose starts waiting. Outside
juxtapose, the optional chaining makes it a no-op. If the page never calls it,
the capture happens at the cap and the result is flagged `settle-timeout` with
`window.__juxtapose.ready() was not called`.

### When a capture is flagged

Read the `pending` list, then do one of the following:

- **The work never finishes**, such as a poll, a stream or an analytics call.
  Add its pattern to `network.ignore`.
- **The work is slow but finishes.** Raise `timeout`.
- **The page shows a different state at every capture**, such as a clock or a
  ticking counter. Mask it (see [Content that changes every run](#content-that-changes-every-run)).

## Content that changes every run

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

## Override stories you don't own

Per-story options live in `parameters.juxtapose`, which you can only edit in a
Storybook you own. For a deployed `origin` or someone else's `buildDir`, put
the same options in the project config under `stories`, keyed by story id:

```json
{
  "platform": "storybook",
  "buildDir": "chakra/storybook-static",
  "stories": {
    "components-card--basic": { "mask": ["img"] },
    "components-sandbox--re-renders": { "mask": ["[data-testid=clock]"] },
    "components-aspectratio--*": {
      "settle": { "network": { "ignore": ["**/tile.openstreetmap.org/**"] } }
    },
    "components-codeblock--*": { "waitForSelector": ".shiki span" },
    "components-map--*": { "skip": true }
  }
}
```

An entry can set `skip`, `mask`, `delay`, `waitForSelector`, `captureTimeout`,
`settle`, `network`, `threshold` and `minDiffPercent`, with the meaning and
values they have in `parameters.juxtapose`. Anything else is an error.

**Which stories match.** A key is a story id with `*` (anything but `/`), `**`
(anything, `/` included) and `?` (one character, not `/`) as wildcards; an id
with none is an exact match. Story ids rarely contain a `/`, so `*` and `**`
differ mainly for URL-style ids. A key that matches no story is reported as a
warning by `jux run` (a typo, or a glob that cannot match). A key that
matches a story's id also covers all of its variants. To target one variant,
use its capture key, `<story id>__<variant>` (or `*__mobile` for every
variant of that name).

**Precedence.** A config override wins over the story's own
`parameters.juxtapose` (variants included, and values only the live preview
declares), and loses only to the command line. The order is: project defaults,
then the story, then `stories`, then flags. The override is above the story on
purpose. It is the project owner's word about a story they can't edit, and its
job is to correct what the story declares: a `delay` that is too short, or a
`skip` that has to go. Set `"skip": false` to capture a story whose source
skips itself.

A skipped story skips all of its variants, and a variant key cannot undo that:
`"components-card--basic__mobile": { "skip": false }` does nothing while
`components-card--basic` is skipped, and `jux run` warns about it. Set
`skip: false` on the story id instead.

**Several matching keys.** They combine from least to most specific, and the
more specific one wins a conflict:

1. Keys that name a variant (they contain `__`) come after keys that do not, so
   `*__mobile` beats an exact `components-card--basic` on the mobile capture.
1. Keys with a wildcard come before exact ids.
1. Among wildcard keys, the one with fewer literal characters comes first, so
   `components-*` yields to `components-card--*`.
1. At equal specificity, the key later in the file wins.

`delay`, `waitForSelector`, `captureTimeout`, `threshold`, `minDiffPercent` and
`skip` take the winning value. `mask` is the union of every match, since a
mask only hides more. `settle` and `network` merge field by field, and the
`settle.network` lists combine.

**Skipped by config.** A story the config skips is not dropped silently. It is
a `skip` result in the run report with `skippedBy` naming the keys, `jux run`
prints how many were skipped by `stories`, the PR comment says so, and `jux
handoff <id>` explains that nothing was captured and which entry to change.

A bad entry is a usage error that names the key, such as
`project config: stories['components-card--*']: unknown option 'dely'`.
It is checked before any browser starts, by `run`, `init`, `snap`, `jux mcp`
and the review server alike.

## Capture a built or deployed Storybook

Set `buildDir` to capture a static build. The path is relative to the project
root. jux serves the build on `127.0.0.1` for the length of the run, so you
don't need a web server:

```json
{
  "buildDir": "storybook-static"
}
```

Set `origin` to capture a deployed Storybook. jux fetches `index.json` from the
URL to list the stories, and the browser loads `iframe.html` for each one:

```json
{
  "origin": "https://storybook.chakra-ui.com/"
}
```

If you set neither, jux looks for a build in `storybook-static`, `build`,
`.ladle/build` and `dist/storybook`, in that order. A set `origin` turns this
search off.

If you set both, `origin` decides what jux captures. jux doesn't serve
`buildDir`. `jux run` still reads `buildDir` for change analysis, so point it at
the build that produced the deployed site.

The `--build-dir` and `--origin` flags override `buildDir` and `origin`
from the config. See [Commands](cli.md#capture-a-built-or-deployed-storybook).

jux caches the story parameters it reads from a `buildDir`. It keys the cache
on the hashes of `index.json` and `iframe.html`, so a changed build invalidates it.
jux never caches for an `origin`. A remote Storybook can change between runs,
so jux loads its preview again on every run.

## Baseline storage

`storage.kind` accepts `"s3"`, but the CLI throws on it in this version. Git is
the only implemented backend, and `"fs"` is the same store pointed at a
directory you choose. See the
[issues](https://github.com/juxtapose-dev/juxtapose/issues) for the roadmap.
