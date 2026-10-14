---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

`jux snap` and the MCP `snap` tool give each URL its own budget and replace the shared page after a timeout (#163). One wedged URL used to poison the page every later URL shared: three URLs gave 90 s and all three failed. Now the hung URL errors once, within `storyTimeout` or the 30 s navigation cap, whichever fires first, with an error naming the stuck step; the following URLs get a fresh page and capture normally. `jux snap` still exits 3 when any URL failed. Snaps that do not time out keep sharing one page, so they are byte-identical to before.
