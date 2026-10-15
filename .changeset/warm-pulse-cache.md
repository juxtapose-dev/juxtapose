---
'@juxtapose/core': patch
---

With `freshRenderer: false`, disable and re-enable the network cache before each reused-renderer navigation. This evicts Blink's in-memory resource cache and removes most history-dependent pixels (Chakra: 32 stories differed from fresh-renderer captures before, 5 after, 4 of them already flaky between two fresh runs).
