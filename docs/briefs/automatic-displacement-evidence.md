# Automatic exact-region displacement: offline evidence

Status: internal research helper in core. No root export, MCP caller, default
response, capture or comparison-policy change. No agent value or efficiency
claim. No push, merge or publish.

## Observed problem and method

The reference-only first-draft prefill experiment failed its global-quality gate.
A later hand-picked map crop showed an exact one-pixel displacement, but manual
region selection could not support an automatic tool claim. This helper recovers
that observation without a supplied crop or target DOM.

`findExactDisplacements(referenceRgba, currentRgba, {radius?})` samples changed,
textured tiles across the frame. It searches at most 12 highest-ranked
proposals for integer offsets within ±8px by default (explicit maximum ±64).
Multiple sampled matches abstain. A unique sampled candidate must then match
every RGBA byte of the entire rectangle before it can be reported. Adjacent or
separated regions may merge only after full verification of their bounding
rectangle, including the space between them. Already covered proposals and
contained duplicate observations are skipped with small bounded scans.

At most three observations are returned, with target/current rectangles,
current-minus-reference dx/dy, pixel count, provenance and a shared confidence
rule. Positive dy means the current pixels are lower. A fact concerns only its
rectangle, not a whole component, page, CSS cause or visual verdict. No observation
is an abstention, never a passing target verdict. Sampling alone is not proof.

Search radius, frame extent, proposal count, full-verification pixel budget and
response size are bounded. The helper never changes an acceptance policy or
recaptures the browser. A future caller must cache by reference/current identity,
algorithm version and radius rather than assuming a live app is unchanged.

## Native gate

Authoritative results: `juxtapose-experiments/iteration-billing/auto-displacement-v4`.
Earlier variants are retained. Covered proposals and contained output are skipped
rather than spending the verification budget again on already-proven pixels.
Ablation on the website case returns the same observation with global top-twelve
selection as with a spatial heuristic, so the simpler ranking is retained. Fully
transparent RGB samples do not produce texture or displacement evidence.

| Case                                  | Observations | Local RGBA-only p50 / p95 |
| ------------------------------------- | -----------: | ------------------------: |
| Actual website control draft          |            0 |             0.97 / 3.38ms |
| Actual website candidate draft        |            1 |             1.42 / 4.83ms |
| Constructed global translation (3,-4) |            1 |             6.51 / 8.18ms |
| Explicit radius64, translation (0,32) |            1 |           10.34 / 10.48ms |
| Resized real reference at 4MP         |            2 |           28.08 / 32.28ms |

The automatically selected website rectangle is current (648,392,384,500) versus
reference (648,391,384,500): **192000 exactly equal pixels, current one pixel
lower**. It overlaps and independently recovers the known map displacement.
No supplied map crop, current DOM or target DOM enters selection.

Sharp independently extracts every reported rectangle and confirms exact byte
equality: five reported observations across these positive cases, all verified.
Unchanged input, flat regions, repeated patterns and unsampled pixel corruption
produce no observations. The actual control's remaining 21394 global mismatch
pixels do not disappear merely because this helper abstains.

All ten cases repeat byte-stably. Ten repeats follow one warmup per case;
decode is excluded and first-call samples remain in raw results. These are local
diagnostics, not OS-cold measurements or a broad precision/recall estimate. The
4MP input is a synthetic resize of a real reference, not a native 4MP design.
Response JSON remains below 3KB (919 bytes in the observed website case).

## Verification and next gate

Focused tests cover signed/one-pixel offsets, exact verification of unsampled
bytes, ambiguous periodic patterns, changed content excluded from reported
regions, extent/radius guards, byte-stable output, output/work bounds and no
contained duplicate facts. The displacement, streaming and layout files contain sixteen passing tests. Build, typecheck and lint pass. The full serial suite passes
160 files and 2059 tests, with 3 skipped, in 227.12s
(`/private/tmp/jux-exact-displacement-final-suite.log`).

No model or browser calls were used for this offline study. The next agent gate
should ask a focused, common question about the same current implementation in
both arms, retaining equal source/image/tool access. Treatment gets the scoped
verified observation. Grade actual CSS changes with a fresh native capture,
preserving the global comparison policy and reporting any remaining errors.
Keep this conditional question separate from autonomous work selection, the
failed raw-target prefill, and full-build time/token savings. Default promotion
requires actual agent-value evidence; more correct pixel facts alone do not earn it.

## Focused grader preflight

An isolated clone checks actual CSS adjustments before a model trial. Starting
whole-target mismatch is 53730 and selected-rectangle mismatch 9165. A 1px upward
relative-position adjustment makes the selected crop byte-equal and reduces
global mismatch to 39378. The wrong direction leaves 14130 selected mismatches
and 60750 global mismatches. Restoring source reproduces the original whole
image exactly. All whole-target exact-pass flags remain false. This validates a
focused grader, not the CSS root cause or an agent result. Artifacts are in
`focused-displacement-question-v1/native-preflight.json`.

## Focused decision screen: control sufficient

Sol 6.1 medium receives two focused image crops and 118 bytes of relevant current
CSS. It proposes `.map>img { transform: translateY(-1px) }` in one model call,
10.177s, with 2519 counted tokens (14564 input, 12160 cached, 115 output). Fresh
native grading confirms exact selected-region alignment and whole-target
mismatch 53730→39420; the whole target still fails. The predeclared futility
stop applies, so treatment is not run. No comparative time/token saving or
added decision benefit is established.

This control already receives curated crops and source. It does not test the
cost of selecting/requesting those crops, replacing image views with text,
autonomous work selection or weaker-model ability. Keep this internal analysis
unexposed pending a different, justified agent-value question. Do not repeat
the solved decision to seek a nicer percentage. Artifacts and protocol are in
`focused-displacement-question-v1`.
