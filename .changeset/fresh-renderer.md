---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

**Default change:** each cold capture after a page's first now starts in a new Chrome renderer process (#153). The new `freshRenderer` config option (default `true`) controls this, and `--no-fresh-renderer` turns it off for one `jux run` or `jux snap`.

Chrome's renderer kept canvas text measurement, font and raster state across navigations, so the story captured before could change the next story's pixels, and the shuffled queue made that verdict random. Primer's PageLayout pull-request-page hashed 37d0ff51 after PageHeader webhooks and 76cf4695 alone. Spectrum's card--default hashed 28d933b6 after a button group and 2faf799d alone. A story's hash no longer depends on the story captured before it.

**This makes runs slower.** It costs about 220 ms per Storybook story: the full 1,086-story Spectrum pass went from 47 to 83 s at concurrency 8, and from 36 to 70 s at 16. Set `"freshRenderer": false` for speed-critical runs where you accept order dependence. A non-boolean `freshRenderer` is a config error in run, init, snap, MCP and the review server.
