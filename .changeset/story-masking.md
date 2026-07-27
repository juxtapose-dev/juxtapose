---
'@juxtapose/core': minor
---

Add `mask` for content that changes every run.

A clock or a random avatar makes a story permanently red under a byte-exact
hash, and `minDiffPercent` cannot help — the hash decides before the diff runs.
`parameters.juxtapose.mask` takes CSS selectors and paints a solid box over
each before the screenshot, so that region is identical every run while
everything around it is still compared exactly.

The docs lead with the better fix: make the input deterministic. Stubbing the
date keeps full pixel coverage; masking gives it up for that region, and is for
nondeterminism you do not control.
