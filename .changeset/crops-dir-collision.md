---
'@juxtapose/cli': patch
---

`jux diff --crops` no longer lets same-named images share a crops dir (#131). A `.webp` path input is named `<basename>.<8 hex of sha256(absolute path)>`, so `runA/images/X-current.webp` vs `runB/images/X-current.webp` and `runA/...` vs `runC/...` write to different dirs under `.juxtapose/crops/` instead of overwriting `X-current~vs~X-current`. Snap-name pairs keep their readable `<a>~vs~<b>` dirs.
