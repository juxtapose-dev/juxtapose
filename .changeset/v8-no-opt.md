---
'@juxtapose/core': patch
---

Capture Chrome now runs V8 with `--js-flags=--no-opt`. Each story loads the workbench bundle once in a fresh renderer, so TurboFan's optimising compiles were wasted work: 5.6% less wall time on 200 Spectrum stories on a GitHub runner, with every capture hash unchanged. A `--js-flags` passed in launch args is merged into the same switch instead of replacing it.
