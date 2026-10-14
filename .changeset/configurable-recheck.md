---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

Make the stable-approve recheck configurable. `recheck` in the config, `--recheck <mode>` and `--no-recheck` on `jux run`, and a `recheck` argument on the MCP `run` tool choose which stories the run captures twice: `"changed"` (new and failing, the default and today's behavior), `"new"` (new only) or `"off"` (none). A story the run didn't capture twice is marked `unrechecked` in `report.json`, and `jux approve` captures it again and approves it only if the two hashes match, so approval stays safe; `--allow-unstable` still overrides. With the recheck off, stories carry no `unstable` or `flake`, and `report.json` (`recheck`) and the `jux run` output say so. `jux config --explain` shows the effective `recheck` and its source. The Storybook panel's approve button refuses an `unrechecked` story; use `jux approve`.
