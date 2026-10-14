---
'@juxtapose/core': minor
'@juxtapose/cli': minor
'@juxtapose/server': patch
---

Event-driven settle. Instead of waiting for 150 ms without DOM changes (capped at 500 ms), juxtapose now waits until the page has no pending timers due within 1000 ms, animation frames, posted messages, DOM changes, loading fonts, loading in-viewport images or network requests in flight. On the example workbenches the captures are byte-identical to before, and settling takes about 40 ms per story instead of about 165 ms. Pages that finish late, such as a 300 ms timer or a slow fetch, are now captured in their final state.

The wait is capped by `settle.timeout` (default 1500 ms). At the cap the page is captured anyway, and the result is flagged `settle-timeout` with a list of what was still pending, such as `1 request to /api/feed in flight (Fetch)`. The flag appears in `DiffResult.flags` and `DiffResult.settle`, in the verdict's `flags`, in `jux snap` results, in `jux run` output and in `jux handoff`. It never changes a pass or a failure. If the wait can't run (for example, the page navigated during it), juxtapose waits for fonts, images and a quiet DOM instead and flags the result `settle-fallback`.

New settle options, layered from the project config through story parameters (including variants) to the command: `settle.timeout`, `settle.ready` (wait for the page to call `window.__juxtapose.ready()`), `settle.network.ignore` and `settle.network.require` (URL glob patterns with an optional `type:<ResourceType>`). WebSocket, EventSource, beacon and prefetch requests are ignored by default. The project config also accepts `waitForSelector` and `delay`. `jux snap` and `jux run` take `--settle-timeout`, `--settle-ready`, `--no-settle-ready`, `--settle-ignore` and `--settle-require`, `jux snap` takes `--delay`, and the MCP `snap` and `run` tools take a `settle` argument (and `delay` on `snap`). An invalid settle option exits 2 and names where it came from; the review server reports an invalid project `settle` as a config error.

Fixes a hang: the image wait before capture had no cap, so a story with an image that never loaded held its worker until the page's 30 s evaluation timeout. Images are now part of the capped wait, and a lazy image outside the viewport is not waited for.

The exported `Page` interface gains an optional internal `on` for CDP events; a `Page` implemented outside core doesn't need it.
