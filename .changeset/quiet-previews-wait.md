---
'@juxtapose/cli': minor
---

Add explicit `jux submit --wait-preview` publication waiting and read-only
`--resume <buildId> --wait-preview`, with bounded polling and trusted private
preview URLs. Preview waiting never starts hosted capture or reports a visual
verdict. Existing upload and review-wait behavior remains unchanged.
