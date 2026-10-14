---
'@juxtapose/core': minor
'@juxtapose/cli': patch
'@juxtapose/storybook': patch
---

One schema for the project config and story parameters (#178). `@juxtapose/core` now publishes `@juxtapose/core/schema.json`, a JSON Schema for `juxtapose.config.json` that gives editors completion, hover docs and validation. It also exports `JuxtaposeParameters`, the schemas themselves, and `registerFormats()` for checking them with TypeBox. The TypeScript types, the JSON Schema, the MCP tool argument shapes and the runtime checks are all derived from it. The runtime accepts and rejects exactly what it did before, with the same messages. An unknown key now prints a warning on stderr with the closest option it could mean; it never fails a command. Adds the `@sinclair/typebox` dependency. `jux init` writes a `$schema` line pinned to the installed version on jsDelivr, and `@juxtapose/cli` ships a copy of `schema.json` for offline use. `@juxtapose/storybook` exports `JuxtaposeParameters` and types `parameters.juxtapose` in CSF files (#180).
