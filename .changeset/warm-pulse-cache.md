---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/server': patch
---

Add project and per-story `renderer: { shared, clearResourceCache }` settings. Shared rendering is the default. Baseline mismatches receive bounded cache-pulse retries followed by fresh retries, with retry evidence and per-story pinning instructions in reports. Proactive cache clearing is optional. Reports identify which recovery matched the baseline.

Approval now confirms every selected capture on a fresh renderer, including with `--allow-unstable`, and requires the reviewed hash to match. Initial baselines also use fresh renderers.
