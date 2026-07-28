# Examples

Two workbenches, Storybook and Ladle, rendering the **same components** from
`examples/components`. That is the point: the adapters should produce
equivalent results from identical source.

```bash
pnpm install
pnpm --filter example-storybook visual   # build + capture
pnpm --filter example-ladle visual
```

Both start with everything `new` (no baselines are committed, see below).
`jux approve --all` establishes them, then subsequent runs should be all-pass.

## Layout

```
examples/
  components/      shared React components, plain JSX, no build step
  storybook/       Storybook 8 + @storybook/react-vite
  storybook-vue/   Storybook 8 + @storybook/vue3-vite
  ladle/           Ladle 5
```

`storybook-vue` exists to keep "works with Storybook" honest. Storybook's
indexing is core rather than per-renderer, so the adapter should be
renderer-agnostic.
It runs in CI alongside the others, and captures 9 stories byte-identically
with `skip` and per-story viewport overrides behaving exactly as they do on
React.

## What the stories cover

`Button` and `Card` are ordinary components: variants, sizes, text wrapping.
They exist to look like a real project.

The `Determinism` stories are different: each one targets a specific step of
the capture pipeline, so when the suite flakes, the story that flakes tells you
what broke.

| story               | what it proves                                          |
| ------------------- | ------------------------------------------------------- |
| `InfiniteSpinner`   | animations are frozen                                   |
| `AnimatedEntrance`  | the same, for a one-shot entrance animation             |
| `AwaitsNetwork`     | capture waits for async content, not the loading state  |
| `Typography`        | text rendering, the most diff-sensitive thing on a page |
| `NarrowViewport`    | per-story viewport overrides                            |
| `NeverCaptured`     | `skip`                                                  |
| `AnimationsRunning` | opting _out_ of the freeze, and what it costs           |

`AnimationsRunning` is marked `skip` deliberately. With animations live the
spinner is at an arbitrary rotation when the shutter fires, so under a
byte-exact hash the story is inherently unstable. That is the honest tradeoff
of `animations: 'play'`. Remove the `skip` to watch it flap.

## Per-story config differs by platform

Same options, different declaration site. This is the clearest illustration of
what the platform adapters actually abstract.

```jsx
// Storybook: parameters
export const Narrow = {
  render: () => <TextSpecimen />,
  parameters: { juxtapose: { viewport: { width: 480, height: 400 } } },
};

// Ladle: meta (statically extracted at build time, so it must be a literal)
export const Narrow = () => <TextSpecimen />;
Narrow.meta = { juxtapose: { viewport: { width: 480, height: 400 } } };
```

Both workbenches enumerate 16 stories and capture 14. The two `skip` stories
are honoured identically. That was not always true: Storybook drops custom
parameters from its static index, so `skip` was invisible at enumeration time
until `readLiveParams` started re-reading them from the live preview. If the
two ever disagree on counts again, that is the mechanism to suspect.

## Baselines are not committed here

Normally you _would_ commit `juxtapose.manifest.json` and
`.juxtapose/baselines/`, which is the whole point of the git store.

These examples are the exception. Antialiased rendering differs across
platforms and Chromium versions, so a baseline captured on one machine will not
match another's byte-for-byte. Committing them would leave the examples
permanently red for everyone but the author. Run `jux approve --all` locally
instead.

## Trying a regression

```bash
# change something in the shared components
sed -i '' "s/#2563eb/#dc2626/" examples/components/src/index.jsx

pnpm --filter example-storybook visual
# -> 9 pass, 5 fail (every Button story carrying the changed colour)

pnpm --filter example-storybook exec jux handoff button--primary
# -> an agent-ready prompt with exact coordinates and the component path
```
