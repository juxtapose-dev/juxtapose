---
'@juxtapose/cli': minor
'@juxtapose/core': minor
---

Navigation no longer waits for the `load` event, and a new `network.external` option can block third-party requests (#125, part of #147). `page.goto` now resolves on `DOMContentLoaded` by default (`waitUntil: 'load'` restores the old behavior), so one subresource that never answers, such as Chakra's avatar fallback `<img src="https://bit.ly/broken-link">` that 522s after ~20 s, no longer holds a worker for 20-30 s on every run or errors the story. The settle wait, which already tracks requests and images in flight, waits for it up to `settle.timeout` and flags the capture `settle-timeout` naming the request. `network.external: 'block'` (config, story parameters, `--network-external`, and the MCP `network` argument) fails requests to origins other than the page's own through CDP `Fetch`, so a random photo or a broken external link neither changes the pixels nor stalls the capture. Default is `'allow'`. Record/replay (#147) is not implemented.
