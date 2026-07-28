---
'@juxtapose/cli': patch
---

Fix `jux check` clearing every visual regression

`check` decided a story was approved if the manifest merely had an entry for it.
`resolveStatus` only reports `changed` when an entry already exists, so every
real regression had one and every real regression was cleared. `jux check`
exited 0 on a suite `jux run` had just failed, which is worse than no gate
because CI looks green.

It now confirms the approval against the bytes, comparing the run's captured
image to the manifest hash the way the addon already does. A capture that cannot
be read blocks rather than clears.

Verified end to end against `examples/storybook`: a colour change failing 5
stories now exits 1 and names them, and `jux approve --all` returns it to 0.
