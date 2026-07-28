---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

Report per-phase timings on `jux run`

A run reported one total, which is enough to know it was slow and not enough to
know why:

```
15 pass   (1.0s)
  enumerate 5ms | launch 137ms | baselines 1ms | capture 1.0s
```

`diff(N)` reports how many diffs actually ran. Under a byte-exact hash that is
the figure that explains a slow run, since diffing is a cold path only reached
by stories that already failed:

```
10 pass  ·  5 fail   (0.9s)
  enumerate 5ms | launch 76ms | diff(5) 110ms | capture 828ms
```

Capture is measured across the whole streamed loop rather than summed per
story, because the pool runs several pages at once and summing would report
multiples of the wall-clock actually spent.
