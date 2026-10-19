---
'@juxtapose/core': patch
---

Normalize captured DOM bounds into viewport coordinates on scrolled pages, so visible elements and pixel-diff regions use the same coordinate system. Screenshot pixels are unchanged; recapture old scrolled metadata to obtain corrected geometry.
