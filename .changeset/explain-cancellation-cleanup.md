---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Close all browser contexts owned by a cancelled configuration-explain call, including contexts that finish opening after cancellation. Stop waiting for discovery immediately, discard late results before caching, and preserve the caller's shared browser. Narrow the discovery browser interface to remove an unsafe double cast.
