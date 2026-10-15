---
'@juxtapose/core': patch
---

Use Chromium's binary CDP pipe to avoid repeated JSON conversion of large DOM snapshots. Preserve existing screenshot, structure, and daemon client formats. Keep `JUX_CDP_JSON=1` as an internal diagnostic fallback, including private-browser fallback and daemon identity.
