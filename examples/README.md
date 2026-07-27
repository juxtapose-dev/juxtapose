# Examples

Two workbenches — Storybook and Ladle — rendering the **same components** from
`examples/components`. That is the point: the adapters should produce
equivalent results from identical source.

```bash
pnpm install
pnpm --filter example-storybook visual   # build + capture
pnpm --filter example-ladle visual
```

Both start with everything `new` (no baselines are committed — see below).
`jux approve --all` establishes them, then subsequent runs should be all-pass.

## Layout

```
examples/
  components/   shared React components, plain JSX, no build step
  storybook/    Storybook 8 + @storybook/react-vite
  ladle/        Ladle 5
```

## What the stories cover

`Button` and `Card` are ordinary components — variants, sizes, text wrapping.
They exist to look like a real project.

The `Determinism` stories are different: each one targets a specific step of
the capture pipeline, so when the suite flakes, the story that flakes tells you
what broke.

| story               | what it proves                                                               |
| ------------------- | ---------------------------------------------------------------------------- |
| `InfiniteSpinner`   | animation freezing — a spinner would otherwise land on a random frame        |
| `AnimatedEntrance`  | the same freeze path via a keyframe animation on mount                       |
| `AwaitsNetwork`     | network quiescence — capture waits for a real `fetch`, not the loading state |
| `Typography`        | antialiased text, the most sensitive input a pixel differ receives           |
| `NarrowViewport`    | per-story viewport overrides                                                 |
| `NeverCaptured`     | `skip`                                                                       |
| `AnimationsRunning` | opting _out_ of the freeze, and what it costs                                |

`AnimationsRunning` is marked `skip` deliberately. With animations live the
spinner is at an arbitrary rotation when the shutter fires, so under a
byte-exact hash the story is inherently unstable — that is the honest tradeoff
of `animations: 'play'`. Remove the `skip` to watch it flap.

## Per-story config differs by platform

Same options, different declaration site — this is the clearest illustration of
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

## Known difference between the two

Storybook captures 16 stories; Ladle captures 14.

Storybook only serializes a whitelist of parameters into `index.json`, so
`parameters.juxtapose` — including `skip` — is not visible to enumeration.
Ladle extracts `meta` statically and it is complete. This is tracked in
[#12](https://github.com/juxtapose-dev/juxtapose/issues/12); the fix is to read
parameters from the live preview, which the Storybook adapter already supports
but the capture path does not yet use.

## Baselines are not committed here

Normally you _would_ commit `juxtapose.manifest.json` and
`.juxtapose/baselines/` — that is the whole point of the git store.

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
# -> 13 pass, 3 fail (the three primary-variant Button stories)

pnpm --filter example-storybook exec jux handoff button--primary
# -> an agent-ready prompt with exact coordinates and the component path
```
