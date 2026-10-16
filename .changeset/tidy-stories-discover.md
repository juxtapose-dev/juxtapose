---
'@juxtapose/adapter-storybook': patch
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Load only selected stories during Storybook parameter discovery, and include the selection in discovery cache keys so partial results cannot be reused for full runs. Preserve whole-store extraction for full selections and previews without per-story loading support.
