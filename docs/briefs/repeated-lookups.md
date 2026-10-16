# Repeated lookup audit

Inspected DOM normalization, variant expansion, affected-story analysis, browser
capture and structural diff code. Repeated linear lookups are candidates, not
proof of a meaningful bottleneck. The large quadratic sibling/nth-of-type scan
in DOM normalization was already removed before this audit.

- DOM border-style normalization searches the fixed property list for each kept
  element. Precomputing four width-column indices avoids that work, but does not
  change overall asymptotic complexity: the property list has fixed size.
- Affected-story analysis checks external-file membership per changed file.
  A set changes worst-case O(changes × external files) to O(changes + external
  files), but allocating it can lose for one changed file or an early match.
  Measure real cardinalities and hit positions before adopting an index.
- Variant cycle detection scans a growing chain; front insertion also shifts
  array entries repeatedly. A set and append/reverse preserve semantics, but
  ordinary inheritance chains may be too short for a meaningful benefit.
- Structural shift grouping scans moved facts to select an anchor and backwalks
  to the head of a displacement run. This is a red-path candidate. Compare bounded
  backwalking, reuse of existing positions, and indexing on representative diffs;
  do not assume a full additional index is best. No shift code was changed.

A combined diagnostic prototype covers the first three changes. Build, ESLint,
and 128 focused tests passed. Three paired controlled runs produced 720 exact
captures and full structures plus 120 exact decoded cross-arm image pairs,
with no retries or failures. Host load changed substantially: timings do not
justify a throughput claim or production adoption. The changes remain only in
[the prototype patch](experiment-repeated-lookups.patch) and branch
`perf/remove-repeated-lookups`. [Evidence](repeated-lookups-results.json).

The current optimized green-path measurement of roughly 2.8 seconds for 120
captures means about 23 ms per capture in amortized throughput, not individual
latency: eight page workers overlap. More useful next profiles are unusually
large real DOMs, short-run startup, and changed-image diff/report workloads.
