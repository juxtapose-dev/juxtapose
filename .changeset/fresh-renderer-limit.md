---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

The fresh renderer from #153 now holds at high concurrency, and a capture that doesn't get one is flagged. Chrome reuses a renderer that already ran a story once a browser holds its renderer-process limit, which Chrome derives from memory (24 on a 4 GB machine). Measured on Chrome 151 at concurrency 16 with a limit of 24, 14 of 128 captures stayed in a used renderer. At concurrency 8 with a limit of 8, 56 of 56 did. jux now launches Chrome with `--renderer-process-limit=1000`: 0 of 128 at concurrency 16. The flag changes no pixels. The Storybook, Ladle and Vue examples hash byte-identical to before. It also changes the warm browser's key, so an older warm browser is not reused.

A story that still lands in a used renderer, for example in a browser started with a lower limit, is flagged `renderer-reused` in `report.json` `flags`, in `jux snap` results and output, and in a warning printed once per run. The check compares the page's `Runtime.getIsolateId`, which is random per renderer process, and costs about 0.2 ms a capture.
