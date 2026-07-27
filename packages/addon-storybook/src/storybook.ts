// Every Storybook import the addon makes, in one place.
//
// These live under `storybook/internal/*` in Storybook 8 and moved to bare
// `storybook/*` specifiers in 9. Addons are expected to use them — it is how
// Storybook wants addons to look native — but "expected" is not "stable", so
// funnelling them through one module means a version bump is a single edit
// rather than a hunt across the UI.
//
// Typed loosely on purpose. The real types are not exported from a stable
// path, and pinning to internals we cannot import cleanly would trade one
// fragility for another.

export {
  addons,
  types,
  useStorybookApi,
  useStorybookState,
} from 'storybook/internal/manager-api';

export { styled } from 'storybook/internal/theming';

export { Badge, Button, EmptyTabContent, Loader } from 'storybook/internal/components';
