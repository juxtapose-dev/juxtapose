# Focused requested PNG measurements

Status: local feature branch; no push, merge or release. `reference({name, detail: "layout"})` returns one named target's existing cached painted-region evidence, with confidence rules, current element identities and explicit abstentions/omissions. It does not run outline analysis or recapture. Default output stays separate.

## Measurement and repair evidence

- Actual named-target MCP responses: full JSON 3500 bytes; focused layout 1776 bytes, 49.3% smaller, with exactly equal layout observations. This is a UTF-8 response-size result, not a measured token or time saving.
- A tool-free Sol medium repair decision receives the 1776-byte packet and frozen public editable source. It independently passes all four target visual states and 28 behavior checks under unchanged Pixelmatch 0.1 / includeAA false / exact extent / zero mismatches. Target implementation and target DOM are absent. The fixture has one seeded field-height defect, not the four-defect regression fixture.
- One normal model call: 15622 total input, 12160 cached input, 342 output, 3804 counted uncached input plus output; 10.141 model-process seconds. No image viewing or tool calls. This is conditional repair sufficiency on one familiar fixture, not a matched control comparison or the six-per-arm promotion gate.
- Full MCP workflow validation with normal product tools/guidance: one Sol medium session discovers `detail=layout`, requests three target states in one batched tool phase with source reading, changes only `src/form.css`, then verifies both stories. Independent quality is 4/4 visual and 28/28 behavior; protected inputs/references stay unchanged. Four model usage updates, 26.681s, 87306 total input / 70400 cached input / 743 output / 17649 counted tokens. This one-arm result establishes API discovery and workflow completion, not comparative savings. Three RPCs already share a model phase, so a batch endpoint cannot claim three saved model round trips.
- The real CLI stdio endpoint advertises the new detail mode and returns the same packet. Repeated and restarted MCP requests are byte-stable, and derived cache file mtimes stay unchanged. These checks use an invalid Chrome path and require no browser/model.

Artifacts: `juxtapose-experiments/iteration-billing/focused-png-evidence-v1`, `focused-png-decision-v1`, and `focused-layout-mcp-v1`, and `focused-png-full-v1`. All evidence remains local.

## Contract and limits

One name is required. Layout detail cannot be combined with a crop or checkpoint comparison. The 3072-byte budget omits whole over-budget observations and counts them; it never truncates an identity. Metadata exceeding the budget fails explicitly. Capture errors retain bounded issue text. Other target states still need independent verification. Full JSON retains the broader ledger and diagnostic view.

The formatter reuses the existing extraction/cache path. It adds no new analysis, target correspondence guarantee, CSS-cause claim or acceptance policy. The earlier PNG precision/recall and capability limits continue to apply. No default promotion or general website-reconstruction saving is established.

## Validation

Workspace build, typecheck and lint pass. Full serial browser-backed Vitest: 155 files passed; 2031 tests passed, 3 skipped; 228.35s (`/private/tmp/jux-focused-layout-full-suite.log`). The focused tests cover unchanged measured content, UTF-8 bounds, whole-identity omissions, unavailable/error states and invalid argument combinations. Browser smoke and independent repair grading are recorded above. No capture/browser implementation changed, so this branch does not require a new capture determinism study.
