# On-demand CSS candidate measurements: local research evidence

Status: experimental static-fixture adapter only. No product probe API,
default, native dependency or acceptance change is introduced.

The planner reference uses off-grid heading sizes while agents start with
slightly different public current values. Both arms receive the same source,
images and existing Jux/browser tools. Candidate alone may propose values of
an existing CSS custom property; native captures compare those proposals with
the reference PNG. The agent selects the property and values, and must verify
its actual source edit afterward. The adapter does not infer a CSS cause.

## Completed pilot and stronger-baseline validation

| Study                    | Control calls / seconds / counted | Probe calls / seconds / counted |
| ------------------------ | --------------------------------- | ------------------------------- |
| Pilot                    | 9 / 78.471 / 12632                | 4 / 24.823 / 8271               |
| Known Node/Sharp runtime | 8 / 77.276 / 12377                | 4 / 21.787 / 14414              |

All four sessions complete normally, pass 2/2 exact visual states and 4/4
behavior checks, preserve protected inputs, and end with only the two responsive
font tokens corrected. No baseline is approved. The pilot control has three
intermediate runtime/script failures; the validation supplies Node sharp and
pixelmatch plus local image paths equally, with zero shell failures. The studies
are retained separately, not pooled.

The supplied-toolkit pair uses 71.8% less process time, half the model calls
and 54.9% less total input with the probe. Actual counted usage is 16.5% higher
because cache reuse differs, including a large candidate-prefix miss. Do not
subtract that miss or claim a consistent counted-cost reduction. One stress
fixture/model does not establish a general effect or confidence interval.

## Why it helped in this case

The control successfully measures pixels with Node but then misinterprets the
typography, including a tracking change that it later reverts. Candidate tests
nearby values of --page-heading, finds unique zero-mismatch candidates and keeps
the other typography unchanged. Its native probe costs 874ms in the validation,
fully included in the 21.787s interval. Layout inspection still takes a phase;
the probe avoids subsequent image interpretation, wrong edits and recovery.

The static adapter returns bounded measured rankings, not images or proposed
code. It leaves source unchanged, reports nonzero closest values as unverified,
withholds results on concurrent source change, and caches by source/reference/
proposal identity. Native and real stdio preflight verify exact matches,
no-match ranges, unused properties, repeated-request reuse, source/reference
invalidation and limits. Cached requests return byte-stable data with no new
captures. These cache guarantees do not yet extend to live workbench state.

## Scope and next gates

Time includes all agent tools and probe source/reference loading, native CLI/
browser/captures and comparison; it excludes shared setup and independent
grading. Both studies use Pixelmatch 0.1, includeAA false, exact extent and zero
mismatches. Targets are PNGs; agents receive no target DOM or implementation.

The adapter currently serves a frozen static source snapshot with temporary
:root overrides for integer-px CSS custom properties, at most 32 captures per
batch. This is not production support for arbitrary URLs or Storybook. Before
adoption: test other parameter classes and an already-explained geometry case;
test lower initial image context; design faithful native workbench overrides,
render-identity invalidation, checkpoint isolation and cleanup. Preserve the
fast green path and do not promote automatic probing on every mismatch.

Artifacts: `juxtapose-experiments/iteration-billing/probe-agent-v1` and
`probe-agent-toolkit-v1`, including archived controllers, runtime checks, raw
rollouts/usage, proposed values, native measurements and independent grades.
