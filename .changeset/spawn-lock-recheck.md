---
'@juxtapose/core': patch
---

A client that wins the launch lock just after the daemon it was waiting on came up now re-checks for that daemon before spawning, instead of starting a redundant supervisor that only loses the socket bind.
