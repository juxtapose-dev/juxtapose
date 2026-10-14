---
'@juxtapose/adapter-storybook': patch
---

Capture navigations set Storybook's `a11y.manual` global, so addon-a11y no longer runs axe-core in each story's afterEach while jux captures it. On a very large story axe held the page's main thread past the 60 s story budget: Primer's `treeview-features--contain-intrinsic-size` (110k elements) failed on every run and now captures in seconds. Hashes of other stories are unchanged.
