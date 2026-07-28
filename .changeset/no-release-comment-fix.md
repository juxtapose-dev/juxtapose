---
---

No release. `packages/core/src/types.ts` changed, but only the doc comment on
`BaselineManifest`, so there is nothing for a user to install.

An empty changeset is how you say that deliberately. The check in CI cannot
tell a comment from a behaviour change, and loosening it far enough to try
would have missed the bad changeset that failed every release run earlier.
