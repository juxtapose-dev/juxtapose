---
'@juxtapose/adapter-histoire': minor
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

Add a Histoire adapter.

Enumerates from `histoire.json` and captures each `<Variant>` through
`__sandbox.html`, gating the screenshot on Histoire's own
`__histoire:sandbox-ready` message. Per-story config is read from `meta.juxtapose`
on either a `<Story>` or a `<Variant>`, with the variant winning.

Histoire is the first platform whose native unit is not a story — a story file
holding six variants produces six baselines.
