---
'@juxtapose/core': patch
---

Fix Svelte component source links in monorepos by recording paths relative to the Git repository, while preserving package-local compiler and project configuration. Omit source paths when the repository cannot be verified or the component resolves outside it.
