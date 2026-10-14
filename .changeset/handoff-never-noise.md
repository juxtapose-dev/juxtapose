---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

A small pixel mismatch is no longer called noise or safe to approve (#201). The handoff, PR comment and structural summary only say "likely rendering noise" when the structural diff positively shows nothing changed and the regions are thin hairlines. With no baseline structure the handoff says the change is unexplained, shows the regions and magnitude, and tells the agent to inspect the crops before approving. The PR comment heading states the largest mismatch instead of "all under 0.1%" and always offers `jux handoff`. Adds `scripts/check-init.mjs` to CI, a regression check that `jux init` saves structure for every baseline (#199).
