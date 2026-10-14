---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Each result in `report.json` now carries `timings`: milliseconds per capture phase (navigate, freshRenderer, render, settle, paint, structure, screenshot, encode, other) that sum to `durationMs`. They are clock reads around existing calls and change no pixels or hashes.
