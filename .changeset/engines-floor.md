---
'@juxtapose/core': patch
'@juxtapose/cli': patch
'@juxtapose/server': patch
'@juxtapose/storybook': patch
'@juxtapose/adapter-storybook': patch
'@juxtapose/adapter-ladle': patch
---

Declare a Node floor of >=20.11.

`parseArgs` is the binding constraint — it is only stable from Node 20 — and
the build targets ES2023. Without `engines`, someone on Node 18 installs
cleanly and then hits a confusing runtime failure instead of a warning at
install time.
