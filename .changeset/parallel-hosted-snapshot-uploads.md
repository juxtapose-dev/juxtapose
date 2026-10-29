---
'@juxtapose/cli': patch
---

Upload hosted snapshots with four bounded workers and report upload/finalization progress on stderr. Preserve per-request retries, stable counts and artifact identities; drain in-flight work after a failure and never finalize incomplete uploads.
