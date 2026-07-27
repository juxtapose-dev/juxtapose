# @juxtapose/storybook

Storybook addon for [juxtapose](https://github.com/juxtapose-dev/juxtapose) —
review visual diffs next to the story that produced them.

![The Visual panel showing a changed story: baseline and current side by side, the mismatch percentage, and approve and copy-prompt actions](https://raw.githubusercontent.com/juxtapose-dev/juxtapose/main/docs/media/addon-panel.png)

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
current story or the whole suite, approve changes, and copy an agent-ready
prompt describing exactly what moved.

Four comparison modes: side by side with a diff overlay, a draggable slider, an
onion crossfade, and flicker.

![Cycling through the four comparison modes](https://raw.githubusercontent.com/juxtapose-dev/juxtapose/main/docs/media/addon-modes.gif)

A story that matches its baseline says so and shows no controls — there is
nothing to compare, and offering an approve button for an unchanged story only
invites a pointless click.

![The panel on a passing story, reading "Matches the approved baseline"](https://raw.githubusercontent.com/juxtapose-dev/juxtapose/main/docs/media/addon-panel-passing.png)

Keyboard: `j`/`k` next and previous failing story, `a` approve, `1`–`4` view
mode, `d` diff overlay, `u` dim unchanged areas.

The addon mounts its API inside Storybook's own dev server, so there is no
second process to run and no port to configure.

Full documentation: https://github.com/juxtapose-dev/juxtapose

MIT © Magic Factory LLC
