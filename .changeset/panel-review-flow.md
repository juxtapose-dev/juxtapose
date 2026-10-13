---
'@juxtapose/storybook': minor
---

Keep the review panel's keyboard flow working, and stop the diff hiding the change

- **Comparison modes are now `s` (side by side), `w` (slider), `o` (onion) and `f` (flicker).** They used to be `1` to `4`, but Storybook already binds bare `1`, `2` and `3` to focus the sidebar, preview and panel, and its handler runs first. Pressing `2` for Slider moved focus into the preview iframe, and from then on `j`, `a` and the other shortcuts went to the story instead of the panel.
- **The diff overlay now tints the current capture instead of covering it.** It was drawn at full opacity over Current. Because pixelmatch's output contains the whole frame, the reviewer saw a red silhouette and never the new render.
- **A failing story whose diff marks no pixels now says so.** Before, it read "0% changed" next to Approve. This happens with a small colour change, such as `#2563eb` to `#1d4ed8`, that fails the byte hash but sits inside pixelmatch's colour tolerance. The panel now says the change is too subtle for the overlay and points to Flicker, and it hides the Diff and Unfocus toggles, which would show nothing.
