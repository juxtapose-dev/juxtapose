# Reproduce the project-access review demo

`examples/storybook/stories/ProjectAccess.stories.jsx` is a self-contained,
network-free settings panel. Its fixed content includes an invitation field,
two members, a sharing switch, and save/cancel actions. The story requests a
632 × 560 capture so both versions fit without clipping.

The `changed` flag is intentionally a source edit, rather than a second story:
this demonstrates comparing the same story against its approved baseline.

1. Start the example Storybook (`pnpm --filter example-storybook storybook`).
2. From `examples/storybook`, with `changed = false`, run:

   ```sh
   jux run --origin http://localhost:6006 --story workflow-project-access--default
   jux approve --origin http://localhost:6006 --story workflow-project-access--default
   ```

3. Set `changed = true` and repeat the `jux run` command.
4. Review the story in the Visual addon panel, or open the generated report.
5. Restore `changed = false` when finished. Do not approve the intentional change.

The change narrows the explanatory paragraph from 550 to 320 pixels and
changes the footer's flex justification. The narrower paragraph wraps onto
another line; the content below moves down, and Cancel moves to the left edge.
These two source changes give comparison modes an easy-to-follow subject
without changing the whole background or introducing nondeterministic content.

For marketing captures, keep the native baseline/current/diff image dimensions
identical. Do not independently crop the images: their pixel alignment is what
makes slider, onion-skin, and flicker comparisons meaningful. Use actual report
values for captions; mismatch counts can vary with the capture environment.
