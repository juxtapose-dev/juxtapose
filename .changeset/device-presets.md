---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

Add device presets. A `device` (`iphone-15`, `pixel-8`, `ipad`, the aliases `mobile`, `tablet` and `desktop`, or one you define under `devices`) sets the viewport and emulates the device: mobile layout, touch, user agent and client hints, at device scale factor 1. `orientation` rotates it. Use them with `jux snap --device` and `--orientation` (and the MCP `snap` tool), in project config, story parameters, URL entry `params` and variants. A baseline approved on another device is reported as `previous device emulation`. `jux snap --help` now lists `--viewport`. Captures with no device and no orientation are unchanged.
