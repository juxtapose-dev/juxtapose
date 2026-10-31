---
'@juxtapose/cli': minor
---

Use direct R2 uploads for Storybook archives and snapshot batches when the service advertises support.
Verify acceptance through the API after upload, recover ambiguous transfer and
response failures, and keep signed URLs out of returned receipts. Existing
services continue to use API uploads. Snapshot batches share artifact uploads,
limit concurrent PUTs, and recover missing cached artifacts through API finalization.
