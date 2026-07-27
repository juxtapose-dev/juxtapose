---
'@juxtapose/storybook': patch
'@juxtapose/adapter-storybook': patch
---

Explain why two packages both say "Storybook".

`@juxtapose/storybook` is the addon you install; `@juxtapose/adapter-storybook`
is how the CLI drives a browser, and arrives as a dependency. Nothing renamed —
the addon keeps the short name, matching `@chromatic-com/storybook` — but the
docs never said which was which, which made the split look backwards.

The addon's directory is now `packages/storybook/` rather than
`packages/addon-storybook/`, so every directory matches its published name.
That mismatch is what produced a changeset naming a package that did not exist,
which failed the release.
