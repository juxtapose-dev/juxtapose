# Expose verified painted-fill evidence

The scoped contact repair control made a separate Sharp color-sampling call
after requesting layout evidence. That layout matcher had already established
exact target/current opaque fill equality for the moved Save button but omitted
the measured color. The trial later reached its six-call limit: despite exact
independently graded final images and passing behavior, it is inconclusive and
its treatment was not run. No agent saving is established.

The requested layout/JSON evidence now includes
`paintedFill: {rgb: [40, 91, 196], targetCurrentEqual: true}` on this button's
verified match. RGB describes the opaque pixel component, not the CSS background,
a whole-element identity or a suggested declaration. Matching, abstention and
visual acceptance are unchanged; absence of a match implies no color agreement.
The compact run response adds nothing. No extra analysis is performed.

The core type and CLI projection carry the field. Derived layout caches advance
to version 3; entries with missing or invalid fill observations are recomputed.
The existing whole-match omission and 3072-byte focused-response limit remain.

## Evidence

`juxtapose-experiments/iteration-billing/painted-fill-evidence-v1` checks the saved
native contact captures with a nonexistent Chrome path. It verifies the reported
RGB against both segmented fills, preserves the previous geometry and abstention,
and returns byte-identical evidence within one session and after restart.
Cache bytes remain unchanged on reuse. The focused response grows from 1,406 to 1,526
bytes and the target verdict remains fail. No model or browser call is made.

`iteration-billing/efficient-repair-context-v1` records the separate benchmark
preflight: scoping the repair catalog preserves run/reference/report and both
browser tools, removes 8,073 contract bytes and enforces its advertised allowlist.
The native bridge smoke passes. Image arguments now use a positional separator
before stdin; local rendering attaches all four images without treating '-' as
an image. Neither byte reductions nor runtime preflights establish agent savings.

`iteration-billing/efficient-repair-agent-v2` preserves the interrupted control:
37.787 seconds, 11,542 last-reported uncached-input-plus-output tokens, 115,712 cached
input tokens separately, 6 calls, 2/2 exact visual and 6/6 behavior checks, protected
inputs unchanged. Final billing may be incomplete. No treatment, replacement or
feedback recovery run was performed.

## Verification

Build, typecheck, lint and 34 focused checks pass, including unequal-color
abstention, cache restart/reuse, malformed fill rejection and response bounds.
Astra review found no blocking issue. The full serial suite records 159 passing
files, one failed file, 2,066 passing tests, one failed test and three skipped in
481.22 seconds (`/private/tmp/jux-painted-fill-suite.log`). Its only failure is a
five-second timeout in the browser supervisor idleMinutes test while machine
load averages were 709–940. That exact test passes unchanged on one isolated
recheck in 1.278 seconds (`/private/tmp/jux-painted-fill-supervisor-recheck.log`).
The initial full-suite failure remains recorded; there was no full-suite rerun.
Capture/browser code is unchanged; this is not a determinism claim.

The next behavioral gate should ask whether explicit fill evidence avoids local
sampling while retaining an uncertain-heading measurement before editing. Keep
raw image access, exact tool handles, identical feedback and equal quality.
Do not repeat the capped trial or present its final quality as a completed
baseline. Broader workflow savings remain unproven.

`iteration-billing/initial-region-packet-v1` passes a separate offline gate:
the top three saved regions include the heading in both states, both saved
crop requests execute without Chrome, and the proposed two-state packet fits
1,702 bytes. This is an experimental packet, not default MCP output or evidence
of agent crop selection or savings.
