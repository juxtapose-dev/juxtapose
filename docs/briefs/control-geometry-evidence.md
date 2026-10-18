# Approved/current control geometry research

Status: experimental observer integrated into saved failed-capture detail on this branch; not promoted into compact MCP summaries. No new capture, no image decode, no native dependency, no acceptance change.

Evidence: on the cleaned billing fixture, a tool-free compact-response replay changed label/input spacing when given only a wrapper resize delta. It passed behavior but failed all four visuals. Adding a measured textbox height (49→36, from unique matching DOM ID) produced 28/28 behavior and 4/4 visual passes in one subsequent replay. This is an information-value signal, not a statistical performance claim.

The existing ancestor-following suppression remains unchanged. `packages/core/src/diff/control-geometry.ts` provides separate conservative observations, capped at three observations and 1024 serialized UTF-8 bytes, sorted by explicit identity. It requires equal viewports and unique matching DOM IDs or test IDs, tags, and roles across both snapshots. Oversized observations are omitted whole and counted. It only covers native input, textarea, select and button elements. Controls without either explicit identity and custom ARIA controls are not covered. It describes border-box dimensions, not CSS properties or causality.

Before promotion: validate real captured sidecars beyond billing, check duplicate-ID and ID-reuse cases, measure response bytes and cost, test whether the new information avoids extra calls in a full loop with the same browser comparator control. Do not replace the existing compact default with this prototype yet.

Checks: fifteen focused tests, core no-emit typecheck, focused ESLint. No full browser suite or determinism rerun: capture is untouched and the observer is not invoked by production code.

Offline coverage audit: 35 saved pairs, all self-comparisons clear. Structural corpus has 21 button appearances with no IDs, therefore no observations; Settings has 36 identified controls across 10 pairs but no changed-size positive. Billing yields 8 observations and 2 omitted across 4 states. Only billing validates positive behavior so far. 35-pair in-memory batch p95 0.0703ms, excluding I/O. Keep experimental; no default promotion or broader agent-benefit claim. Full artifacts: juxtapose-experiments/iteration-billing/control-geometry-offline-v1/.

Explicit test-ID extension: the existing structural matcher prioritizes DOM IDs,
then test IDs. The captured corpus button has `data-testid="save"`; using that
unique explicit identity recovers six actual size changes (padding, font size,
font weight, line height, letter spacing, and text). Other corpus changes yield
no size observations. No positional, class, or accessible-name fallback added.
Duplicate identities anywhere in a snapshot and conflicting explicit identities
still abstain. All 35 identity controls remain clear. Across 35 in-memory pairs,
p95 was 0.199ms in 100 batches, excluding I/O. Settings still supplies no changed-
size positive. Evidence remains experimental and not in default MCP output.
Artifacts: control-geometry-offline-v2 includes the tested implementation snapshot.

Byte-budget audit (v3): all 35 saved pairs preserve the v2 observations and omission counts; multibyte adversarial IDs exercise the new bound. The byte limit applies to the observation array, not the surrounding response envelope. Full artifacts: control-geometry-offline-v3. No additional model spend.

Automatic-selection replay: the first failing attention item, processed by this observer with no element override, added 428 bytes and produced a patch passing 28/28 behavior and 4/4 visuals. Counted spend 4,259; process 8.411s. This is one tool-free replay, not a full-loop speed claim. Evidence: compact-automatic-control-replay-v1/RESULTS.md.

Truncation guard: either truncated snapshot now returns unavailable=truncated-structure and no observations. Identity uniqueness cannot be established over an omitted suffix. Two focused cases cover each side. This preserves the requirement to abstain instead of guessing.

Integration constraint found during review: structural verdicts have an existing 1500-character bound. Do not append this evidence to that verdict or displace existing facts. A requested-detail envelope should carry it separately and label the comparison direction (approved/current vs earlier/later). Summary and detail must not collide in saved comparison caches.

Saved detail integration: run failure analysis reuses its decoded approved and current snapshots, persists a separate controlGeometry field beside structural, and exposes it through the existing report({story}) request. Structural verdict budgeting and signatures stay unchanged. MCP regression tests verify detail visibility and summary omission; the run-path test checks a single sidecar read with renderer retries and rechecks disabled. Real capture-to-MCP preflight now passes; full agent-loop validation remains outstanding.

Browser preflight: control-geometry-browser-preflight-v1 captured all four billing states with product commit 67254af. Measurements persisted and returned identically after MCP restart; saved image mtimes were unchanged by report requests. Per-story evidence was 319–891 bytes and absent from the 1183-byte compact summary. No paid model calls. This proves transport/reuse, not agent-loop savings.

Selective collection integration: optional structural analysis collects parent-following identities in its existing matcher/fact pass, marks validated control observations suppressedResize, and prioritizes them before the count/byte budget. Identity checks use unfiltered snapshots, preserving collisions on adapter context wrappers. All 35 saved verdicts remain identical with collection enabled; selected counts are billing 8, corpus 0, Settings 0. 120 focused tests pass. Compact summaries remain unchanged.
