# Selective control geometry evidence

Status: enabled in compact MCP summaries on this feature branch. Not pushed or released. Visual acceptance, structural verdicts and signatures are unchanged.

## Problem and implementation

Ancestor geometry deduplication hid an input resize in the billing fixture. A compact-response replay changed field spacing incorrectly. Automatically adding the measured input height produced the correct repair. Padding and typography controls showed that extra geometry is redundant when a direct style fact already describes the change.

The existing matcher/fact pass collects resizes suppressed as parent followers with no other direct fact. The control observer requires a unique DOM ID or test ID, matching tag/role, complete snapshots and compatible viewports. It validates identities against original snapshots so adapter context filtering cannot hide duplicates. Measurements describe border boxes, never CSS causes. Conservative selection may miss useful measurements when another direct fact exists.

Failure reports save up to three measured observations within 1024 UTF-8 bytes, prioritizing selected measurements before budgeting. Compact summaries group selected dimensions across captures, preserve explicit approved/current values and scope, and cap the block at three items/768 bytes. Omission counts are explicit. Older reports without the evidence remain readable and emit no block. Detailed report reads use saved data; there is no additional capture or sidecar read. The run path uses the existing matching pass.

## Evidence

- 35 saved pairs: enabling collection leaves all structural verdicts identical. The selector retains eight billing measurements and excludes six redundant corpus measurements. Settings supplies no identified changed-size positive.
- Held-out padding/line-height repairs: both existing and augmented feedback yield identical correct patches, all four pixel comparisons pass, no fixed dimensions introduced. Extra geometry adds 180 counted tokens without benefit.
- Scoped compact replay: 574-byte block, zero extra tool calls, 28/28 behavior and 4/4 visuals, 4442 counted tokens.
- Two order-reversed full-loop pairs, Sol medium: all four sessions pass 28/28 behavior and 4/4 visuals. Mean model-process time 30.666→22.918s; counted uncached input plus output 12066→9002.5; model calls 5.5→4. Treatment avoids a pre-edit report in both pairs. Discovery behavior also varies, so this is not a general 25% claim or an isolated latency estimate for one tool call.
- Real browser/MCP preflight verifies all four states, saved-detail reuse after restart, and exact same-build control/treatment parity except the 574-byte block.

Artifacts live in juxtapose-experiments/iteration-billing: SELECTIVE-CONTROL-FULL-RESULTS.md, selective-control-full-v1/v2, control-geometry-heldout-v1, scoped-control-decision-v1, control-geometry-selective-v2, compact-control-summary-v1 and control-geometry-browser-preflight-v2. Invalid decision trials are excluded from savings.

## Verification and limits

Focused observer, fact, run-path, summary and MCP tests cover identity ambiguity, truncated structures, adapter context collisions, multibyte bounds, selection before budgeting, capture scope, unchanged verdicts and green paths. Real captures and independent fixed-policy visual/behavior grading validate the evaluated fixture. Workspace build, typecheck and lint pass. The full serial Vitest run passes 154 files: 2016 tests passed, 3 skipped (230.13 seconds). The normal CLI MCP entry point emits the default block without a constructor override. Synthetic 300/1000-capture summaries stay at 1950/1962 bytes, with a 248-byte measurement block; this smoke check uses no model calls or captures (`default-control-summary-v1/result.json`). No capture implementation changed; a new determinism run was not required for this promotion.

Only one model and one full-loop fixture have been tested. PNG-only targets have no approved DOM evidence. Custom ARIA controls and controls without explicit identities are not covered. Additional evidence is not a verdict or a suggested CSS edit. The internal constructor override is retained only to reproduce controlled benchmark comparisons; it is not a new public MCP argument.
