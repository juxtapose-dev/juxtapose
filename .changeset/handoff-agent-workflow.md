---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Align handoff prompts with the user's requested task: use saved evidence first, inspect history only when intent is unclear, proceed with already-requested fixes, and preserve review-only scope. Require explicit user authorization for baseline approval and avoid repair/approval work for a passing baseline. Clarify that baseline evidence does not establish design-target correctness; quote source paths in optional history commands.
