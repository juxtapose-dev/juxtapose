---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/storybook': minor
---

Capture bounded React, Vue, and instrumented Svelte component trees alongside DOM evidence. Component instances link to their retained DOM elements for visual review and agent inspection, while image verdicts and structure hashes remain unchanged. Masked captures suppress component identities.

The Storybook Vite preset adds component build support automatically. Other Vite workbenches can use `juxtaposeComponentEvidence()` from `@juxtapose/core/vite`. Svelte records context parents and declared element ownership; coverage excludes uninstrumented dependencies. React and Vue source positions are not inferred from names.
