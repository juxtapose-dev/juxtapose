# @juxtapose/storybook

Storybook addon for [juxtapose](https://github.com/juxtapose-dev/juxtapose).
review visual diffs next to the story that produced them.

```bash
pnpm add -D @juxtapose/storybook
```

```js
// .storybook/main.js
export default {
  addons: ['@juxtapose/storybook'],
};
```

A **Visual** tab appears in the addon panel. From there you can capture the
current story or the whole suite, compare against the baseline four ways
(side by side with a diff overlay, a draggable slider, an onion crossfade, or
flicker), approve changes, and copy an agent-ready prompt describing exactly
what moved.

Keyboard: `j`/`k` next and previous failing story, `a` approve, `1`–`4` view
mode, `d` diff overlay, `u` dim unchanged areas.

The addon mounts its API inside Storybook's own dev server, so there is no
second process to run and no port to configure.

Full documentation: https://github.com/juxtapose-dev/juxtapose

MIT © Magic Factory LLC
