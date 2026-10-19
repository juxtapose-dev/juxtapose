---
'@juxtapose/cli': patch
---

Select the latest saved run by its report timestamp rather than mutable directory metadata, so adding analysis caches to an older run cannot change which run is selected. Break equal timestamps deterministically.
