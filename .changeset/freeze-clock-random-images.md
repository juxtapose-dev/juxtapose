---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/server': patch
'@juxtapose/storybook': minor
---

Freeze animated GIF, WebP and APNG images on their first frame by default (#182). Set `freeze.images: false` to retain playback for a project.

Add opt-in clock and random fixture controls (#146). `freeze.clock: true` starts `Date`, `Date.now()`, `Intl.DateTimeFormat` and `Temporal.Now` at 2024-01-01T12:00:00Z; an ISO 8601 instant selects another starting time. Timer callbacks advance the clock, with a fallback for synchronous clock polling; asynchronous callback order is not controlled. `freeze.random: true` seeds `Math.random`, `crypto.getRandomValues` and `crypto.randomUUID`. Both options default to `false`.

Clock and random settings layer per project, story, variant and `stories` override; animated-image policy is project-wide. Types, JSON schema, configuration docs and `jux config --explain` describe the controls. Enabling a control can change captured pixels and require fresh baseline approval.
