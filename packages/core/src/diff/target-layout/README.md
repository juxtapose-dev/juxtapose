# Target layout evidence prototype

Internal, experimental analysis for offline evaluation. Requested `reference` JSON detail uses this on failing targets. Capture and
the default MCP hint do not run it. Do not promote it until a
PNG-only agent decision replay demonstrates value in addition to the offline precision screen. Segmentation and pair evidence
are cached by image, structure and algorithm identity.

`fromPng` accepts **already decoded RGBA**, not encoded PNG bytes. It finds exact
opaque-color components using row runs and union-find. It drops the largest
edge-connected background, components below 16 solid pixels, shapes with less
than 80% rectangular occupancy, and excess blocks beyond 256. At 40,000 runs it
abstains from the image altogether. This bounds memory on photographs without
building a full pixel index.

`extractTargetEvidenceStreaming(encodedImage)` is a separate opt-in producer.
It finalizes exact-color connected components after their last occupied row,
retaining only live row components and bounded candidate output. A photo-heavy
1280×900 reference has 234780 runs but at most 797 simultaneously live roots:
the original producer abstains; streaming recovers 96 paint blocks. The selected
reference-only study packet contains eight substantial regions. Streaming keeps
all pixel runs and the same inner-paint fingerprints; it does not use short-run
or color filtering. Candidate and per-row limits still fail closed.

This producer is not wired to the default extractor, matcher or MCP response.
Complete evidence matches the original algorithm with a raised offline run
budget on six reference images. Decode plus streaming takes about 23ms median
on that desktop reference in a local alternating-order test; the raised-budget
original takes about 16ms. This is a coverage/memory strategy, not an established
analysis-speed or agent-efficiency win. Agent usefulness and matcher precision
on the recovered regions remain separate gates. Caller caches must distinguish
producer identity; do not reuse the existing default image-evidence cache keys.

`matchLayout` first requires equal image/DOM viewport extents (DPR 1). It matches
exact fill colors (a deliberately stricter subset of DeltaE <=3), exact inner
paint fingerprints when present, mutual best assignments with a second-best
cost at least twice the best, and excludes repeated same-size lookalikes.
Geometry differences at most two pixels produce no observation. Current DOM
mapping requires a unique outer or computed border-inset rectangle agreeing
within one pixel of raster rounding. A painted rectangle is not a CSS border
box and never implies a CSS cause.

Inner fingerprints are exact cropped pixels, not OCR, a font detector, or a
semantic identity. They distinguish some unchanged text/icon patterns through
translation and reorder, but deliberately reject different text, font or
antialias pixels. Blank identical controls remain ambiguous.

`fromStructure` supplies actual DOM rectangles with `structure` provenance;
its solid fill area is unknown (`null`). Children follow the captured parent
indices in one pass. It is a ground-truth/seam producer today; the conservative
pixel matcher does not yet accept structure-only blocks as target pixels.

The first 30 real pairs produced 12 correct facts with the flat-only prototype,
and 22 after exact inner paint and current-border mapping. A separate nine-pair
form family produced 19 correct facts, including reordered stable IDs, with no
observed false positives. These small related corpora do not prove universal
precision. Recall remains low, and the agent-value gate is untested.

Projection hierarchies, measured gaps, relaxed color matching, Hungarian
assignment, worker pools and public reference output are not implemented in
this prototype. Add them only against a demonstrated failure or value gate;
the current pure-JS analysis is within the timing budget.

Offline runner: `node scripts/bench-target-layout.mjs cases.json new-results.json`.
Source snapshots, captured pairs, preliminary grader failures and corrected
reports are retained in the experiments workspace under
`iteration-billing/target-layout-*`. The first reorder grader used full ancestor
paths, which change after moving an identified field. The corrected independent
oracle prefers unique IDs and uses the actual target DOM border inset to grade
paint bounds. The matcher was not changed to fix that oracle error.

`displacement.ts` is a separate internal experiment over already decoded equal
RGBA extents. It proposes changed textured regions automatically, rejects
ambiguous sampled translations and verifies every byte before reporting up to
three scoped displacement facts. It does not depend on DOM matching or change
verdicts. The real website's one-pixel map shift is recovered over 192000 pixels
in about 1.4ms median locally (decode excluded). Negative periodic/flat/changed
content cases abstain. Agent usefulness remains untested; no root export or MCP
caller is added. The bounds and negative cases are guarded by
[displacement.test.ts](displacement.test.ts). Any public integration still needs
independent output verification and a demonstrated agent-value gate.
