---
'@juxtapose/cli': minor
---

Add `jux mcp`, a Model Context Protocol server on stdio for coding agents. It exposes six tools (`snap`, `diff`, `run`, `check`, `handoff`, `approve`) that return the same JSON as the matching commands with `--json`, and it keeps one browser open for the whole session. `approve` takes explicit story ids only. See `docs/mcp.md`.
