---
'@juxtapose/core': minor
'@juxtapose/server': minor
'@juxtapose/addon-storybook': minor
---

Watch mode: recapture stories as you edit them.

Storybook's own render event is the trigger rather than a file watcher — HMR
rerenders a story, and the story knows which component file it came from, so
there is no second source of truth about which files matter. A render counts as
an edit only when no navigation preceded it, which is what separates "I saved a
file" from "I clicked a story in the sidebar".

Scope is every story sharing the edited component. When a static build is
available the import graph widens that to dependents; the dev server has no
bundler graph, so without one it stays at the component. `liveCapture: false`
opts a story out of live recapture while leaving normal runs alone.

Unlike `jux run`'s analysis, an uncertain answer here narrows rather than
capturing everything: this fires on a keystroke pause, where escalating to the
whole suite is a hang rather than a safety net. CI remains the backstop.
