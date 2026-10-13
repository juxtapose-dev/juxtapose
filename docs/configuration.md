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

Also accepted: `buildDir` and `origin` (the CLI flags' defaults), `threshold`
and `minDiffPercent` as project-wide versions of the per-story options below,
and `warmSwitch` — off by default, and best left there: it is ~4x faster but
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
| `threshold` / `minDiffPercent` | tune the _reported_ diff; the hash still decides    |
| `captureTimeout`               | max ms to wait for render-ready (default 2000)      |
| `mask`                         | paint over selectors before the shutter (see below) |
| `liveCapture: false`           | exclude from watch-mode recapture (see below)       |

Captures are reproducible: juxtapose freezes animations, waits for webfonts
and images, and pins rendering to settings that don't vary by machine.

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
