---
'@juxtapose/core': patch
---

`network.external: 'block'` now treats the committed main-frame document's origin as first-party, so a top-level redirect to another origin keeps its own CSS, JS and images. A request left open by a child frame of the previous document no longer stays in flight after navigation; on a full local Chakra pass this removed spurious `settle-timeout` flags (55 and 40 per pass before, 3 and 2 after). Story and variant `network` values are validated before the run, and a `network` value only the live preview declares now warns.
