---
'@juxtapose/core': patch
---

Rebuilding `will-change` layers before a capture (#136) now changes only the elements that declare `will-change`, through an inline style that is put back afterwards. It no longer adopts a page-wide stylesheet. Those elements keep their containing block, so a `position: fixed` child no longer moves to the viewport for two frames, and IntersectionObserver or ResizeObserver code no longer reacts to that move and changes the captured state. Layers inside open shadow roots and layers set by an inline `!important` style are now rebuilt too. A story with no `will-change` element skips the step, which saves about one frame per capture.
