# Snapshot processing worker experiment

The prototype moves DOM normalization and canonical structure hashing to one
shared Node worker thread. Browser-side extraction, mask verification and mask
cleanup complete before screenshot preparation. Only immutable data crosses the
worker boundary; paint and settling safeguards are unchanged.

The previous same-thread overlap experiment could block screenshot promise
continuations. This experiment lets those continuations run while normalization
executes on a separate CPU thread. Structured cloning transfers both raw input
and normalized output; these costs and worker startup are included in wall time.

The worker is shared across page captures, not one worker per story. The capture
still waits for normalization before returning, so ordinary in-flight work is
bounded by page concurrency. This diagnostic implementation is not ready to ship:
it needs explicit cancellation, shutdown and timeout handling, bounded queued bytes,
and worker-failure tests. Timeout recovery can otherwise accumulate work.

Timing accounting assigns browser structure collection and any normalization tail
after screenshot completion to the structure phase. Screenshot duration includes
its real wall time; overlapped normalization is not added twice. Detailed
`structureTimings.normalize` in the candidate includes posting, queueing, startup,
worker execution and reply, whereas baseline normalization is synchronous CPU work.
These detailed timings cannot be interpreted as an isolated CPU-speed comparison.

Artifact writes already run in the consumer of a capture-pool buffer while page
workers advance to the next story. Moving them behind another queue would not
create that overlap anew. Synchronous structure compression still runs on Node's
main thread, so offloading serialization/compression is a distinct potential
experiment; this benchmark does not test it.

## Results

M5 Pro, same immutable 120-capture collection, five alternating measured runs per
arm, separate excluded fresh references and warmups. Both arms use one Chrome
browser and the same page concurrency. Optional 250 ms process-tree RSS sampling
was enabled in both comparisons; detailed structure timings only in the
three-worker comparison. Compare within each pair, not across the two batches.

| Page workers | Baseline median | Worker median | Median change | Mean change |
| ------------ | --------------: | ------------: | ------------: | ----------: |
| 8            |         2.803 s |       2.925 s |   4.4% slower | 0.9% slower |
| 3            |         4.358 s |       4.199 s |   3.7% faster | 0.5% faster |

The three-worker baseline ranged from 3.995 to 4.420 seconds, so the median
improvement is not a robust throughput win. Eight-worker summed peak RSS medians
were 3.316 versus 3.481 GiB; three-worker medians were 2.535 versus 2.676 GiB.
Summed RSS double-counts shared mappings and sampling can miss peaks.

Across both comparisons, all 2,400 measured image hashes and complete structure
objects matched fresh references, including independent canonical hash checks.
All 240 decoded cross-arm image pairs matched, with zero failures and retries.
The build, changed-file ESLint, and 21 structure unit tests passed. A built-worker
probe checked eight concurrent real-fixture requests, invalid-input failure, and
subsequent successful work. These checks do not cover worker crash/cancellation.

**Decision:** retain as an experiment, not a production change. There is no
convincing improvement on this controlled collection. This does not rule out a
benefit on unusually large DOM snapshots or a different transfer boundary.

[Raw summaries and provenance](snapshot-worker-results.json).
[Prototype patch](experiment-snapshot-worker.patch), also preserved on
`perf/snapshot-worker-probe` at `88f91cd`. The patch applies to the parent of that
commit; source changes after the eight-worker run only added message type
annotations and formatting, with the three-worker run using the rebuilt version.

Reproduce after applying the patch and building, using an unchanged baseline CLI:

```sh
JUX_PROFILE_CONCURRENCY=8 JUX_PROFILE_MEMORY=1 node scripts/compare-pipeline.mjs BASELINE_CLI CANDIDATE_CLI examples/storybook/storybook-profile 5 --pixel-parity
JUX_PROFILE_CONCURRENCY=3 JUX_PROFILE_MEMORY=1 JUX_STRUCTURE_PROFILE=1 node scripts/compare-pipeline.mjs BASELINE_CLI CANDIDATE_CLI examples/storybook/storybook-profile 5 --pixel-parity
node scripts/check-pipeline-structure-parity.mjs PROFILE_DIRECTORY
```

## Artifact serialization/compression follow-up

A second prototype moved JSON serialization and synchronous gzip into a dedicated
worker at the CLI artifact boundary. It retained one pending sidecar at a time,
including input cloning, result copying, startup and file-write waits.

Five alternating runs at eight page workers were disrupted by increasing host
load: baseline runs ranged 2.862–4.298 s and candidate runs 2.884–6.757 s. This
batch does not establish a repeatable speed improvement; the prototype is not
adopted. All 1,200 measured captures and complete structures matched, and all
120 decoded cross-arm pairs were exact, with zero retries or failures.

[Evidence with per-run load](encoding-worker-results.json) and
[prototype patch](experiment-encoding-worker.patch), also on branch
`perf/structure-encoding-probe`. A production implementation would need explicit
worker shutdown, cancellation and concurrent-caller handling. No public API or
production default changes are justified by this result.
