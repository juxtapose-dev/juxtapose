# @juxtapose/storybook

Storybook addon for [juxtapose](https://github.com/juxtapose-dev/juxtapose) —
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

A **Juxtapose** tab appears in the addon panel. From there you can capture the
current story or the whole suite, compare against the baseline four ways
(side by side with a diff overlay, a draggable slider, an onion crossfade, or
flicker), approve changes, and copy an agent-ready prompt describing exactly
what moved.

juxtapose also registers as a test provider: a **Juxtapose** row in Storybook's
testing module at the bottom of the sidebar, and Storybook's **Run tests**
button runs the visual suite alongside your other tests. The test provider
needs Storybook 8.5 or later and is checked against 8.6 and 10.6. On earlier
versions the row doesn't appear; the panel works either way.

The **What changed** section uses the existing report's structural summary,
with expandable before/after details, evidence limits, and unexplained regions.
When available, it also shows flake evidence and suggested configuration you can
select and copy. Suggestions are not applied automatically. Renderer recovery
reports an exact hash match when successful; it does not establish a root cause.
These explanations require no additional captures or analysis.

Capture errors, cancellation, and failed runs are shown explicitly. A failed run
may leave the previous report visible, labelled as such. Approval is unavailable
for capture errors or confirmed unstable results; eligible approvals still take
a fresh confirming capture. Missing baseline images show the current capture
and available structural evidence, without comparison controls.

Keyboard: `j`/`k` next and previous pending capture (including variants), `a`
approve, `s` side by side, `w` wipe slider, `o` onion, `f` flicker, `d` diff
overlay, `u` dim unchanged areas, and `z` loupe. Shortcuts ignore text inputs,
modifier keys, and repeated key events. Approval shortcuts obey the same guards
as the buttons.

The wipe slider supports pointer dragging, arrow keys (1%; Shift for 10%), and
Home/End. Flicker has a pause/play control, starts paused when reduced motion
is requested, and pauses while the browser tab is hidden. If copying an agent
prompt fails, its text remains selectable in the panel.

The addon mounts its API inside Storybook's own dev server, so there is no
second process to run and no port to configure.

MSW-backed stories are supported: Storybook captures allow service workers.
Configure MSW in your Storybook, serve its worker asset in both development and
static builds, and await worker readiness in your preview/loader before fetching
mocked data. The addon does not install or configure MSW for you. CI verifies
real MSW responses in repeated captures; the example's `Msw.stories.jsx` shows
the setup. This is separate from URL-only `jux snap`, which blocks service workers.

Full documentation: https://github.com/juxtapose-dev/juxtapose

MIT © Magic Factory LLC
