---
'@juxtapose/core': patch
---

Rebuild `will-change` compositor layers before the paint barrier, so a capture no longer depends on the page's history (#136). Chrome keeps the subpixel offset a `will-change: transform` layer was first rasterized at, so a marquee whose animation ran for a frame before the freeze, or whose width changed after its first raster when a font loaded, kept glyph antialiasing from an earlier frame. That earlier frame depended on timing, so one Chakra marquee story captured three different hashes depending on whether it ran alone, in a full run, or through the warm browser. It now captures one. Stories with such a layer may need a one-time re-approval, because their new baseline is the page's final state. The examples capture byte-identical to before.
