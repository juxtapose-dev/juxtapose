# Design-reference agent loop

## Primary workflow

Optimize incremental edits to an existing Storybook or Ladle component. The
agent selects the changed stories, receives a concise diff against approved
baselines or an explicit design-reference PNG, inspects a paired region only
when needed, edits the component, and verifies every affected story/viewport
in one run. Design targets remain separate from approved regression baselines.

The billing experiment showed 29–42% fewer tokens and 39–47% less elapsed time
across two pairs at equal measured quality. Those numbers are task-specific and
come from prototype tooling, not the released CLI. The work below makes the
workflow available in the product; it does not promise those savings generally.

## Work packages

1. **Core reference contract** (`feat/design-reference-core`): typed config
   mapping capture keys to project-contained PNG files and geometry; strict
   path/format checks; browser-free saved-current/reference comparison; a
   versioned result with changed/missing pixels, region IDs, provenance and
   uncertainty. No target DOM is assumed. Owns core tests.
2. **Current agent output** (`feat/agent-diff-output`): improve the existing
   approved-baseline handoff and MCP guidance independently. A short readable
   verdict points to complete machine details and optional crops. Preserve
   errors, retries and flake flags; do not imply a structural explanation proves
   visual acceptance. Owns handoff tests.
3. **CLI/MCP integration** (`feat/design-reference-cli`): add a command/MCP
   operation to compare an existing run's saved current image with a configured
   target, without Chrome or recapture; persist the full report; return a
   bounded readable summary and stable saved-evidence key. Expose optional
   paired crops with path confinement and size limits. Use the core contract
   from package 1. Owns CLI/MCP tests and user docs.
4. **Fast evaluation** (experiment harness): frozen small cases and a cheap
   next-action replay for one output change at a time. A pre-call spend gate
   must pass fake-provider tests before any paid model trial. Compare quality,
   first action, crop/capture calls, tokens, cost and elapsed time; retain failed
   and cutoff runs.

Packages 1, 2 and 4 can proceed independently. Package 3 begins with CLI
scaffolding and then binds to package 1's exported API. Merge order: core,
CLI/MCP, then reconcile the agent-output branch with the new reference flow.
The fast evaluation may inform wording and evidence order before release.

## Acceptance

- A user can configure desktop and mobile references for named capture keys,
  run a story, and compare the saved results without a second capture.
- The same run can be reopened after server restart; comparison and crop IDs
  resolve from disk without depending on an in-memory cache.
- The agent sees every selected state's status; configured references for
  unrelated stories outside a subset run do not turn that run into an error.
  Missing reference, incompatible geometry, capture error, instability and
  ordinary visual mismatch are not conflated.
- Output distinguishes observed pixels/DOM from suggested causes; the agent
  can request a bounded paired crop by ID and receive exactly the saved target
  and current pixels.
- Existing approved-baseline runs and handoffs keep their behavior. Changes to
  core/CLI/MCP pass focused tests, typecheck and relevant package checks.
- Documentation shows config, first comparison, targeted inspection and
  all-state verification; it identifies design references separately from
  approvals.

## Boundaries

No Figma ingestion, automatic target discovery, broad design reconstruction,
new capture-worker tuning, or paid large-model benchmarking is required for
this increment. Existing native run speed is already low per story; prioritize
fewer agent steps and fewer unnecessary image loads. The present Claude CLI
stream cutoff can overshoot, so it is not an acceptable hard cap for the next
live experiment.
