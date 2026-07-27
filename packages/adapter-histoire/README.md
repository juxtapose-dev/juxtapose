# @juxtapose/adapter-histoire

Histoire platform adapter for juxtapose visual testing.

Part of [juxtapose](https://github.com/juxtapose-dev/juxtapose), visual
regression testing for component workbenches.

**You probably don't need to install this directly.** Use
[`@juxtapose/cli`](https://www.npmjs.com/package/@juxtapose/cli) for the
command line, or
[`@juxtapose/storybook`](https://www.npmjs.com/package/@juxtapose/storybook)
to review diffs inside Storybook. This package is a building block those
depend on.

## Notes specific to Histoire

**One baseline per variant, not per story.** A Histoire story is a file
holding many `<Variant>`s, and only a variant is a single render — so a story
file with six variants produces six baselines. The captured id is the variant
id.

**Per-story config goes in `meta`**, which Histoire serialises into
`histoire.json` verbatim:

```vue
<Story title="Button">
  <Variant title="Slow" :meta="{ juxtapose: { delay: 200 } }">
    <Button />
  </Variant>
</Story>
```

Variant config overrides story config, so one variant can opt out with
`{ juxtapose: { skip: true } }` without affecting its siblings.

**Set explicit variant ids if you reorder.** Histoire numbers variants
positionally (`my-story-vue-0`, `-1`, …), so inserting a `<Variant>`
renumbers every variant after it — which reads as a rename, and orphans those
baselines. `<Variant id="primary">` pins them.

**Capture requires a build.** `histoire.json` is written by `histoire build`
and never by the dev server, so `--origin` against `histoire dev` will not
enumerate. Point juxtapose at `.histoire/dist`.

Full documentation: https://github.com/juxtapose-dev/juxtapose

MIT © Magic Factory LLC
