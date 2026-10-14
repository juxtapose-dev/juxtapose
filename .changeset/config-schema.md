---
'@juxtapose/core': minor
'@juxtapose/cli': patch
'@juxtapose/storybook': patch
---

One schema for the project config and story parameters (#178). `@juxtapose/core` now publishes `@juxtapose/core/schema.json`, a JSON Schema for `juxtapose.config.json` that gives editors completion, hover docs and validation, and exports `JuxtaposeParameters` and the schemas themselves. The TypeScript types, the JSON Schema, the MCP tool argument shapes and the runtime checks are all derived from it; the runtime accepts and rejects exactly what it did before, with the same messages. Adds the `@sinclair/typebox` dependency. `jux init` writes a `$schema` line into a new config. `@juxtapose/storybook` exports `JuxtaposeParameters` and types `parameters.juxtapose` in CSF files (#180).
