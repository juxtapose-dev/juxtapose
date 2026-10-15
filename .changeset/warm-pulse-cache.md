---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/server': patch
---

Add project and per-story `renderer: { shared, clearResourceCache }` settings. Shared-renderer baseline mismatches receive bounded fresh retries, with retry evidence and per-story pinning instructions in reports. Cache clearing is optional. Fresh renderers remain the default pending three-suite verification.

Approval now confirms every selected capture on a fresh renderer, including with `--allow-unstable`, and requires the reviewed hash to match. Initial baselines also use fresh renderers.
