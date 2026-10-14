---
'@juxtapose/core': patch
---

The structure snapshot is faster on very large pages. It no longer asks Chrome for DOM rects, which nothing read and which made Chrome lay out every `content-visibility` subtree, and normalizing it is now linear in the page's node count rather than quadratic in sibling count. On Primer's `treeview-features--contain-intrinsic-size` (110k elements) the snapshot went from about 3.0 s to 0.9 s (median of 3). Capture hashes are unchanged. Sidecars are byte-identical except that a closed `<details>`'s menu, which is never painted, is no longer recorded as visible.
