# Renderer reuse and exact-hash recovery

Contributor reference for implemented renderer recovery. Supported configuration
is documented in [configuration](../configuration.md); behavior is implemented in
[run.ts](../../packages/core/src/run/run.ts), with regression checks in
[run-recheck.test.ts](../../packages/core/src/run/run-recheck.test.ts).

## Separate reuse policies

`renderer.shared` controls reuse of renderer processes between stories.
`renderer.clearResourceCache` requests the cache pulse for a reused renderer.
These are separate from a warm browser daemon and from opt-in warm story switching.
A shared renderer can carry process state across navigations; neither a cache
pulse nor repeatability alone proves that this state cannot affect pixels.

Project, story, variant and matching override settings retain their documented
precedence. Fresh recovery and approval override reuse where required, rather
than letting a story setting weaken their confirmation boundary.

## Bounded recovery

A baseline mismatch under shared rendering is a recovery candidate, not evidence
that the change is harmless. Candidates are selected deterministically after the
first pool closes. The recovery limit is `ceil(0.1 * non-skipped captures)`;
completion order must not decide which stories receive that budget.

The pipeline can try a cache pulse, then an isolated fresh renderer. A successful
recovery must satisfy the existing judgment and exact baseline-hash checks. A
cache-pulse result replaces the initial result only after those checks pass. A
fresh retry is reported even if it still mismatches, retaining the initial hash
and retry evidence. Unconfirmed captures,
errors, a reused supposedly fresh renderer and exhausted recovery capacity must
remain visible in results.

Recovery records the initial capture and subsequent evidence. Pulse/fresh recovery
counts describe observed outcomes, not a proven root cause: retries also change
context and timing. They do not justify a general nondeterminism tolerance.

## Approval boundary

Approval requires fresh confirmation of the selected reviewed capture and retains
its environment/identity checks. Stability overrides do not authorize bytes that
differ from the selected capture. Audit alternate approval entry points against
this same boundary.

Run both fresh and daemon determinism checks after changes to renderer ownership,
page setup or recovery. A benchmark needs the same workload and explicit recovery
counts; an apparent speedup from omitted or unconfirmed work is not a valid result.
