# V8 no-opt: current-pipeline review

Do not enable `--js-flags=--no-opt` by default. The original experiment assumed
fresh renderers for every story; renderer sharing is now the default, so that
rationale no longer establishes a general performance benefit.

Fresh paired measurements use the optimized native-WebP/binary-CDP pipeline,
120 controlled captures per run, five alternating runs per arm, excluded fresh
references and warmups, and identical total worker counts within each pair.

| Platform            | Workers | Default median | no-opt median |      Change |
| ------------------- | ------: | -------------: | ------------: | ----------: |
| M5 Pro macOS        |       8 |        2.724 s |       2.849 s | 4.6% slower |
| Linux GitHub runner |       3 |       13.372 s |      13.245 s | 0.9% faster |

This is not a matched operating-system comparison: concurrency and hardware
also differ. The small Linux improvement does not justify a global JIT-policy
change, especially given the local slowdown. Application execution cost and
scheduling can differ when optimization is disabled.

All 2,400 measured image hashes and complete structures matched their fresh
references, and all 240 decoded cross-arm image pairs matched exactly. No
retries or failures. Current flag unit tests and full Linux CI also passed.
These establish correctness on the samples, not a universal performance win.

Production remains unchanged. The prototype is preserved on
`perf/js-no-opt-probe` and as [a patch](experiment-no-opt.patch). The patch was
made before the animated-image-freeze merge and may require conflict resolution
against later browser flag tests. PR #229 now records the experiment instead of
shipping the flag. No release changeset is required for research-only files.

[Machine-readable results](no-opt-current-results.json).
[Linux benchmark](https://github.com/juxtapose-dev/juxtapose/actions/runs/38833055050).
