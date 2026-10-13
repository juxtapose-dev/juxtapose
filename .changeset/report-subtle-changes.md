---
'@juxtapose/core': patch
---

Stop the PR comment and HTML report calling a real change "0%"

Pass/fail is a byte hash, but the percentage comes from pixelmatch, which tolerates small colour deltas. A colour nudge like `#2563eb` to `#1d4ed8` therefore failed the hash, marked zero pixels, and was listed as **0%** in the comment and "0% changed" in the HTML report. It now reads "subtle, diff marks no pixels". A crashed capture still shows its error.

The comment also now names the Storybook panel by its actual tab label, **Visual**.
