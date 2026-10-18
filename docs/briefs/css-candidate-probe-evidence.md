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

## No initial screenshots: incomplete feasibility trial

`probe-agent-noimages-v1` removes all four initial image attachments while
retaining source, saved evidence, local PNGs and on-demand image tools. One
candidate session requests layout evidence and proposes nine heading values,
but its native probe command fails before an edit. The monitor stops the trial;
independent grading remains 0/2 visual and 4/4 behavior. Last-reported usage is
4478 counted tokens plus 12160 cached input, with final billing incomplete.
This is inconclusive, not evidence of an image-free repair or savings.

No paid retry is made. A separate native-only replay of the same proposals
finds exact RGBA matches for both targets. The original error is not explained:
the adapter discarded native diagnostic output. Future calls now preserve exit,
signal, stdout and stderr, while controllers retain incomplete outcomes without
inventing phase timings. Three focused checks pass; two real native captures
also verify exact matches and preserved expected new-baseline exit-1 output.
Frozen study controllers and raw logs remain unchanged. Image-free efficacy and
production robustness are still open gates.

## Geometry-sufficient repair and image-request ordering

`probe-geometry-v1` tests a responsive button-height mismatch with unchanged
typography. One Sol 6.1 medium session completes in 3 model calls and 19.886s,
using 53717 total input, 46592 cached input and 425 output: 7550 counted tokens.
It requests saved layout for both states, edits two height tokens, then verifies
both exact targets and all four behavior checks. No probe is called. Protected
inputs remain intact. This is a single-arm sufficiency result, not a controlled
savings estimate.

The full rollout also contains two local image views in the first code-mode
batch, despite zero image blocks in the MCP server log. Initial attachments
were absent, but this was not an image-free repair. Future analyses must inspect
nested local image calls as well as MCP logs. Tool guidance now asks clients to
read measurements before deciding whether images are needed, edit and verify
when source plus measurements suffice, and request a focused paired crop for
unresolved appearance. It does not prohibit images or change tool contracts.
The wording's effect on agent behavior still needs a controlled test across
geometry-sufficient and appearance-uncertain cases.

## Tool-description ordering screen

`evidence-order-v1` completes one control-first Sol 6.1 medium pair at exact
2/2 visual and 4/4 behavior quality. Only the served reference description
changes (710 to 707 bytes); shared instructions, schemas, tools and prompts
are equal. Both take 3 calls. Control takes 18.636s, candidate 25.528s.
Candidate views two local images instead of four but also runs a pixel script.
Total input increases from 53937 to 54362. Counted usage is 18145 versus 8087,
accompanied by different cache reuse; this is not a stable cost-saving claim.

No efficiency benefit is established. Description exposure is also unverified:
neither agent requests its schema, and the changed wording is absent from
logged messages/output. Rollouts do not fully expose model tool-schema context,
so absence is not proven. Do not claim the agent ignored a visible instruction.
Stop this metadata-only protocol rather than repeating it. Before a future
trial, assert intervention visibility in a supplied compact result/prompt packet,
or use a supplied-catalog replay. No response/default change is promoted from
this result; the tool wording remains a workflow clarification, not a measured
optimization. Full design-from-scratch performance is still unestablished.

## Visible-guidance replay and benchmark preflight

`visible-guidance-replay-v1` stops after its first control call: the decision
selects the correct height edit and saved crop, but uses `run({name})` rather
than `run({stories})`. The replay omitted tool schemas. Its exact grader rejects
the call, so no candidate runs and no guidance comparison exists. Sol medium
uses 5727 counted tokens (17629 input, 12160 cached, 258 output) in 10.103s.
Keep this as a benchmark defect and inconclusive result, without a paid retry.

Future packet preparation now validates oracle calls against the same schemas
included in the exact public prompt, hashes that rendering and excludes private
expected answers. Focused checks reject invalid arguments and absent tools.
`visible-guidance-packet-v2` passes this preflight with no model/browser calls.
This is preparation only, not a reason to keep repeating wording experiments.

Image accounting also reads structured image blocks delivered in the rollout,
including code-mode outputs, rather than relying on MCP-only logs or literal
call sites. Historical audits confirm two tool images in the geometry session,
four versus two in the ordering pair, and two versus zero additional tool images
in the supplied-toolkit typography pair (both initially attached four images).
Image counts alone do not establish a time or token effect.

## Other properties and coupled hypotheses: native-only gates

`css-probe-contact-v1` tests static initial-state DOM from the public
agent-authored contact form, rather than the planner typography fixture.
Spacing-only and height-only mutations each yield the unique correct value
with RGBA equality across desktop and mobile. Six-capture batches take
725ms and 706ms locally; these are single measurements, not agent savings.
Repeated requests reuse results and preserve source. No model calls occur.

A coupled spacing/height mutation exposes a scalar ranking limitation. With
height still wrong, true gap20 leaves 7444/6106 mismatches (desktop/mobile),
whereas incorrect gap24 leaves only 4414/3636. The minimum compensates for
another defect. The adapter correctly returns no exact value; this does not
show an agent would follow the misleading ranking.

`joint-css-hypotheses-v1` evaluates four explicit two-property sets across
both states, with no generated search. Only joint gap20/height44 passes both
states and is independently RGBA equal. Omitting it yields no-match; alias
IDs for equivalent passing overrides remain ambiguous. Repeated/reordered
requests reuse saved measurements. One eight-capture native batch takes
1065ms locally; no model calls. Three contract checks cover bounds, canonical
identity dependencies, all-state completeness, ambiguity and distinct
policy-pass/RGBA evidence.

This validates a bounded hypothesis-measurement contract, not agent value.
The controller supplied the correct hypothesis. Keep this static prototype
on demand and internal: no new MCP tool/default, live Storybook support,
automatic CSS cause, optimization loop or acceptance change. A future agent
gate must require agent-chosen hypotheses and equal independently verified
quality, with a feasible budget that does not depend on cached prefixes.
