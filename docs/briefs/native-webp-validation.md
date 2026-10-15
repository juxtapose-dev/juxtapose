# Native lossless WebP validation

Date: October 15, 2026. Based on main `434eb24` (CLI/core 0.20.0),
macOS arm64, pinned Chrome headless shell 151.0.7922.34. Concurrency is three;
all projects and `JUX_STATE_DIR` locations are temporary. Static builds are
reused, with one browser workload at a time.

## Pixel correctness and performance

The real-browser encoder test checks that Chrome's quality-100 WebP contains
one lossless VP8L bitstream, strips ICC metadata, and decodes to exactly the
same pixels as PNG for text, gradients, transparency, and masking. Malformed
headers, truncation, missing image data, and lossy frames are rejected.

`scripts/profile-encoder.mjs` repeats a fixed 1280 × 800 local UI frame, four
warm-up pairs followed by 40 alternating pairs. PNG capture plus Sharp lossless
WebP effort 0 took a median 25.61 ms; native lossless WebP plus ICC removal took
16.29 ms. The isolated snapshot pipeline was about 36% faster. Output sizes
were 42,902 and 40,596 bytes respectively. Navigation, settling, report writing,
and browser startup are excluded, so this is not a whole-suite speedup claim.

## Repeated workbench captures

- Ladle: 16 stories × 20 fresh-renderer passes, 320 captures; all hashes stable,
  no capture errors. Log: `/tmp/jux-webp-ladle20.log`.
- Example Storybook: 18 stories × 3 fresh-launch passes, all exact; 18 × 3
  daemon passes exact and identical to the fresh reference. Logs:
  `/tmp/jux-webp-determinism.log`, `/tmp/jux-webp-daemon.log`.
- Spectrum: 50 evenly spaced story IDs from the sorted story index of
  `adobe/spectrum-web-components@9d8151f41f7cd363613aa4f3f1ae17739e69dd65`.
  Raw reports, selection, and images: `/tmp/jux-webp-spectrum-Mc8jPV`.
  This selection includes native controls, text, overlays, and virtualized tables.

Spectrum is not a clean exact-determinism gate. The initial 12 native passes
showed variation in `field-label--standard`, `textfield-sizes--no-size`, and
`number-field-sizes--l`, with no capture errors. The loop was paused for controls:

- The same two-story text subset was stable across 10 current-main PNG passes
  and 10 native-WebP passes.
- The same 50-story selection on current-main PNG reproduced
  `field-label--standard` variation in the initial four-pass control, extended
  to 20 passes below. Its source predates native encoding, but this alone does
  not establish equal stability or explain every varying story.

The completed 20-pass native run captured 1,000 images with zero errors.
47/50 stories were byte-stable; the same three IDs varied, with no additional
varying IDs in the final eight passes. Variation is retained, not hidden by
Pixelmatch. This is a measured limitation, not a clean Spectrum parity result.
Logs: `/tmp/jux-webp-spectrum20.log`, `/tmp/jux-webp-spectrum20-rest.log`,
`/tmp/jux-webp-control50.log`, `/tmp/jux-webp-control-noise.log`, and
`/tmp/jux-webp-native-noise.log`.

The completed PNG control also captured 1,000 images with zero errors. It had
48/50 stable stories: `field-label--standard` and `tabs--vertical-right` varied.
Native field-label had 14 distinct hashes (most-common hash 4/20); PNG had six
(most-common 9/20). Native number-field/textfield and PNG tabs each had one
outlier in 20. These batches were sequential, not interleaved matched-load runs.
The two additional native text variations were not reproduced by this control.

**Release gate remains open:** do not claim equal stability or merge solely on
the performance result. Investigate the native-only text outliers and the
first-screenshot raster issue, then repeat a short matched control before
rerunning the broader gate. PNG control reports/images:
`/tmp/jux-webp-spectrum-zoZZwj`; continuation log:
`/tmp/jux-webp-control50-rest.log`.

## Placeholder-transition follow-up

Cherry-picked the fix from PR #239 (`fdef3f0`): freeze `::placeholder` transitions
in addition to elements and their before/after pseudo-elements. The focused
encoder/shadow-root tests passed 16/16; the three previously varying text IDs
were exact across 10 passes each.

A repeated native 50-story × 20-pass gate still had three varying stories and
zero errors: `number-field-sizes--l` (two passes), `field-label--standard` (one),
and `picker--custom` (one). Field-label variation fell from 14 distinct hashes
to two; its residual includes the disabled control's background, border, and
text. Number-field variation is 242 border pixels, not text. The picker outlier
shows a partly transparent menu with underlying content visible (304,932 changed
pixels). These require separate investigation and do not establish encoder
regressions or equal stability.

Reports/images: `/tmp/jux-webp-spectrum-pEYdxG`; log:
`/tmp/jux-webp-placeholder-spectrum20.log`. The draft remains gated on residual
classification and parity. Native encoding has not been merged or released.

## Bounded residual instrumentation

Ten passes of the three residual stories and five passes of the full 50-story
selection were instrumented without adding sleeps or extra screenshots. All
280 captures were exact within their respective runs. Post-first-capture
`getAnimations()` across open roots found no active animations. The 15 target
observations in the full-selection run had zero-duration input border and
placeholder transitions with the freeze sheet present. Passive CDP animation
events reported only Storybook's zero-duration `sb-rotate360`, then cancellation;
no border, placeholder, or opacity transitions were observed.

This did not reproduce or explain the rare residuals. Instrumentation may
perturb timing, and post-capture styles do not establish earlier compositor
state. Do not claim those residuals are animations or that the instrumented
pass proves parity. Investigation stopped at this bounded check; PR #241 stays
draft with unclassified outliers.

Artifacts: `/tmp/jux-native-residual-after.jsonl`,
`/tmp/jux-native-residual-events.jsonl`, and full-selection reports/images under
`/tmp/jux-webp-spectrum-94e0On`. The placeholder regression test now asserts the
rendered pure-blue endpoint rather than exact glyph identity across separate
renders, following PR #239's Linux correction (`eaf6f1a`).

## Checks

Build, typecheck, lint, and diff checks pass. The final impacted browser/unit
batch passed 108 tests; the actual-Pixelmatch visual regression tests passed
another eight. Run mocks preserve the actual encoder classification while
mocking only browser environment discovery. The initial native head passed the full Linux CI workflow
`38787300823`, including tests and all determinism jobs. The placeholder follow-up
requires CI on its final head before merge.

## Migration

Encoded bytes change even where pixels do not. Exact baselines require a
reviewed re-approval. Run and doctor explain the previous encoder, and
`env.encoder` records `chrome-webp-lossless` separately from Chrome's version.
Opt-in Pixelmatch may accept equivalent pixels but does not rewrite approvals.
Diff and crop color handling is unchanged; only captured screenshots have the
ICC metadata removed. A tolerant pass must not carry a previous-encoder failure
label. HTTP failure screenshots use the same native encoder but remain
ineligible for approval.
