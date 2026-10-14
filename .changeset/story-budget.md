---
'@juxtapose/core': minor
---

One per-story capture budget, and real `durationMs` on errored stories (#154). A page whose main thread stays busy after `DOMContentLoaded` (Primer's ~110k-element treeview story) stalled every browser call for its own 30 s cap, so one story cost 127-160 s and triple a run's wall time. The new `storyTimeout` config option (ms, default 60000) bounds the whole capture of a story: when it runs out the story fails once, with an error naming the step it was stuck in, the worker's page is discarded and replaced, and the run continues. Errored stories now record the time they really took instead of `durationMs: 0`, so they show up in slow-story stats.
