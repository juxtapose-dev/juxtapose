---
'@juxtapose/cli': patch
---

Fix truncated `--json` output when stdout is a pipe (#135). The CLI called `process.exit()` as soon as a command returned. Pipes are asynchronous on macOS, so output still queued in the process was dropped and a reader saw at most 64 KiB. The CLI now waits for stdout and stderr to drain, up to 30 seconds, before exiting. This applies to every command.
