# Configuration

## Design references

`designReferences` names PNG targets for exact story or variant capture keys.
They are separate from approved regression baselines:

```json
{
  "designReferences": {
    "checkout-mobile": {
      "storyId": "checkout--default__mobile",
      "image": "design/checkout-mobile.png",
      "viewport": { "width": 390, "height": 844 }
    }
  }
}
```

The image path must stay inside the project, including after symlink resolution.
For a viewport target (the default), the PNG dimensions must equal
`viewport × deviceScaleFactor` (default `1`) and the saved capture must have
the same viewport. For a full-page target, set `captureKind: "full-page"` and
capture that story with `fullPage: true`:

```json
{
  "stories": { "checkout--default__mobile": { "fullPage": true } },
  "designReferences": {
    "checkout-mobile-page": {
      "storyId": "checkout--default__mobile",
      "image": "design/checkout-mobile-page.png",
      "viewport": { "width": 390, "height": 844 },
      "captureKind": "full-page"
    }
  }
}
```

The configured viewport is the browser's layout viewport, even when the PNG
extends below it. Jux compares the whole image without cropping or resizing;
the saved capture must record the same layout viewport and have the PNG's
dimensions. `jux reference` and the MCP `reference` tool compare against images
already saved by `jux run`; they never capture or approve. The comparison uses
Pixelmatch threshold `0.1` and excludes antialiasing, independently of the
approved-baseline `comparison` setting. Missing captures and geometry mismatches
are reported explicitly.

`juxtapose.config.json`, or a `juxtapose` key in package.json:

```json
{
  "$schema": "./node_modules/@juxtapose/cli/schema.json",
  "platform": "storybook",
  "concurrency": 8,
  "viewport": { "width": 1280, "height": 800 },
  "storage": { "kind": "cache" }
}
```

Also accepted: `devices`, `device` and `orientation` (see [Devices](#devices)), `buildDir` and `origin` (the CLI flags' defaults), `threshold`,
`minDiffPercent`, `waitForSelector`, `delay`, `settle`, `network` and `freeze` as project-wide
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

### Capture encoder upgrades

Captures use Chrome's lossless WebP encoder, with its ICC color-profile metadata
removed. The decoded pixels are preserved, but the encoded bytes differ from
jux 0.20 and earlier, which used PNG capture followed by Sharp encoding.
Existing exact baselines therefore need a one-time review and re-approval:

```sh
jux run --all
jux approve --all
```

Review the diffs before approving. `jux run` labels affected failures as
`previous encoder`, and `jux doctor` lists baselines needing migration.
The manifest's `env.encoder` records `chrome-webp-lossless`; the Chrome version
is recorded separately. A configured Pixelmatch policy can accept equivalent
pixels across the encoder change, but leaves the old approved baseline intact.

## Devices

A `device` sets the viewport and emulates the device: mobile layout (so
`<meta name="viewport">` applies), touch (`ontouchstart`, `maxTouchPoints`,
`(pointer: coarse)`, `(hover: none)`), the user agent and, for Android, its
client hints. It is accepted wherever `viewport` is: `--device` on `jux snap`,
the MCP `snap` tool, project config, `parameters.juxtapose` / `meta.juxtapose`,
URL entries' `params` and variants (not `stories` overrides). Nothing fans out:
a story is captured on one device unless you declare variants.

Device scale factor is always 1, so an image is 1 px per CSS px.

| Device                     | Size (portrait) |
| -------------------------- | --------------- |
| `iphone-se`                | 375×667         |
| `iphone-15`, `iphone-16`   | 393×852         |
| `iphone-15-pro-max`        | 430×932         |
| `iphone-16-pro-max`        | 440×956         |
| `pixel-7`, `pixel-8`       | 412×915         |
| `pixel-8-pro`              | 448×998         |
| `galaxy-s24`, `galaxy-a55` | 360×780         |
| `ipad-mini`                | 744×1133        |
| `ipad`                     | 810×1080        |
| `ipad-pro-13`              | 1032×1376       |
| `galaxy-tab-s9`            | 800×1280        |

Aliases: `mobile` is `iphone-15`, `tablet` is `ipad`, and `desktop` is
1280×800 with no emulation beyond the size (no user agent override, not
mobile, no touch). Android user agents name the Chrome version jux pins.

`orientation` is `portrait` or `landscape`, accepted everywhere `device` is
(`--orientation` on snap). A device's listed shape is its default: taller than
wide is portrait, anything else landscape. The other orientation swaps width
and height, and the page is told: `screen.orientation` and `(orientation: …)`
agree with the size. Phones and tablets report `landscapePrimary` at 90°;
`desktop` reports 0°.

Add your own under `devices`, from scratch or `extends` a built-in or an
earlier project device. Keys are lowercase letters, digits and dashes. A key
named like a built-in replaces it for this project, which is how you repoint
`mobile`:

```json
{
  "devices": {
    "kiosk": { "width": 1080, "height": 1920, "touch": true },
    "mobile": { "extends": "pixel-8" }
  },
  "device": "kiosk",
  "orientation": "portrait"
}
```

Fields are `width`, `height`, `mobile`, `touch`, `userAgent`, `userAgentMetadata`
and `extends`. There is no scale factor field.

An unknown name is an error that suggests the closest keys:
`unknown device 'iphone15'; did you mean iphone-15?`. `jux snap` reports it as
a usage error before it launches a browser.

### Precedence

Layers are the project config, then story parameters, then a variant. For each:

- A layer's `device` sets the size and all of the emulation.
- A `viewport` at the same or a higher layer overrides only the size; the
  device's emulation stays. `{ "device": "pixel-8", "viewport": { "width": 412, "height": 600 } }`
  is a short Pixel.
- A `device` at a higher layer replaces a lower layer's `viewport` too.
- `orientation` layers on its own. The project's is a fallback for any layer.

With no `device` and no `orientation` anywhere, a capture is exactly what it was
before devices existed. `jux snap` reads the project's `devices`, but not its
`device`, `viewport` or `variants`: its flags are the whole request.

`jux config --explain <story>` shows a `device` row with the resolved device,
its size and the layer that set it, for example
`mobile (iphone-15, 393x852 portrait)` from `variant:mobile (project config)`.

### Variants

To capture more than one device, name variants. Each one is captured as
`<story>__<name>` and merges over the story's parameters:

```json
{
  "variants": {
    "mobile": { "device": "mobile" },
    "tablet-landscape": { "device": "tablet", "orientation": "landscape" }
  }
}
```

### What this is not

A device preset is Chrome emulating the device's viewport, user agent and
touch. It is not Safari: an `iphone-*` capture uses Chrome's rendering, fonts
and form controls, and shows no notch, safe-area insets or browser toolbars.
Server-side user-agent sniffing, client hints, touch and pointer media queries
and `'ontouchstart' in window` checks see the phone. WebKit-only behavior does
not.

A page with no `<meta name="viewport">` lays out about 980 px wide and is
scaled down to fit, as it is on a phone; the capture shows that.

### Changing a device

A baseline records the emulation it was approved with. Capture on another
device, orientation, or user agent and the story fails and `jux run` labels it
`(previous device emulation)`, as it labels a `(previous encoder)`. Review the
diff and re-approve with `jux approve`.

## Visual equivalence

SHA-256 remains the default verdict and artifact identity. To accept small color
and antialias differences after a hash mismatch, opt in:

```json
{
  "comparison": { "mode": "pixelmatch", "threshold": 0.05 },
  "stories": {
    "critical-icon--*": { "comparison": { "mode": "exact" } }
  }
}
```

`comparison` is supported in project config, per-story parameters, variants, and
`stories` overrides. A story policy replaces the project policy. `mode` is
required; `threshold` defaults to `0.05` and must be between 0 and 1. This is a
perceived color-distance threshold, **not a percentage of allowed pixels**.
Pixelmatch excludes likely antialiasing differences and must count **zero**
remaining differing pixels. There is no `maxDiffPixels` allowance.

Exact matches still skip decoding and baseline-image reads. On a mismatch,
visual equivalence requires the approved baseline image, verified against its
manifest hash, valid ancestry, and matching dimensions. Missing/corrupt images
cannot produce a tolerant pass. The result's `hash` stays the current SHA-256;
`comparison` records the baseline hash, pinned Pixelmatch version (6.0.0), threshold, antialias setting, and raw
changed-pixel count. CLI, HTML, PR comments, handoffs, and the addon distinguish
these passes from exact matches. The approved baseline is never automatically
replaced. Fresh approval and renderer recovery still require exact hashes.

The legacy top-level `threshold` and `minDiffPercent` tune the reported diff in
exact mode; they do not enable visual equivalence or loosen its zero-pixel rule.

Tolerance can hide real low-contrast changes. Use exact mode for captures where
those changes matter. The initial 0.05 policy filtered 43 of 44 saved Linux noise
pairs and detected six deliberate browser mutations: a changed digit, missing
icon, removed one-pixel border, one-pixel shift, font-weight change, and text color
`#222` to `#333`. This is bounded validation, not a guarantee for every UI.

## Renderer settings

```json
{
  "renderer": { "shared": true, "clearResourceCache": false },
  "stories": { "card--*": { "renderer": { "shared": false } } }
}
```

`renderer.shared` (default `true`) controls whether cold captures reuse a
Chrome renderer process. Baseline mismatches retry with a cache pulse, then
fall back to a fresh renderer if necessary. Recovery passes only when its
byte-exact hash matches the approved baseline. Renderer recovery itself uses no
visual tolerance; the separate comparison policy below can accept a first capture.
Set `shared: false` to use a fresh renderer from the start.

`renderer.clearResourceCache` (default `false`) clears Blink's in-memory
resource cache immediately before a reused-renderer navigation. It retains
HTTP cache entries and is ignored when `shared` is false. This optional cache
pulse can reduce history effects proactively. Otherwise, a baseline mismatch
automatically triggers one pulse retry before the fresh fallback. Stories
that already used a pulse go straight to the fresh fallback.

Both fields also work in Storybook's `parameters.juxtapose.renderer`, Ladle's
`meta.juxtapose.renderer`, named variants, and project `stories` glob overrides.
`shared: false` also overrides warm switching for that capture.
Fields merge individually: overriding `shared` preserves the inherited cache
setting. Existing precedence applies: project defaults, story, variant, then
matching config overrides. Live renderer settings discovered after rendering
cause a cold recapture before judgment.

`freshRenderer` remains a legacy project option: `true` means `shared: false`,
`false` means `shared: true`. Conflicting explicit project settings are rejected.
`--no-fresh-renderer` remains available as a command override.

Reuse can carry canvas text measurements, font metrics, and raster state from
one story to the next. A fresh renderer avoids this history dependence;
settling is still necessary for load- and timing-dependent changes.

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

On `jux run`, retry at most `ceil(10% * selected non-skipped captures)`.
Variants count as separate captures. Candidates are sorted by capture key so
completion order does not choose which stories get retried. New, stale,
skipped, errored, and fresh captures are not candidates. Retry errors consume
the budget; excess mismatches remain failures. A capped run can therefore
remain red even if a full fresh run would pass. `jux snap` has no baseline and
does not perform history retries.

The retry runs even with `recheck: "off"`. A fresh result that still differs
becomes the current failure; `recheck: "changed"` confirms it with another
fresh capture. A resolved result passes and records `rendererRetry.outcome:
"resolved"`; other outcomes are `mismatch`, `unconfirmed`, and `cap`.
`rendererRetry.resolvedBy` identifies `cache-pulse` or `fresh`, with
`cachePulseHash` and `freshHash` recording the available evidence. Reports
suggest `renderer: { shared: true, clearResourceCache: true }` for pulse
recoveries and `renderer: { shared: false }` for fresh recoveries. A pulse
recovery is not proof of a cache root cause: retry workers use new contexts
and timing can also differ. Warm switching remains separate and opt-in.
Retries disable it; approval always forces a fresh renderer.

`recheck` (default `"changed"`) sets which stories the run captures a second
time. Approving a flaky capture makes it a permanently red baseline, so `jux run`
captures a story it can't yet pass a second time and compares the hashes (see
[Approval requires two identical captures](cli.md#approval-requires-two-identical-captures)).
The recheck costs about one extra capture for each story it covers. Passing
stories are never captured twice. The value is one of:

| Value       | Captures twice          | Use                                              |
| ----------- | ----------------------- | ------------------------------------------------ |
| `"changed"` | new and failing stories | Local and agent runs. The default.               |
| `"new"`     | new stories only        | CI, where many stories fail on purpose in a PR.  |
| `"off"`     | nothing                 | The fastest run. `jux approve` confirms instead. |

Pass `--recheck <mode>` (or `--no-recheck`, the same as `--recheck off`) to
`jux run`, or `recheck` to the MCP `run` tool, to override the config for one
call. `jux config --explain` shows the effective value and where it came from.

`jux approve` captures every selected story on a fresh renderer and requires
its hash to match the reviewed run before writing a baseline, including when
`--allow-unstable` is set. The flag can waive an earlier instability verdict;
it cannot waive fresh capture or approve different bytes. Capture errors and
environment mismatches refuse approval. `jux init` forces fresh captures and
always rechecks. `unrechecked: true` still marks results without an ordinary
stability recheck; `rendererRetry` separately records history retry evidence.

Measured on examples/storybook, a first run of 18 captures (all new), with
concurrency 4, on a shared machine (the run's own time, median of three):

| `recheck`   | run time |
| ----------- | -------- |
| `"changed"` | 1.8 s    |
| `"new"`     | 1.8 s    |
| `"off"`     | 0.9 s    |

`"changed"` and `"new"` match here because every story is new. They differ on a
later run in which stories fail: `"new"` captures those once.

Concurrency defaults to 8. Higher is not automatically better — past your core
count, contention slows captures down rather than speeding them up.

`mcp.concurrency` sets how many snaps `jux mcp` captures at once, from 1 to 16. The default is half the CPU cores, from 1 up to 4. See [MCP server](mcp.md#snap-concurrency).

Per-story options go through the platform's own parameter mechanism
(`parameters.juxtapose` in Storybook, `meta.juxtapose` in Ladle):

| option                         | purpose                                             |
| ------------------------------ | --------------------------------------------------- |
| `skip`                         | never capture this story                            |
| `viewport`                     | override the capture size                           |
| `device` / `orientation`       | emulate a device preset (see [Devices](#devices))   |
| `animations: 'play'`           | let animations run (for stories testing animation)  |
| `captureAfterPlay`             | screenshot after interactions, not at first render  |
| `waitForSelector`              | wait for async content juxtapose can't detect       |
| `delay`                        | fixed extra wait; last resort                       |
| `settle`                       | how long to wait for the page to finish (see below) |
| `freeze`                       | clock and random sources (see below)                |
| `threshold` / `minDiffPercent` | tune the _reported_ diff in exact mode              |
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

To reduce capture noise, juxtapose freezes animations and animated images,
waits for the page to finish its work (see [Settle](#settle)), and uses controlled
rendering settings. Clock and random freezing are opt-in
(see [Clock, random and animated images](#clock-random-and-animated-images)).
These controls do not guarantee identical rendering across machines.

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

Not sure which layer won? `jux config --explain <storyId>` prints the value
each setting would have for one story or variant key and the layer it came
from: see [Which setting won](cli.md#which-setting-won-jux-config---explain).

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

| option             | default | purpose                                                                                                                                              |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network.external` | `allow` | `allow` or `block`, or an object `{ default, images, frames, media }`: what to do with requests to origins other than the page's own                 |
| `network.rules`    | none    | `[{ match, action }]`: URL rules checked before `external`, in order, the first match wins. They match any URL, including the Storybook's own origin |

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

#### By resource type

`"external": "block"` means `{ "default": "block" }`. The object form lets a
resource type differ from the default. `images`, `frames` (sub-frame
documents, such as an `<iframe>`) and `media` (audio and video) each take
`allow`, `block` or `placeholder`, apply to third-party requests only, and
override `default` for that type. The type is the one Chrome reports for the
request. `placeholder` is not valid for `default`; it is a config error.

`images` covers only what Chrome classifies as an image: `<img>`, CSS
backgrounds and the like. An image you load with `fetch()` or `XMLHttpRequest`
is a `Fetch` or `XHR` request, so it falls to `default`. To control it, add a
[URL rule](#url-rules) such as `{ "match": "type:Fetch https://cdn.example.com/**", "action": "block" }`.

`data:` and `blob:` URLs never reach the policy, so no rule or `external` entry
applies to them. Requests that a service worker makes bypass the policy too
([#191](https://github.com/juxtapose-dev/juxtapose/issues/191)).

```json
{
  "network": {
    "external": { "default": "allow", "images": "placeholder", "frames": "placeholder" }
  }
}
```

A `placeholder` answers the request at once with a fixed stand-in instead of
fetching it, so the page renders the same pixels every run:

| type     | `placeholder` answers with                                                      |
| -------- | ------------------------------------------------------------------------------- |
| `images` | a 64x64 solid gray PNG, the same bytes every time                               |
| `frames` | an empty HTML document (`<body>` with nothing in it), the same bytes every time |
| `media`  | nothing: media has no stand-in, so `placeholder` blocks it, the same as `block` |

A placeholder request finishes immediately and never counts as in flight for
the settle wait.

#### URL rules

```json
{
  "network": {
    "external": { "images": "placeholder" },
    "rules": [
      { "match": "https://www.google-analytics.com/**", "action": "block" },
      { "match": "https://picsum.photos/**", "action": "placeholder" },
      { "match": "type:Media", "action": "block" },
      { "match": "/api/clock", "action": "block" }
    ]
  }
}
```

A rule's `match` is the same pattern as `settle.network.ignore`: a URL glob, a
`type:<ResourceType>`, or both (`type:Image https://cdn.example.com/**`). Rules
are checked first, in array order, and the first match decides the request.
Only a request no rule matches falls through to `external`. Unlike
`external`, a rule matches any URL, the Storybook's own origin included, so it
can block one of your own requests, or allow a request that `external` would
block (an `allow` rule before a `block` default). The top-level document is
never decided.

`placeholder` in a rule follows the type of the request it matches: an image
gets the image, a sub-frame document gets the empty frame, and any other
request, media included, is blocked instead. A rule that can only match types
with no stand-in, such as `type:Script`, is an error when the config loads;
a rule by URL alone is accepted, and a script it matches is blocked.

#### Layering

It's layered like `settle`: the project config, then the story's
`parameters.juxtapose.network`, then a `stories` override, then the command
(`--network-external block`, `--network '<json>'` with the same object as the
config, or `network: { ... }` in the MCP `snap` and `run` tools). The type map
merges field by field, so a story's `images: "block"` keeps the project's
`frames`. The string form is the exception: `"external": "block"` (or the
`--network-external` flag, or the MCP `external` argument) at a higher layer
means that policy for every resource type, so it replaces `default` and clears
the lower layers' per-type entries. For example, a project's `images: "block"`
plus `--network-external allow` on the command line allows images. Rules from a
higher layer are checked before the lower layer's. Because the first match wins,
to lift a lower layer's rule, add a rule at the higher layer that matches the
same URL, such as `{ "match": "https://cdn.example.com/**", "action": "allow" }`. Only values known before navigation
apply, so a value that only the live Storybook preview declares is ignored.
Recording and replaying external responses is tracked in #147 and isn't
implemented.

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

## Clock, random and animated images

A story that renders `new Date()`, a countdown, a generated id or an animated
GIF captures different pixels on every run. Under an exact hash, that story
fails every run. jux makes these inputs fixed before any page script runs:

```json
{
  "freeze": { "clock": true, "random": true, "images": true }
}
```

Animated images freeze by default. Clock and random freezing are opt-in: their
defaults are `false`, preserving application timing and native randomness.

### `freeze.clock`

`Date`, `Date.now()`, `Date()`, `Intl.DateTimeFormat` (`format()` and
`formatToParts()` with no date) and `Temporal.Now` start at
2024-01-01T12:00:00Z. Set an ISO 8601 date (`"2030-06-15"`, read as UTC
midnight) or a date-time with `Z` or an offset to start somewhere else, or
`false` (the default) to keep the real clock. A date-time without an offset is an error:
each machine would read it in its own time zone.

The clock doesn't follow the wall clock. It moves forward only when a timer
fires, to that timer's due time. Code that measures elapsed time with `Date`
still progresses: a debounce built on `Date.now()` (lodash's `debounce` and
`throttle`) still runs. A synchronous loop that waits on `Date.now()` ends
by advancing 1 ms per read after 10,000 reads without a timer callback.
This does not make asynchronous execution deterministic: different callback
orders or interval counts can still produce different dates.

`performance.now()`, `requestAnimationFrame` timestamps and event
timestamps stay real. jux's own settle wait measures with them.

jux doesn't pin the time zone, so a time rendered in local time depends on the
machine's `TZ`. The default instant is noon UTC, so the date is the same from
UTC-11 to UTC+11. To render the same time everywhere, set `TZ` for the run, or
format dates in an explicit time zone.

### `freeze.random`

When enabled, `Math.random()`, `crypto.getRandomValues()` and
`crypto.randomUUID()` return a fixed-seed sequence. Different call ordering can
still change which value a component receives. Values repeat across page
loads; use this only for test fixtures, never to generate real credentials.
Web workers keep their own, unseeded, sources.

### `freeze.images`

Animated GIF, WebP and APNG images show their first frame, in `<img>`,
`<picture>` and CSS backgrounds. This is a Chrome launch setting, so it
applies to the whole run: set it in the project config, not on a story.
`animations: 'play'` only controls CSS/Web Animations; to test animated images,
set `freeze.images: false` for the project.

### Opting out and layering

A story can opt out of `clock` or `random`, for example a story that tests a
live clock:

```js
export const LiveClock = {
  parameters: { juxtapose: { freeze: { clock: false } } },
};
```

`freeze` layers field by field like `settle`: the project config, then the
story, then `stories` overrides. jux reads it before the story's page loads,
so a `freeze` that only the live preview declares (Storybook parameters that
aren't in `index.json`) is ignored with a warning. Declare it in the story's
parameters, the project config or a `stories` override. `jux config --explain`
shows the effective values and where each came from.

Turning a freeze on changes the pixels of the stories that render a date, a
random value or an animated image, so their baselines need approving again
once. Even a previously stable story can change if it consumes dates or random
values during initialization.

## Content that changes every run

A clock, a random avatar, a generated id — under an exact hash these are
red in exact mode; visual tolerance is not a reliable workaround for changing content.
`freeze` covers the browser’s own clock and random sources (see [Clock, random and animated images](#clock-random-and-animated-images)).
For anything else, such as a server response or a third-party image, stub the
data or pin the fixture. That keeps full pixel coverage.

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
`settle`, `network`, `freeze` (`clock` and `random`), `threshold` and `minDiffPercent`, with the meaning and
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
mask only hides more. `settle`, `network` and `freeze` merge field by field, and the
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

Projects commit hashes and metadata, never snapshot images.

| Commit                    | Ignore                                              |
| ------------------------- | --------------------------------------------------- |
| `juxtapose.config.json`   | `.juxtapose/` (cache, runs, tmp: all machine-local) |
| `juxtapose.manifest.json` | baseline images (`.webp`), wherever they are        |
| `juxtapose.structures/`   |                                                     |

`juxtapose.manifest.json` is a small generated lockfile containing image hashes,
approval metadata, and references to readable JSON under `juxtapose.structures/`.
Commit both. The manifest's `$comment` explains that these files are generated;
the structure directory has a shared README. Neither note affects capture hashes.

Each structure has one element per line. An element's `segment` is relative to
its indexed `parent` (and may include omitted ancestors); roots and paths that
cannot be shortened retain `path`. Readers reconstruct the original full paths
before comparison, so structure hashes and explanations are unchanged. The new
file schema is `juxtapose.structure/compact-v1` and the manifest remains version 1.
Older clients still compare the same image hashes, but need an upgrade to read
the separate structure evidence.

New approvals write this layout. Existing inline structures remain readable;
`jux doctor --fix` migrates them without capture, approval, or hash changes. File
references include a SHA-256 checksum: missing, modified, or mismatched files
are treated as unavailable evidence, never used for a misleading explanation.
Keep the directory readable JSON; do not gzip or hand-edit it. Unreferenced
files may remain after removing a baseline; they are ignored, not automatically
deleted. Stable per-story filenames keep Git diffs local to the changed story.

**Don't hand-merge it; regenerate it**, as you would a lockfile. On a merge
conflict, take either side (`git checkout --theirs juxtapose.manifest.json`, or
`--ours`), run `jux run`, then `jux approve --story <id>` for each story the two
branches changed (or `jux approve --all` after you have reviewed the run). jux
refuses a manifest with conflict markers (exit 2) and prints these steps rather
than treating it as empty.

`storage.kind` picks where the images live:

- `"cache"` (default): a local, git-ignored directory of `<sha256>.webp` files,
  `.juxtapose/cache/baselines/` unless you set `dir`. Approving writes the hash
  to the manifest, structure to readable files, and the image to the cache. A passing run also
  keeps its capture in the cache. `jux run` never writes the manifest; only
  `jux approve` does (and `jux doctor --fix`, below).
- `"git"`: commit images under `.juxtapose/baselines/` (or `dir`). The layout
  before 0.15, kept for projects that want pixels in the repo.
- `"fs"`: the repo-backed store pointed at a `dir` you choose.
- `"s3"`: declared, but the CLI throws on it in this version.

Pass/fail needs no image: a story passes when its captured hash equals the
manifest's. The image is only for the pixel diff and the review UI. When a
story fails and its approved image is not in the cache (a fresh clone, a CI job
with a cold cache), jux reports the failure by hash and structure and says
"baseline image not available (not in cache); structure diff only". It does not
error. To get pixel diffs in CI, save and restore the cache; see [CI](ci.md).

`jux init` adds one line, `.juxtapose/`, to `.gitignore`: everything under it is
machine-local. A project with no `storage` key and images already committed
under `.juxtapose/baselines/` keeps working: jux reads those images (when they
match the manifest hash), copies each into the cache as it does, and writes new
ones to the cache. Run `jux doctor` for the migration commands. Old per-story
`.structure.json.gz` sidecars move into `juxtapose.structures/` with `jux doctor --fix`,
which approves nothing. Run
`jux run --all` before you commit the untracking: the commit deletes the images
from every clone that pulls it, and those clones then rely on their own run or a
restored CI cache, and report structure only until then.

A cache `dir` must be a relative path inside the project (`/` and `\` both
separate): no `..`, absolute or UNC path, glob characters, control characters
or leading `-`, and not the manifest. A `git` or `fs`
`dir` keeps accepting any path, including one outside the project; only a
leading `-` and control, line-separator and bidi characters are refused. A
refused value is a usage error (exit 2). Half-written images go to
`.juxtapose/tmp/` (or `<dir>.tmp/` for a custom cache dir), also ignored, and
stale ones are deleted on the next write. A cache or tmp directory that is a
symlink, or resolves outside the project, is never written to or swept: jux
warns once and skips caching. The cache is not pruned yet; see
[CI](ci.md).

Structure sidecars are plain JSON, one element per line, so an approval's diff
shows which elements moved. Legacy `.structure.json.gz` sidecars are still read.
