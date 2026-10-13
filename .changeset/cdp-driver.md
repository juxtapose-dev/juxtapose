---
'@juxtapose/core': minor
'@juxtapose/adapter-storybook': minor
'@juxtapose/adapter-ladle': minor
'@juxtapose/cli': minor
'@juxtapose/server': minor
'@juxtapose/storybook': minor
---

Capture through juxtapose's own CDP driver instead of Playwright. Captures stay byte-identical (verified on both example workbenches), so existing baselines remain valid and nothing needs re-approving.

Playwright is no longer a dependency or peer dependency. The browser is a pinned `chrome-headless-shell` 151.0.7922.34, installed once with `npx -p @juxtapose/cli jux browser install` (also `jux browser status` and `jux browser path`). An existing `ms-playwright` cache of the same build is reused and nothing is downloaded. New: `JUX_CHROME=<path>` or `--chrome <path>` uses your own Chromium, and `JUX_CACHE_DIR` moves the cache.

**Breaking:**

- Mask and `--wait-for` selectors must be CSS. Playwright-only syntax (`text=`, `>>`, `:has-text()`, `:visible`, `nth=`) now fails the story with `jux: selector '…' is not a CSS selector` instead of silently matching nothing.
- Node >= 22.2.0 is required (it was 20).
- Adapters receive `@juxtapose/core`'s `Page`, not Playwright's. Third-party adapters that used Playwright-only `Page` methods need to move to the `Page` interface core exports.
