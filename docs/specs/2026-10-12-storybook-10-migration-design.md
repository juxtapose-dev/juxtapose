# Storybook 10 migration — and the "addon works perfectly" program

Status: draft for review · 2026-10-12

## The program

Goal: the Storybook addon and the capture pipeline behind it work perfectly —
launch-ready as open source, and solid enough to be the intake for
juxtapose-service — proven on a synthetic conformance suite and on real,
large design systems.

Five sub-projects, in dependency order. Each gets its own spec → plan →
implementation cycle; only sub-project 1 is specified here.

| # | Sub-project | Why it is in this position |
| - | ----------- | -------------------------- |
| 1 | **Storybook 10 migration** (this doc) | Everything else is built on SB 10; today the addon is only ever run on 8.4.7. |
| 2 | **Pinned capture image** — Docker, pinned Chromium + fonts; laptop and CI produce identical bytes | Determinism floor for 3–5. Closes #74/#75. Same environment the service renderer will need. |
| 3 | **Conformance suite** — synthetic SB 10 workbench, one story per feature/hazard, each with an expected outcome; runner asserts outcomes across N runs, then applies mutations and asserts failures, changed regions and affected-story selection | Small, named repros for every failure; "covers everything we need" lives here. |
| 4 | **Addon E2E** — Playwright drives a real SB 10 with the addon: panel, sidebar dots, test provider, approve/deny writing the manifest, watch mode | The addon UI has unit tests but has never been driven end to end. |
| 5 | **Real-world corpus** — two large OSS SB 10 design systems pinned at a commit, static builds cached, run 5× in the image with zero tolerated flakes; timings recorded | Scale and realism; validates the claims in ARCHITECTURE.md that were measured on the predecessor tool. |

Order is conformance-first: corpus failures in an 800-story suite are slow to
isolate, so the corpus runs last against a pipeline the conformance suite has
already hardened.

## Decision: support Storybook 10 only

npm downloads for the week before 2026-10-12, by major:

| major | first release | weekly downloads | share |
| ----- | ------------- | ---------------- | ----- |
| 10.x (latest 10.6.2) | 2025-10-28 | 18.3M | ~73% |
| 8.x  | 2024-03-11 | 4.5M  | ~18% |
| 9.x  | 2025-05-28 | 1.7M  | ~7%  |
| 11.x | alpha (`next` = 11.0.0-alpha.6) | — | — |

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
   10.5's `experimental_getTestProviderStore` but every example is on 8.4.7,
   where it is a deliberate no-op. It is unexercised code, not working code.
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

  | ours | SB 10 status value | why |
  | ---- | ------------------ | --- |
  | `pass` | `success` | |
  | `fail` | `error` | a hash mismatch is a failed check |
  | `new` | `new` | no baseline yet — SB now has the exact word |
  | `stale` | `warning` | baseline exists but is not an ancestor of HEAD |
  | `skip` | cleared (`unset`) | skipped stories carry no verdict |
  | in-flight capture | `pending` | |

  Keep the pure `RunReport → Status[]` function and its tests; only the
  application step changes. Keep the degrade-to-warning behaviour if the store
  export is missing (an 11-alpha could move it).
- `test-provider.tsx` / `test-provider-state.ts`: drop the 8/9 no-op branch
  and the type casts; the provider is now expected to register, and a failure
  to register is an error worth surfacing.
- `package.json`: peer `storybook: ^10`, dev `storybook ^10.6`, React types
  for the version SB 10 builds against.

**Examples** (`examples/storybook`, `examples/storybook-vue`)
- Upgrade to `storybook`, `@storybook/react-vite`, `@storybook/vue3-vite`
  `^10.6`. Run Storybook's own automigrate, then review its diff rather than
  accepting it wholesale.

**Repo**
- Delete `packages/addon-storybook/` — it contains only a stale `dist/` and
  `tsconfig.tsbuildinfo`, no source or package.json.
- README / package READMEs: state SB 10 as the requirement.
- CI: add the `storybook@next` job (`continue-on-error: true`), which swaps the
  example's Storybook packages to `next`, builds, and runs `visual` once.
- Changeset: minor bump for `@juxtapose/storybook` and
  `@juxtapose/adapter-storybook` noting the dropped majors.

## Verification

Done means all of these were run and their output recorded in the PR:

1. `pnpm build && pnpm typecheck && pnpm lint && pnpm test` green.
2. `pnpm --filter example-storybook visual` and the Vue example produce a
   report with every story captured; then `pnpm check:determinism` green
   (it captures the examples repeatedly and asserts byte-stability).
3. **Live-addon smoke check** — the one runnable check this change leaves
   behind: a small Playwright script under `scripts/` that starts the example
   dev server, opens Storybook, and asserts
   - no `[juxtapose]` warnings or uncaught errors in the manager console,
   - the Visual panel tab renders,
   - after a run, at least one sidebar item carries a `juxtapose/visual`
     status,
   - the juxtapose row appears in the test-provider panel.
   It runs in CI. Sub-project 4 grows it into the full addon E2E suite.
4. The `storybook@next` job has run at least once, and its result (green or
   the specific break) is recorded in the PR.

## Out of scope

Docker image, conformance suite, full addon E2E, real-world corpus
(sub-projects 2–5). Warm-switch determinism (#32). Adopting SB 10's own
change-detection statuses (`storybook/change-detection`, `new/modified/affected`)
as an input to affected-story analysis — worth evaluating, separately.
