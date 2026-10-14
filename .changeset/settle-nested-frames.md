---
'@juxtapose/core': patch
---

Settle waits out nested animation frames that are not a loop. A `requestAnimationFrame` chain stopped counting at depth 3, so an overlay that opens through three nested frames and then a `nextFrame()` (Spectrum's `guaranteedAllTransitionend`) was captured mid-open. Frames now stop counting only when the same call site re-arms itself 3 times, and frames still pending after the paint barrier get a second wait, like timers do. Part of #197.
