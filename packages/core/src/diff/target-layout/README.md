# Target layout evidence

This directory contains optional layout diagnostics for saved design-reference
comparisons. Requested MCP `reference` layout/JSON detail can use the saved
current DOM to describe conservative matches between painted regions. These
observations do not affect capture, approval or Pixelmatch verdicts. See the
[tool reference](../../../../../docs/mcp.md#reference) for public usage.

## Producers

- `fromPng` accepts decoded RGBA. It finds exact opaque-color regions, omits the
  largest edge-connected background, blocks under 16 solid pixels, and shapes
  below 80% rectangular occupancy. It retains at most 256 blocks and rejects
  images exceeding its 40,000-run budget.
- `extractTargetEvidenceStreaming` accepts encoded image bytes and uses a
  separate streaming producer. It preserves exact-color runs and inner-paint
  fingerprints while retaining live row regions and bounded candidate output.
  It is opt-in and does not replace the default extractor. Caches must distinguish
  producer identity.
- `fromStructure` preserves captured DOM rectangles, parent indices and optional
  text with `structure` provenance. Its solid fill area is unknown. These blocks
  do not establish what appears in a PNG target.

## Matching limits

`matchLayout` requires equal image/DOM extents at DPR 1. It uses exact fill colors,
unchanged inner paint where available, and mutual best assignments with a
second-best cost at least twice the best. Repeated
lookalikes, changed text or fonts, and ambiguous shapes can produce no match.
Geometry differences of two pixels or less produce no observation.

DOM mapping needs a unique outer or computed border-inset rectangle that agrees
with raster rounding within one pixel. Painted rectangles describe pixels;
they do not establish CSS border boxes or the source rule responsible for a
change. Inner-paint fingerprints identify exact cropped pixels and do not
recognize text or fonts.

`displacement.ts` separately checks proposed translations against decoded RGBA
bytes and reports at most three verified observations. It does not use DOM
matching or change verdicts, and has no root SDK export or MCP caller.
[Its tests](displacement.test.ts) cover ambiguous and changed-content inputs.

For offline comparisons with your own inputs, use
`node scripts/bench-target-layout.mjs cases.json new-results.json` from the
repository root. See [controlled profiling](../../../../../docs/profiling.md)
for measurement and reporting guidance.
