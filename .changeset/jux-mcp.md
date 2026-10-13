---
'@juxtapose/cli': minor
---

Add `jux mcp`, a Model Context Protocol server on stdio for coding agents. It exposes six tools (`snap`, `diff`, `run`, `check`, `handoff`, `approve`) that return the same JSON as the matching commands with `--json`, and it keeps one browser open for the whole session. `approve` takes explicit story ids only. See `docs/mcp.md`.

`jux snap --viewport` now accepts each side from 1 to 10000 and reports anything larger as a usage error. `jux approve --json` now prints `{"approved":[],"failed":[]}` when there is nothing to approve, instead of printing nothing.
