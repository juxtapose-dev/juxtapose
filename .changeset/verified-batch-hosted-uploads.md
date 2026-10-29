---
'@juxtapose/cli': patch
---

Use advertised project-scoped verified artifact reuse and bounded snapshot batches, with four upload workers, per-item receipts and bounded retries for failed items. Retain four-worker snapshot PUT compatibility only when the hosted service does not advertise the batch protocol. Never finalize incomplete uploads or substitute legacy unverified dedup objects.

Resuming a legacy upload after batch ingestion is enabled can require a fresh capture when the service cannot verify the old snapshot's immutable artifact fingerprint. The CLI reports that conflict and retains the original artifacts instead of silently changing upload protocols.
