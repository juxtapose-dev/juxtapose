---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

Capture lossless WebP directly in Chrome to avoid PNG decoding and Sharp re-encoding. Remove ICC metadata without changing pixels and reject lossy screenshots. Existing exact baselines require a one-time reviewed re-approval; run and doctor identify previous-encoder baselines. Pixelmatch remains opt-in and can accept equivalent pixels without replacing approvals.
