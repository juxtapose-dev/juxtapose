---
'@juxtapose/core': patch
---

Every cold capture after the first on a page now starts in a new renderer process (#153). Chrome's renderer kept font and raster state across navigations, so the story a page showed before could change the next story's pixels, and the shuffled queue made that hash random. Primer's PageLayout pull-request-page hashed differently after PageHeader webhooks (37d0ff51 vs 76cf4695 alone), and Spectrum's card--default after a button group (28d933b6 vs 2faf799d). Now each story hashes as it does alone. This costs time: about 220 ms per Storybook story, and the full Spectrum pass went from 47 to 83 s at concurrency 8. Warm switching (`warmSwitch: true`) is unchanged.
