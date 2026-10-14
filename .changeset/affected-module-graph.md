---
'@juxtapose/core': minor
'@juxtapose/storybook': minor
'@juxtapose/cli': minor
---

`jux run --since` now captures only the stories a changed component reaches, instead of every story (#200). Vite's build manifest lists chunks, not the modules bundled into them, so a shared component never appeared in it and almost every UI edit fell back to a full run. The Storybook addon now adds a Vite plugin to `storybook build` that records every source module and its imports to `.vite/juxtapose-modules.json`; the analysis walks that. Ladle and other Vite workbenches add `juxtaposeModuleGraph()` from the new `@juxtapose/core/vite` export to their `vite.config.js`. Rebuild once after upgrading.

Anything the graph cannot place still captures everything, and the printed reason now says which file: a changed file the build never saw (`unmapped-change`, even beside mapped files), or one only the preview imports (`shared-entry-changed`). Also fixed: git's repository-relative paths are mapped to project paths, so affected-only runs work when the workbench is below the repository root (#96), and a project-level `tsconfig.json`, lockfile or `.storybook` there now escalates.
