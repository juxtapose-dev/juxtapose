# Renderer reuse with a fresh retry

Status: shared rendering defaults on, with cache-pulse then fresh recovery.
Jer explicitly changed the rollout decision after the first field comparison.
The original strict parity comparison failed; this is not a claim that its
21/6/2 hash differences were all caused by renderer reuse. Fresh-only runs
also varied.
Scope: [handoff](../briefs/codex-renderer-reuse-handoff.md), PR #231.
The renderer configuration was approved by Jer. Validation results are recorded
on [PR #231](https://github.com/juxtapose-dev/juxtapose/pull/231).

## Capture policy

Add `renderer: { shared?: boolean, clearResourceCache?: boolean }` to story
capture options and project configuration. Reuse the existing `stories` glob
map as the pattern list:

```json
{
  "renderer": { "shared": true, "clearResourceCache": false },
  "stories": { "card--*": { "renderer": { "shared": false } } }
}
```

A story can set `parameters.juxtapose.renderer` (Storybook) or
`meta.juxtapose.renderer` (Ladle). Preserve existing story/variant/glob
precedence, with project settings as fallback. Merge individual renderer
fields, so overriding `shared` preserves an inherited `clearResourceCache`.
Resolve before navigation; live-only values discovered after render must
trigger a recapture with the resolved policy before judgment, never silently
affect only the next story.

`shared: true` reuses the renderer and enables cache-pulse then fresh retry on baseline
mismatch. `shared: false` uses the existing renderer hop and isolate check.
`clearResourceCache: true` performs this branch's
`Network.setCacheDisabled` true/false pair before a reused-renderer navigation,
clearing Blink's in-memory resource cache while retaining the HTTP cache.
Ignore cache clearing when `shared` is false. Forced fresh retry and approval
set `shared: false` and disable `warmSwitch`, overriding story settings.
Keep warm switching opt-in; it is outside the reuse rollout.

Default `shared` to true.
Default `clearResourceCache` to false. Map explicit legacy
`freshRenderer: false` to `shared: true` and true to false; reject conflicting
project settings. An omitted legacy key uses sharing.

Stage 2 must add the object to `config/schema.ts` so generated `ProjectConfig`
and story parameter types, runtime validation, and story/variant overrides
agree. Document both fields, defaults, field-wise merging, legacy mapping,
retry behavior, and the approval override in `docs/configuration.md`; update
relevant CLI/MCP documentation and examples. These are not available runtime
options until stage 2 is implemented.

## Retry and recheck

In `runCapture` (`packages/core/src/run/run.ts`), collect eligible hash
mismatches during the first pool pass, then retry after that pool closes and
before the existing `toConfirm` recheck pass and final tally. Eligibility:
a successful shared-renderer capture with an existing, non-stale baseline whose
hash differs. New, stale, skipped, errored, and explicitly fresh captures do
not receive history retries. Baseline image availability is irrelevant.

Retry cap: `ceil(0.10 * N)`, where N is selected non-skipped capture keys
(variants count separately; exclude live skips). Sort candidates by code-unit
capture-key order before selecting the capped subset so pool completion order
cannot choose which failures receive retries. Attempt each selected key with a pulse, then fresh if needed;
errors consume budget. Skip the pulse tier if the first capture already pulsed. Excess candidates retain normal failure/recheck
behavior. Report cap exhaustion; a capped run can remain red even when an
uncapped fresh run would pass.

First retry with a cold navigation and a forced cache pulse, including the
first navigation of a new retry worker. Do not overwrite artifacts for an
unsuccessful pulse. An exact baseline match resolves the story; otherwise
force fresh, cold captures in the fallback pool. Share renderer-isolate tracking
across the first, retry, and recheck pools; a `renderer-reused` retry is
unconfirmed, not evidence of a fresh result. Compare its byte-exact hash with
the manifest before comparing it with the first capture:

| Fresh retry outcome                    | Final handling                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| Matches baseline                       | Pass; remove from `toConfirm`; no instability verdict for the initial mismatch. |
| Still differs                          | Judge and retain the fresh snapshot as the current failure.                     |
| Error, skip, abort, or reused renderer | Retain failure and mark retry unconfirmed; never pass or silently approve.      |

For a valid retry, replace current image/structure and result details with the
fresh judgment; remove obsolete diffs, cause, flake, and instability metadata.
Keep initial/retry hashes as evidence and include both captures in duration.
Ensure artifact consumers remove stale diff files when the result becomes a
pass. No image buffers need to remain in memory between passes.

History retry runs independently of `recheck`, including `off`. After retry,
`changed` confirms remaining new/failing captures; `new` confirms only new
captures; `off` confirms none. Existing unrechecked approval guards remain.
A still-failing fresh retry needs a further fresh capture under `changed`:
compare fresh with fresh, not reuse with fresh. An ordinary confirmation is
not another history retry and cannot turn a baseline mismatch into a pass.

## Results, reporting, and approval

Use optional `DiffResult.rendererRetry` with `outcome` (`resolved`,
`mismatch`, `unconfirmed`, or `cap`), `initialRenderer` (the resolved renderer settings), `initialHash`, and optional
`cachePulseHash`/`cachePulseError`, `resolvedBy` (`cache-pulse` or `fresh`),
and `freshHash`/`reason`. Absence means no retry was needed. Derive resolved counts
from these results; status stays within the existing status enum. Carry this
evidence through JSON, CLI, HTML, PR comments, handoff, MCP, and review UI.

Report footer: “N stories passed only after a fresh retry.” Follow
with sorted capture keys and a copyable config entry for each:
`"stories": { "card--default": { "renderer": { "shared": false } } }`.
Also report attempted retries, the cap, and failures left without a retry.
For pulse-resolved stories, recommend `renderer: { shared: true, clearResourceCache: true }`.
Report pulse and fresh recovery counts separately. These are observed recovery
results, not causal proof; retry workers also change context and timing.

`jux approve` must freshly capture every selected story, including already
rechecked results and `--allow-unstable`. Use `approve-confirm.ts` and `run/confirm.ts` to confirm fresh hashes; retain
reviewed artifacts only when they match those fresh bytes exactly.
Require equality with the selected run hash before normal approval; a
disagreement requires review of a new run. Preserve environment checks and
fail closed on capture errors. `--allow-unstable` may waive stability checks,
but cannot waive fresh capture or approve bytes different from the selected
hash. Audit shared approval entry points so they cannot promote reuse bytes
through an alternate path.

Renderer configuration, result metadata, and report wording are implemented. Stage 2 was authorized by Jer on 2026-10-15.
The original stage-3 strict comparison is retained as evidence. Jer then
authorized shared by default with recovery. Verify the revised recovery on all
three suites and both determinism modes before release; record remaining
failures rather than treating them as successful recovery.
