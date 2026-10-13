---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/storybook': minor
---

Structural diff and `jux diff`: two structure sidecars plus the pixel diff
become a deterministic tier-0 verdict (`juxtapose.verdict/v1`) — what
changed, by how much, whether it explains every changed pixel, with risk
flags. `jux run` attaches it to failing stories as `results[].structural`;
`jux handoff` leads with it. `jux snap` takes several urls with
`--as-prefix`, one browser launch; `jux diff --prefix before after` verdicts
every page.
