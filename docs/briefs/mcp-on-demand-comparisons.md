# On-demand design and iteration comparisons

The MCP `reference` tool currently answers “How does this saved capture differ
from the design target?” The agent also needs to answer “What did my last edit
change?” without receiving a progress block after every `run` or opening Chrome
again. These are distinct comparisons: a decrease in target mismatch count does
not describe which pixels changed between two captures.

## Interface

- `reference({ name?, detail?, region? })` remains the target-versus-current
  view. The default is a short summary; `detail: "json"` and a region ID expose
  the saved ledger and a paired crop only when requested.
- `reference({ compare: "previous", fromRun: "<run-id>", name?, detail?, region? })`
  compares the named saved run with the latest saved run. `fromRun` is explicit:
  a time-ordered guess can select a different run when another actor captures
  stories. The response names both run IDs. A region crop places the previous
  capture on the left and current capture on the right.
- A later `toRun` argument can select an older current run if a reproducible
  comparison requires it. It is unnecessary for the first MCP workflow.
- Neither form captures or navigates. Missing keys and incompatible image
  geometry are reported, not silently compared.
- `run({ feedback: "none" })` saves a capture and returns its RunReport without
  computing the default target hint when the next question is only about the
  previous/current change.

## Session state

Cache up to eight previous/current ledgers per MCP session, keyed by the
canonical latest run path, explicit earlier run and reference selection. Saved
run directories are immutable once `run` returns, so a new run changes the
cache key. Keep design-reference analysis separate: it depends on the
reference PNG, config and image hashes, so a changed reference must invalidate
its result even when the saved run is unchanged. Disk analysis remains
available after MCP restart; no session cache is required for correctness.

## Feedback budget and evidence

Do not append iteration comparison to every `run` response. The agent requests
it when it needs to know whether an edit moved or introduced a mismatch. Short
responses give changed-pixel counts and a few largest regions; full region
measurements and crops are optional. Report current distance to target in the
target view. If a progress-to-target number is later included, label it as a
change in mismatch count, not an image delta or proof of improvement.

Measure the complete agent loop, including extra MCP calls, on a frozen
second-edit task. Compare default target-only feedback against optional
previous/current lookup, with identical source, captures, model, prompts and
token cap. Grade final visual and behavior quality independently. The prior
always-on progress block used 12,652 counted tokens and 18.8 seconds versus
9,443 tokens and 12.9 seconds in one equal-quality pair, so optional access
must earn its place with a better result on a task where it changes the edit.

An unmodeled smoke check on the saved four-state billing captures measured
66.3 ms for the first previous/current MCP request and 0.29 ms for the same
request from the session cache (0.21 ms for its JSON form). The short response
was 504 bytes, versus 3,076 bytes for JSON. This verifies the local lookup and
cache behavior on that fixture; it is not evidence of agent token or elapsed
time savings.
