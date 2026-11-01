# Capture variant identity and resolution

Contributor reference for implemented variants. See
[configuration](../configuration.md) for supported fields and user examples.
The [variant implementation](../../packages/core/src/capture/variants.ts) and its
tests define resolution and error handling.

## Expansion

A variant is an additional capture job, not a new platform story. Expansion runs
after platform enumeration and emits the default capture plus configured variants.
A skipped story skips its variants. Variant declarations do not implicitly turn
every story into a viewport/device matrix.

Project and story variants merge by name; a story declaration wins and `false`
removes that variant. `extends` resolves within the merged set. Unknown targets,
cycles, invalid names and capture-key collisions are configuration errors.

Resolution combines the base story settings, extended variants and the selected
variant, then applies matching project story overrides. Nested settings such as
renderer, network, freeze and settle policies use their explicit merge rules.
Device and viewport conflicts must not be resolved by accidentally carrying state
from a previous capture. Live adapter values must preserve the selected variant
and project-override precedence.

## Identity

A variant capture key is `${baseStoryId}__${variant}`. The manifest keeps optional
`baseStoryId` and `variant` fields so consumers do not need to reverse-engineer the
key. Names follow the schema's bounded lowercase alphanumeric/hyphen grammar.
Expansion sorts keys in code-unit order and rejects duplicate capture identities.

Platform navigation uses `baseStoryId ?? storyId`. Baselines, captured images,
reports and approval selection use the capture key. This distinction prevents a
variant key from being sent to a workbench that knows only the underlying story.

Selecting a base story for capture includes its variants; selecting a capture key
can target one variant. Approval operates on the reviewed run's capture identities
and retains fresh-confirmation and environment checks. It must not broaden an
explicit selection or silently approve a different capture.

## Capture and reports

Viewport, color scheme and device policy must be applied for each capture,
including resetting pooled-page state between variants. A dark or mobile capture
must not affect the default capture that follows it.

Reports preserve the base-story/variant association while presenting independent
capture results. Any story-level aggregate is distinct from the number of rendered
captures. Tests cover expansion, inheritance, key collisions, selection and actual
variant capture behavior; see [contributing](../../CONTRIBUTING.md) for real-browser
and determinism checks.
