---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

A full-page capture that differs from its design reference only in size now returns `fail` with an `extent` block (`current`, `reference`, `dw`, `dh`, `missingAreaPixels`) and overlap mismatch counts, instead of `incompatible` with no pixels. The overlap is compared top-left aligned and pixels present in only one image count as mismatched. `reference` output and the MCP design-reference hint show `extent:{dh,dw}` and a short "current is N px shorter than the target" note. Viewport, device scale factor, capture-kind and target-geometry mismatches stay `incompatible`. When a `run` has no approved baseline (every story `new`) but design targets were compared, the summary `next` text points to the design-reference hint.
