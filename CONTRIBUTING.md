# Contributing

```bash
pnpm install
pnpm build
pnpm test
```

Node 22.2+ and the pnpm version pinned in the root `package.json`. Capturing anything also needs the pinned browser (a one-time ~100 MB download):

```bash
# from a checkout, after `pnpm build` (the published form is
# `npx -p @juxtapose/cli jux browser install`):
node packages/cli/dist/index.js browser install
```

## Checks

CI runs all of these, so run them before opening a pull request:

```bash
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm check:determinism   # needs pnpm build and a built example first
```

## Working on capture

The examples are the real test surface. Unit tests cover the pure functions,
but every significant bug so far was invisible to them and showed up the moment
the tool ran against an actual workbench.

```bash
pnpm --filter example-storybook visual
pnpm --filter example-ladle visual
```

If your change touches capture, also run `pnpm check:determinism`. Captures
must be byte-identical across repeated runs of unchanged stories — that is what
makes exact comparison possible, and the failure mode is a race, so a single
green run doesn't prove much.

`examples/README.md` explains what each example story is there to prove.

## Adding a workbench

Implement the `Platform` interface in `packages/core/src/platform.ts`:
`detect`, `enumerate`, `showStory`, `previewUrl`, `settle`, `configDirs` and
`storyFileGlobs`; optionally `switchStory`, `storyUrl` and `readLiveParams`. The existing
adapters are small — Ladle's is under 200 lines — and both were written against
this interface without changing it. If something platform-specific is creeping
into `core`, that usually means the interface needs another method rather than
core needing a special case.

## Conventions

Comments should explain _why_, not what — the code already says what it does.
When you fix something subtle, record the measurement or failure that justified
the fix, since that's the part nobody can re-derive by reading the code.

Non-trivial logic should leave one runnable check behind. Not a suite per
function; the smallest thing that fails if the logic breaks.

Prefer tests that exercise the real library over hand-rolled fixtures. A
fixture can encode the same wrong assumption as the code and pass while
production is broken — that has happened here.

## Pull requests

Add a changeset for anything user-facing:

```bash
pnpm changeset
```

Merging to main without one publishes nothing, so this is how a change ships.

`ARCHITECTURE.md` covers the design; `CLAUDE.md` covers the invariants worth
knowing before changing capture or diff internals.

## Documentation review

[User documentation](docs/README.md) describes verified, released behavior and
supported setup. Check commands and defaults against the published package before
changing them. Mark unreleased features explicitly; do not present proposals,
synthetic timings or untested integrations as product capabilities.

Contributor references explain reviewed implementation contracts, tests and
reproducible measurement methods. Keep them consistent with source, identify the
version and limits of historical results, and update or retire superseded advice.
Review links when removing a document.

Keep personal handoffs, generated execution plans, speculative roadmaps and raw
scratch output out of the public docs by default. A useful experiment can become
a concise contributor reference after human review of its evidence, scope and
publication intent. Do not copy an agent's approval label as proof of that review.

Contributor entry points: [architecture](ARCHITECTURE.md),
[design references](docs/README.md#contributor-references),
[field-test reproduction](docs/field-tests.md) and [profiling](docs/profiling.md).
