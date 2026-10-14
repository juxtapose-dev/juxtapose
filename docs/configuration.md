# Configuration

`juxtapose.config.json`, or a `juxtapose` key in package.json:

```json
{
  "platform": "storybook",
  "concurrency": 8,
  "viewport": { "width": 1280, "height": 800 },
  "storage": { "kind": "git" }
}
```

Also accepted: `buildDir` and `origin` (the CLI flags' defaults), `threshold`,
`minDiffPercent`, `waitForSelector`, `delay` and `settle` as project-wide
versions of the per-story options below, and `warmSwitch` — off by default, and best left there: it is ~4x faster but
does not reproduce cold-load pixels exactly, which under a byte-exact hash
makes a story's verdict depend on where it lands in the queue.

`.juxtaposerc.json` works as well. JSON only — a `.ts` or `.js` config is not
loaded.

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

Captures are reproducible: juxtapose freezes animations, waits for the page to
finish its work (see [Settle](#settle)), and pins rendering to settings that
don't vary by machine.

## Settle

After a story renders, juxtapose waits until the page has no pending work, then
captures it. Pending work is any of the following:

- A timer due within 1000 ms (`setTimeout`, or a `setInterval` before its first
  tick). A timer that re-arms itself from its own callback with a delay of 16
  ms or more, such as a poll or a clock, counts only for its first arm.
- An animation frame callback, unless the page re-requests it from inside one
  for more than three frames, which is an animation loop.
- A posted message not yet delivered, such as React's scheduler. Messages to a
  port that never delivers stop counting once deliveries stop.
- A dedicated `Worker` that hasn't sent its first message, for up to 1000 ms
  after it's created.
- A DOM change since the previous check.
- A web font that is still loading.
- An image that is still loading, unless it's lazy and either outside the
  viewport or not rendered (`display: none`).
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

Settle options come from four places. Each one overrides the one before it:

1. Built-in defaults.
1. The project config: `settle`, `waitForSelector` and `delay`.
1. The story's parameters (`parameters.juxtapose`, including a variant's own
   settings).
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

## Baseline storage

`storage.kind` accepts `"s3"`, but the CLI throws on it in this version. Git is
the only implemented backend, and `"fs"` is the same store pointed at a
directory you choose. See the
[issues](https://github.com/juxtapose-dev/juxtapose/issues) for the roadmap.
