---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/storybook': minor
'@juxtapose/server': minor
---

Add opt-in `comparison: { mode: "pixelmatch", threshold: 0.05 }` at project, story, variant, and override level. Exact SHA-256 matches remain the fast path and default. Hash mismatches can pass only with a verified baseline image, valid ancestry, equal dimensions, and zero pixels remaining after Pixelmatch color/antialias filtering. Reports identify visual-equivalence passes and preserve both exact hashes; approved baselines, fresh approval, and exact renderer recovery are unchanged.
