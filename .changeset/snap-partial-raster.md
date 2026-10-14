---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Capture no longer depends on repaint timing: Chrome launches with `--disable-partial-raster`. A repaint re-rastered only its invalidated rect, and a rounded border on that rect's edge rasterized a few pixels differently, so about 1 capture in 600 on Linux differed from the rest (issue #120). Pages that never repaint capture the same bytes as before. A warm browser started by an older jux is not reused, because the daemon key covers the flags.
