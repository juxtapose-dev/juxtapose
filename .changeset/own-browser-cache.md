---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

jux runs its pinned browser only from its own cache or an explicit `JUX_CHROME` / `--chrome` (#141). It used to run chrome-headless-shell straight out of Playwright's cache, so `playwright install` or a disk cleanup deleting that directory broke every launch, mid-run included. A matching Playwright build is now copied into jux's cache once (a clone where the filesystem supports it), version-checked, and used from there; Playwright's directory is only read. When there is no browser, the error names the expected path and `jux browser install`.
