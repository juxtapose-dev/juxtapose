# Binary Chrome pipe validation

## Scope

Chrome already builds protocol responses in CRDTP CBOR. The JSON pipe makes its
renderer convert them to JSON and its browser process convert them back to CBOR
for validation. The binary pipe avoids both conversions. Node decodes directly
into the same guarded message dispatch as JSON. No image encoding, structural
normalization, capture ordering, or comparison policy changes here.

Daemon clients still use NUL-framed JSON sockets with the same routing, ownership
checks, IDs and isolation. Only the supervisor's connection to Chrome changes.
`JUX_CDP_JSON=1` selects the previous transport for diagnosis. The selected mode
is included in the daemon's command-line fingerprint. An explicit caller
environment also reaches private-browser fallback and the spawned browser.

The codec follows pinned Chromium 151.0.7922.34 CRDTP, not arbitrary CBOR:
UTF16LE strings (including lone surrogates), tagged binary converted to base64,
int32 tokens, float64 values and enveloped indefinite maps/arrays. It preserves
JSON's own-property behavior for `__proto__` and Chromium's non-finite-number
conversion. Malformed frames close the connection and reject pending work.

## Evidence before implementation

A five-snapshot trace on the controlled large nested story averaged 89.28 ms per
round trip. Renderer dispatch averaged 50.34 ms, including 17.92 ms in its send
span; browser response dispatch averaged 29.28 ms. These are nested spans, not
additive independent phases. Source inspection locates the conversions inside
those spans; the trace alone does not assign every millisecond to conversion.

Pinned source:

- [Renderer FinalizeMessage](https://github.com/chromium/chromium/blob/151.0.7922.34/third_party/blink/renderer/core/inspector/devtools_session.cc)
- [Browser ValidateMessage](https://github.com/chromium/chromium/blob/151.0.7922.34/content/browser/devtools/devtools_session.cc)
- [CRDTP codec](https://github.com/chromium/chromium/blob/151.0.7922.34/third_party/inspector_protocol/crdtp/cbor.cc)

Standalone local prototype, JSON/CBOR/CBOR/JSON launch order, two warmups plus ten
snapshot requests per story per launch:

| Story         | JSON median | Binary median |
| ------------- | ----------: | ------------: |
| Nested large  |   157.35 ms |      89.64 ms |
| Nested medium |    35.97 ms |      21.73 ms |
| Nested small  |     7.57 ms |       4.05 ms |
| Forms large   |    35.95 ms |      20.19 ms |
| Images large  |    13.80 ms |       9.53 ms |

All 20 full captures matched exact encoded image hashes, decoded pixels,
dimensions, normalized structure JSON and structure hashes. This is local
stage evidence under variable host load, not the final full-pipeline measurement.
Raw prototype data: `/tmp/jux-cbor-compare-results.json`.

## Reproducible accounting

Trace the actual Chrome spans:

```sh
node scripts/trace-structure-extraction.mjs examples/storybook/storybook-profile profile--nested-large 5
```

Compare two built revisions with separate fresh references, warmups, alternating
AB/BA runs, exact per-arm hashes and cross-arm decoded-pixel checks:

```sh
node scripts/compare-pipeline.mjs BASELINE_CLI CANDIDATE_CLI examples/storybook/storybook-profile 5 --pixel-parity
```

`JUX_PROFILE_CONCURRENCY` accepts 1–8 (default 3). Reports include mean phase
milliseconds per capture and worker-time shares. Phase shares are not wall-time
shares: pages overlap. The profile workflow accepts `baseline_ref` for the same
comparison on one Linux runner; it requires matching lockfiles before sharing
installed dependencies between checkouts.

## Validation status

Codec: 42 tests, malformed/truncated frames, all split positions, multiple frames,
large payloads, Unicode, binary values, prototype keys and depth limits. Binary
routing/launch/daemon identity: 153 focused tests passed, two platform/CI skips.
Full pre-native-merge suite: 1,827 passed, three skips. Independent review found
an explicit-environment fallback inconsistency, fixed with a real-command-line
regression test. Combined native-WebP/binary transport validation: 18 Storybook stories × three
fresh runs, 16 Ladle stories × three runs, and 18 Storybook stories × three
daemon runs all byte-identical; daemon matches its fresh reference. The JSON
fallback also passes 18 stories × three runs. The combined full suite passed
1,832 tests with three skips and one outdated timing assertion: native metadata
work can round to 0.0 ms. That assertion was corrected and its test passes.

[Final paired accounting](pipeline-final-accounting.md) records five runs per
arm on macOS and Linux: 18.4% and 19.9% median whole-run improvements, 2,400 exact
measured image hashes, 240 cross-revision decoded image pairs and 2,400 exact
structure comparisons, with zero failures or retries.
