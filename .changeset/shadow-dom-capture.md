---
'@juxtapose/core': patch
---

Freeze, settle and the image wait now reach into open shadow roots (#152). The animation freeze is adopted into every open shadow root, including ones attached after the story starts rendering; DOM changes and loading images inside open shadow roots are waited for like the document's. Closed shadow roots stay out of reach. Stories with animations or transitions inside shadow DOM (spinners, progress bars, web component dialogs and tooltips) capture their frozen frame from now on, so they change once and need re-approval.
