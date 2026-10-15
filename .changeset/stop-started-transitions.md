---
'@juxtapose/core': patch
---

Stop already-running CSS transitions when freezing animations. Setting duration to zero only prevented new transitions, allowing intermediate border and placeholder colors into captures. The freeze now removes transition properties, reaching the final style without an added delay. The `animations: 'play'` opt-out is unchanged.
