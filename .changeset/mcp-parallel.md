---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

`jux mcp` runs tool calls in parallel when they touch different files. Snaps
with different names capture at the same time (each in its own browser
context, byte-identical to a snap taken alone); a `diff` waits for any snap
writing its inputs; `run` and `approve` still run alone. Calls that conflict
start in the order the server reads them, even when sent in one write, and a
waiting `run` is never starved. A call id that is still in progress is refused
with `-32600`, and a `project` inside `.juxtapose` is refused. Four
snaps through one server took 299 ms instead of 1028 ms on a 15-core M5 Pro.

The snap limit defaults to half the CPU cores, from 1 up to 4, and is set with `mcp.concurrency` in `juxtapose.config.json` or `jux mcp --concurrency <n>` (1 to 16).
