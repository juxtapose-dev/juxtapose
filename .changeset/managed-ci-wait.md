---
'@juxtapose/cli': minor
---

Add opt-in `jux submit --experimental --wait` for hosted capture and review publication. Trigger the existing idempotent capture request, poll exact build/source status with bounded I/O, timeout and interruption handling, and report the canonical hosted review URL. Preserve upload-only defaults and receipt validation. Exit separately for ready unchanged/approved reviews, review needs, explicit reference capture, actionable missing ancestor baselines and operational failures. No automatic baseline approval or local browser capture.

Add read-only `submit --resume <buildId>` for existing builds without local checkout or archive assumptions. Preserve exact server build/source identity across polls and recover scoped diagnostics when capture intake pauses after upload.
