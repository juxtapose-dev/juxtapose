---
'@juxtapose/cli': patch
---

Add `jux submit --wait --review-in-github` to exit successfully after a verified published review is handed to the required Juxtapose App check. Preserve default wait verdict exits, explicit reference output, and failures for missing baselines, stale source, unavailable execution or invalid evidence. Support the same handoff on read-only resume without treating handoff as approval.
