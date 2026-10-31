---
'@juxtapose/core': patch
---

Report selected captures with static story-level `skip: true` parameters as explicit skip rows instead of silently omitting them. Preserve config attribution, live-only skips, variant selection and nonblocking local CLI exits. This does not change hosted capture completeness requirements.
