---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

Add opt-in full-document capture: `jux snap <url> --full-page`, or `fullPage: true` for a story. The image covers the whole rendered document while the browser keeps its layout viewport, which full-page captures record as `layoutViewport`. Before capturing, the page is scrolled through once so lazy images and scroll-triggered reveals load and finish animating.
