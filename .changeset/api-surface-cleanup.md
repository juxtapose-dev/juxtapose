---
'@juxtapose/core': minor
'@juxtapose/server': patch
'@juxtapose/cli': patch
'@juxtapose/storybook': patch
---

Trim the public API surface before it becomes a semver commitment.

`@juxtapose/core` exported sixteen symbols with no consumer outside the package
— `armSettle`, `waitForPaint`, `DOM_IDLE_MS`, `captureStory`, `capturePool`,
`diffImages`, `computeChangedRegions` and similar. These are exactly the
internals CLAUDE.md describes as load-bearing and easy to break, so publishing
them invites downstream code to pin the parts that most need freedom to change.
The barrel is now organised by who consumes it — adapter authors, store
authors, run drivers, reporters — with a note saying so.

`formatPercent` moves to `core` and is shared. It had five copies, one already
stylistically drifted, and it encodes a product rule rather than a format: a
real change must never display as "0.00%".

`hashImage` is now exported and used by the review server, which had its own
copy. Anything comparing against a manifest entry has to use the function the
manifest was written with; a second implementation silently diverges the moment
the algorithm changes.
