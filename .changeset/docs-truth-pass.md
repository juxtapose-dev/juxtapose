---
'@juxtapose/core': patch
'@juxtapose/cli': patch
---

Remove two options that were declared but never read.

`ProjectConfig.ignore` (glob patterns of story ids to never capture) and the
CLI's `--force` flag both parsed fine and did nothing. Setting either was a
silent no-op, which is worse than the option not existing — you would conclude
the tool ignored your config rather than that the feature was never wired up.
Use `parameters.juxtapose.skip` for the `ignore` case.

Also corrects documentation that had drifted from the code ahead of the first
publish: hosted S3 storage was advertised as available when the CLI throws on
it, the HTML report and PR comments were listed as unbuilt after shipping, the
settle pipeline was documented with animation-freezing in the wrong position
(the exact ordering bug that was fixed), and the packages table omitted
`@juxtapose/storybook` — the package you install for the addon.
