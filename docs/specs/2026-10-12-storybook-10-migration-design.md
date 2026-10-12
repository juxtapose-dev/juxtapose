# Storybook 10 migration — and the "addon works perfectly" program

Status: draft for review · 2026-10-12

## The program

Goal: the Storybook addon and the capture pipeline behind it work perfectly —
launch-ready as open source, and solid enough to be the intake for
juxtapose-service — proven on a synthetic conformance suite and on real,
large design systems.

**Re-sequenced 2026-10-12** after the agentic-visual-diffing research and the
build/publish steelman (both in `juxtapose-service/docs/research/`, landing via
juxtapose-service PR #155). The agent
surface comes first because it is the thesis under test, and it does not need
the addon; the addon and the corpus prove the Storybook/CI upgrade path after
the thesis holds. Each sub-project gets its own spec → plan → implementation
cycle; only the Storybook 10 migration is specified here.

| #   | Sub-project                                                                                                                                                                                                                                                                     | Why it is in this position                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Structural engine + Storybook-free agent surface** — DOM/computed-style sidecar captured beside pixels; structural diff → classification → tier-0 verdict; `jux snap <url>`, `jux diff <a> <b> --structural --json` (URL adapter, issue #11); a Claude Code skill. MCP later. | The 10× claim is "verdict in ~300 text tokens, not ~4k image tokens"; it is unproven until this exists. Needs a page + CDP, not Storybook. Same-machine before/after captures sidestep the cross-machine baseline problem. |
| 1   | **Viewport matrix + cheap Chromatic-parity items** — `viewports` config, viewport in story id + manifest, cost linear in the matrix                                                                                                                                             | Config-level work on a settle pipeline that already re-settles per viewport. Browsers are _not_ here: determinism flags are Chromium-specific; Firefox/WebKit arrive with the service renderer.                            |
| 2   | **Storybook 10 migration, CLI-first** (this doc) — peer `^10`, examples on 10, capture verified; addon manager fixes follow                                                                                                                                                     | Everything downstream is built on SB 10; today the addon only ever runs on 8.6 (declared `^8.4.7`, lockfile 8.6.18). CLI capture is unaffected by 10 (verified); the addon's manager imports are what break.               |
| 3   | **Stale-check and false-green fixes** — squash/rebase/shallow-clone staleness; uncommitted edits visible to `--since`; partial-match full-run fallback; live params wired end to end; hash decoded pixels not WebP bytes                                                        | Found in the 2026-10-12 review; each is a silent-wrong-answer path the exact-hash philosophy cannot tolerate. Must land before any public claim.                                                                           |
| 4   | **Benchmark** — ~100 labelled real diffs; arms: today's handoff + free image access / tier-0 only / tier-0 + escalation; agreement with human verdicts, tokens, images read, $                                                                                                  | Turns "faster, cheaper, agent-first" into numbers T53 allows us to publish. Flip-to-go gate: tier-0 ≥ image-review agreement at <10% tokens.                                                                               |
| 5   | **Pinned capture image** — Docker, pinned Chromium + fonts; laptop and CI produce identical bytes                                                                                                                                                                               | Determinism floor for 6–8. Closes #74/#75. Same environment the service renderer will need.                                                                                                                                |
| 6   | **Conformance suite** — synthetic SB 10 workbench, one story per feature/hazard with an expected outcome; N runs, then mutations asserting failures, regions and affected-story selection                                                                                       | Small, named repros for every failure.                                                                                                                                                                                     |
| 7   | **Addon E2E** — Playwright drives a real SB 10 with the addon: panel, dots, test provider, approve/deny writing the manifest, watch mode                                                                                                                                        | The addon UI has unit tests but has never been driven end to end.                                                                                                                                                          |
| 8   | **Real-world corpus** — two large OSS SB 10 design systems pinned at a commit, 5× in the image, zero tolerated flakes; timings recorded                                                                                                                                         | Scale and realism; replaces the inherited ARCHITECTURE.md numbers with ours; the only source for a 1,000-story figure.                                                                                                     |

Later, not scheduled: Figma frame as a third baseline kind for the structural
diff (after tier 2 exists); browsers via the service renderer.

Within 5–8 the order stays conformance-first: corpus failures in an 800-story
suite are slow to isolate.

## Decision: support Storybook 10 only

npm downloads for the week before 2026-10-12, by major:

| major                | first release                   | weekly downloads | share |
| -------------------- | ------------------------------- | ---------------- | ----- |
| 10.x (latest 10.6.2) | 2025-10-28                      | 18.3M            | ~73%  |
| 8.x                  | 2024-03-11                      | 4.5M             | ~18%  |
| 9.x                  | 2025-05-28                      | 1.7M             | ~7%   |
| 11.x                 | alpha (`next` = 11.0.0-alpha.6) | —                | —     |

The 8.x share is mostly maintenance-mode installs — not the teams likely to
adopt a new visual testing tool. Supporting three majors triples the matrix
for users we are not targeting, and the addon's manager surface (status API,
test providers, import paths) differs on every one.

- Peer range becomes `storybook: ^10`. Re-add a major only on real demand.
- CI gains a **non-blocking** job against `storybook@next` (11 alpha) so the
  break is known before 11 ships, not after.
- This is a breaking change for 0.x packages → minor bump with a changeset.

## What breaks on 10 today

Found by reading `storybook@10.6.2`'s published package, not by running it.
Confirming each on a live dev server is the first implementation step.

1. **Manager import paths do not resolve.** `packages/storybook/src/storybook.ts`
   imports `storybook/internal/manager-api` and `storybook/internal/theming`.
   SB 10's `exports` map has `./manager-api` and `./theming` but no internal
   variants of those two, and the manager globals map aliases only the legacy
   `@storybook/manager-api`. Expected effect: the addon's manager bundle fails
   to load, taking the panel with it. (`storybook/internal/components` is still
   exported and stays.)
2. **Sidebar dots are silently off.** `applyStatuses` (`sidebar.ts:130`) looks for
   `experimental_updateStatus` / `updateStatus` on the API object. SB 10 has
   neither; it exports `experimental_getStatusStore(typeId)` from
   `storybook/manager-api`, returning a store with `set(Status[])` /
   `unset(storyIds?)`, and a new vocabulary:
   `status-value:{pending,success,new,modified,affected,reviewing,warning,error,unknown}`.
   The fallback logs a warning and returns — so this ships as a silent
   cosmetic regression.
3. **The test provider has never run.** `test-provider.tsx` was written against
   10.5's `experimental_getTestProviderStore` but every example resolves to
   8.6.18 (declared `^8.4.7`), where it is a deliberate no-op. It is unexercised code, not working code.
4. **Typing is pinned to 8.** devDependency `storybook ^8.4.7`, and the
   comment in `registerTestProvider` casts around 8's `TEST_PROVIDER` type.
   On 10 the real types apply and the casts should go.

What does **not** break: the capture adapter. `adapter-storybook` depends on
`__STORYBOOK_PREVIEW__.storyRenders[].phase`, the `storyRenderPhaseChanged`
event, `playing`/`played` and `setCurrentStory` — all present in
SB 10.6.2's `preview/runtime.js`. SB 10.6.2 accepts Vite 5–8, so the examples'
Vite 5 is fine; CI already runs Node 22.

## Changes

**`packages/storybook`**

- `storybook.ts`: import from `storybook/manager-api` and `storybook/theming`;
  keep `storybook/internal/components`. Re-export `experimental_getStatusStore`
  and `experimental_getTestProviderStore` from here so the shim stays the only
  file that names Storybook modules.
- `sidebar.ts`: replace the API-object probe with the status store. Status
  type id `juxtapose/visual`. Mapping from `DiffStatus`:

  | ours              | SB 10 status value | why                                            |
  | ----------------- | ------------------ | ---------------------------------------------- |
  | `pass`            | `success`          |                                                |
  | `fail`            | `error`            | a hash mismatch is a failed check              |
  | `new`             | `new`              | no baseline yet — SB now has the exact word    |
  | `stale`           | `warning`          | baseline exists but is not an ancestor of HEAD |
  | `skip`            | cleared (`unset`)  | skipped stories carry no verdict               |
  | in-flight capture | `pending`          |                                                |

  The pure `RunReport → Status[]` function stays pure and unit-tested, but its
  vocabulary changes: `SbStatusValue` gains `new`/`warning`/`pending` and
  drops `warn`, and `toSidebarStatus` emits the table above (today it emits
  `warn` for both `new` and `stale`). `sidebar.test.ts` is rewritten to the
  new vocabulary. Keep the degrade-to-warning behaviour if the store export
  is missing (an 11-alpha could move it).

- `test-provider.tsx` / `test-provider-state.ts`: drop the 8/9 no-op branch
  and the type casts; the provider is now expected to register, and a failure
  to register is an error worth surfacing.
- `package.json`: peer `storybook: ^10`, dev `storybook ^10.6`, React types
  for the version SB 10 builds against.

**Examples** (`examples/storybook`, `examples/storybook-vue`)

- Upgrade every Storybook package to `^10.6` — `storybook`,
  `@storybook/react-vite` and `@storybook/react` (React example),
  `@storybook/vue3-vite` and `@storybook/vue3` (Vue example). Leaving the
  renderer packages on 8.x beside storybook 10 is a peer mismatch and a
  duplicate preview runtime. Run Storybook's own automigrate, then review its
  diff rather than accepting it wholesale.

**Repo**

- `packages/addon-storybook/` is untracked residue (a gitignored `dist/` and
  `tsconfig.tsbuildinfo` from before the package rename) on the author's
  checkout only; nothing in git. Not part of this PR — `rm -rf` it locally.
- README / package READMEs: state SB 10 as the requirement.
- CI: add the `storybook@next` job (`continue-on-error: true`), which swaps the
  example's Storybook packages to `next`, builds, and runs `visual` once.
- Changeset: minor bump for `@juxtapose/storybook` only, noting the dropped
  majors. `@juxtapose/adapter-storybook` declares no `storybook` peer and is
  unaffected, so it gets no changeset.

## Verification

Done means all of these were run and their output recorded in the PR:

1. `pnpm build && pnpm typecheck && pnpm lint && pnpm test` green.
2. `pnpm --filter example-storybook visual` and the Vue example produce a
   report with every story captured; then byte-stability for both:
   `pnpm check:determinism` (hardcoded to `examples/storybook`) and
   `node scripts/check-determinism.mjs examples/storybook-vue 3`, as CI does.
3. **Live-addon smoke check** — the one runnable check this change leaves
   behind: a small Playwright script under `scripts/` that starts the example
   dev server, opens Storybook, and asserts
   - no `[juxtapose]` warnings or uncaught errors in the manager console,
   - the Visual panel tab renders,
   - after a run, at least one sidebar item carries a `juxtapose/visual`
     status,
   - the juxtapose row appears in the test-provider panel.
     It runs in CI. Sub-project 7 (addon E2E) grows it into the full suite.
4. The `storybook@next` job has run at least once, and its result (green or
   the specific break) is recorded in the PR.

## Out of scope

Everything in the program table other than row 2: the agent surface and
viewports (0–1), the stale/false-green fixes and benchmark (3–4), Docker image,
conformance suite, addon E2E and corpus (5–8). Warm-switch determinism (#32).
Adopting SB 10's own change-detection statuses as an input to affected-story
analysis — these are status _type ids_ in `storybook/manager-api`
(`CHANGE_DETECTION_STATUS_TYPE_ID = "storybook/change-detection"`, values
`new/modified/affected`), not a module — worth evaluating, separately.
