---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Restore suppressed border-box size measurements for ID-less controls whose existing structural pair has a unique equal tag, role and accessible name in both complete saved snapshots. Include these measurements in the existing bounded compact summary without changing structural verdicts or inferring target CSS.
