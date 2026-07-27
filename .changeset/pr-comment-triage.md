---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

Make the PR comment a triage surface rather than a report.

The heading now carries the decisive number — `3 visual changes need review —
largest 1.01%` — because it is the only part that renders in the PR timeline
and in notification emails. Under a byte-exact hash a bare count cannot be
acted on: three antialiasing hairs and three collapsed layouts both read as
"3 changed".

Fixes a correctness bug in the instructions: `jux approve` reads the last
**local** run, so the `jux approve --all` the comment printed after a CI run
either failed outright or silently approved a stale local run. Every command
block now leads with `jux run`.

Other changes: per-status guidance instead of one instruction for `fail`, `new`
and `stale`; commands uncollapsed and prose collapsed, so a first-time reader
does not pay a click to find the CTA; errors sorted above magnitude, and never
offered as an approve target; `new` and `stale` cells say `first capture` and
`pixels identical` rather than an em-dash; columns dropped when every row
shares a value; pipes escaped so a story id or error message cannot corrupt the
table.

`DiffResult` now records the `viewport` a capture used. This fixes `jux
handoff` computing region-area percentages against the project default for any
story with a per-story viewport override.

`--html` is now registered in the argument parser — it previously worked only
because unknown flags are tolerated.
