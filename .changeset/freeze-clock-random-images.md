---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/server': patch
'@juxtapose/storybook': minor
---

Freeze the clock, random sources and animated images during capture (#146, #182). A new `freeze` option (`{ clock, random, images }`, all on by default) starts `Date`, `Date.now()`, `Intl.DateTimeFormat` and `Temporal.Now` at 2024-01-01T12:00:00Z, advancing only as timers fire; seeds `Math.random`, `crypto.getRandomValues` and `crypto.randomUUID`; and launches Chrome so animated GIF, WebP and APNG images show their first frame. `freeze.clock` takes `false` or another ISO 8601 instant. A story or a `stories` override can set `clock` and `random`; `images` is project-wide. `jux config --explain` shows the effective values. Stories that render a date, a random value or an animated image capture new pixels once and need approving again.
