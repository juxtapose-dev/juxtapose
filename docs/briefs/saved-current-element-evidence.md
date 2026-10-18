# On-demand saved current-element evidence

Status: local feature branch; no push, merge or release. The MCP request
`report({story, runId, element: {tag: "h1"}, properties: ["font-size"]})`
reads the saved current structure, without browser launch or image analysis.
It returns captured computed values and the border-box rectangle, not target
values or a proposed CSS fix. Default run/report evidence is unchanged.

## Why expose it on demand

In a held-out typography decision, Sol 6.1 medium chose the exact repair in
2/2 trials with current styles versus 1/2 with screenshots alone. Both arms
saw identical target/current images and four neutral-ID candidate edits;
only treatment received the current rectangle and seven computed properties.
Target values and target DOM were not supplied. Chrome independently graded
the candidates under Pixelmatch 0.1, includeAA false, exact extent and zero
mismatch pixels. The winning edit passed exactly; alternatives left 2317,
6818 and 3301 mismatches.

This is a quality lead on one small conditional decision, **not a speed or
token saving**. In C T T C order, mean model-process time was 7.2285 seconds
for control and 7.8325 for treatment. Total input was 30351 versus 30481;
cached input was 24320 in each arm; counted uncached input plus output was
6300 versus 6439. All four completed normally. A source-enabled coding agent
could inspect CSS instead, so the result does not prove superiority over that
baseline. It supports requested inspection when computed cascade/responsive
values are unclear, rather than adding styles to every response.

Artifacts: `juxtapose-experiments/website-build/style-holdout-v1`, including
the frozen protocol, prompts, native images, raw usage and independent grades.

## Contract and efficiency checks

Exact query fields combine with AND; a unique match is required. Unchanged
duplicates count toward ambiguity, and truncated snapshots abstain. Missing
snapshots and unavailable historical properties remain explicit. The inspector
does not infer CSS causes. Output has a 3072-byte core budget and 4096-byte MCP
budget, omits whole over-budget styles and preserves identities. Requested
property ordering does not change serialized output.

Concurrent/repeated requests share decoded sidecars and report parsing.
Three cold concurrent MCP requests originally read the same report three
times; the regression check now requires one report read, alongside one
sidecar read. In-place sidecar changes invalidate the cache. Failed loads are
not retained; trusted saved-run containment checks reject symlink escapes.
Element matching uses a scan that stops at the second match, without a full
DOM index.

Real CLI stdio smoke returned a 624-byte response with expected font size,
line height and margin; repeats were stable and ordinary report output was
unchanged. An invalid Chrome path verified this required no capture. Artifacts:
`juxtapose-experiments/website-build/saved-element-mcp-v1`.

## Verification

Workspace build, typecheck and lint pass. The focused serial suite passes
57 tests across the inspector, saved-element MCP/cache, saved reports,
one-call verification and documentation schema checks. The final serial
browser-backed suite passes 157 files and 2040 tests, with 3 skipped, in
229.59 seconds (`/private/tmp/jux-saved-element-final-suite.log`).
Capture/browser code is unchanged; this feature makes no new
capture-determinism claim.
