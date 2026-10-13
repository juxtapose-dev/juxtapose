---
'@juxtapose/core': minor
'@juxtapose/cli': patch
'@juxtapose/server': patch
'@juxtapose/storybook': patch
---

CDP calls are typed through Chrome's own protocol definitions (`devtools-protocol`, a types-only dependency of `@juxtapose/core`, pinned to the protocol revision of the pinned Chrome), and JSON read from disk or the wire is checked where it enters instead of cast. `Page.send` infers params and results for protocol methods; an untyped fallback overload keeps existing `page.send<T>('Method', params)` calls, and methods newer than the pinned protocol, compiling unchanged. New exports `parseRunReport` and `isRunReport` read a `report.json`. Files that are not what they claim now fail with a message at the boundary: a `report.json` that is not a run report, a structure sidecar that is not one `jux` wrote (read as absent, like a corrupt one), and a review-server `/run` body whose `storyIds` is not a list of ids (400). The Storybook addon now calls `addons.add` bound to `addons`. Capture output is unchanged.
