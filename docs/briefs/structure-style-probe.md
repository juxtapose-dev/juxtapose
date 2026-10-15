# Chrome structure extraction: style and parsing probe

## Outcome

Do not adopt the compact-style request tested here. It preserved exact structure
on the controlled collection but did not reduce total extraction/normalization
time. No production capture behavior changes in this experiment.

Actual CDP JSON parsing took 10.2% of full snapshot round-trip time. The remainder
combines Chrome work, serialization, transport, framing, and scheduling; this probe
does not separate those components. Moving parsed objects to workers was already
rejected by the earlier worker experiment.

## Method

Run after `pnpm build` and building the controlled Storybook:

```sh
node scripts/probe-structure-extraction.mjs examples/storybook/storybook-profile 10
```

One persistent browser, one page at a time, 24 stories, desktop 1280 × 800.
Ten measured repetitions per arm per story plus two excluded warmups; arm order
rotates. Each story is settled through the real capture pipeline. All arms read
the same page. Exact normalized JSON and structure hashes must agree for full
and compact requests; PNG screenshot bytes must agree before and after the probe.
There are 720 measured requests, including 480 full/compact parity checks.

Arms:

- Full: current 42 properties, including visibility, and paint order.
- Compact: 33 properties; margin, padding and border-width shorthands replace
  twelve longhands. Reconstruct the original layout style columns before using
  the unchanged normalizer. Expansion caches repeated shorthand values.
- Visibility: visibility alone, with paint order. Diagnostic lower bound only;
  dropping styles destroys explanation coverage and is not a shipping option.

The probe temporarily wraps JSON.parse within its own process to time actual CDP
snapshot response parsing. Byte counting and other probe overhead remain in the
round-trip measurement. It restores JSON.parse and closes the browser/server in
finally blocks. Shorthand values outside the experiment's supported resolved-pixel
syntax fail explicitly; the experiment is not a general CSS shorthand parser.

## Results

macOS, Apple M5 Pro, Node 26.11.1, Chrome 151.0.7922.34. This is a serial,
warm-page microbenchmark, not a Linux or end-to-end speedup measurement.
All 24 stories passed structural parity and unchanged screenshot checks.
Full per-story medians and aggregate measurements are in
[structure-style-probe-results.json](structure-style-probe-results.json).

Summed measured time over 240 requests per arm:

| Arm             | Snapshot round trip | JSON.parse (included) | Expansion | Normalization | Total stages |
| --------------- | ------------------: | --------------------: | --------: | ------------: | -----------: |
| Full            |            2,530 ms |                258 ms |     ~0 ms |        301 ms |     2,831 ms |
| Compact         |            2,434 ms |                234 ms |    170 ms |        290 ms |     2,894 ms |
| Visibility only |            1,197 ms |                137 ms |       n/a |           n/a |          n/a |

Compact responses were 112.30 MB total versus 127.23 MB full (11.7% smaller).
The ~97 ms round-trip saving was smaller than expansion cost; total stages were
~2.2% slower. An earlier optimized repetition similarly had no net gain. The
initial uncached expansion was much worse and is not used in the committed script.

Largest nested story medians:

| Arm             | Snapshot round trip | JSON.parse | Expansion | Normalization |
| --------------- | ------------------: | ---------: | --------: | ------------: |
| Full            |            99.54 ms |    9.91 ms |     ~0 ms |       4.05 ms |
| Compact         |            97.69 ms |    8.93 ms |   8.90 ms |       4.54 ms |
| Visibility only |            43.68 ms |    4.93 ms |       n/a |           n/a |

The full response was 5.05 MB versus 4.42 MB compact. Savings in protocol size
alone do not establish a useful optimization.

## Implications

A smaller property list does not proportionally reduce snapshot time. Current
Chromium source caches computed styles within a capture, but still emits a style
index array per layout row. This is a hypothesis-supporting source inspection,
not a trace of the pinned binary:
[BuildStylesForNode](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/inspector/inspector_dom_snapshot_agent.cc).

Any more ambitious extraction replacement needs exact coverage for pseudo-elements,
shadow DOM, overflow, masks, visibility, element ordering and paint order. A
visibility-only response or viewport-only DOM query cannot replace the current
snapshot without losing information. No such replacement is enabled here.

Prioritize native lossless WebP validation for a demonstrated independent saving.
For further extraction research, isolate Chrome CPU versus transport with tracing
before changing the protocol or building a custom extractor. Re-run a promising
candidate on Linux before making a runtime change.
