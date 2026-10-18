# Compact MCP guidance candidate

Status: local branch, not pushed or promoted from comparative workflow evidence.

In a real Codex discovery response, global Jux instructions were prepended to
each tool. An earlier 12-tool benchmark packet contained 17237 bytes of repeated
shared prefix beyond its first copy. Two of those tools belonged to the benchmark
browser. The candidate's validation separates the browser server so that product
measurements concern Jux's ten tools only.

Server-wide guidance shrinks from 1678 to 305 UTF-8 bytes. A deterministic packet
of ten tool schemas with the guidance prepended shrinks from 31462 to 17986
bytes, 42.8% smaller. This is context size, not a measured token/time saving.
The remaining tool schema is exactly equal after descriptions are removed.
Workflow-specific instructions live with snap, run, report, reference and
checkpoint arguments. Shared rules retain identity/measurement limits,
ordinal meaning, complete verification and explicit approval.

Real stdio preflight verifies both contracts and confirms that the separate
browser tools have no Jux instruction prefix. Focused tests cover the multiplied
context budget and preserved workflow guidance. Build, typecheck and lint pass.
The full serial browser-backed suite passes 158 files and 2042 tests, with
3 skipped, in 230.38 seconds (`/private/tmp/jux-compact-guidance-suite.log`).
Capture/browser code is unchanged; no new capture-determinism claim is made.

The C T T C full-loop comparison stops in its first control arm. After two
model calls, the monitor reports 18648 counted tokens and reserves 17693 for
a potential next call, exceeding remaining headroom under the 30k ceiling.
It stops before editing; no candidate model call runs and no trial is replaced.
Cached input is 24320, reported separately and excluded from that count.
The remaining original visual mismatches mean the run is inconclusive, not a
valid control or evidence of a comparative performance gain. Do not pool it
with previous successful trials under different server topology.

The control also searches names and descriptions with a broad "guidance"
alternative. That query includes unrelated Pages/web tools, reports 27443
original output tokens and is truncated. Definitions are requested again on
the next call. This is an additional discovery failure, not a cost entirely
attributable to Jux's prefix duplication. Future replays must distinguish
bounded name-based discovery from the byte reduction measured here.

Next gate is a small routing/next-action replay covering preserved guidance,
before any more full runs. Nothing changes capture, result formats, acceptance,
or approval behavior. Artifacts and the frozen protocol are under
`juxtapose-experiments/iteration-billing/mcp-guidance-context-v1`.
