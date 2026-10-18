---
'@juxtapose/core': patch
---

Disambiguate changed element labels against unchanged siblings in the captured snapshot. Two same-name controls now retain distinct page ordinals even when only one changes. Check named-ancestor scopes against unchanged peers too, using one cached pass per label group rather than repeated sibling scans.
