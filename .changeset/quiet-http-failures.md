---
'@juxtapose/core': patch
'@juxtapose/adapter-storybook': patch
---

Report HTTP error documents as capture errors instead of visual regressions. Keep diagnostic screenshots without approvable hashes, include Retry-After guidance, and stop scheduling captures after a rate-limited or unavailable workbench returns 429 or 503.

Hosted Storybook index failures now report HTTP status and Retry-After instead of suggesting that the build is missing.
