# From a visual change to its component

A screenshot tells you where the page changed. Component evidence helps you find
which part of the application to inspect next. A button may belong to a `Row`
instance inside a `Cart`; selecting that instance can highlight its captured DOM
elements, including elements rendered through a portal.

Keep the pixels and DOM alongside that context. A component name does not explain
why a margin changed, and it does not prove that a particular source edit caused
the diff. Image comparison still determines the verdict. Component metadata never
approves a change or changes a baseline hash.

## Capture setup

The Storybook addon adds the build support automatically for Vite workbenches.
For Ladle or another Vite workbench, add the component plugin before the framework
compiler:

```ts
import { juxtaposeComponentEvidence } from '@juxtapose/core/vite';

export default {
  plugins: [
    ...juxtaposeComponentEvidence(),
    // Your framework plugin follows here.
  ],
};
```

React 18 and 19 use a capture-time observer installed before the application loads;
they need no source transform. The Vite plugin preserves function and class names
when esbuild minifies the build, unless `esbuild.keepNames` is explicitly disabled.
This can increase the workbench bundle size. Other minifiers and already-minified
dependencies may still produce shortened names. Vue 3 production builds need
`__VUE_PROD_DEVTOOLS__` enabled. The plugin enables that flag while respecting an
explicit opt-out. Svelte 5 uses the project's installed compiler to record mounted
instances and element ownership. Production compilation stays enabled, and the
transform preserves authored source-map positions for normal debugging.

Older snapshots still contain their original DOM evidence. Capture both sides
with component support to compare their component trees; installing a new CLI
cannot recover component instances from an old screenshot.

## Read the tree accurately

Repeated names are separate instances. Two rows called `Row` are not interchangeable,
and their capture-local IDs are not stable identities across commits. A fragment
or portal can associate several DOM elements with one component. A component with
no retained DOM association may render text, be outside the capture, or render
nothing; the evidence does not distinguish those cases.

React and Vue record rendered parent relationships. Svelte's instrumented tree
records context parents and the component that **declared** each native element.
For example, a snippet declared in a parent can render inside a child while its
elements still belong to the declaring component. Precompiled or uninstrumented
Svelte dependencies are not enumerated, so Svelte coverage is labelled partial.

Trees are bounded and can be truncated. If DOM mutations are detected during
collection, or an association is ambiguous, component evidence becomes unavailable. DOM and pixel
review remain usable. Captures with active masks suppress the entire component
tree, including names of instances that have no visible DOM elements.

## Source context and agents

Source locations appear only when the capture provides them. Svelte instrumentation
records repository-relative file identity. React and Vue source positions are not
inferred from component names. Anonymous Vue object components stay unnamed; Vue
single-file components can provide compiler-generated names. Source
maps alone do not identify mounted component instances.

For hosted review, ask an agent to inspect the visual diff with trees included,
read the selected instance's DOM associations, and compare those elements' recorded
styles and geometry. A useful request is:

> Inspect this PR's visual diff and its component and DOM trees. Identify the
> affected instance and the recorded changes to its elements. Separate what the
> evidence shows from likely causes, then propose the smallest code change to check.

The [hosted MCP guide](https://www.juxtapose.dev/docs/hosted-mcp/) covers access to PR
review evidence. The [local MCP server](mcp.md) supports the rapid edit-and-capture
loop. Captures export bounded names, relationships, element associations and
available source positions—not props, hooks, application state, raw source maps
or source contents.
