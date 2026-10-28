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

## Routing preservation follow-up

Four valid Sol 6.1 medium single-call replays in C T T C order each answer
the same seven tool-routing/next-action cases. Both arms return every expected
decision exactly, with no invoked tools or cap stops. Mean counted usage is
8979→6371.5 (29.0% less); total input 20916→18308.5 (12.5% less), with equal
12160 cached input and 223 output tokens in both arms. Mean process time is
7.0075→6.927 seconds: no meaningful time saving is established.

This validates scoped guidance decisions and input reduction with a supplied
catalog, not autonomous repair, dynamic discovery, or full-loop savings. The
same seven cases repeated twice per arm are not independent generalization
samples. Cases cover URL before/after, target versus baseline measurements,
omitted required states, checkpoint comparison, saved styles, source rollback
and stopping without approval. The grader's mutation tests pass; every oracle
call validates against both frozen schemas. No dependency was installed.

Next full-loop study must bound name-based discovery in both arms. Nothing
changes capture, result formats, acceptance or approval behavior. Artifacts
are under `juxtapose-experiments/iteration-billing/mcp-guidance-context-v1`
and `guidance-routing-v2` (the latter includes archived controller sources).
