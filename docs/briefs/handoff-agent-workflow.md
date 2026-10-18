# Handoff follows the requested task

Status: local candidate, not pushed or released. This change fixes conflicting
prompt instructions; no measured agent time/token saving is claimed.

The older handoff always instructed history inspection, began by requesting
the machine-readable sidecar even when its facts were already inline, and
said not to apply a regression fix without confirmation. That could add work
or block a fix the user had already requested. It also suggested approval
for an intentional change without requiring the user's explicit request,
unlike the MCP server's shared rules.

The formatter now says to use supplied evidence first, read saved detail only
for a remaining question, and inspect history if intent remains unclear.
Requested regression fixes can proceed within their scope and must verify
the affected stories/variants; review-only requests remain read-only. Baseline
approval requires an explicit user request, including new/stale baselines and
cases with missing baseline structure. Optional history paths are shell-quoted.

A passing baseline has no repair or approval instructions. Recorded structural
observations and capture warnings are still shown, since a pixel-policy pass
must not erase other evidence. Passing one baseline does not establish that
design references, other required states or behavior checks pass. Handoffs
label their evidence as approved-baseline data, separate from design targets.

## Verification and limits

Build, typecheck and lint pass. The focused serial suite passes 63 tests across
the core formatter, CLI handoff, MCP guidance budget and documentation schemas.
It covers requested fix/review/approval scope, new/stale states, missing
structure, passing captures with structural observations and settle warnings,
and quoted history paths. Existing flake, renderer recovery and paired-crop
coverage remains intact.

A real stdio MCP client reads an actual saved URL run through the built CLI
using an invalid Chrome path. The 1311-byte response contains the new scope
and approval rules, with no model call or capture. Artifacts are under
`juxtapose-experiments/iteration-billing/handoff-workflow-stdio-v1`; its boolean
checks describe returned instructions, not observed agent behavior.

The final serial browser-backed suite passes 158 files and 2045 tests, with
3 skipped, in 230.14 seconds (`/private/tmp/jux-handoff-workflow-suite.log`).
Capture code, acceptance, payload types and tool arguments are unchanged.
No new capture-determinism claim is made. This does not preload source, infer
CSS causes or establish a reduction in autonomous repair turns.

A separate no-model startup audit identifies a follow-up: the new-story early
return does not name the saved current image, run ID or sidecar. The native
current image exists; exposing its location could avoid rediscovery when
appearance must be assessed. This branch does not yet change artifact links.
Evidence: `juxtapose-experiments/iteration-billing/handoff-startup-audit-v1`.
